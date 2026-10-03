'use client';

import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import type { WorkspacePathOperationPublic } from './workspace-path-operation-public';

const pending = (operation: WorkspacePathOperationPublic) => ['queued', 'applying'].includes(operation.status);

export class WorkspacePathOperationClientError extends Error {
  constructor(readonly operation: WorkspacePathOperationPublic, message: string) {
    super(message); this.name = 'WorkspacePathOperationClientError';
  }
}

function assertOperation(value: unknown, workspaceId?: string | null): asserts value is WorkspacePathOperationPublic {
  const operation = value as Partial<WorkspacePathOperationPublic> | null;
  if (!operation || typeof operation.batchId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(operation.batchId)
    || typeof operation.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(operation.planId)
    || typeof operation.workspaceId !== 'string' || workspaceId && operation.workspaceId !== workspaceId
    || !['preview', 'blocked', 'queued', 'applying', 'applied', 'needs_review', 'needs_recovery', 'failed', 'undone'].includes(String(operation.status))) {
    throw new Error('Invalid file action status response');
  }
}

/** The file store receives a successful mutation only after the durable action finishes. */
export async function waitForWorkspacePathOperationResult<T extends { operation?: WorkspacePathOperationPublic }>(
  initial: T, workspaceId?: string | null,
  options: { timeoutMs?: number; intervalMs?: number; expectedOutcome?: 'applied' | 'undone' } = {},
): Promise<T> {
  if (!initial.operation) return initial;
  assertOperation(initial.operation, workspaceId);
  const identity = initial.operation;
  let result = initial;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('notification_summary_updated'));
  while (pending(result.operation!) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
    const response = await fetch(`/api/files/operations/batches/${encodeURIComponent(identity.batchId)}`, {
      credentials: 'include', headers: { [WORKSPACE_ID_HEADER]: identity.workspaceId }, cache: 'no-store',
    });
    const payload = await response.json() as T & { error?: unknown };
    if (!response.ok) throw new WorkspacePathOperationClientError(identity,
      typeof payload.error === 'string' ? payload.error : 'Could not read the file action status.');
    assertOperation(payload.operation, identity.workspaceId);
    if (payload.operation!.batchId !== identity.batchId || payload.operation!.planId !== identity.planId) {
      throw new Error('File action identity changed while waiting');
    }
    result = payload;
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
  const response = await fetch(`/api/files/operations/batches/${encodeURIComponent(operation.batchId)}`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', [WORKSPACE_ID_HEADER]: operation.workspaceId },
    body: JSON.stringify({ action: 'undo', planId: operation.planId }),
  });
  const payload = await response.json() as { operation?: WorkspacePathOperationPublic; error?: unknown };
  if (!response.ok) throw new WorkspacePathOperationClientError(operation,
    typeof payload.error === 'string' ? payload.error : 'Could not safely undo the file action.');
  assertOperation(payload.operation, operation.workspaceId);
  if (payload.operation.batchId !== operation.batchId || payload.operation.planId !== operation.planId) {
    throw new Error('File action identity changed while waiting');
  }
  await waitForWorkspacePathOperationResult(payload, operation.workspaceId, { expectedOutcome: 'undone' });
}
