import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import { buildWorkspaceLinkIndexFromDocuments } from '@/app/lib/markdown/workspace-link-index-core';
import { buildWorkspacePlannerSnapshot } from '@/app/lib/markdown/workspace-file-operation-preview';
import { buildWorkspaceOperationBatchPlan } from './workspace-operation-batch-plan';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import type { WorkspaceOperationDeletePreview, WorkspaceOperationReviewStatus } from './workspace-operation-review-contract';
import { WorkspaceOperationReviewError } from './workspace-operation-review-service';

export type WorkspaceDeleteReviewRequired = {
  reviewId: string; planId: string; workspaceId: string; status: WorkspaceOperationReviewStatus;
};
export type WorkspaceDeletionReviewInput = {
  scope: WorkspaceOperationBatchScope; paths: string[]; userId: string; displayName: string; idempotencyKey?: string;
};
type DeletionReviewResult = { reviewRequired: WorkspaceDeleteReviewRequired; blocked: boolean };

function assertDocumentReviewEnabled(): void {
  if (!readDocumentReviewAvailability().documentReviewEnabled) {
    throw new WorkspaceOperationReviewError('DOCUMENT_REVIEW_DISABLED', 409, 'The experimental Review Center is disabled.');
  }
}

function deletionReviewIdentity(input: WorkspaceDeletionReviewInput) {
  if (!input.userId || !input.scope.workspace.permissions.canRead || !input.scope.workspace.permissions.canWrite
    || !input.scope.workspace.permissions.canDelete || input.scope.workspace.status && input.scope.workspace.status !== 'active') {
    throw new WorkspaceOperationReviewError('REVIEW_ACCESS_DENIED', 403, 'Current workspace permissions are required.');
  }
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string'
    || !input.idempotencyKey.trim() || input.idempotencyKey.length > 512)) {
    throw new WorkspaceOperationReviewError('REVIEW_INVALID_IDEMPOTENCY_KEY', 422, 'Invalid file action identity.');
  }
  const selections = input.paths.map((sourcePath) => ({ sourcePath: resolveWorkspacePath(input.scope.workspace, sourcePath).relativePath }));
  const request = { kind: 'delete' as const, selections };
  return { request, selections,
    reviewId: input.idempotencyKey ? createHash('sha256').update(JSON.stringify(['workspace-manual-delete-review-v1',
      input.scope.workspace.workspaceId, input.userId, input.idempotencyKey])).digest('hex') : randomUUID(),
    requestHash: createHash('sha256').update(JSON.stringify({ request, userId: input.userId })).digest('hex') };
}

/** Look up the original manual review without traversing paths or creating a new proposal. */
export async function getExistingWorkspaceDeletionReview(input: WorkspaceDeletionReviewInput): Promise<DeletionReviewResult | null> {
  if (!input.idempotencyKey) return null;
  const identity = deletionReviewIdentity(input);
  const db = await openDb();
  try {
    const row = await db.get('SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1', [identity.reviewId]) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.request_hash !== identity.requestHash || row.source_workspace_id !== input.scope.workspace.workspaceId
      || row.destination_workspace_id !== input.scope.workspace.workspaceId || row.actor_user_id !== input.userId) {
      throw new WorkspaceOperationReviewError('REVIEW_IDEMPOTENCY_CONFLICT', 409, 'The review retry key belongs to another request.');
    }
    return { blocked: row.status === 'blocked', reviewRequired: { reviewId: identity.reviewId,
      planId: String(row.plan_id), workspaceId: input.scope.workspace.workspaceId, status: row.status as WorkspaceOperationReviewStatus } };
  } finally { await db.close(); }
}

/** Called inside the workspace mutation lock when experimental cleanup review is enabled. */
export async function reviewWorkspaceDeletionIfRequired(input: WorkspaceDeletionReviewInput): Promise<DeletionReviewResult | null> {
  const existing = await getExistingWorkspaceDeletionReview(input);
  if (existing) return existing;
  assertDocumentReviewEnabled();
  const { reviewId, selections, request, requestHash } = deletionReviewIdentity(input);
  const plan = await buildWorkspaceOperationBatchPlan({ scope: input.scope,
    actions: [{ reviewId, ...request }] });
  if (plan.readiness === 'ready' && plan.linkEdits.length === 0) return null;

  const blocked = plan.readiness !== 'ready';
  const snapshot = await buildWorkspacePlannerSnapshot(input.scope.workspace.workspaceId, input.scope.fileOptions);
  const index = buildWorkspaceLinkIndexFromDocuments(snapshot.entries
    .filter((entry) => entry.kind === 'file' && entry.markdownContent !== undefined)
    .map((entry) => ({ path: entry.path, content: entry.markdownContent! })), new Date(0),
  snapshot.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
  const selected = (candidate: string) => selections.some((selection) => candidate === selection.sourcePath
    || candidate.startsWith(`${selection.sourcePath}/`));
  const preview: WorkspaceOperationDeletePreview = {
    kind: 'delete', planId: plan.planId, readiness: plan.readiness,
    deletedPaths: plan.deletedPaths,
    potentialBrokenLinks: index.edges.filter((edge) => edge.status === 'resolved' && edge.targetPath
      && selected(edge.targetPath) && !selected(edge.sourcePath)).map((edge) => ({
      sourcePath: edge.sourcePath, targetPath: edge.targetPath!, targetLiteral: edge.targetLiteral })),
    coverage: plan.coverage, issues: plan.issues,
  };
  const reasons = ['USER_FILE_OPERATION', 'DELETE', 'LINK_CLEANUP_REQUIRED',
    ...(blocked ? ['INCOMPLETE_PREVIEW'] : [])];
  const now = Date.now();
  const db = await openDb();
  try {
    assertDocumentReviewEnabled();
    await db.run(`INSERT INTO workspace_file_operation_reviews
      (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
       actor_user_id,actor_id,actor_display_name,status,reason_codes_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$7,$8,$9,$10,$11,$11)
      ON CONFLICT (review_id) DO NOTHING`,
    [reviewId, plan.planId, requestHash,
      JSON.stringify(request), JSON.stringify(preview), input.scope.workspace.workspaceId,
      input.userId, input.displayName, blocked ? 'blocked' : 'pending', JSON.stringify(reasons), now]);
  } finally { await db.close(); }
  if (input.idempotencyKey) return (await getExistingWorkspaceDeletionReview(input))!;
  return { blocked, reviewRequired: { reviewId, planId: plan.planId,
    workspaceId: input.scope.workspace.workspaceId, status: blocked ? 'blocked' : 'pending' } };
}
