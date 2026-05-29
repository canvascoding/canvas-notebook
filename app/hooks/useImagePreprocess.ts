'use client';

import { useState, useCallback } from 'react';
import type { PreprocessFileInfo, ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';
import { isHeicUploadFile, shouldPreprocessImageFile } from '@/app/lib/images/client-preprocess';

export interface UseImagePreprocessOptions {
  onUpload: (
    files: File[],
    convertParams?: (ConvertParams | null)[],
    targetDir?: string,
    pathMap?: Map<File, string>,
  ) => Promise<void>;
}

export interface ImagePreprocessDialogState {
  files: PreprocessFileInfo[];
  targetDir?: string;
}

export interface UseImagePreprocessReturn {
  handleFiles: (files: File[], targetDir?: string, pathMap?: Map<File, string>) => Promise<void>;
  dialogState: ImagePreprocessDialogState | null;
  isProcessing: boolean;
  setDialogState: (state: ImagePreprocessDialogState | null) => void;
  handleConfirm: (convertParams: (ConvertParams | null)[]) => Promise<void>;
  handleSkip: () => Promise<void>;
}

function filterPathMap(files: File[], pathMap?: Map<File, string>): Map<File, string> | undefined {
  if (!pathMap) return undefined;

  const filtered = new Map<File, string>();
  for (const file of files) {
    const relativePath = pathMap.get(file);
    if (relativePath) {
      filtered.set(file, relativePath);
    }
  }

  return filtered.size > 0 ? filtered : undefined;
}

export function useImagePreprocess({ onUpload }: UseImagePreprocessOptions): UseImagePreprocessReturn {
  const [dialogState, setDialogState] = useState<ImagePreprocessDialogState | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingPreprocessFiles, setPendingPreprocessFiles] = useState<File[]>([]);
  const [pendingTargetDir, setPendingTargetDir] = useState<string | undefined>(undefined);
  const [pendingPathMap, setPendingPathMap] = useState<Map<File, string> | undefined>(undefined);

  const handleFiles = useCallback(async (files: File[], targetDir?: string, pathMap?: Map<File, string>) => {
    const preprocessFiles: PreprocessFileInfo[] = [];
    const normalFiles: File[] = [];

    for (const file of files) {
      const preprocessInfo = shouldPreprocessImageFile(file);

      if (preprocessInfo) {
        preprocessFiles.push({ file, ...preprocessInfo });
      } else {
        normalFiles.push(file);
      }
    }

    if (preprocessFiles.length > 0) {
      setPendingFiles(files);
      setPendingPreprocessFiles(preprocessFiles.map((f) => f.file));
      setPendingTargetDir(targetDir);
      setPendingPathMap(filterPathMap(files, pathMap));
      setDialogState({ files: preprocessFiles, targetDir });
    } else if (normalFiles.length > 0) {
      await onUpload(normalFiles, undefined, targetDir, filterPathMap(normalFiles, pathMap));
    }
  }, [onUpload]);

  const handleConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    setIsProcessing(true);
    try {
      const convertParamsByFile = new Map<File, ConvertParams | null>();
      pendingPreprocessFiles.forEach((file, index) => {
        convertParamsByFile.set(file, convertParams[index] ?? null);
      });
      const uploadConvertParams = pendingFiles.map((file) => convertParamsByFile.get(file) ?? null);
      await onUpload(pendingFiles, uploadConvertParams, pendingTargetDir, pendingPathMap);
    } finally {
      setIsProcessing(false);
      setDialogState(null);
      setPendingFiles([]);
      setPendingPreprocessFiles([]);
      setPendingTargetDir(undefined);
      setPendingPathMap(undefined);
    }
  }, [onUpload, pendingFiles, pendingPreprocessFiles, pendingTargetDir, pendingPathMap]);

  const handleSkip = useCallback(async () => {
    setIsProcessing(true);
    try {
      const nonHeicFiles = pendingFiles.filter((f) => !isHeicUploadFile(f));
      if (nonHeicFiles.length > 0) {
        await onUpload(nonHeicFiles, undefined, pendingTargetDir, filterPathMap(nonHeicFiles, pendingPathMap));
      }
    } finally {
      setIsProcessing(false);
      setDialogState(null);
      setPendingFiles([]);
      setPendingPreprocessFiles([]);
      setPendingTargetDir(undefined);
      setPendingPathMap(undefined);
    }
  }, [onUpload, pendingFiles, pendingTargetDir, pendingPathMap]);

  return {
    handleFiles,
    dialogState,
    isProcessing,
    setDialogState,
    handleConfirm,
    handleSkip,
  };
}
