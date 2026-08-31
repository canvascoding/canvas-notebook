'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import {
  WORKSPACE_FILE_DRAG_TYPE,
  decodeWorkspaceFileDrag,
  hasWorkspaceFileDragType,
} from '@/app/lib/files/file-drag';

type UseChatFileDropParams = {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  onWorkspaceFiles?: (paths: string[]) => void;
  workspaceId?: string | null;
};

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types || []).includes('Files') || dataTransfer.files.length > 0;
}

export function useChatFileDrop({
  disabled = false,
  onFiles,
  onWorkspaceFiles,
  workspaceId = null,
}: UseChatFileDropParams) {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isDraggingWorkspaceFiles, setIsDraggingWorkspaceFiles] = useState(false);
  const dragDepthRef = useRef(0);

  const clearDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    setIsDraggingWorkspaceFiles(false);
  }, []);

  const acceptsWorkspaceFiles = useCallback((dataTransfer: DataTransfer) => (
    Boolean(onWorkspaceFiles && workspaceId && hasWorkspaceFileDragType(dataTransfer.types))
  ), [onWorkspaceFiles, workspaceId]);

  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    const isWorkspaceFileDrag = acceptsWorkspaceFiles(event.dataTransfer);
    const isFileDrag = hasDraggedFiles(event.dataTransfer);
    if (!isWorkspaceFileDrag && !isFileDrag) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;

    dragDepthRef.current += 1;
    setIsDraggingFiles(isFileDrag);
    setIsDraggingWorkspaceFiles(isWorkspaceFileDrag);
  }, [acceptsWorkspaceFiles, disabled]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!acceptsWorkspaceFiles(event.dataTransfer) && !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
      setIsDraggingWorkspaceFiles(false);
    }
  }, [acceptsWorkspaceFiles, disabled]);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!acceptsWorkspaceFiles(event.dataTransfer) && !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }, [acceptsWorkspaceFiles, disabled]);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>) => {
    const isWorkspaceFileDrag = acceptsWorkspaceFiles(event.dataTransfer);
    const isFileDrag = hasDraggedFiles(event.dataTransfer);
    if (!isWorkspaceFileDrag && !isFileDrag) return;
    event.preventDefault();
    event.stopPropagation();

    const workspaceDrag = isWorkspaceFileDrag
      ? decodeWorkspaceFileDrag(event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE))
      : null;
    const files = Array.from(event.dataTransfer.files || []);
    clearDragState();
    if (disabled) return;

    if (workspaceDrag && workspaceDrag.workspaceId === workspaceId) {
      onWorkspaceFiles?.(workspaceDrag.paths);
      return;
    }

    if (files.length === 0) return;

    onFiles(files);
  }, [acceptsWorkspaceFiles, clearDragState, disabled, onFiles, onWorkspaceFiles, workspaceId]);

  return {
    isDraggingFiles,
    isDraggingWorkspaceFiles,
    dropHandlers: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  };
}
