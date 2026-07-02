import type { ConvertParams } from '@/app/components/shared/ImagePreprocessDialog';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { CurrentFile, FileCollaborationState, FileNode, FileRevisionRecord, FileStats } from './types';

interface ApiErrorPayload {
  error?: unknown;
  message?: unknown;
}

export interface DeleteWorkspacePathsResult {
  deleted?: string[];
  failed?: Array<{ path: string; error: string }>;
}

export interface CopyWorkspacePathsResult {
  copied: string[];
  failed: Array<{ path: string; error: string }>;
  skipped: string[];
  sourceWorkspaceId?: string;
  targetWorkspaceId?: string;
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
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message;
    }
  } catch (error) {
    if (error instanceof Error) return error.message;
  }

  return `${fallbackMessage}${formatResponseStatus(response)}`;
}

export async function loadWorkspaceTree(
  path = '.',
  depth = 4,
  noCache = false,
  fallbackMessage = 'Failed to load file tree',
  workspaceId?: string | null
): Promise<FileNode[]> {
  const baseUrl = `/api/files/tree?path=${encodeURIComponent(path)}&depth=${depth}${noCache ? `&noCache=${Date.now()}` : ''}`;
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
  options: { metaOnly?: boolean; noCache?: boolean; fallbackMessage?: string } = {}
): Promise<CurrentFile> {
  const { metaOnly = false, noCache = false, fallbackMessage = 'Failed to load file' } = options;
  let url = `/api/files/read?path=${encodeURIComponent(path)}${metaOnly ? '&meta=1' : ''}`;
  if (noCache) {
    url += `&t=${Date.now()}`;
  }

  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: workspaceHeaders(),
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
  options: { expectedSha256?: string | null; baseRevisionId?: string | null } = {}
): Promise<WriteWorkspaceFileResult> {
  const response = await fetch('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    credentials: 'include',
    body: JSON.stringify({
      path,
      content,
      expectedSha256: options.expectedSha256 ?? null,
      baseRevisionId: options.baseRevisionId ?? null,
    }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, 'Failed to save file'));
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

export async function renameWorkspacePath(oldPath: string, newPath: string, overwrite = false): Promise<void> {
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

export async function uploadWorkspaceFiles({
  files,
  targetDir,
  pathMap,
  convertParams,
  onProgress,
}: UploadWorkspaceFilesParams): Promise<void> {
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
    xhr.open('POST', '/api/files/upload', true);
    xhr.withCredentials = true;
    const workspaceId = getActiveWorkspaceId();
    if (workspaceId) {
      xhr.setRequestHeader(WORKSPACE_ID_HEADER, workspaceId);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }

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
        reject(new Error(typeof error.error === 'string' ? error.error : `Upload failed with status ${xhr.status}`));
      } catch {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(formData);
  });
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
