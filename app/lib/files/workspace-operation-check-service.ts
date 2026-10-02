import 'server-only';
import { openDb } from '@/app/lib/db';
import { WorkspaceOperationBatchError } from './workspace-operation-batch-store';
import { getWorkspaceOperationBatchReview } from './workspace-operation-batch-service';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import type { WorkspaceOperationCheckPublic } from './workspace-operation-check-contract';
import { WorkspaceOperationCheckStore, type WorkspaceOperationCheckRecord } from './workspace-operation-check-store';

const store = new WorkspaceOperationCheckStore();
export function workspaceOperationCheckPublic(job: WorkspaceOperationCheckRecord): WorkspaceOperationCheckPublic {
  return { checkId: job.checkId, workspaceId: job.workspaceId, reviewIds: job.reviewIds,
    status: job.status, batchId: job.batchId, errorCode: job.errorCode, createdAt: job.createdAt, updatedAt: job.updatedAt };
}
export async function getWorkspaceOperationCheck(checkId: string): Promise<WorkspaceOperationCheckPublic | null> {
  const job = await store.get(checkId);
  return job ? workspaceOperationCheckPublic(job) : null;
}
export async function getWorkspaceOperationCheckResult(checkId: string, scope: WorkspaceOperationBatchScope) {
  const check = await getWorkspaceOperationCheck(checkId);
  if (!check) throw new WorkspaceOperationBatchError('CHECK_NOT_FOUND', 404, 'File review check not found.');
  if (check.workspaceId !== scope.workspace.workspaceId || !scope.workspace.permissions.canRead) {
    throw new WorkspaceOperationBatchError('CHECK_ACCESS_DENIED', 403, 'Current workspace access is required.');
  }
  if (check.batchId && ['ready', 'blocked'].includes(check.status)) {
    const batch = await getWorkspaceOperationBatchReview(check.batchId);
    if (!batch || batch.workspaceId !== check.workspaceId) {
      return { check: { ...check, status: 'failed' as const, errorCode: 'CHECK_RESULT_MISSING' } };
    }
    return { check, batch };
  }
  return { check };
}
/** DB-only submission. Workspace traversal belongs to the durable check worker. */
export async function enqueueWorkspaceOperationCheck(input: {
  scope: WorkspaceOperationBatchScope; reviewIds: string[]; requesterUserId: string;
}): Promise<WorkspaceOperationCheckPublic> {
  const workspace = input.scope.workspace;
  if (!workspace.permissions.canRead || !workspace.permissions.canWrite || !workspace.permissions.canDelete
    || workspace.status && workspace.status !== 'active') {
    throw new WorkspaceOperationBatchError('CHECK_ACCESS_DENIED', 403, 'Current workspace permissions are required.');
  }
  if (!input.requesterUserId || !Array.isArray(input.reviewIds) || input.reviewIds.length < 1 || input.reviewIds.length > 50
    || new Set(input.reviewIds).size !== input.reviewIds.length
    || input.reviewIds.some((id) => !/^[A-Za-z0-9_-]{16,128}$/u.test(id))) {
    throw new WorkspaceOperationBatchError('CHECK_INVALID_SELECTION', 422, 'Select between 1 and 50 distinct file reviews.');
  }
  const db = await openDb();
  try {
    const rows = await db.all(`SELECT review_id,source_workspace_id,destination_workspace_id,status,
      successor_review_id,batch_id,request_json FROM workspace_file_operation_reviews WHERE review_id=ANY($1::text[])`,
    [input.reviewIds]) as Record<string, unknown>[];
    if (rows.length !== input.reviewIds.length || rows.some((row) => row.source_workspace_id !== workspace.workspaceId
      || row.destination_workspace_id !== workspace.workspaceId || row.successor_review_id || row.batch_id
      || !['pending','stale','blocked'].includes(String(row.status))
      || !['move','rename','delete'].includes(JSON.parse(String(row.request_json)).kind))) {
      throw new WorkspaceOperationBatchError('REVIEW_CONFLICT', 409, 'Selected file reviews must still be open in this workspace.');
    }
  } finally { await db.close(); }
  return workspaceOperationCheckPublic(await store.enqueue({ workspaceId: workspace.workspaceId,
    requesterUserId: input.requesterUserId, reviewIds: input.reviewIds }));
}
