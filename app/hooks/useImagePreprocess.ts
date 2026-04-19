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
  onUpload: (files: File[], convertParams?: (ConvertParams | null)[], targetDir?: string) => Promise<void>;
}

export interface ImagePreprocessDialogState {
  files: PreprocessFileInfo[];
  targetDir?: string;
}

export interface UseImagePreprocessReturn {
  handleFiles: (files: File[], targetDir?: string) => Promise<void>;
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
  const [pendingTargetDir, setPendingTargetDir] = useState<string | undefined>(undefined);

  const handleFiles = useCallback(async (files: File[], targetDir?: string) => {
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
      await onUpload(normalFiles, undefined, targetDir);
    }

    if (preprocessFiles.length > 0) {
      setPendingFiles(preprocessFiles.map((f) => f.file));
      setPendingTargetDir(targetDir);
      setDialogState({ files: preprocessFiles, targetDir });
    }
  }, [onUpload]);

  const handleConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    setIsProcessing(true);
    try {
      await onUpload(pendingFiles, convertParams, pendingTargetDir);
    } finally {
      setIsProcessing(false);
      setDialogState(null);
      setPendingFiles([]);
      setPendingTargetDir(undefined);
    }
  }, [onUpload, pendingFiles, pendingTargetDir]);

  const handleSkip = useCallback(async () => {
    setIsProcessing(true);
    try {
      const nonHeicFiles = pendingFiles.filter((f) => !isHeicFile(f));
      if (nonHeicFiles.length > 0) {
        await onUpload(nonHeicFiles, undefined, pendingTargetDir);
      }
    } finally {
      setIsProcessing(false);
      setDialogState(null);
      setPendingFiles([]);
      setPendingTargetDir(undefined);
    }
  }, [onUpload, pendingFiles, pendingTargetDir]);

  return {
    handleFiles,
    dialogState,
    isProcessing,
    setDialogState,
    handleConfirm,
    handleSkip,
  };
}