'use client';

import { useState, useCallback } from 'react';
import type {
  ConvertParams,
  ImagePreprocessProgressItem,
  ImagePreprocessProgressStatus,
  PreprocessFileInfo,
} from '@/app/components/shared/ImagePreprocessDialog';
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
  progressItems: ImagePreprocessProgressItem[];
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

function createProgressItems(files: File[]): ImagePreprocessProgressItem[] {
  return files.map((file) => ({
    fileName: file.name,
    size: file.size,
    status: 'queued',
  }));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Upload failed';
}

export function useImagePreprocess({ onUpload }: UseImagePreprocessOptions): UseImagePreprocessReturn {
  const [dialogState, setDialogState] = useState<ImagePreprocessDialogState | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressItems, setProgressItems] = useState<ImagePreprocessProgressItem[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingPreprocessFiles, setPendingPreprocessFiles] = useState<File[]>([]);
  const [pendingTargetDir, setPendingTargetDir] = useState<string | undefined>(undefined);
  const [pendingPathMap, setPendingPathMap] = useState<Map<File, string> | undefined>(undefined);

  const updateProgressItem = useCallback((
    index: number,
    status: ImagePreprocessProgressStatus,
    detail?: string,
  ) => {
    setProgressItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, status, detail } : item
    )));
  }, []);

  const clearPreprocessState = useCallback(() => {
    setDialogState(null);
    setProgressItems([]);
    setPendingFiles([]);
    setPendingPreprocessFiles([]);
    setPendingTargetDir(undefined);
    setPendingPathMap(undefined);
  }, []);

  const handleFiles = useCallback(async (files: File[], targetDir?: string, pathMap?: Map<File, string>) => {
    setProgressItems([]);
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
    setProgressItems(createProgressItems(pendingFiles));
    try {
      const convertParamsByFile = new Map<File, ConvertParams | null>();
      pendingPreprocessFiles.forEach((file, index) => {
        convertParamsByFile.set(file, convertParams[index] ?? null);
      });

      for (let index = 0; index < pendingFiles.length; index += 1) {
        const file = pendingFiles[index];
        const convertParam = convertParamsByFile.get(file) ?? null;
        updateProgressItem(index, convertParam ? 'processing' : 'uploading');

        try {
          await onUpload(
            [file],
            [convertParam],
            pendingTargetDir,
            filterPathMap([file], pendingPathMap),
          );
          updateProgressItem(index, 'success');
        } catch (error) {
          updateProgressItem(index, 'error', getErrorMessage(error));
        }
      }
    } finally {
      setIsProcessing(false);
    }
  }, [onUpload, pendingFiles, pendingPreprocessFiles, pendingTargetDir, pendingPathMap, updateProgressItem]);

  const handleSkip = useCallback(async () => {
    setIsProcessing(true);
    setProgressItems(createProgressItems(pendingFiles));
    try {
      for (let index = 0; index < pendingFiles.length; index += 1) {
        const file = pendingFiles[index];
        if (isHeicUploadFile(file)) {
          updateProgressItem(index, 'skipped');
          continue;
        }

        updateProgressItem(index, 'uploading');
        try {
          await onUpload([file], undefined, pendingTargetDir, filterPathMap([file], pendingPathMap));
          updateProgressItem(index, 'success');
        } catch (error) {
          updateProgressItem(index, 'error', getErrorMessage(error));
        }
      }
    } finally {
      setIsProcessing(false);
    }
  }, [onUpload, pendingFiles, pendingTargetDir, pendingPathMap, updateProgressItem]);

  return {
    handleFiles,
    dialogState,
    isProcessing,
    progressItems,
    setDialogState: (state) => {
      if (state === null) {
        clearPreprocessState();
        return;
      }
      setDialogState(state);
    },
    handleConfirm,
    handleSkip,
  };
}
