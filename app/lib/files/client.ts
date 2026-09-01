import type { ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { CurrentFile, FileCollaborationState, FileNode, FileRevisionRecord, FileStats } from './types';
import {
  type WorkspaceBatchUploadResult,
  type WorkspaceUploadFileProgress,
  uploadWorkspaceFilesInChunks,
} from './workspace-upload-client';

export { WorkspaceBatchUploadError } from './workspace-upload-client';
export type { WorkspaceBatchUploadResult, WorkspaceUploadFileProgress } from './workspace-upload-client';

interface ApiErrorPayload {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  path?: unknown;
  expectedSha256?: unknown;
  currentSha256?: unknown;
  currentRevisionId?: unknown;
  baseRevisionId?: unknown;
  currentStats?: unknown;
  activeLock?: unknown;
}

export class WorkspaceFileApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly path: string | null;
  readonly expectedSha256: string | null;
  readonly currentSha256: string | null;
  readonly currentRevisionId: string | null;
  readonly baseRevisionId: string | null;
  readonly currentStats: FileStats | null;
  readonly activeLock: unknown;

  constructor(message: string, response: Response, payload: ApiErrorPayload = {}) {
    super(message);
    this.name = 'WorkspaceFileApiError';
    this.status = response.status;
    this.code = typeof payload.code === 'string' ? payload.code : null;
    this.path = typeof payload.path === 'string' ? payload.path : null;
    this.expectedSha256 = typeof payload.expectedSha256 === 'string' ? payload.expectedSha256 : null;
    this.currentSha256 = typeof payload.currentSha256 === 'string' ? payload.currentSha256 : null;
    this.currentRevisionId = typeof payload.currentRevisionId === 'string' ? payload.currentRevisionId : null;
    this.baseRevisionId = typeof payload.baseRevisionId === 'string' ? payload.baseRevisionId : null;
    this.currentStats = isFileStats(payload.currentStats) ? payload.currentStats : null;
    this.activeLock = payload.activeLock ?? null;
  }
}

export interface DeleteWorkspacePathsResult {
  deleted?: string[];
  failed?: Array<{ path: string; error: string }>;
  trashEntries?: WorkspaceTrashEntryReference[];
}

export interface WorkspaceTrashEntryReference {
  id: string;
  originalPath: string;
  itemType: 'file' | 'directory' | 'other';
  sizeBytes: number;
  expiresAt: string;
}

export interface CopyWorkspacePathsResult {
  copied: string[];
  failed: Array<{ path: string; error: string }>;
  skipped: string[];
  sourceWorkspaceId?: string;
  targetWorkspaceId?: string;
}

export interface ExtractWorkspaceZipResult {
  targetDir: string;
  files: string[];
  directories: string[];
}

export interface WorkspacePathConflictError extends Error {
  code?: string;
  type?: string;
  sourcePath?: string;
  destPath?: string;
}

export interface WriteWorkspaceFileResult {
  path: string;
  stats?: FileStats;
  revision?: FileRevisionRecord | null;
  collaboration?: FileCollaborationState | null;
}

interface UploadWorkspaceFilesParams {
  files: File[];
  targetDir: string;
  pathMap?: Map<File, string>;
  convertParams?: (ConvertParams | null)[];
  onProgress?: (progress: number) => void;
  onFileProgress?: (progress: WorkspaceUploadFileProgress) => void;
}

interface LoadWorkspaceTreeOptions {
  includeStats?: boolean;
}

export interface WorkspaceFileReferenceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  isImage: boolean;
  size?: number;
  created?: number;
  modified?: number;
  publicShare?: FileNode['publicShare'];
}

export interface WorkspaceFileReferencePage {
  files: WorkspaceFileReferenceEntry[];
  total: number;
}

export interface ListWorkspaceFileReferencesOptions {
  query?: string;
  limit?: number;
  sort?: 'name' | 'created' | 'modified' | 'size';
  workspaceId: string;
  signal?: AbortSignal;
  cache?: RequestCache;
}

function formatResponseStatus(response: Response) {
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  return response.status ? ` (${response.status}${statusText})` : '';
}

function describeNonJsonResponse(response: Response, fallbackMessage: string, body: string) {
  const trimmed = body.trimStart().toLowerCase();
  const responseKind = trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')
    ? 'HTML'
    : 'a non-JSON response';
  return `${fallbackMessage}${formatResponseStatus(response)}: server returned ${responseKind} instead of JSON. Please retry when the server is responsive.`;
}

function isFileStats(value: unknown): value is FileStats {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'size' in value &&
    typeof value.size === 'number' &&
    'modified' in value &&
    typeof value.modified === 'number' &&
    'permissions' in value &&
    typeof value.permissions === 'string',
  );
}

function getActiveWorkspaceId(): string | null {
  return useWorkspaceStore.getState().activeWorkspaceId;
}

export function workspaceHeaders(workspaceId?: string | null): HeadersInit {
  const resolvedWorkspaceId = workspaceId ?? getActiveWorkspaceId();
  return resolvedWorkspaceId ? { [WORKSPACE_ID_HEADER]: resolvedWorkspaceId } : {};
}

export function withWorkspaceQuery(url: string, workspaceId?: string | null) {
  const resolvedWorkspaceId = workspaceId ?? getActiveWorkspaceId();
  if (!resolvedWorkspaceId) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}workspaceId=${encodeURIComponent(resolvedWorkspaceId)}`;
}

export function workspaceDownloadUrl(
  path: string,
  options: { download?: boolean; workspaceId?: string | null } = {}
) {
  const downloadFlag = options.download ? '&download=1' : '';
  return withWorkspaceQuery(
    `/api/files/download?path=${encodeURIComponent(path)}${downloadFlag}`,
    options.workspaceId,
  );
}

export async function readApiJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`${fallbackMessage}${formatResponseStatus(response)}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(describeNonJsonResponse(response, fallbackMessage, body));
  }
}

export async function readApiError(response: Response, fallbackMessage: string) {
  try {
    const payload = await readApiJson<ApiErrorPayload>(response, fallbackMessage);
    return apiErrorMessage(response, fallbackMessage, payload);
  } catch (error) {
    if (error instanceof Error) return error.message;
  }

  return `${fallbackMessage}${formatResponseStatus(response)}`;
}

export async function searchWorkspaceFileReferences({
  query = '',
  limit = 50,
  sort,
  workspaceId,
  signal,
  cache = 'no-store',
}: ListWorkspaceFileReferencesOptions): Promise<WorkspaceFileReferencePage> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new Error('Workspace context is not ready');
  }

  const params = new URLSearchParams({
    limit: String(limit),
    workspaceId: normalizedWorkspaceId,
  });
  if (sort) params.set('sort', sort);
  const normalizedQuery = query.trim();
  if (normalizedQuery) params.set('q', normalizedQuery);

  const response = await fetch(`/api/files/list?${params.toString()}`, {
    credentials: 'include',
    cache,
    headers: workspaceHeaders(normalizedWorkspaceId),
    signal,
  });
  if (!response.ok) {
    throw new WorkspaceFileApiError(
      await readApiError(response, 'Failed to search workspace files'),
      response,
    );
  }

  const payload = await readApiJson<{ success?: boolean; files?: WorkspaceFileReferenceEntry[]; total?: number; error?: string }>(
    response,
    'Failed to search workspace files',
  );
  if (!payload.success || !Array.isArray(payload.files)) {
    throw new Error(payload.error || 'Failed to search workspace files');
  }
  return {
    files: payload.files,
    total: typeof payload.total === 'number' ? payload.total : payload.files.length,
  };
}

export async function listWorkspaceFileReferences(
  options: ListWorkspaceFileReferencesOptions,
): Promise<WorkspaceFileReferenceEntry[]> {
  const page = await searchWorkspaceFileReferences(options);
  return page.files;
}

function apiErrorMessage(response: Response, fallbackMessage: string, payload: ApiErrorPayload) {
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }
  return `${fallbackMessage}${formatResponseStatus(response)}`;
}

async function readWorkspaceFileApiError(response: Response, fallbackMessage: string) {
  try {
    const payload = await readApiJson<ApiErrorPayload>(response, fallbackMessage);
    return new WorkspaceFileApiError(apiErrorMessage(response, fallbackMessage, payload), response, payload);
  } catch (error) {
    if (error instanceof Error) {
      return new WorkspaceFileApiError(error.message, response);
    }
    return new WorkspaceFileApiError(`${fallbackMessage}${formatResponseStatus(response)}`, response);
  }
}

export function isWorkspaceFileRevisionConflictError(error: unknown): error is WorkspaceFileApiError {
  return error instanceof WorkspaceFileApiError &&
    error.status === 409 &&
    (error.code === 'FILE_REVISION_CONFLICT' || error.code === 'FILE_REVISION_ID_CONFLICT');
}

export async function loadWorkspaceTree(
  path = '.',
  depth = 0,
  noCache = false,
  fallbackMessage = 'Failed to load file tree',
  workspaceId?: string | null,
  options: LoadWorkspaceTreeOptions = {}
): Promise<FileNode[]> {
  const includeStats = options.includeStats ?? true;
  const baseUrl = `/api/files/tree?path=${encodeURIComponent(path)}&depth=${depth}${includeStats ? '' : '&stats=0'}${noCache ? `&noCache=${Date.now()}` : ''}`;
  const url = withWorkspaceQuery(baseUrl, workspaceId);
  const response = await fetch(url, {
    credentials: 'include',
    cache: noCache ? 'no-store' : 'default',
    headers: workspaceHeaders(workspaceId),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, fallbackMessage));
  }

  const { data } = await readApiJson<{ data: FileNode[] }>(response, fallbackMessage);
  return data;
}

export async function readWorkspaceFile(
  path: string,
  options: { metaOnly?: boolean; noCache?: boolean; fallbackMessage?: string; workspaceId?: string | null } = {}
): Promise<CurrentFile> {
  const { metaOnly = false, noCache = false, fallbackMessage = 'Failed to load file', workspaceId } = options;
  let url = `/api/files/read?path=${encodeURIComponent(path)}${metaOnly ? '&meta=1' : ''}`;
  if (noCache) {
    url += `&t=${Date.now()}`;
  }

  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: workspaceHeaders(workspaceId),
  });

  if (!response.ok) {
    throw response;
  }

  const { data } = await readApiJson<{ data: CurrentFile }>(response, fallbackMessage);
  return data;
}

export async function writeWorkspaceFile(
  path: string,
  content: string,
  options: { expectedSha256?: string | null; baseRevisionId?: string | null; workspaceId?: string | null } = {}
): Promise<WriteWorkspaceFileResult> {
  const response = await fetch('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders(options.workspaceId) },
    credentials: 'include',
    body: JSON.stringify({
      path,
      content,
      expectedSha256: options.expectedSha256 ?? null,
      baseRevisionId: options.baseRevisionId ?? null,
    }),
  });

  if (!response.ok) {
    throw await readWorkspaceFileApiError(response, 'Failed to save file');
  }

  const { data } = await readApiJson<{ data: WriteWorkspaceFileResult }>(response, 'Failed to save file');
  return data;
}

export async function createWorkspacePath(
  path: string,
  type: 'file' | 'directory',
  options: { template?: 'excalidraw' } = {}
): Promise<void> {
  const response = await fetch('/api/files/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    credentials: 'include',
    body: JSON.stringify({ path, type, ...options }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to create path'));
  }
}

export async function deleteWorkspacePaths(paths: string[]): Promise<DeleteWorkspacePathsResult> {
  const response = await fetch('/api/files/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    credentials: 'include',
    body: JSON.stringify({ path: paths }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to delete paths'));
  }

  return readApiJson<DeleteWorkspacePathsResult>(response, 'Failed to delete paths');
}

export async function restoreWorkspaceTrashEntry(
  entryId: string,
  workspaceId?: string | null,
): Promise<WorkspaceTrashEntryReference> {
  const response = await fetch(`/api/files/trash/${encodeURIComponent(entryId)}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders(workspaceId) },
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to restore trashed item'));
  }

  const payload = await readApiJson<{ restored?: WorkspaceTrashEntryReference }>(
    response,
    'Failed to restore trashed item',
  );
  if (!payload.restored) throw new Error('Failed to restore trashed item');
  return payload.restored;
}

export interface WorkspaceRenameResult {
  linkUpdates?: {
    updatedFiles: string[];
    updatedLinks: number;
    warnings: string[];
  };
}

export async function renameWorkspacePath(
  oldPath: string,
  newPath: string,
  overwrite = false,
): Promise<WorkspaceRenameResult> {
  const response = await fetch('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    credentials: 'include',
    body: JSON.stringify({ oldPath, newPath, overwrite }),
  });

  if (!response.ok) {
    const error = await readApiJson<ApiErrorPayload & {
      code?: string;
      type?: string;
      sourcePath?: string;
      destPath?: string;
    }>(response, 'Failed to rename path');
    const message = typeof error.error === 'string' && error.error.trim()
      ? error.error
      : 'Failed to rename path';
    const err = new Error(message) as WorkspacePathConflictError;
    err.code = error.code;
    err.type = error.type;
    err.sourcePath = error.sourcePath;
    err.destPath = error.destPath;
    throw err;
  }

  return readApiJson<WorkspaceRenameResult>(response, 'Failed to read rename result');
}

export async function copyWorkspacePaths(params: {
  sources: string[];
  destDir: string;
  overwrite?: boolean;
  renameOnCollision?: boolean;
  sourceWorkspaceId?: string | null;
  targetWorkspaceId?: string | null;
}, fallbackMessage = 'Failed to copy files'): Promise<CopyWorkspacePathsResult> {
  const response = await fetch('/api/files/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders(params.sourceWorkspaceId) },
    credentials: 'include',
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, fallbackMessage));
  }

  return readApiJson<CopyWorkspacePathsResult>(response, fallbackMessage);
}

export async function extractWorkspaceZip(
  path: string,
  targetDir: string,
): Promise<ExtractWorkspaceZipResult> {
  const response = await fetch('/api/files/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    credentials: 'include',
    body: JSON.stringify({ path, targetDir }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to extract ZIP archive'));
  }

  const payload = await readApiJson<{
    success?: boolean;
    targetDir?: string;
    files?: string[];
    directories?: string[];
    error?: string;
  }>(response, 'Failed to extract ZIP archive');
  if (!payload.success || !payload.targetDir || !Array.isArray(payload.files) || !Array.isArray(payload.directories)) {
    throw new Error(payload.error || 'Failed to extract ZIP archive');
  }

  return {
    targetDir: payload.targetDir,
    files: payload.files,
    directories: payload.directories,
  };
}

export async function uploadWorkspaceFiles({
  files,
  targetDir,
  pathMap,
  convertParams,
  onProgress,
  onFileProgress,
}: UploadWorkspaceFilesParams): Promise<WorkspaceBatchUploadResult> {
  if (!convertParams?.some(Boolean)) {
    const workspaceId = getActiveWorkspaceId();
    return uploadWorkspaceFilesInChunks({
      files: files.map((file) => ({
        file,
        path: pathMap?.get(file) || (file as { webkitRelativePath?: string }).webkitRelativePath || file.name,
      })),
      targetDir,
      workspaceId,
      onProgress,
      onFileProgress,
    });
  }

  const totalUploadBytes = files.reduce((total, currentFile) => total + currentFile.size, 0);
  const formData = new FormData();
  formData.append('path', targetDir);

  for (const file of files) {
    const filePath = pathMap?.get(file) || (file as { webkitRelativePath?: string }).webkitRelativePath || file.name;
    formData.append('files', file, filePath);
  }

  if (convertParams && convertParams.length === files.length) {
    const paramsForAll: ({ format: string; quality: number; maxDimension?: number } | null)[] = convertParams.map((params) =>
      params ? { format: params.format, quality: params.quality, maxDimension: params.maxDimension } : null
    );
    formData.append('convertParams', JSON.stringify(paramsForAll));
  }

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const failFiles = (message: string) => {
      files.forEach((file, index) => onFileProgress?.({
        index,
        path: pathMap?.get(file) || (file as { webkitRelativePath?: string }).webkitRelativePath || file.name,
        size: file.size,
        uploadedBytes: 0,
        status: 'failed',
        attempt: 1,
        error: message,
      }));
      reject(new Error(message));
    };
    xhr.open('POST', '/api/files/upload', true);
    xhr.withCredentials = true;
    const workspaceId = getActiveWorkspaceId();
    if (workspaceId) {
      xhr.setRequestHeader(WORKSPACE_ID_HEADER, workspaceId);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
        files.forEach((file, index) => onFileProgress?.({
          index,
          path: pathMap?.get(file) || (file as { webkitRelativePath?: string }).webkitRelativePath || file.name,
          size: file.size,
          uploadedBytes: Math.min(file.size, event.loaded),
          status: 'uploading',
          attempt: 1,
        }));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        files.forEach((file, index) => onFileProgress?.({
          index,
          path: pathMap?.get(file) || (file as { webkitRelativePath?: string }).webkitRelativePath || file.name,
          size: file.size,
          uploadedBytes: file.size,
          status: 'completed',
          attempt: 1,
        }));
        resolve();
        return;
      }

      let message = `Upload failed with status ${xhr.status}`;
      try {
        const error = JSON.parse(xhr.responseText) as { error?: unknown; code?: unknown };
        if (error.code === 'FORMDATA_PARSE_ERROR') {
          console.warn('[FileClient] Upload FormData parse error', {
            endpoint: '/api/files/upload',
            status: xhr.status,
            fileCount: files.length,
            totalBytes: totalUploadBytes,
            hasPathMap: Boolean(pathMap),
            hasConvertParams: Boolean(convertParams?.length),
          });
        }
        if (typeof error.error === 'string') message = error.error;
      } catch {
        // The response may be an HTML error page emitted by a reverse proxy.
      }
      failFiles(message);
    };

    xhr.onerror = () => failFiles('Network error during upload');
    xhr.send(formData);
  });

  return {
    totalFiles: files.length,
    totalBytes: totalUploadBytes,
    completed: files.map((file) => ({
      path: pathMap?.get(file) || (file as { webkitRelativePath?: string }).webkitRelativePath || file.name,
      size: file.size,
    })),
    failed: [],
  };
}

export function triggerWorkspaceDownload(path: string): void {
  const url = workspaceDownloadUrl(path, { download: true });
  const anchor = document.createElement('a');
  const name = path.split('/').pop() || 'download';
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
