'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';

type UseChatFileDropParams = {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
};

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types || []).includes('Files') || dataTransfer.files.length > 0;
}

export function useChatFileDrop({ disabled = false, onFiles }: UseChatFileDropParams) {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepthRef = useRef(0);

  const clearDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
  }, []);

  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;

    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }, [disabled]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  }, [disabled]);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }, [disabled]);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();

    const files = Array.from(event.dataTransfer.files || []);
    clearDragState();
    if (disabled || files.length === 0) return;

    onFiles(files);
  }, [clearDragState, disabled, onFiles]);

  return {
    isDraggingFiles,
    dropHandlers: {
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
    },
  };
}
