'use client';

import { useState, useCallback, useRef } from 'react';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { beginUploadJob, finishUploadJob, updateUploadItem, updateUploadJob, useUploadStore, type UploadJobHandle, type UploadOptions } from '@/app/store/upload-store';
import type {
  ConvertParams,
  ImagePreprocessProgressItem,
  ImagePreprocessProgressStatus,
  PreprocessFileInfo,
} from '@/app/components/shared/ImagePreprocessDialog';
import { isHeicUploadFile, shouldPreprocessImageFile } from '@/app/lib/images/client-preprocess';
import { assertUploadSelectionWithinLimits } from '@/app/lib/files/upload-limits';

export interface UseImagePreprocessOptions {
  onUpload: (
    files: File[],
    convertParams?: (ConvertParams | null)[],
    targetDir?: string,
    pathMap?: Map<File, string>,
    options?: UploadOptions,
  ) => Promise<void>;
  onBatchComplete?: (targetDir?: string, job?: UploadJobHandle) => Promise<void>;
}

export interface ImagePreprocessDialogState {
  files: PreprocessFileInfo[];
  targetDir?: string;
}

export interface UseImagePreprocessReturn {
  handleFiles: (files: File[], targetDir?: string, pathMap?: Map<File, string>, job?: UploadJobHandle) => Promise<void>;
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

export function useImagePreprocess({ onUpload, onBatchComplete }: UseImagePreprocessOptions): UseImagePreprocessReturn {
  const pendingJob = useRef<UploadJobHandle | null>(null);
  const running = useRef(false);
  const [dialogState, setDialogState] = useState<ImagePreprocessDialogState | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressItems, setProgressItems] = useState<ImagePreprocessProgressItem[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingPreprocessFiles, setPendingPreprocessFiles] = useState<File[]>([]);
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
    if (running.current) return;
    if (pendingJob.current) updateUploadJob(pendingJob.current, { phase: 'cancelled' });
    pendingJob.current = null;
    setDialogState(null);
    setProgressItems([]);
    setPendingFiles([]);
    setPendingPreprocessFiles([]);
    setPendingPathMap(undefined);
  }, []);

  const handleFiles = useCallback(async (files: File[], targetDir?: string, pathMap?: Map<File, string>, providedJob?: UploadJobHandle) => {
    if (running.current || pendingJob.current) throw new Error('Finish the current image upload before starting another.');
    assertUploadSelectionWithinLimits(files);
    const job = providedJob ?? beginUploadJob(files, targetDir || '.', useWorkspaceStore.getState().activeWorkspaceId, pathMap);
    pendingJob.current = job;
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
      setPendingPathMap(filterPathMap(files, pathMap));
      setDialogState({ files: preprocessFiles, targetDir });
    } else if (normalFiles.length > 0) {
      running.current = true;
      let failure: unknown;
      try {
        await onUpload(normalFiles, undefined, job.targetDir, filterPathMap(normalFiles, pathMap), { job, refreshTree: false });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          updateUploadJob(job, { phase: 'reconciling' });
          await onBatchComplete?.(job.targetDir, job);
        } catch (error) {
          failure ??= error;
          throw error;
        } finally {
          finishUploadJob(job, failure);
          pendingJob.current = null;
          running.current = false;
        }
      }
    } else {
      finishUploadJob(job);
      pendingJob.current = null;
    }
  }, [onBatchComplete, onUpload]);

  const runPendingUploads = useCallback(async (
    resolveConvertParam: (file: File, index: number) => ConvertParams | null,
    skipHeic: boolean,
  ) => {
    const job = pendingJob.current;
    if (!job || running.current) return;
    running.current = true;
    let failure: unknown;
    try {
      for (let index = 0; index < pendingFiles.length; index += 1) {
        const file = pendingFiles[index];
        if (skipHeic && isHeicUploadFile(file)) {
          updateProgressItem(index, 'skipped');
          const item = useUploadStore.getState().jobs[job.id]?.items[index];
          if (item) updateUploadItem(job, { ...item, status: 'skipped' });
          continue;
        }

        const convertParam = resolveConvertParam(file, index);
        updateProgressItem(index, convertParam ? 'processing' : 'uploading');

        try {
          await onUpload(
            [file],
            convertParam ? [convertParam] : undefined,
            job.targetDir,
            filterPathMap([file], pendingPathMap),
            { refreshTree: false, job, fileIndices: [index] },
          );
          const item = useUploadStore.getState().jobs[job.id]?.items[index];
          if (item) updateUploadItem(job, { ...item, status: 'completed', uploadedBytes: file.size });
          updateProgressItem(index, 'success');
        } catch (error) {
          failure = error;
          const item = useUploadStore.getState().jobs[job.id]?.items[index];
          if (item) updateUploadItem(job, { ...item, status: 'failed', error: getErrorMessage(error) });
          updateProgressItem(index, 'error', getErrorMessage(error));
        }
      }

    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        updateUploadJob(job, { phase: 'reconciling' });
        await onBatchComplete?.(job.targetDir, job);
      } catch (error) {
        failure ??= error;
        throw error;
      } finally {
        finishUploadJob(job, failure);
        pendingJob.current = null;
        running.current = false;
      }
    }
  }, [onBatchComplete, onUpload, pendingFiles, pendingPathMap, updateProgressItem]);

  const handleConfirm = useCallback(async (convertParams: (ConvertParams | null)[]) => {
    setIsProcessing(true);
    setProgressItems(createProgressItems(pendingFiles));
    try {
      const convertParamsByFile = new Map<File, ConvertParams | null>();
      pendingPreprocessFiles.forEach((file, index) => {
        convertParamsByFile.set(file, convertParams[index] ?? null);
      });

      await runPendingUploads((file) => convertParamsByFile.get(file) ?? null, false);
    } finally {
      setIsProcessing(false);
    }
  }, [pendingFiles, pendingPreprocessFiles, runPendingUploads]);

  const handleSkip = useCallback(async () => {
    setIsProcessing(true);
    setProgressItems(createProgressItems(pendingFiles));
    try {
      await runPendingUploads(() => null, true);
    } finally {
      setIsProcessing(false);
    }
  }, [pendingFiles, runPendingUploads]);

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
