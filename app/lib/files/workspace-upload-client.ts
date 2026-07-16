'use client';

import {
  WORKSPACE_UPLOAD_CHUNK_SIZE,
  WORKSPACE_UPLOAD_MAX_RETRIES,
  formatUploadBytes,
  getWorkspaceUploadChunkRange,
} from '@/app/lib/files/upload-limits';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export type WorkspaceUploadClientStatus = 'pending' | 'uploading' | 'retrying' | 'completed' | 'failed';

export interface WorkspaceUploadClientFile {
  file: File;
  path: string;
}

export interface WorkspaceUploadFileProgress {
  index: number;
  path: string;
  size: number;
  uploadedBytes: number;
  status: WorkspaceUploadClientStatus;
  attempt: number;
  error?: string;
}

export interface WorkspaceBatchUploadResult {
  totalFiles: number;
  totalBytes: number;
  completed: Array<{ path: string; size: number }>;
  failed: Array<{ path: string; size: number; error: string }>;
}

interface ServerUploadFile {
  id: string;
  sourceIndex: number;
  relativePath: string;
  targetPath: string;
  size: number;
  uploadedBytes: number;
  status: string;
}

interface CreateUploadResponse {
  success: true;
  upload: {
    id: string;
    files: ServerUploadFile[];
  };
  limits?: {
    chunkBytes?: number;
  };
}

interface UploadErrorPayload {
  error?: unknown;
  code?: unknown;
  expectedOffset?: unknown;
}

class WorkspaceUploadRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'WorkspaceUploadRequestError';
    this.status = status;
    this.code = code;
    this.retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export class WorkspaceBatchUploadError extends Error {
  readonly result: WorkspaceBatchUploadResult;

  constructor(result: WorkspaceBatchUploadResult) {
    const examples = result.failed
      .slice(0, 3)
      .map((entry) => `${entry.path}: ${entry.error}`)
      .join('; ');
    const remaining = Math.max(0, result.failed.length - 3);
    const details = examples
      ? ` ${examples}${remaining > 0 ? `; and ${remaining} more` : ''}`
      : '';
    super(
      `${result.completed.length} of ${result.totalFiles} files uploaded successfully; ${result.failed.length} failed.${details}`,
    );
    this.name = 'WorkspaceBatchUploadError';
    this.result = result;
  }
}

function requestHeaders(workspaceId: string | null, json = false): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(workspaceId ? { [WORKSPACE_ID_HEADER]: workspaceId } : {}),
  };
}

function parseErrorPayload(body: string): UploadErrorPayload {
  try {
    const payload = JSON.parse(body) as UploadErrorPayload;
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

function uploadErrorMessage(params: {
  status: number;
  statusText?: string;
  body?: string;
  fallback: string;
}): WorkspaceUploadRequestError {
  const payload = parseErrorPayload(params.body ?? '');
  const code = typeof payload.code === 'string' ? payload.code : null;
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return new WorkspaceUploadRequestError(payload.error.trim(), params.status, code);
  }
  if (params.status === 413) {
    return new WorkspaceUploadRequestError(
      `The server or reverse proxy rejected the upload as too large (HTTP 413). The chunk was ${formatUploadBytes(WORKSPACE_UPLOAD_CHUNK_SIZE)}; check the proxy request-body limit if this repeats.`,
      params.status,
      code ?? 'UPLOAD_PROXY_LIMIT',
    );
  }
  const status = params.status > 0
    ? `HTTP ${params.status}${params.statusText ? ` ${params.statusText}` : ''}`
    : 'network error';
  return new WorkspaceUploadRequestError(`${params.fallback} (${status}).`, params.status, code);
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) {
    throw uploadErrorMessage({
      status: response.status,
      statusText: response.statusText,
      body,
      fallback,
    });
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new WorkspaceUploadRequestError(
      `${fallback}: server returned an invalid response.`,
      response.status,
      'UPLOAD_INVALID_RESPONSE',
    );
  }
}

function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(2_000, 300 * (2 ** Math.max(0, attempt - 1)));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function retryRequest<T>(
  request: () => Promise<T>,
  onRetry: (attempt: number, error: Error) => void,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= WORKSPACE_UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = error instanceof WorkspaceUploadRequestError
        ? error.retryable
        : error instanceof TypeError;
      if (!retryable || attempt >= WORKSPACE_UPLOAD_MAX_RETRIES) {
        throw lastError;
      }
      onRetry(attempt + 1, lastError);
      await waitBeforeRetry(attempt);
    }
  }
  throw lastError ?? new Error('Upload request failed.');
}

function sendChunk(params: {
  sessionId: string;
  serverFileId: string;
  workspaceId: string | null;
  offset: number;
  chunk: Blob;
  onProgress: (loaded: number) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      fileId: params.serverFileId,
      offset: String(params.offset),
      expectedBytes: String(params.chunk.size),
    });
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/files/uploads/${encodeURIComponent(params.sessionId)}?${query}`, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (params.workspaceId) {
      xhr.setRequestHeader(WORKSPACE_ID_HEADER, params.workspaceId);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) params.onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        params.onProgress(params.chunk.size);
        resolve();
        return;
      }
      reject(uploadErrorMessage({
        status: xhr.status,
        statusText: xhr.statusText,
        body: xhr.responseText,
        fallback: 'Upload chunk failed',
      }));
    };
    xhr.onerror = () => reject(new WorkspaceUploadRequestError(
      'Network connection interrupted while uploading a chunk.',
      0,
      'UPLOAD_NETWORK_ERROR',
    ));
    xhr.onabort = () => reject(new WorkspaceUploadRequestError(
      'Upload chunk was cancelled.',
      499,
      'UPLOAD_CANCELLED',
    ));
    xhr.send(params.chunk);
  });
}

async function cancelUploadSession(sessionId: string, workspaceId: string | null): Promise<void> {
  await fetch(`/api/files/uploads/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: requestHeaders(workspaceId),
    credentials: 'include',
  }).catch(() => undefined);
}

export async function uploadWorkspaceFilesInChunks(params: {
  files: WorkspaceUploadClientFile[];
  targetDir: string;
  workspaceId: string | null;
  onProgress?: (progress: number) => void;
  onFileProgress?: (progress: WorkspaceUploadFileProgress) => void;
}): Promise<WorkspaceBatchUploadResult> {
  const totalBytes = params.files.reduce((total, entry) => total + entry.file.size, 0);
  let highestProgress = 0;
  let confirmedBytes = 0;
  const completed: WorkspaceBatchUploadResult['completed'] = [];
  const failed: WorkspaceBatchUploadResult['failed'] = [];
  const reportOverallProgress = (inFlightBytes = 0) => {
    const progress = totalBytes > 0
      ? Math.round(((confirmedBytes + inFlightBytes) / totalBytes) * 100)
      : Math.round(((completed.length + failed.length) / Math.max(1, params.files.length)) * 100);
    highestProgress = Math.max(highestProgress, Math.min(100, progress));
    params.onProgress?.(highestProgress);
  };
  const reportFile = (
    index: number,
    status: WorkspaceUploadClientStatus,
    uploadedBytes: number,
    attempt: number,
    error?: string,
  ) => params.onFileProgress?.({
    index,
    path: params.files[index].path,
    size: params.files[index].file.size,
    uploadedBytes,
    status,
    attempt,
    ...(error ? { error } : {}),
  });

  params.files.forEach((_entry, index) => reportFile(index, 'pending', 0, 0));
  reportOverallProgress();

  const created = await retryRequest(
    async () => {
      const createResponse = await fetch('/api/files/uploads', {
        method: 'POST',
        headers: requestHeaders(params.workspaceId, true),
        credentials: 'include',
        body: JSON.stringify({
          targetDir: params.targetDir,
          files: params.files.map((entry) => ({
            path: entry.path,
            size: entry.file.size,
            mimeType: entry.file.type || 'application/octet-stream',
          })),
        }),
      });
      return readJsonResponse<CreateUploadResponse>(createResponse, 'Could not start upload');
    },
    () => undefined,
  );
  const sessionId = created.upload.id;
  const chunkBytes = Math.max(1, Math.min(
    created.limits?.chunkBytes ?? WORKSPACE_UPLOAD_CHUNK_SIZE,
    WORKSPACE_UPLOAD_CHUNK_SIZE,
  ));

  try {
    for (let index = 0; index < params.files.length; index += 1) {
      const entry = params.files[index];
      const serverFile = created.upload.files.find((candidate) => candidate.sourceIndex === index);
      if (!serverFile) {
        const message = 'Server did not initialize this file.';
        failed.push({ path: entry.path, size: entry.file.size, error: message });
        reportFile(index, 'failed', 0, 0, message);
        reportOverallProgress();
        continue;
      }

      let uploadedBytes = serverFile.uploadedBytes || 0;
      let fileFailed = false;
      reportFile(index, 'uploading', uploadedBytes, 1);

      while (uploadedBytes < entry.file.size) {
        const range = getWorkspaceUploadChunkRange(entry.file.size, uploadedBytes);
        const end = Math.min(range.end, uploadedBytes + chunkBytes);
        const chunk = entry.file.slice(uploadedBytes, end);
        let inFlightBytes = 0;
        try {
          await retryRequest(
            () => sendChunk({
              sessionId,
              serverFileId: serverFile.id,
              workspaceId: params.workspaceId,
              offset: uploadedBytes,
              chunk,
              onProgress: (loaded) => {
                inFlightBytes = Math.min(chunk.size, loaded);
                reportFile(index, 'uploading', uploadedBytes + inFlightBytes, 1);
                reportOverallProgress(inFlightBytes);
              },
            }),
            (attempt, error) => {
              inFlightBytes = 0;
              reportFile(index, 'retrying', uploadedBytes, attempt, error.message);
            },
          );
          uploadedBytes += chunk.size;
          confirmedBytes += chunk.size;
          reportFile(index, 'uploading', uploadedBytes, 1);
          reportOverallProgress();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Upload failed.';
          failed.push({ path: entry.path, size: entry.file.size, error: message });
          reportFile(index, 'failed', uploadedBytes, WORKSPACE_UPLOAD_MAX_RETRIES, message);
          fileFailed = true;
          break;
        }
      }

      if (fileFailed) continue;

      try {
        await retryRequest(
          async () => {
            const response = await fetch(`/api/files/uploads/${encodeURIComponent(sessionId)}/complete`, {
              method: 'POST',
              headers: requestHeaders(params.workspaceId, true),
              credentials: 'include',
              body: JSON.stringify({ fileId: serverFile.id }),
            });
            await readJsonResponse(response, `Could not finalize ${entry.path}`);
          },
          (attempt, error) => reportFile(index, 'retrying', uploadedBytes, attempt, error.message),
        );
        completed.push({ path: entry.path, size: entry.file.size });
        reportFile(index, 'completed', entry.file.size, 1);
        reportOverallProgress();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not finalize uploaded file.';
        failed.push({ path: entry.path, size: entry.file.size, error: message });
        reportFile(index, 'failed', uploadedBytes, WORKSPACE_UPLOAD_MAX_RETRIES, message);
        reportOverallProgress();
      }
    }
  } finally {
    await cancelUploadSession(sessionId, params.workspaceId);
  }

  const result: WorkspaceBatchUploadResult = {
    totalFiles: params.files.length,
    totalBytes,
    completed,
    failed,
  };
  if (failed.length > 0) {
    throw new WorkspaceBatchUploadError(result);
  }
  params.onProgress?.(100);
  return result;
}
