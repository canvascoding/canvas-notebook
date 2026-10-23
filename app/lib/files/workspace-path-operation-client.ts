'use client';

import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import type { WorkspacePathOperationPublic } from './workspace-path-operation-public';
import { readWorkspacePathOperation } from './workspace-path-operation-parser';
import { openedDocumentAuthScope, type OpenedDocumentAuthScope } from '../collaboration/opened-document-registry';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { readWorkspaceImplicitMoveBinding, readWorkspaceImplicitMoveLegacyReplay } from './workspace-implicit-move-parser';
import { observeWorkspacePathOperationAttemptCompletion } from './workspace-path-operation-attempts';

const pending = (operation: WorkspacePathOperationPublic) => ['queued', 'applying'].includes(operation.status);

export class WorkspacePathOperationClientError extends Error {
  constructor(readonly operation: WorkspacePathOperationPublic, message: string) {
    super(message); this.name = 'WorkspacePathOperationClientError';
  }
}

/** The original caller key survives; no successful UI mutation may be inferred. */
export class WorkspacePathOperationOutcomeUnknownError extends Error {
  readonly code = 'WORKSPACE_OPERATION_OUTCOME_UNCONFIRMED';
  constructor(readonly operationId: string, readonly planId?: string) {
    super('The file action outcome could not be confirmed. Check Notification Center before retrying.');
    this.name = 'WorkspacePathOperationOutcomeUnknownError';
  }
}

/** The file store receives a successful mutation only after the durable action finishes. */
export async function waitForWorkspacePathOperationResult<T extends { operation?: WorkspacePathOperationPublic; historical?: true }>(
  initial: T, workspaceId?: string | null,
  options: { timeoutMs?: number; intervalMs?: number; expectedOutcome?: 'applied' | 'undone';
    authScope?: OpenedDocumentAuthScope; deferAttemptCompletion?: true } = {},
): Promise<T> {
  if (!initial.operation) return initial;
  const identity = readWorkspacePathOperation(initial.operation, { workspaceId });
  const implicitBinding = identity.implicitBinding;
  const legacyImplicitReplay = identity.legacyImplicitReplay;
  const current = () => {
    if (options.authScope && (openedDocumentAuthScope() !== options.authScope
      || useWorkspaceStore.getState().activeWorkspaceId !== identity.workspaceId
      || implicitBinding && implicitBinding.actorUserId !== options.authScope.userId
      || legacyImplicitReplay && legacyImplicitReplay.actorUserId !== options.authScope.userId)) {
      throw new WorkspacePathOperationClientError(identity, 'The signed-in file action context changed.');
    }
  };
  current();
  let result = { ...initial, operation: identity };
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('notification_summary_updated'));
  while (pending(result.operation!) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
    current();
    let response: Response;
    let payload: T & { error?: unknown };
    try {
      response = await fetch(`/api/files/operations/batches/${encodeURIComponent(identity.batchId)}`, {
        credentials: 'include', headers: { [WORKSPACE_ID_HEADER]: identity.workspaceId }, cache: 'no-store',
      });
      payload = await response.json();
      current();
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
    if (implicitBinding) {
      if (operation.legacyImplicitReplay) throw new WorkspacePathOperationClientError(result.operation, 'The original preparation mapping changed.');
      if (operation.implicitBinding) readWorkspaceImplicitMoveBinding(operation.implicitBinding, implicitBinding);
      operation = { ...operation, implicitBinding }; // Existing immutable batch/plan/workspace checks succeeded above.
    } else if (legacyImplicitReplay) {
      if (operation.implicitBinding || payload.historical !== undefined && payload.historical !== true) {
        throw new WorkspacePathOperationClientError(result.operation, 'The original legacy replay mapping changed.');
      }
      if (operation.legacyImplicitReplay) readWorkspaceImplicitMoveLegacyReplay(operation.legacyImplicitReplay, legacyImplicitReplay);
      operation = { ...operation, legacyImplicitReplay }; // The verified initial legacy tag remains bound to this exact batch/plan/workspace.
    }
    current();
    result = { ...payload, operation, ...(initial.historical === true ? { historical: true as const } : {}) };
  }
  const operation = result.operation!;
  if (operation.status !== (options.expectedOutcome ?? 'applied')) {
    throw new WorkspacePathOperationClientError(operation, pending(operation)
      ? 'The file action is still running. Check Notification Center for its progress.'
      : 'The file action could not finish safely. Check Notification Center for details.');
  }
  current();
  if (!options.deferAttemptCompletion) observeWorkspacePathOperationAttemptCompletion(operation);
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
