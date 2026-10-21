'use client';

import { WORKSPACE_ID_HEADER } from '../workspaces/constants';
import { openedDocumentAuthScope } from '../collaboration/opened-document-registry';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { WorkspacePathOperationResponse } from './workspace-path-operation-public';
import type { WorkspaceImplicitMovePreparationPublicV2 } from './workspace-implicit-move-public';
import { readWorkspaceImplicitMoveBinding, readWorkspaceImplicitMoveLegacyReplay, readWorkspaceImplicitMovePreparation } from './workspace-implicit-move-parser';
import { readWorkspacePathOperation } from './workspace-path-operation-parser';
import { bindWorkspacePathOperationAttempt, bindWorkspacePathOperationAttemptImplicitPreparation,
  observeWorkspacePathOperationAttemptImplicitAbort, observeWorkspacePathOperationAttemptCompletion, type WorkspacePathOperationAttempt } from './workspace-path-operation-attempts';
import { waitForWorkspacePathOperationResult, WorkspacePathOperationClientError,
  WorkspacePathOperationOutcomeUnknownError } from './workspace-path-operation-client';

export class WorkspaceImplicitMovePendingError extends Error {
  readonly code = 'IMPLICIT_MOVE_PREPARATION_PENDING';
  constructor(readonly preparation: WorkspaceImplicitMovePreparationPublicV2) {
    super(preparation.state === 'pending' && !preparation.canResume
      ? 'The file preparation requires recovery. Its original request has been retained.'
      : 'The file preparation is still pending. Retry this same file action to continue it.');
    this.name = 'WorkspaceImplicitMovePendingError';
  }
}
export class WorkspaceImplicitMoveAbortedError extends Error {
  readonly code = 'IMPLICIT_MOVE_PREPARATION_ABORTED';
  constructor(readonly preparation: WorkspaceImplicitMovePreparationPublicV2) {
    super('The original selection could not be moved. Request a new file action.');
    this.name = 'WorkspaceImplicitMoveAbortedError';
  }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (body.length > 16 * 1024 ** 2 || new TextEncoder().encode(body).byteLength > 16 * 1024 ** 2) throw new Error('Invalid file action response.');
  const result: unknown = JSON.parse(body);
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.getPrototypeOf(result) !== Object.prototype) throw new Error('Invalid file action response.');
  return result as Record<string, unknown>;
}

/** One original keyed request, then the exact saved resume endpoint. Never changes the file store. */
export async function waitForWorkspaceImplicitMoveResponse(initial: Response,
  context: Readonly<{ attempt: WorkspacePathOperationAttempt; workspaceId: string; action: 'rename';
    selections: readonly Readonly<{ sourcePath: string; destinationPath: string }>[] }>,
): Promise<WorkspacePathOperationResponse> {
  const { attempt, workspaceId } = context;
  const current = () => {
    if (openedDocumentAuthScope() !== attempt.authScope || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) {
      throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
    }
  };
  const expected = { actorUserId: attempt.authScope.userId, workspaceId, operationId: attempt.operationId,
    action: context.action, selections: context.selections };
  const deadline = Date.now() + 60_000;
  let response = initial;
  while (true) {
    current(); const payload = await json(response); current();
    const pinned = attempt.implicitBinding;
    const pinnedLegacy = attempt.legacyImplicitReplay;
    if (Object.hasOwn(payload, 'preparation')) {
      if (pinnedLegacy) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      if (Object.hasOwn(payload, 'operation') || Object.hasOwn(payload, 'mutation') || Object.hasOwn(payload, 'historical')
        || Object.hasOwn(payload, 'linkUpdates') || Object.hasOwn(payload, 'linkStatus')) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      const preparation = readWorkspaceImplicitMovePreparation(payload.preparation, { ...expected,
        ...(pinned ? { requestId: pinned.requestId, selectionDigest: pinned.selectionDigest } : {}) });
      if (preparation.state === 'aborted') {
        if (response.status !== 409 || payload.success !== false || payload.code !== 'IMPLICIT_MOVE_PREPARATION_ABORTED'
          || Object.keys(payload).some(key => !['success','error','code','preparation'].includes(key))) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
        observeWorkspacePathOperationAttemptImplicitAbort(attempt, preparation);
        throw new WorkspaceImplicitMoveAbortedError(preparation);
      }
      if (response.status !== 202 || payload.success !== true || Object.keys(payload).length !== 2) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      bindWorkspacePathOperationAttemptImplicitPreparation(attempt, preparation);
      if (!preparation.canResume || Date.now() >= deadline) throw new WorkspaceImplicitMovePendingError(preparation);
      await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now())))); current();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(25_000, deadline - Date.now())));
      try {
        // Strict parser derived this exact relative URL from the UUID; never fetch arbitrary response URLs.
        response = await fetch(`/api/files/operations/implicit-moves/${preparation.requestId}`, {
          method: 'POST', credentials: 'include', cache: 'no-store', signal: abort.signal,
          headers: { 'Content-Type': 'application/json', [WORKSPACE_ID_HEADER]: workspaceId }, body: '{}' });
      } catch { throw new WorkspaceImplicitMovePendingError(preparation); }
      finally { clearTimeout(timer); }
      continue;
    }
    if (!payload.operation) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
    const operation = readWorkspacePathOperation(payload.operation, { workspaceId });
    let identityOperation = operation;
    if (operation.legacyImplicitReplay !== undefined) {
      if (pinned || operation.implicitBinding || payload.historical !== true) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      const legacyImplicitReplay = readWorkspaceImplicitMoveLegacyReplay(operation.legacyImplicitReplay,
        { actorUserId: expected.actorUserId, workspaceId, operationId: attempt.operationId,
          batchId: pinnedLegacy?.batchId ?? operation.batchId, planId: pinnedLegacy?.planId ?? operation.planId });
      identityOperation = { ...operation, legacyImplicitReplay };
    } else {
      if (pinnedLegacy) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      const binding = readWorkspaceImplicitMoveBinding(operation.implicitBinding, { ...expected,
        ...(pinned ? { requestId: pinned.requestId, selectionDigest: pinned.selectionDigest } : {}) });
      identityOperation = { ...operation, implicitBinding: binding };
    }
    if (operation.preparation || operation.kind !== context.action || operation.selections.length !== context.selections.length
      || operation.selections.some((selection, index) => selection.sourcePath !== context.selections[index].sourcePath
        || selection.destinationPath !== context.selections[index].destinationPath)
      || payload.historical !== undefined && payload.historical !== true) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
    bindWorkspacePathOperationAttempt(attempt, identityOperation);
    if (!response.ok) throw new WorkspacePathOperationClientError(operation,
      typeof payload.error === 'string' ? payload.error.slice(0,4096) : 'The original file action could not finish.');
    const completed = await waitForWorkspacePathOperationResult({ ...payload, operation: identityOperation } as WorkspacePathOperationResponse,
      workspaceId, { authScope: attempt.authScope, deferAttemptCompletion: true });
    current();
    if (identityOperation.legacyImplicitReplay) {
      if (completed.historical !== true || completed.operation.implicitBinding) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      readWorkspaceImplicitMoveLegacyReplay(completed.operation.legacyImplicitReplay, identityOperation.legacyImplicitReplay);
    } else {
      if (completed.operation.legacyImplicitReplay) throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      readWorkspaceImplicitMoveBinding(completed.operation.implicitBinding, identityOperation.implicitBinding);
    }
    if (completed.operation.status !== 'applied' || completed.linkStatus !== 'complete') throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
    if (completed.historical !== true) {
      const mutation = completed.mutation;
      if (!mutation || mutation.type !== 'rename' || mutation.workspaceId !== workspaceId
        || mutation.oldPath !== context.selections[0].sourcePath || mutation.newPath !== context.selections[0].destinationPath
        || typeof mutation.operationId !== 'string' || !/^(?:native-move:)?[a-f0-9]{64}$/u.test(mutation.operationId)) {
        throw new WorkspacePathOperationOutcomeUnknownError(attempt.operationId);
      }
    }
    observeWorkspacePathOperationAttemptCompletion(completed.operation);
    return completed;
  }
}
