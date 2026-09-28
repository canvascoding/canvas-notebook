import { workspaceHeaders } from './client';

export type WorkspaceOperationBackupListItem = {
  status: 'manifest_valid';
  backupId: string;
  operationId: string;
  originalPath: string;
  itemType: 'file' | 'directory';
  capturedAt: number;
  retention: string;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  contentSha256: string;
} | {
  status: 'unavailable';
  backupId: string;
};

export type WorkspaceOperationBackupPage = {
  backups: WorkspaceOperationBackupListItem[];
  nextCursor: string | null;
};

export class WorkspaceOperationBackupClientError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'WorkspaceOperationBackupClientError';
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new WorkspaceOperationBackupClientError(
      typeof payload?.error === 'string' ? payload.error : 'Sicherungen konnten nicht geladen werden.',
      response.status,
      typeof payload?.code === 'string' ? payload.code : null,
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new WorkspaceOperationBackupClientError('Ungültige Sicherungsantwort.', response.status, null);
  }
  return payload as T;
}

export async function listWorkspaceOperationBackups(
  workspaceId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<WorkspaceOperationBackupPage> {
  const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
  const response = await fetch(`/api/files/operation-backups?${query}`, {
    headers: workspaceHeaders(workspaceId), credentials: 'include', cache: 'no-store', signal,
  });
  const payload = await readResponse<WorkspaceOperationBackupPage>(response);
  if (!Array.isArray(payload.backups)
    || payload.backups.some((item) => !item || typeof item.backupId !== 'string')
    || payload.nextCursor !== null && typeof payload.nextCursor !== 'string') {
    throw new WorkspaceOperationBackupClientError('Ungültige Sicherungsliste.', response.status, null);
  }
  return payload;
}

export async function restoreWorkspaceOperationBackupFromClient(input: {
  workspaceId: string;
  backupId: string;
  targetPath: string;
}): Promise<{ restoredPath: string; contentSha256: string; sizeBytes: number }> {
  const response = await fetch(`/api/files/operation-backups/${encodeURIComponent(input.backupId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders(input.workspaceId) },
    credentials: 'include',
    body: JSON.stringify({ targetPath: input.targetPath }),
  });
  const payload = await readResponse<{ restored: {
    backupId: string; restoredPath: string; contentSha256: string; sizeBytes: number;
  } }>(response);
  if (!payload.restored || payload.restored.backupId !== input.backupId
    || typeof payload.restored.restoredPath !== 'string') {
    throw new WorkspaceOperationBackupClientError('Ungültiges Wiederherstellungsergebnis.', response.status, null);
  }
  return payload.restored;
}
