'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import {
  WORKSPACE_FILE_DRAG_TYPE,
  decodeWorkspaceFileDrag,
  encodeWorkspaceFileDrag,
  getWorkspaceFileDragPaths,
  hasWorkspaceFileDragType,
  validateWorkspaceFileDrop,
  type WorkspaceFileDragPayload,
} from '@/app/lib/files/file-drag';
import { getCanvasDesktopFileDragBridge } from '@/app/lib/desktop/file-drag';
import type { WorkspaceMoveController } from './useWorkspaceMove';

const TREE_AUTO_EXPAND_DELAY_MS = 650;
const DESKTOP_FILE_DRAG_PREPARE_TTL_MS = 8 * 60 * 1000;
const DROP_TARGET_SELECTOR = '[data-file-drop-path]';

interface UseFileMoveDragOptions {
  controller: WorkspaceMoveController;
}

function getDropTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(DROP_TARGET_SELECTOR)
    : null;
}

function createDragPreview(label: string): HTMLElement {
  const preview = document.createElement('div');
  preview.className = 'fixed -left-[9999px] -top-[9999px] z-[9999] rounded-md border border-primary/40 bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-lg';
  preview.textContent = label;
  preview.setAttribute('aria-hidden', 'true');
  document.body.appendChild(preview);
  return preview;
}

export function useFileMoveDrag({ controller }: UseFileMoveDragOptions) {
  const t = useTranslations('notebook');
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const dragPayloadRef = useRef<WorkspaceFileDragPayload | null>(null);
  const dropTargetPathRef = useRef<string | null>(null);
  const autoExpandTimerRef = useRef<number | null>(null);
  const preparedDesktopPathsRef = useRef(new Map<string, number>());

  const stopAutoExpand = useCallback(() => {
    if (autoExpandTimerRef.current !== null) {
      window.clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
  }, []);

  const updateDropTarget = useCallback((path: string | null) => {
    dropTargetPathRef.current = path;
    setDropTargetPath(path);
  }, []);

  const clearDragState = useCallback(() => {
    stopAutoExpand();
    dragPayloadRef.current = null;
    updateDropTarget(null);
  }, [stopAutoExpand, updateDropTarget]);

  const scheduleTreeAutoExpand = useCallback((target: HTMLElement, path: string) => {
    stopAutoExpand();
    if (target.dataset.fileDropExpand !== 'true') return;
    if (useFileStore.getState().expandedDirs.has(path)) return;

    autoExpandTimerRef.current = window.setTimeout(() => {
      autoExpandTimerRef.current = null;
      if (dropTargetPathRef.current !== path) return;
      const store = useFileStore.getState();
      if (store.expandedDirs.has(path)) return;
      store.setExpandedDirs(new Set([...store.expandedDirs, path]));
      void store.loadSubdirectory(path, false, false);
    }, TREE_AUTO_EXPAND_DELAY_MS);
  }, [stopAutoExpand]);

  const handleDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    if (controller.isMoving || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      event.preventDefault();
      return;
    }

    const item = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-file-path]')
      : null;
    const sourcePath = item?.dataset.filePath;
    if (!item || !sourcePath) {
      event.preventDefault();
      return;
    }

    const state = useFileStore.getState();
    const paths = getWorkspaceFileDragPaths(sourcePath, state.multiSelectPaths);
    if (!state.multiSelectPaths.has(sourcePath)) {
      useFileStore.setState({
        selectedNode: {
          path: sourcePath,
          type: item.dataset.fileType === 'directory' ? 'directory' : 'file',
          name: item.dataset.fileName || sourcePath.split('/').pop() || sourcePath,
        },
        multiSelectPaths: new Set<string>(),
        isMultiSelectMode: false,
        lastSelectedPath: sourcePath,
      });
    }

    const payload: WorkspaceFileDragPayload = {
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      paths,
    };
    dragPayloadRef.current = payload;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, encodeWorkspaceFileDrag(payload));
    event.dataTransfer.setData('text/plain', paths.join('\n'));

    if (payload.workspaceId) {
      const desktopBridge = getCanvasDesktopFileDragBridge();
      if (desktopBridge) {
        const desktopRequest = { workspaceId: payload.workspaceId, paths: payload.paths };
        void desktopBridge.prepareFileDrag(desktopRequest).catch(() => undefined);
        desktopBridge.startFileDrag(desktopRequest);
      }
    }

    const preview = createDragPreview(t('selectedCount', { count: paths.length }));
    event.dataTransfer.setDragImage(preview, 16, 16);
    window.setTimeout(() => preview.remove(), 0);
    state.closeContextMenu();
    state.closeBackgroundContextMenu();
  }, [controller.isMoving, t]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const item = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-file-path]')
      : null;
    const sourcePath = item?.dataset.filePath;
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!sourcePath || !workspaceId) return;
    const preparedAt = preparedDesktopPathsRef.current.get(sourcePath);
    if (preparedAt !== undefined && Date.now() - preparedAt < DESKTOP_FILE_DRAG_PREPARE_TTL_MS) return;

    const desktopBridge = getCanvasDesktopFileDragBridge();
    if (!desktopBridge) return;
    preparedDesktopPathsRef.current.set(sourcePath, Date.now());
    void desktopBridge.prepareFileDrag({ workspaceId, paths: [sourcePath] }).catch(() => {
      preparedDesktopPathsRef.current.delete(sourcePath);
    });
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasWorkspaceFileDragType(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();

    const payload = dragPayloadRef.current
      ?? decodeWorkspaceFileDrag(event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE));
    const target = getDropTarget(event.target);
    const targetPath = target?.dataset.fileDropPath;
    if (
      !payload
      || !target
      || !targetPath
      || payload.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      || !validateWorkspaceFileDrop(payload.paths, targetPath).valid
    ) {
      event.dataTransfer.dropEffect = 'none';
      stopAutoExpand();
      updateDropTarget(null);
      return;
    }

    event.dataTransfer.dropEffect = 'move';
    if (dropTargetPathRef.current !== targetPath) {
      updateDropTarget(targetPath);
      scheduleTreeAutoExpand(target, targetPath);
    }
  }, [scheduleTreeAutoExpand, stopAutoExpand, updateDropTarget]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasWorkspaceFileDragType(event.dataTransfer.types)) return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    stopAutoExpand();
    updateDropTarget(null);
  }, [stopAutoExpand, updateDropTarget]);

  const handleDrop = useCallback(async (event: DragEvent<HTMLElement>) => {
    if (!hasWorkspaceFileDragType(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();

    const payload = dragPayloadRef.current
      ?? decodeWorkspaceFileDrag(event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE));
    const targetPath = getDropTarget(event.target)?.dataset.fileDropPath;
    stopAutoExpand();
    updateDropTarget(null);
    dragPayloadRef.current = null;

    if (
      !payload
      || !targetPath
      || payload.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      || !validateWorkspaceFileDrop(payload.paths, targetPath).valid
    ) return;

    await controller.startMove(payload.paths, targetPath);
  }, [controller, stopAutoExpand, updateDropTarget]);

  const handleDragEnd = useCallback(() => {
    clearDragState();
  }, [clearDragState]);

  useEffect(() => clearDragState, [clearDragState]);

  return {
    dropTargetPath,
    isWorkspaceFileDrag: (dataTransfer: DataTransfer) => (
      hasWorkspaceFileDragType(dataTransfer.types)
    ),
    handlers: {
      onDragStart: handleDragStart,
      onPointerMove: handlePointerMove,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onDragEnd: handleDragEnd,
    },
  };
}
