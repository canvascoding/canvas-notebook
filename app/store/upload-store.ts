'use client';

import { create } from 'zustand';
import type { WorkspaceMarkdownUploadResume, WorkspaceUploadFileProgress } from '@/app/lib/files/workspace-upload-client';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation,
  type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

export type UploadPhase = 'collecting' | 'preparing' | 'uploading' | 'reconciling' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'awaiting_completion';
export interface UploadJobHandle { id: string; workspaceId: string | null; targetDir: string }
export interface UploadItem extends Omit<WorkspaceUploadFileProgress, 'status'> {
  status: WorkspaceUploadFileProgress['status'] | 'processing' | 'skipped';
  kind?: 'directory';
  resuming?: boolean;
}
export interface UploadJob extends UploadJobHandle {
  phase: UploadPhase;
  items: UploadItem[];
  error?: string;
  collection?: { files: number; directories: number; bytes: number };
  accountId?: string;
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
  const scope = openedDocumentAuthScope();
  if (scope) hydrateMarkdownUploadResumes(scope);
  const job: UploadJob = {
    id: crypto.randomUUID(), workspaceId, targetDir, phase,
    ...(scope ? { accountId: scope.userId } : {}),
    items: files.map((file, index) => ({ index, path: pathMap?.get(file) || file.webkitRelativePath || file.name,
      size: file.size, uploadedBytes: 0, status: 'pending', attempt: 0 })),
  };
  useUploadStore.setState(({ jobs }) => ({ jobs: Object.fromEntries([
    ...Object.entries(jobs).filter(([, entry]) => isUploadActive(entry) || entry.items.some(item => item.resume) || entry.workspaceId !== workspaceId),
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
  if (job.items.some(item => item.resume)) {
    updateUploadJob(handle, { phase: 'awaiting_completion', error: undefined });
    return;
  }
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

const resumeStoragePrefix = 'canvas-markdown-upload-resumes:v1:';
const maxSavedResumes = 16;
let hydratedScope: OpenedDocumentAuthScope | null = null;
let savedAccountId: string | null = null;
const resumeStorageKey = (accountId: string) => resumeStoragePrefix + encodeURIComponent(accountId);

/** Storage is untrusted lookup data, never auth, request identity or native evidence. */
function validResume(value: unknown): value is WorkspaceMarkdownUploadResume {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as WorkspaceMarkdownUploadResume;
  return Object.keys(item).sort().join(',') === 'fileId,status,targetPath,uploadId,workspaceId'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.uploadId)
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.fileId)
    && typeof item.workspaceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.workspaceId)
    && typeof item.targetPath === 'string' && item.targetPath.length <= 4096
    && !/[\\\u0000-\u001f\u007f]/u.test(item.targetPath)
    && !item.targetPath.split('/').some(segment => !segment || segment === '.' || segment === '..')
    && /\.(?:md|markdown)$/iu.test(item.targetPath)
    && ['projection_pending', 'recovery_required', 'unavailable', 'unconfirmed'].includes(item.status);
}

function persistMarkdownUploadResumes() {
  const scope = openedDocumentAuthScope();
  if (typeof window === 'undefined' || !scope || scope !== hydratedScope) return;
  const locators = new Map<string, WorkspaceMarkdownUploadResume>();
  for (const job of Object.values(useUploadStore.getState().jobs)) {
    if (job.accountId !== scope.userId) continue;
    for (const item of job.items) if (validResume(item.resume)) {
      locators.set(`${item.resume.uploadId}:${item.resume.fileId}`, item.resume);
    }
  }
  try {
    savedAccountId = scope.userId;
    const key = resumeStorageKey(scope.userId), serialized = JSON.stringify({
      version: 1, accountId: scope.userId, locators: [...locators.values()].slice(-maxSavedResumes),
    });
    if (window.localStorage.getItem(key) !== serialized) window.localStorage.setItem(key, serialized);
  } catch { /* Storage unavailable: the current page still retains its locators. */ }
}

/** Called only after existing auth hydration. This function never makes a request. */
export function hydrateMarkdownUploadResumes(scope: OpenedDocumentAuthScope): void {
  if (typeof window === 'undefined' || openedDocumentAuthScope() !== scope || hydratedScope === scope) return;
  hydratedScope = scope; savedAccountId = scope.userId;
  try {
    const raw = window.localStorage.getItem(resumeStorageKey(scope.userId));
    if (!raw || raw.length > 128 * 1024) return;
    const saved = JSON.parse(raw);
    if (!saved || Object.keys(saved).sort().join(',') !== 'accountId,locators,version' || saved.version !== 1
      || saved.accountId !== scope.userId || !Array.isArray(saved.locators) || saved.locators.length > maxSavedResumes
      || !saved.locators.every(validResume) || openedDocumentAuthScope() !== scope) return;
    useUploadStore.setState(({ jobs }) => {
      const next = { ...jobs };
      const existing = new Set(Object.values(jobs).flatMap(job => job.items.flatMap(item => item.resume
        ? [`${item.resume.uploadId}:${item.resume.fileId}`] : [])));
      for (const resume of saved.locators as WorkspaceMarkdownUploadResume[]) {
        const key = `${resume.uploadId}:${resume.fileId}`;
        if (existing.has(key)) continue;
        existing.add(key);
        const slash = resume.targetPath.lastIndexOf('/');
        const job: UploadJob = { id: `markdown-resume:${key}`, workspaceId: resume.workspaceId,
          targetDir: slash >= 0 ? resume.targetPath.slice(0, slash) : '.', accountId: scope.userId,
          phase: 'awaiting_completion', items: [{ index: 0, path: resume.targetPath, size: 0,
            uploadedBytes: 0, status: 'awaiting_completion', attempt: 0, resume: { ...resume } }] };
        next[job.id] = job;
      }
      return { jobs: next };
    });
  } catch { /* Malformed or unavailable storage cannot start or authorize an import. */ }
}

/** Updates only an existing current-account locator; coordinates cannot be replaced. */
export function updateMarkdownUploadResume(jobId: string, index: number, update: {
  resuming?: boolean; status?: WorkspaceMarkdownUploadResume['status']; error?: string; completed?: boolean;
}): void {
  const scope = openedDocumentAuthScope();
  if (!scope) return;
  useUploadStore.setState(({ jobs }) => {
    const job = jobs[jobId], original = job?.items[index];
    if (job?.accountId !== scope.userId || !original?.resume) return { jobs };
    const { resume, error: _error, resuming: _resuming, ...rest } = original;
    const item: UploadItem = update.completed ? { ...rest, status: 'completed', uploadedBytes: rest.size }
      : { ...rest, resume: { ...resume, status: update.status ?? resume.status }, status: 'awaiting_completion',
          resuming: update.resuming ?? false, ...(update.error ? { error: update.error } : {}) };
    const items = job.items.map(entry => entry.index === index ? item : entry);
    return { jobs: { ...jobs, [jobId]: { ...job, items, error: undefined,
      phase: items.some(entry => entry.resume) ? 'awaiting_completion'
        : items.every(entry => entry.status === 'completed') ? 'completed' : 'partial' } } };
  });
}

useUploadStore.subscribe(persistMarkdownUploadResumes);
subscribeOpenedDocumentAuthInvalidation(() => {
  const accountId = savedAccountId;
  hydratedScope = null; savedAccountId = null;
  if (!accountId) return;
  try {
    const key = resumeStorageKey(accountId), raw = typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    if (raw && JSON.parse(raw)?.accountId === accountId) window.localStorage.removeItem(key);
  } catch { /* Never touch another account's storage. */ }
  useUploadStore.setState(({ jobs }) => ({ jobs: Object.fromEntries(Object.entries(jobs)
    .filter(([, job]) => job.accountId !== accountId)) }));
});
