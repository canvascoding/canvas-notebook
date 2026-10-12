'use client';

import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import type { WorkspacePathOperationPublic } from './workspace-path-operation-public';
import { readWorkspacePathOperation } from './workspace-path-operation-parser';

const pending = (operation: WorkspacePathOperationPublic) => ['queued', 'applying'].includes(operation.status);

export class WorkspacePathOperationClientError extends Error {
  constructor(readonly operation: WorkspacePathOperationPublic, message: string) {
    super(message); this.name = 'WorkspacePathOperationClientError';
  }
}

/** The file store receives a successful mutation only after the durable action finishes. */
export async function waitForWorkspacePathOperationResult<T extends { operation?: WorkspacePathOperationPublic }>(
  initial: T, workspaceId?: string | null,
  options: { timeoutMs?: number; intervalMs?: number; expectedOutcome?: 'applied' | 'undone' } = {},
): Promise<T> {
  if (!initial.operation) return initial;
  const identity = readWorkspacePathOperation(initial.operation, { workspaceId });
  let result = { ...initial, operation: identity };
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('notification_summary_updated'));
  while (pending(result.operation!) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
    let response: Response;
    let payload: T & { error?: unknown };
    try {
      response = await fetch(`/api/files/operations/batches/${encodeURIComponent(identity.batchId)}`, {
        credentials: 'include', headers: { [WORKSPACE_ID_HEADER]: identity.workspaceId }, cache: 'no-store',
      });
      payload = await response.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid status payload');
    } catch {
      throw new WorkspacePathOperationClientError(result.operation,
        'Could not read the file action status. Check Notification Center before requesting another action.');
    }
    if (!response.ok) {
      let failed = result.operation;
      try { if (payload.operation) failed = readWorkspacePathOperation(payload.operation, identity); } catch { /* Keep the known identity. */ }
      throw new WorkspacePathOperationClientError(failed,
        typeof payload.error === 'string' ? payload.error : 'Could not read the file action status.');
    }
    let operation: WorkspacePathOperationPublic;
    try { operation = readWorkspacePathOperation(payload.operation, identity); }
    catch { throw new WorkspacePathOperationClientError(result.operation, 'Invalid file action status response'); }
    result = { ...payload, operation };
  }
  const operation = result.operation!;
  if (operation.status !== (options.expectedOutcome ?? 'applied')) {
    throw new WorkspacePathOperationClientError(operation, pending(operation)
      ? 'The file action is still running. Check Notification Center for its progress.'
      : 'The file action could not finish safely. Check Notification Center for details.');
  }
  return result;
}

export async function undoWorkspacePathOperation(operation: WorkspacePathOperationPublic): Promise<void> {
  const identity = readWorkspacePathOperation(operation);
  const response = await fetch(`/api/files/operations/batches/${encodeURIComponent(identity.batchId)}`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', [WORKSPACE_ID_HEADER]: identity.workspaceId },
    body: JSON.stringify({ action: 'undo', planId: identity.planId }),
  });
  const payload = await response.json() as { operation?: WorkspacePathOperationPublic; error?: unknown };
  if (!response.ok) {
    let failed = identity;
    try { if (payload.operation) failed = readWorkspacePathOperation(payload.operation, identity); } catch { /* Keep the known identity. */ }
    throw new WorkspacePathOperationClientError(failed,
      typeof payload.error === 'string' ? payload.error : 'Could not safely undo the file action.');
  }
  const current = payload.operation ? readWorkspacePathOperation(payload.operation, identity) : null;
  if (!current) throw new Error('Invalid file action status response');
  await waitForWorkspacePathOperationResult({ ...payload, operation: current }, operation.workspaceId, { expectedOutcome: 'undone' });
}
