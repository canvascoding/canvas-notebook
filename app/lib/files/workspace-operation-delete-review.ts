import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import { buildWorkspaceLinkIndexFromDocuments } from '@/app/lib/markdown/workspace-link-index-core';
import { buildWorkspacePlannerSnapshot } from '@/app/lib/markdown/workspace-file-operation-preview';
import { buildWorkspaceOperationBatchPlan } from './workspace-operation-batch-plan';
import type { WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';
import type { WorkspaceOperationDeletePreview } from './workspace-operation-review-contract';

export type WorkspaceDeleteReviewRequired = {
  reviewId: string; planId: string; workspaceId: string; status: 'pending' | 'blocked';
};

/** Called inside the workspace mutation lock. Linked deletion always needs explicit cleanup approval. */
export async function reviewWorkspaceDeletionIfRequired(input: {
  scope: WorkspaceOperationBatchScope; paths: string[]; userId: string; displayName: string;
}): Promise<{ reviewRequired: WorkspaceDeleteReviewRequired; blocked: boolean } | null> {
  const reviewId = randomUUID();
  const selections = input.paths.map((sourcePath) => ({
    sourcePath: resolveWorkspacePath(input.scope.workspace, sourcePath).relativePath,
  }));
  const request = { kind: 'delete' as const, selections };
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
    await db.run(`INSERT INTO workspace_file_operation_reviews
      (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
       actor_user_id,actor_id,actor_display_name,status,reason_codes_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$7,$8,$9,$10,$11,$11)`,
    [reviewId, plan.planId, createHash('sha256').update(JSON.stringify({ request, userId: input.userId })).digest('hex'),
      JSON.stringify(request), JSON.stringify(preview), input.scope.workspace.workspaceId,
      input.userId, input.displayName, blocked ? 'blocked' : 'pending', JSON.stringify(reasons), now]);
  } finally { await db.close(); }
  return { blocked, reviewRequired: { reviewId, planId: plan.planId,
    workspaceId: input.scope.workspace.workspaceId, status: blocked ? 'blocked' : 'pending' } };
}
