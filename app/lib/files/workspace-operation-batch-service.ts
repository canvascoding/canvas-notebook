import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { buildWorkspaceOperationBatchPlan, workspaceOperationBatchPublicPreview } from './workspace-operation-batch-plan';
import { assertWorkspaceOperationBatchUndoAvailable, getWorkspaceOperationBatchExecutionPublic } from './workspace-operation-batch-executor';
import type { WorkspaceOperationBatchScope, WorkspaceOperationBatchAction } from './workspace-operation-batch-contract';
import type { WorkspaceOperationBatchPublic } from './workspace-operation-batch-public';
import { WorkspaceOperationBatchStore, WorkspaceOperationBatchError,
  type WorkspaceOperationBatchRecord } from './workspace-operation-batch-store';
import { getWorkspaceOperationReview, rebaseReviewSelections, WorkspaceOperationReviewError } from './workspace-operation-review-service';
import { assertWorkspaceOperationBatchApprovalCurrent } from './workspace-operation-batch-approval-fence';

const store = new WorkspaceOperationBatchStore();

function assertDocumentReviewEnabled(): void {
  if (!readDocumentReviewAvailability().documentReviewEnabled) {
    throw new WorkspaceOperationBatchError('DOCUMENT_REVIEW_DISABLED', 409, 'The experimental Review Center is disabled.');
  }
}

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
  if (scope && (scope.workspace.workspaceId !== batch.workspaceId || scope.workspace.status !== 'active'
    || !scope.workspace.permissions.canRead || scope.fileOptions.workspace
      && scope.fileOptions.workspace.workspaceId !== scope.workspace.workspaceId)) return null;
  const result = workspaceOperationBatchPublic(batch);
  if (scope && ['applied', 'undone', 'needs_review', 'needs_recovery', 'failed'].includes(batch.status)) {
    result.execution = await getWorkspaceOperationBatchExecutionPublic({ batchId, scope, plan: batch.plan,
      actionMode: batch.actionMode, status: batch.status, completedActions: batch.completedActions, phase: batch.phase }) ?? undefined;
  }
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
  assertDocumentReviewEnabled();
  assertAccess(input.scope);
  if (!Array.isArray(input.reviewIds) || input.reviewIds.length < 1 || input.reviewIds.length > 50
    || new Set(input.reviewIds).size !== input.reviewIds.length
    || input.reviewIds.some((id) => !/^[A-Za-z0-9_-]{16,128}$/u.test(id))) {
    throw new WorkspaceOperationBatchError('BATCH_INVALID_SELECTION', 422, 'Select between 1 and 50 distinct file reviews.');
  }
  return withWorkspaceMutationLock(input.scope.workspace.workspaceId, async () => {
    assertDocumentReviewEnabled();
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
    const storedActions = ordered.map((row) => ({ reviewId: String(row!.review_id),
      ...JSON.parse(String(row!.request_json)) })) as WorkspaceOperationBatchAction[];
    if (storedActions.some((action) => !['move', 'rename', 'delete'].includes(action.kind))) {
      throw new WorkspaceOperationBatchError('BATCH_UNSUPPORTED_KIND', 422, 'This batch supports Move, Rename, and Delete.');
    }
    const actions: WorkspaceOperationBatchAction[] = [];
    const rebaseContext = { earliestCreatedAt: Math.min(...ordered.map((row) => Number(row!.created_at))) };
    for (const action of storedActions) {
      const original = await getWorkspaceOperationReview(action.reviewId);
      const row = byId.get(action.reviewId)!;
      if (!original || original.planId !== String(row.plan_id) || original.successorReviewId || original.batchId
        || !['pending', 'stale', 'blocked'].includes(original.status)) {
        throw new WorkspaceOperationBatchError('REVIEW_CONFLICT', 409, 'A selected review changed while creating the combined preview.');
      }
      try {
        const normalized = await rebaseReviewSelections(original, action, input.scope, rebaseContext);
        actions.push({ reviewId: action.reviewId, kind: action.kind, selections: normalized.selections });
      } catch (error) {
        if (error instanceof WorkspaceOperationReviewError) {
          throw new WorkspaceOperationBatchError(error.code, error.status, error.message);
        }
        throw error;
      }
    }
    const plan = await buildWorkspaceOperationBatchPlan({ scope: input.scope, actions });
    assertDocumentReviewEnabled();
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
  const approve = async () => {
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
    const current = await store.get(batch.batchId);
    if (!current) throw new WorkspaceOperationBatchError('BATCH_NOT_FOUND', 404, 'File action batch not found.');
    if (action === 'accept' && current.status === 'preview') {
      assertDocumentReviewEnabled();
      await assertWorkspaceOperationBatchApprovalCurrent(batch.plan, scope);
      assertDocumentReviewEnabled();
    }
    return workspaceOperationBatchPublic(await store.enqueue({ ...input, action }));
  };
  return withWorkspaceMutationLock(batch.workspaceId, approve);
}
