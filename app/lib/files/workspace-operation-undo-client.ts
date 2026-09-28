import { workspaceHeaders } from './client';

export type WorkspaceOperationUndoAvailability = {
  available: boolean;
  reason: string | null;
  reasonCode: 'UNDO_UNAVAILABLE' | 'UNDO_CONFLICT' | 'ALREADY_UNDONE' | null;
  undoOperationId: string | null;
};

export type WorkspaceOperationUndoResult = {
  originalOperationId: string;
  undoOperationId: string;
  kind: 'rename' | 'move' | 'copy';
  status: 'applied' | 'needs_recovery' | 'failed';
  restoredPaths: string[];
  linkStatus: string;
};

export class WorkspaceOperationUndoClientError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'WorkspaceOperationUndoClientError';
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new WorkspaceOperationUndoClientError(
      typeof payload?.error === 'string' ? payload.error : 'Dateioperation konnte nicht rückgängig gemacht werden.',
      response.status,
      typeof payload?.code === 'string' ? payload.code : null,
    );
  }
  if (!payload || typeof payload !== 'object') {
    throw new WorkspaceOperationUndoClientError('Ungültige Antwort für das Rückgängigmachen.', response.status, null);
  }
  return payload as T;
}

export async function readWorkspaceOperationUndoAvailability(
  operationId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceOperationUndoAvailability> {
  const response = await fetch(`/api/files/operations/${encodeURIComponent(operationId)}/undo`, {
    headers: workspaceHeaders(workspaceId), credentials: 'include', cache: 'no-store', signal,
  });
  const payload = await readResponse<{ undo: WorkspaceOperationUndoAvailability }>(response);
  if (!payload.undo || typeof payload.undo.available !== 'boolean') {
    throw new WorkspaceOperationUndoClientError('Ungültiger Undo-Status.', response.status, null);
  }
  return payload.undo;
}

export async function undoWorkspaceOperation(
  operationId: string,
  workspaceId: string,
): Promise<WorkspaceOperationUndoResult> {
  const response = await fetch(`/api/files/operations/${encodeURIComponent(operationId)}/undo`, {
    method: 'POST', headers: workspaceHeaders(workspaceId), credentials: 'include',
  });
  const payload = await readResponse<{ undo: WorkspaceOperationUndoResult }>(response);
  if (!payload.undo || payload.undo.originalOperationId !== operationId
    || !payload.undo.undoOperationId || !Array.isArray(payload.undo.restoredPaths)) {
    throw new WorkspaceOperationUndoClientError('Ungültiges Undo-Ergebnis.', response.status, null);
  }
  return payload.undo;
}
