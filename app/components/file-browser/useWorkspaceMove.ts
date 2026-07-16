'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useFileStore } from '@/app/store/file-store';
import { createWorkspaceMovePlan } from '@/app/lib/files/operation-flows';

export interface WorkspaceMoveConflict {
  type: 'file' | 'directory';
  sourcePath: string;
  destPath: string;
  targetDir: string;
  remainingPaths: string[];
  successCount: number;
  skippedCount: number;
}

export type WorkspaceMoveResolution = 'overwrite-selection' | 'overwrite-existing' | 'skip';
export type WorkspaceMoveResult = 'completed' | 'conflict' | 'failed';

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
  const operationActiveRef = useRef(false);
  const conflictResolutionActiveRef = useRef(false);

  const finishMove = useCallback(() => {
    operationActiveRef.current = false;
    conflictResolutionActiveRef.current = false;
    setIsMoving(false);
  }, []);

  const completeMove = useCallback(async (successCount: number, skippedCount: number) => {
    const store = useFileStore.getState();
    store.clearMultiSelect();
    try {
      await store.refreshVisibleTree();
    } catch (error) {
      console.error('Failed to refresh the file tree after moving paths:', error);
    } finally {
      finishMove();
    }
    if (skippedCount > 0) {
      toast.warning(t('moveMultiplePartialSuccess', { moved: successCount, skipped: skippedCount }));
      return;
    }
    toast.success(t('moveMultipleSuccess', { count: successCount }));
  }, [finishMove, t]);

  const handleMoveError = useCallback(async (error: unknown): Promise<WorkspaceMoveResult> => {
    const err = error as Error & { code?: string; sourcePath?: string; destPath?: string };
    try {
      await useFileStore.getState().refreshVisibleTree();
    } catch (refreshError) {
      console.error('Failed to refresh the file tree after a move error:', refreshError);
    } finally {
      finishMove();
    }

    if (err.code === 'DIRECTORY_EXISTS') {
      toast.error(t('directoryConflictError', { destination: err.destPath || '' }));
    } else if (err.code === 'SOURCE_NOT_FOUND') {
      toast.error(t('sourceNotFoundError', { path: err.sourcePath || '' }));
    } else {
      toast.error(t('moveError', { error: err.message }));
    }
    return 'failed';
  }, [finishMove, t]);

  const processMoveQueue = useCallback(async function processMoveQueue(
    pathsToMove: string[],
    targetDir: string,
    initialSuccessCount = 0,
    initialSkippedCount = 0,
  ): Promise<WorkspaceMoveResult> {
    let successCount = initialSuccessCount;
    let skippedCount = initialSkippedCount;

    for (let index = 0; index < pathsToMove.length; index++) {
      const path = pathsToMove[index];
      const plan = createWorkspaceMovePlan([path], targetDir);
      const destination = plan.entries[0]?.destinationPath;
      if (!destination) continue;

      if (path === destination) {
        successCount += 1;
        continue;
      }

      try {
        await useFileStore.getState().renamePath(path, destination, false, false);
        successCount += 1;
      } catch (error) {
        const err = error as Error & {
          code?: string;
          type?: string;
          sourcePath?: string;
          destPath?: string;
        };

        if (err.code === 'FILE_EXISTS') {
          setConflict({
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
          return handleMoveError(error);
        }

        if (err.code === 'SOURCE_NOT_FOUND') {
          skippedCount += 1;
          continue;
        }

        console.error(`Failed to move ${path}:`, error);
        return handleMoveError(error);
      }
    }

    await completeMove(successCount, skippedCount);
    return 'completed';
  }, [completeMove, handleMoveError]);

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

    operationActiveRef.current = true;
    setConflict(null);
    setIsMoving(true);
    try {
      return await processMoveQueue(plan.sourcePaths, targetDir);
    } catch (error) {
      return handleMoveError(error);
    }
  }, [handleMoveError, processMoveQueue, t]);

  const resolveConflict = useCallback(async (
    action: WorkspaceMoveResolution,
  ): Promise<WorkspaceMoveResult> => {
    if (!conflict || !operationActiveRef.current || conflictResolutionActiveRef.current) {
      return 'failed';
    }
    conflictResolutionActiveRef.current = true;
    const activeConflict = conflict;
    setConflict(null);

    try {
      if (action === 'skip' || action === 'overwrite-existing') {
        return await processMoveQueue(
          activeConflict.remainingPaths,
          activeConflict.targetDir,
          activeConflict.successCount,
          activeConflict.skippedCount + 1,
        );
      }

      await useFileStore.getState().renamePath(
        activeConflict.sourcePath,
        activeConflict.destPath,
        true,
        false,
      );
      return await processMoveQueue(
        activeConflict.remainingPaths,
        activeConflict.targetDir,
        activeConflict.successCount + 1,
        activeConflict.skippedCount,
      );
    } catch (error) {
      return handleMoveError(error);
    } finally {
      conflictResolutionActiveRef.current = false;
    }
  }, [conflict, handleMoveError, processMoveQueue]);

  return {
    conflict,
    isMoving,
    startMove,
    resolveConflict,
  };
}
