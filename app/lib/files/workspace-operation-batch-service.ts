import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { buildWorkspaceOperationBatchPlan, workspaceOperationBatchPublicPreview } from './workspace-operation-batch-plan';
import { assertWorkspaceOperationBatchUndoAvailable } from './workspace-operation-batch-executor';
import type { WorkspaceOperationBatchScope, WorkspaceOperationBatchAction } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchPublic } from './workspace-operation-batch-public';
import { WorkspaceOperationBatchStore, WorkspaceOperationBatchError,
  type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';

const store = new WorkspaceOperationBatchStore();

function assertAccess(scope: WorkspaceOperationBatchScope, workspaceId = scope.workspace.workspaceId): void {
  if (scope.workspace.workspaceId !== workspaceId || scope.workspace.status && scope.workspace.status !== 'active'
    || !scope.workspace.permissions.canRead || !scope.workspace.permissions.canWrite || !scope.workspace.permissions.canDelete) {
    throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Current read, write, and delete permissions are required.');
  }
}

export function workspaceOperationBatchPublic(batch: WorkspaceOperationBatchRecord): WorkspaceOperationBatchPublic {
  return { batchId: batch.batchId, planId: batch.planId, workspaceId: batch.workspaceId,
    reviewIds: batch.reviewIds, status: batch.status,
    preview: { ...workspaceOperationBatchPublicPreview(batch.plan), changedReviews: batch.reviewRefs
      .filter((ref) => ref.status === 'stale').map((ref) => ({ reviewId: ref.reviewId,
        previousPlanId: ref.planId, currentPlanId: batch.planId,
        detail: 'Workspace state changed since the individual preview; approve the current combined preview.' })) },
    completedActions: batch.completedActions, totalActions: batch.totalActions, phase: batch.phase,
    errorCode: batch.errorCode, trashEntryIds: batch.trashEntryIds,
    createdAt: batch.createdAt, updatedAt: batch.updatedAt, undoAvailable: false };
}

export async function getWorkspaceOperationBatchReview(batchId: string, scope?: WorkspaceOperationBatchScope): Promise<WorkspaceOperationBatchPublic | null> {
  const batch = await store.get(batchId);
  if (!batch) return null;
  const result = workspaceOperationBatchPublic(batch);
  if (scope && batch.workspaceId === scope.workspace.workspaceId && batch.status === 'applied'
    && scope.workspace.permissions.canWrite && scope.workspace.permissions.canDelete) {
    try {
      await assertWorkspaceOperationBatchUndoAvailable({ batchId, scope });
      result.undoAvailable = true;
    } catch { result.undoAvailable = false; }
  }
  return result;
}

export async function createWorkspaceOperationBatchReview(input: {
  scope: WorkspaceOperationBatchScope; reviewIds: string[];
}): Promise<WorkspaceOperationBatchPublic> {
  assertAccess(input.scope);
  if (!Array.isArray(input.reviewIds) || input.reviewIds.length < 1 || input.reviewIds.length > 50
    || new Set(input.reviewIds).size !== input.reviewIds.length
    || input.reviewIds.some((id) => !/^[A-Za-z0-9_-]{16,128}$/u.test(id))) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_SELECTION', 422, 'Select between 1 and 50 distinct file reviews.');
  }
  return withWorkspaceMutationLock(input.scope.workspace.workspaceId, async () => {
    const db = await openDb();
    let rows: Record<string, unknown>[];
    try { rows = await db.all(`SELECT * FROM workspace_file_operation_reviews
      WHERE review_id = ANY($1::text[])`, [input.reviewIds]) as Record<string, unknown>[]; }
    finally { await db.close(); }
    const byId = new Map(rows.map((row) => [String(row.review_id), row]));
    const ordered = input.reviewIds.map((id) => byId.get(id));
    if (ordered.some((row) => !row || row.source_workspace_id !== input.scope.workspace.workspaceId
      || row.destination_workspace_id !== input.scope.workspace.workspaceId || row.successor_review_id
      || row.batch_id || !['pending', 'stale', 'blocked'].includes(String(row.status)))) {
      throw new WorkspaceOperationBatchError('REVIEW_CONFLICT', 409, 'Selected reviews must be open in the same workspace.');
    }
    const actions = ordered.map((row) => ({ reviewId: String(row!.review_id),
      ...JSON.parse(String(row!.request_json)) })) as WorkspaceOperationBatchAction[];
    if (actions.some((action) => !['move', 'rename', 'delete'].includes(action.kind))) {
      throw new WorkspaceOperationBatchError('BATCH_UNSUPPORTED_KIND', 422, 'This batch supports Move, Rename, and Delete.');
    }
    const plan = await buildWorkspaceOperationBatchPlan({ scope: input.scope, actions });
    const batch = await store.create({ batchId: randomUUID(), plan, reviewRefs: ordered.map((row) => ({
      reviewId: String(row!.review_id), planId: String(row!.plan_id), status: String(row!.status),
    })) });
    return workspaceOperationBatchPublic(batch);
  });
}

/** Persist an exact user-approved job; execution belongs to the long-lived Node worker. */
export async function enqueueWorkspaceOperationBatch(input: {
  batchId: string; planId: string; scope: WorkspaceOperationBatchScope;
  userId: string; displayName: string; action?: 'accept' | 'resume' | 'undo';
  refreshScope?: () => Promise<WorkspaceOperationBatchScope>;
}): Promise<WorkspaceOperationBatchPublic> {
  const batch = await store.get(input.batchId);
  if (!batch) throw new WorkspaceOperationBatchError('BATCH_NOT_FOUND', 404, 'File action batch not found.');
  assertAccess(input.scope, batch.workspaceId);
  const action = input.action ?? 'accept';
  return withWorkspaceMutationLock(batch.workspaceId, async () => {
    const scope = input.refreshScope ? await input.refreshScope() : input.scope;
    assertAccess(scope, batch.workspaceId);
    if (scope.workspace.rootPath !== input.scope.workspace.rootPath) {
      throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Workspace location changed before approval.');
    }
    if (action === 'undo' && batch.status === 'applied') {
      try { await assertWorkspaceOperationBatchUndoAvailable({ batchId: batch.batchId, scope }); }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BATCH_UNDO_CONFLICT';
        throw new WorkspaceOperationBatchError(code, 409, 'Files or links changed after the batch; automatic undo would overwrite newer work.');
      }
    }
    if (action === 'accept' && batch.status === 'preview') {
      const fresh = await buildWorkspaceOperationBatchPlan({ scope, actions: batch.plan.actions });
      if (fresh.planId !== input.planId || fresh.readiness !== 'ready') {
        throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'Files changed after the combined preview. Refresh before approval.');
      }
    }
    return workspaceOperationBatchPublic(await store.enqueue({ ...input, action }));
  });
}
