'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { createWorkspaceMovePlan } from '@/app/lib/files/operation-flows';
import { isSameOrDescendantPath } from '@/app/lib/files/path-utils';
import { WORKSPACE_PATH_RENAMED_EVENT, WORKSPACE_PATHS_DELETED_EVENT, type WorkspacePathRenamedDetail, type WorkspacePathsDeletedDetail } from '@/app/lib/files/workspace-file-events';

export interface WorkspaceMoveConflict {
  operationId: string;
  type: 'file' | 'directory';
  sourcePath: string;
  destPath: string;
  targetDir: string;
  remainingPaths: string[];
  successCount: number;
  skippedCount: number;
}

export type WorkspaceMoveResolution = 'overwrite-selection' | 'overwrite-existing' | 'skip';
export type WorkspaceMoveResult = 'completed' | 'conflict' | 'failed' | 'superseded';

interface MoveOperation {
  id: string;
  workspaceId: string | null;
  treeGeneration: number;
  pendingPaths: string[];
  targetDir: string;
  expectedRename?: { oldPath: string; newPath: string };
  completedPaths: string[];
}

export interface WorkspaceMoveController {
  conflict: WorkspaceMoveConflict | null;
  isMoving: boolean;
  startMove: (paths: Iterable<string>, targetDir: string) => Promise<WorkspaceMoveResult>;
  resolveConflict: (action: WorkspaceMoveResolution) => Promise<WorkspaceMoveResult>;
}

export function useWorkspaceMove(): WorkspaceMoveController {
  const t = useTranslations('notebook');
  const [conflict, setConflict] = useState<WorkspaceMoveConflict | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const operationActiveRef = useRef<MoveOperation | null>(null);
  const conflictResolutionActiveRef = useRef<MoveOperation | null>(null);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const treeGeneration = useFileStore((state) => state.treeGeneration);
  const isCurrent = useCallback((operation: MoveOperation) => (
    operationActiveRef.current === operation
    && useWorkspaceStore.getState().activeWorkspaceId === operation.workspaceId
    && useFileStore.getState().treeGeneration === operation.treeGeneration
  ), []);

  const finishMove = useCallback((operation: MoveOperation) => {
    if (operationActiveRef.current !== operation) return;
    operationActiveRef.current = null;
    conflictResolutionActiveRef.current = null;
    setConflict(null);
    setIsMoving(false);
  }, []);

  useEffect(() => {
    const operation = operationActiveRef.current;
    if (operation && !isCurrent(operation)) finishMove(operation);
  }, [activeWorkspaceId, treeGeneration, finishMove, isCurrent]);
  useEffect(() => () => {
    operationActiveRef.current = null;
    conflictResolutionActiveRef.current = null;
  }, []);

  useEffect(() => {
    const affected = (operation: MoveOperation, paths: string[]) => paths.some((path) => (
      isSameOrDescendantPath(operation.targetDir, path)
      || operation.pendingPaths.some((pending) => isSameOrDescendantPath(pending, path) || isSameOrDescendantPath(path, pending))
    ));
    const renamed = (event: Event) => {
      const detail = (event as CustomEvent<WorkspacePathRenamedDetail>).detail;
      const operation = operationActiveRef.current;
      if (!operation || detail.workspaceId !== operation.workspaceId) return;
      if (operation.expectedRename?.oldPath === detail.oldPath && operation.expectedRename.newPath === detail.newPath) return;
      if (affected(operation, [detail.oldPath, detail.newPath])) finishMove(operation);
    };
    const deleted = (event: Event) => {
      const detail = (event as CustomEvent<WorkspacePathsDeletedDetail>).detail;
      const operation = operationActiveRef.current;
      if (operation && detail.workspaceId === operation.workspaceId && affected(operation, detail.paths)) finishMove(operation);
    };
    window.addEventListener(WORKSPACE_PATH_RENAMED_EVENT, renamed);
    window.addEventListener(WORKSPACE_PATHS_DELETED_EVENT, deleted);
    return () => {
      window.removeEventListener(WORKSPACE_PATH_RENAMED_EVENT, renamed);
      window.removeEventListener(WORKSPACE_PATHS_DELETED_EVENT, deleted);
    };
  }, [finishMove]);

  const completeMove = useCallback(async (operation: MoveOperation, successCount: number, skippedCount: number): Promise<WorkspaceMoveResult> => {
    if (!isCurrent(operation)) { finishMove(operation); return 'superseded'; }
    const store = useFileStore.getState();
    store.clearMultiSelect();
    try {
      await store.refreshVisibleTree();
    } catch (error) {
      console.error('Failed to refresh the file tree after moving paths:', error);
    } finally {
      finishMove(operation);
    }
    if (useWorkspaceStore.getState().activeWorkspaceId !== operation.workspaceId || useFileStore.getState().treeGeneration !== operation.treeGeneration) return 'superseded';
    if (skippedCount > 0) {
      toast.warning(t('moveMultiplePartialSuccess', { moved: successCount, skipped: skippedCount }));
      return 'completed';
    }
    toast.success(t('moveMultipleSuccess', { count: successCount }));
    return 'completed';
  }, [finishMove, isCurrent, t]);

  const handleMoveError = useCallback(async (error: unknown, operation: MoveOperation): Promise<WorkspaceMoveResult> => {
    if (!isCurrent(operation)) { finishMove(operation); return 'superseded'; }
    const err = error as Error & { code?: string; sourcePath?: string; destPath?: string };
    if (operation.completedPaths.length > 0) {
      const selected = useFileStore.getState().multiSelectPaths;
      useFileStore.getState().setMultiSelectPaths([...selected].filter((path) => !operation.completedPaths.some((completed) => isSameOrDescendantPath(path, completed))));
    }
    try {
      await useFileStore.getState().refreshVisibleTree();
    } catch (refreshError) {
      console.error('Failed to refresh the file tree after a move error:', refreshError);
    } finally {
      finishMove(operation);
    }

    if (useWorkspaceStore.getState().activeWorkspaceId !== operation.workspaceId || useFileStore.getState().treeGeneration !== operation.treeGeneration) return 'superseded';
    const message = err.code === 'DIRECTORY_EXISTS'
      ? t('directoryConflictError', { destination: err.destPath || '' })
      : err.code === 'SOURCE_NOT_FOUND' ? t('sourceNotFoundError', { path: err.sourcePath || '' })
        : t('moveError', { error: err.message });
    toast.error(operation.completedPaths.length > 0
      ? t('movePartialFailure', { count: operation.completedPaths.length, error: message }) : message);
    return 'failed';
  }, [finishMove, isCurrent, t]);

  const processMoveQueue = useCallback(async function processMoveQueue(
    operation: MoveOperation,
    pathsToMove: string[],
    targetDir: string,
    initialSuccessCount = 0,
    initialSkippedCount = 0,
  ): Promise<WorkspaceMoveResult> {
    let successCount = initialSuccessCount;
    let skippedCount = initialSkippedCount;

    for (let index = 0; index < pathsToMove.length; index++) {
      if (!isCurrent(operation)) { finishMove(operation); return 'superseded'; }
      operation.pendingPaths = pathsToMove.slice(index);
      const path = pathsToMove[index];
      const plan = createWorkspaceMovePlan([path], targetDir);
      const destination = plan.entries[0]?.destinationPath;
      if (!destination) continue;

      if (path === destination) {
        successCount += 1;
        continue;
      }

      try {
        operation.expectedRename = { oldPath: path, newPath: destination };
        await useFileStore.getState().renamePath(path, destination, false, false, operation.workspaceId);
        operation.expectedRename = undefined;
        if (!isCurrent(operation)) { finishMove(operation); return 'superseded'; }
        operation.completedPaths.push(destination);
        successCount += 1;
      } catch (error) {
        operation.expectedRename = undefined;
        if (!isCurrent(operation)) { finishMove(operation); return 'superseded'; }
        const err = error as Error & {
          code?: string;
          type?: string;
          sourcePath?: string;
          destPath?: string;
        };

        if (err.code === 'FILE_EXISTS') {
          setConflict({
            operationId: operation.id,
            type: err.type === 'directory' ? 'directory' : 'file',
            sourcePath: err.sourcePath || path,
            destPath: err.destPath || destination,
            targetDir,
            remainingPaths: pathsToMove.slice(index + 1),
            successCount,
            skippedCount,
          });
          return 'conflict';
        }

        if (err.code === 'DIRECTORY_EXISTS') {
          return handleMoveError(error, operation);
        }

        if (err.code === 'SOURCE_NOT_FOUND') {
          skippedCount += 1;
          continue;
        }

        console.error(`Failed to move ${path}:`, error);
        return handleMoveError(error, operation);
      }
    }

    return completeMove(operation, successCount, skippedCount);
  }, [completeMove, finishMove, handleMoveError, isCurrent]);

  const startMove = useCallback(async (
    paths: Iterable<string>,
    targetDir: string,
  ): Promise<WorkspaceMoveResult> => {
    if (operationActiveRef.current) return 'failed';
    const plan = createWorkspaceMovePlan(paths, targetDir);
    if (plan.sourcePaths.length === 0) return 'failed';
    if (plan.protectedPaths.length > 0) {
      toast.error(t('protectedFolderMove'));
      return 'failed';
    }
    if (plan.invalidSourcePath) {
      toast.error(t('moveIntoSelf'));
      return 'failed';
    }

    const operation: MoveOperation = {
      id: crypto.randomUUID(),
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      treeGeneration: useFileStore.getState().treeGeneration,
      pendingPaths: plan.sourcePaths,
      targetDir,
      completedPaths: [],
    };
    operationActiveRef.current = operation;
    setConflict(null);
    setIsMoving(true);
    try {
      return await processMoveQueue(operation, plan.sourcePaths, targetDir);
    } catch (error) {
      return handleMoveError(error, operation);
    }
  }, [handleMoveError, processMoveQueue, t]);

  const resolveConflict = useCallback(async (
    action: WorkspaceMoveResolution,
  ): Promise<WorkspaceMoveResult> => {
    const operation = operationActiveRef.current;
    if (!conflict || !operation || conflict.operationId !== operation.id || conflictResolutionActiveRef.current) {
      return 'failed';
    }
    if (!isCurrent(operation)) { finishMove(operation); return 'superseded'; }
    conflictResolutionActiveRef.current = operation;
    const activeConflict = conflict;
    setConflict(null);

    try {
      if (action === 'skip' || action === 'overwrite-existing') {
        return await processMoveQueue(
          operation,
          activeConflict.remainingPaths,
          activeConflict.targetDir,
          activeConflict.successCount,
          activeConflict.skippedCount + 1,
        );
      }

      operation.expectedRename = { oldPath: activeConflict.sourcePath, newPath: activeConflict.destPath };
      await useFileStore.getState().renamePath(
        activeConflict.sourcePath,
        activeConflict.destPath,
        true,
        false,
        operation.workspaceId,
      );
      operation.expectedRename = undefined;
      operation.completedPaths.push(activeConflict.destPath);
      return await processMoveQueue(
        operation,
        activeConflict.remainingPaths,
        activeConflict.targetDir,
        activeConflict.successCount + 1,
        activeConflict.skippedCount,
      );
    } catch (error) {
      return handleMoveError(error, operation);
    } finally {
      operation.expectedRename = undefined;
      if (conflictResolutionActiveRef.current === operation) conflictResolutionActiveRef.current = null;
    }
  }, [conflict, finishMove, handleMoveError, isCurrent, processMoveQueue]);

  return {
    conflict,
    isMoving,
    startMove,
    resolveConflict,
  };
}
