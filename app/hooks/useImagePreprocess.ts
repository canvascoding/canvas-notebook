'use client';

import { useState, useCallback } from 'react';
import type { PreprocessFileInfo, ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
]);

const SIZE_THRESHOLD = 1_500_000;

const HEIC_EXTENSIONS = new Set(['heic', 'heif']);

function isHeicFile(file: File): boolean {
  if (HEIC_MIME_TYPES.has(file.type.toLowerCase())) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return HEIC_EXTENSIONS.has(ext);
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif'].includes(ext);
}

export interface UseImagePreprocessOptions {
  onUpload: (files: File[], convertParams?: (ConvertParams | null)[]) => Promise<void>;
}

export interface ImagePreprocessDialogState {
  files: PreprocessFileInfo[];
}

export interface UseImagePreprocessReturn {
  handleFiles: (files: File[]) => Promise<void>;
  dialogState: ImagePreprocessDialogState | null;
  isProcessing: boolean;
  setDialogState: (state: ImagePreprocessDialogState | null) => void;
  handleConfirm: (convertParams: (ConvertParams | null)[]) => Promise<void>;
  handleSkip: () => Promise<void>;
}

export function useImagePreprocess({ onUpload }: UseImagePreprocessOptions): UseImagePreprocessReturn {
  const [dialogState, setDialogState] = useState<ImagePreprocessDialogState | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const handleFiles = useCallback(async (files: File[]) => {
    const preprocessFiles: PreprocessFileInfo[] = [];
    const normalFiles: File[] = [];

    for (const file of files) {
      const isHeic = isHeicFile(file);
      const isLarge = isImageFile(file) && file.size > SIZE_THRESHOLD;

      if (isHeic || isLarge) {
        preprocessFiles.push({ file, isHeic, isLarge });
      } else {
        normalFiles.push(file);
      }
    }

    if (normalFiles.length > 0) {
      await onUpload(normalFiles);
    }

    if (preprocessFiles.length > 0) {
      setPendingFiles(preprocessFiles.map((f) => f.file));
      setDialogState({ files: preprocessFiles });
    }
  }, [onUpload]);

  const handleConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    setIsProcessing(true);
    try {
      await onUpload(pendingFiles, convertParams);
    } finally {
      setIsProcessing(false);
      setDialogState(null);
      setPendingFiles([]);
    }
  }, [onUpload, pendingFiles]);

  const handleSkip = useCallback(async () => {
    setIsProcessing(true);
    try {
      const nonHeicFiles = pendingFiles.filter((f) => !isHeicFile(f));
      if (nonHeicFiles.length > 0) {
        const nonHeicIndices: number[] = [];
        pendingFiles.forEach((f, i) => {
          if (!isHeicFile(f)) nonHeicIndices.push(i);
        });
        await onUpload(nonHeicFiles);
      }
    } finally {
      setIsProcessing(false);
      setDialogState(null);
      setPendingFiles([]);
    }
  }, [onUpload, pendingFiles]);

  return {
    handleFiles,
    dialogState,
    isProcessing,
    setDialogState,
    handleConfirm,
    handleSkip,
  };
}