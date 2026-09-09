'use client';

import { create } from 'zustand';
import type { WorkspaceUploadFileProgress } from '@/app/lib/files/workspace-upload-client';

export type UploadPhase = 'collecting' | 'preparing' | 'uploading' | 'reconciling' | 'completed' | 'partial' | 'failed' | 'cancelled';
export interface UploadJobHandle { id: string; workspaceId: string | null; targetDir: string }
export interface UploadItem extends Omit<WorkspaceUploadFileProgress, 'status'> {
  status: WorkspaceUploadFileProgress['status'] | 'processing' | 'skipped';
  kind?: 'directory';
}
export interface UploadJob extends UploadJobHandle {
  phase: UploadPhase;
  items: UploadItem[];
  error?: string;
  collection?: { files: number; directories: number; bytes: number };
}
export interface UploadOptions {
  refreshTree?: boolean;
  workspaceId?: string | null;
  job?: UploadJobHandle;
  fileIndices?: number[];
}

export const useUploadStore = create<{ jobs: Record<string, UploadJob> }>(() => ({ jobs: {} }));
export const isUploadActive = (job: UploadJob) => ['collecting', 'preparing', 'uploading', 'reconciling'].includes(job.phase);

export function beginUploadJob(
  files: File[], targetDir: string, workspaceId: string | null, pathMap?: Map<File, string>,
  phase: UploadPhase = 'preparing',
): UploadJobHandle {
  const job: UploadJob = {
    id: crypto.randomUUID(), workspaceId, targetDir, phase,
    items: files.map((file, index) => ({ index, path: pathMap?.get(file) || file.webkitRelativePath || file.name,
      size: file.size, uploadedBytes: 0, status: 'pending', attempt: 0 })),
  };
  useUploadStore.setState(({ jobs }) => ({ jobs: Object.fromEntries([
    ...Object.entries(jobs).filter(([, entry]) => isUploadActive(entry) || entry.workspaceId !== workspaceId),
    [job.id, job],
  ]) }));
  return { id: job.id, workspaceId, targetDir };
}

export function updateUploadJob(handle: UploadJobHandle, update: Partial<Pick<UploadJob, 'phase' | 'items' | 'error' | 'collection'>>) {
  useUploadStore.setState(({ jobs }) => {
    const job = jobs[handle.id];
    if (!job || job.workspaceId !== handle.workspaceId || !isUploadActive(job)) return { jobs };
    return { jobs: { ...jobs, [handle.id]: { ...job, ...update } } };
  });
}

export function updateUploadItem(handle: UploadJobHandle, item: UploadItem) {
  const job = useUploadStore.getState().jobs[handle.id];
  if (!job || !isUploadActive(job)) return;
  const current = job.items[item.index];
  if (!current || current.status === 'completed' || current.status === 'skipped') return;
  updateUploadJob(handle, { items: job.items.map((entry) => entry.index === item.index ? item : entry) });
}

export function setUploadJobFiles(handle: UploadJobHandle, files: File[], pathMap?: Map<File, string>, emptyDirectories: string[] = []) {
  updateUploadJob(handle, { phase: 'preparing', items: [...files.map((file, index): UploadItem => ({
    index, path: pathMap?.get(file) || file.webkitRelativePath || file.name,
    size: file.size, uploadedBytes: 0, status: 'pending', attempt: 0,
  })), ...emptyDirectories.map((path, index): UploadItem => ({ index: files.length + index, path, kind: 'directory',
    size: 0, uploadedBytes: 0, status: 'pending', attempt: 0 }))] });
}

const uploadCollections = new Map<string, AbortController>();
export function beginUploadCollection(job: UploadJobHandle): AbortController {
  const controller = new AbortController();
  uploadCollections.set(job.id, controller);
  return controller;
}
export function endUploadCollection(job: UploadJobHandle): void { uploadCollections.delete(job.id); }
export function cancelUploadCollection(job: UploadJobHandle): void {
  uploadCollections.get(job.id)?.abort();
  uploadCollections.delete(job.id);
  updateUploadJob(job, { phase: 'cancelled' });
}

export function finishUploadJob(handle: UploadJobHandle, error?: unknown) {
  const job = useUploadStore.getState().jobs[handle.id];
  if (!job || !isUploadActive(job)) return;
  const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
  const items = job.items.map((item) => ['completed', 'failed', 'skipped'].includes(item.status) ? item
    : { ...item, status: 'failed' as const, error: message || 'Upload did not complete.' });
  const hasFailure = Boolean(message) || items.some((item) => item.status === 'failed');
  updateUploadJob(handle, { items, error: message, phase: hasFailure
    ? items.some((item) => item.status === 'completed') ? 'partial' : 'failed'
    : 'completed' });
}

export function createUploadProgressReporter(handle: UploadJobHandle, indices?: number[]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, UploadItem>();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const item of pending.values()) updateUploadItem(handle, item);
    pending.clear();
  };
  return {
    report(progress: WorkspaceUploadFileProgress) {
      const item = { ...progress, index: indices?.[progress.index] ?? progress.index };
      pending.set(item.index, item);
      if (item.status !== 'uploading') flush();
      else timer ??= setTimeout(flush, 100);
    },
    flush,
  };
}

export function uploadJobPercent(job: UploadJob) {
  if (job.phase === 'completed') return 100;
  const bytes = job.items.reduce((total, item) => total + item.size, 0);
  const uploaded = job.items.reduce((total, item) => total + (item.status === 'skipped' ? item.size : item.uploadedBytes), 0);
  const finished = job.items.filter((item) => ['completed', 'skipped'].includes(item.status)).length;
  return Math.min(99, Math.round(bytes > 0 ? uploaded / bytes * 100 : finished / Math.max(1, job.items.length) * 100));
}
