import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { openDb } from '@/app/lib/db';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';
import { archiveFileCollaborationPaths } from '@/app/lib/files/collaboration-policy';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { withWorkspaceCopyMutationLocks, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { trashWorkspacePaths } from '@/app/lib/filesystem/workspace-trash';
import { fileReviewPolicyService } from '@/app/lib/file-version-center/review-policy-service';
import { buildWorkspaceLinkIndexFromDocuments } from '@/app/lib/markdown/workspace-link-index-core';
import { buildWorkspaceFileOperationPreview, buildWorkspacePlannerSnapshot,
  assertFreshWorkspaceFileOperationPlan } from '@/app/lib/markdown/workspace-file-operation-preview';
import type { WorkspaceFileOperationPreview } from '@/app/lib/markdown/workspace-file-operation-planner';
import { syncPublicSharesAfterDelete } from '@/app/lib/public-sharing/public-file-shares';
import { resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';

import { observeWorkspaceOperation } from './workspace-operation-observability';
import { executeWorkspaceFileOperationService } from './workspace-file-operation-service';
import { WorkspaceOperationJournal } from './workspace-operation-journal';
import type { WorkspaceOperationDeletePreview, WorkspaceOperationReviewKind,
  WorkspaceOperationReviewPreview, WorkspaceOperationReviewPublic,
  WorkspaceOperationReviewStatus, WorkspaceOperationReviewSubmission } from './workspace-operation-review-contract';

type Scope = { workspace: WorkspaceContext; fileOptions: WorkspaceFileOperationOptions };
type Selection = { sourcePath: string; destinationPath?: string };

export type SubmitAgentWorkspacePathOperationInput = {
  kind: WorkspaceOperationReviewKind;
  source: Scope;
  destination?: Scope;
  selections: readonly Selection[];
  actorUserId: string;
  actorId: string;
  actorDisplayName: string;
  actorSessionId?: string;
  idempotencyKey?: string;
};

type StoredRequest = { kind: WorkspaceOperationReviewKind; selections: Selection[] };
type ReviewRow = Record<string, unknown>;

export class WorkspaceOperationReviewError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'WorkspaceOperationReviewError';
  }
}

function fail(code: string, status: number, message: string): never {
  throw new WorkspaceOperationReviewError(code, status, message);
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function ensureReviewAudit(input: {
  reviewId: string; operationId: string; planId: string;
  workspaceId: string; organizationId: string | null; reviewerUserId: string | null;
  actorId: string; kind: WorkspaceOperationReviewKind; selections: Selection[];
  trashEntryIds: string[]; status: WorkspaceOperationReviewStatus;
}): Promise<boolean> {
  const inputHash = sha(['workspace-operation-review-audit-v1', input.reviewId, input.operationId]);
  const existing = await one('SELECT id FROM audit_events WHERE input_hash = $1 AND workspace_id = $2 LIMIT 1',
    [inputHash, input.workspaceId]);
  if (existing) return true;
  const audit = await recordAuditEvent({
    organizationId: input.organizationId, workspaceId: input.workspaceId,
    userId: input.reviewerUserId, source: 'files', eventType: 'file',
    entityType: 'workspace_path', entityId: input.selections[0].sourcePath,
    action: input.kind === 'delete' ? 'file.delete' : `file.${input.kind}`,
    status: input.status === 'applied' ? 'success' : 'failure',
    summary: `Reviewed agent ${input.kind} ${input.status}.`, inputHash,
    metadata: { reviewId: input.reviewId, operationId: input.operationId,
      planId: input.planId, actorId: input.actorId, selections: input.selections,
      trashEntryIds: input.trashEntryIds },
  });
  return Boolean(audit);
}

function readRow(row: ReviewRow): WorkspaceOperationReviewPublic {
  const request = JSON.parse(String(row.request_json)) as StoredRequest;
  const reasons = JSON.parse(String(row.reason_codes_json)) as string[];
  return {
    reviewId: String(row.review_id), planId: String(row.plan_id),
    kind: request.kind, selections: request.selections,
    sourceWorkspaceId: String(row.source_workspace_id),
    destinationWorkspaceId: String(row.destination_workspace_id),
    status: row.status as WorkspaceOperationReviewStatus,
    actor: { type: reasons.includes('USER_FILE_OPERATION') ? 'user' : 'agent', id: String(row.actor_id) },
    reasonCodes: reasons,
    preview: JSON.parse(String(row.preview_json)) as WorkspaceOperationReviewPreview,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    operationId: row.operation_id === null ? null : String(row.operation_id),
    errorCode: row.error_code === null ? null : String(row.error_code),
    trashEntryIds: JSON.parse(String(row.trash_entry_ids_json)) as string[],
    ...(row.batch_id === undefined ? {} : { batchId: row.batch_id == null ? null : String(row.batch_id) }),
    ...(row.previous_review_id === undefined ? {} : { previousReviewId: row.previous_review_id == null ? null : String(row.previous_review_id) }),
    ...(row.successor_review_id === undefined ? {} : { successorReviewId: row.successor_review_id == null ? null : String(row.successor_review_id) }),
  };
}

async function one(sql: string, params: unknown[]): Promise<ReviewRow | null> {
  const connection = await openDb();
  try { return await connection.get(sql, params) as ReviewRow | undefined ?? null; }
  finally { await connection.close(); }
}

async function all(sql: string, params: unknown[]): Promise<ReviewRow[]> {
  const connection = await openDb();
  try { return await connection.all(sql, params) as ReviewRow[]; }
  finally { await connection.close(); }
}

function assertInput(input: SubmitAgentWorkspacePathOperationInput): StoredRequest {
  const source = input.source.workspace;
  const destination = (input.destination ?? input.source).workspace;
  if (source.workspaceId !== destination.workspaceId || !source.permissions.canRead
    || !source.permissions.canRunAgent || !destination.permissions.canWrite
    || input.kind !== 'copy' && (!source.permissions.canWrite || !source.permissions.canDelete)
    || source.status && source.status !== 'active'
    || destination.status && destination.status !== 'active') {
    fail('REVIEW_ACCESS_DENIED', 403, 'Current workspace permissions are required for an agent file proposal.');
  }
  if (!Array.isArray(input.selections) || input.selections.length < 1 || input.selections.length > 1000) {
    fail('REVIEW_INVALID_SELECTION', 422, 'Invalid file proposal selection count.');
  }
  if (!input.actorUserId || !input.actorId || !input.actorDisplayName) {
    fail('REVIEW_INVALID_ACTOR', 422, 'An agent actor is required.');
  }
  const selections = input.selections.map((selection) => {
    const sourcePath = resolveWorkspacePath(source, selection.sourcePath).relativePath;
    const destinationPath = selection.destinationPath === undefined ? undefined
      : resolveWorkspacePath(destination, selection.destinationPath).relativePath;
    if (sourcePath === '.' || isProtectedAppOutputFolder(sourcePath)
      || destinationPath === '.' || destinationPath && isProtectedAppOutputFolder(destinationPath)
      || input.kind !== 'delete' && !destinationPath
      || input.kind === 'delete' && destinationPath !== undefined) {
      fail('REVIEW_INVALID_PATH', 422, 'The proposal contains an unsupported workspace path.');
    }
    return destinationPath === undefined ? { sourcePath } : { sourcePath, destinationPath };
  });
  return { kind: input.kind, selections };
}

function isDescendant(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

async function buildDeletePreview(input: SubmitAgentWorkspacePathOperationInput, request: StoredRequest): Promise<WorkspaceOperationDeletePreview> {
  const snapshot = await buildWorkspacePlannerSnapshot(input.source.workspace.workspaceId, input.source.fileOptions);
  const sourcePaths = request.selections.map((selection) => selection.sourcePath);
  const selected = sourcePaths.map((sourcePath) => snapshot.entries.find((entry) => entry.path === sourcePath));
  const affected = snapshot.entries.filter((entry) => sourcePaths.some((sourcePath) => isDescendant(entry.path, sourcePath)));
  const issues: WorkspaceOperationDeletePreview['issues'] = [];
  selected.forEach((entry, index) => {
    if (!entry) issues.push({ code: 'missing-source', path: sourcePaths[index], detail: 'Selected path is absent.' });
  });
  const sources = snapshot.entries.filter((entry) => entry.kind === 'file' && entry.markdownContent !== undefined)
    .map((entry) => ({ path: entry.path, content: entry.markdownContent! }));
  const omitted = snapshot.entries.filter((entry) => entry.kind === 'file' && entry.omissionReason)
    .map((entry) => ({ path: entry.path, reason: entry.omissionReason === 'source-too-large'
      ? 'too-large' as const : 'unreadable' as const }));
  const index = buildWorkspaceLinkIndexFromDocuments(sources, new Date(0),
    snapshot.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path), omitted);
  const potentialBrokenLinks = index.edges.filter((edge) => edge.status === 'resolved' && edge.targetPath
    && sourcePaths.some((sourcePath) => isDescendant(edge.targetPath!, sourcePath))
    && !sourcePaths.some((sourcePath) => isDescendant(edge.sourcePath, sourcePath)))
    .map((edge) => ({ sourcePath: edge.sourcePath, targetPath: edge.targetPath!, targetLiteral: edge.targetLiteral }));
  if (!index.coverage.complete) issues.push({ code: 'incomplete-index', path: '.', detail: 'Some Markdown sources could not be inspected.' });
  if (potentialBrokenLinks.length > 1000) issues.push({ code: 'link-limit', path: '.', detail: 'Too many affected links to review.' });
  if (affected.length > 1000) issues.push({ code: 'path-limit', path: '.', detail: 'Too many affected paths to review.' });
  const planId = sha({ kind: 'delete', workspaceId: snapshot.workspaceId, selections: request.selections,
    entries: snapshot.entries.map((entry) => [entry.path, entry.identity, entry.contentHash ?? null]),
    coverage: index.coverage, potentialBrokenLinks });
  return { kind: 'delete', planId, readiness: issues.length === 0 ? 'ready' : 'blocked',
    deletedPaths: affected.slice(0, 1000)
      .map((entry) => ({ path: entry.path, kind: entry.kind, identity: entry.identity })),
    potentialBrokenLinks: potentialBrokenLinks.slice(0, 1000), coverage: index.coverage, issues };
}

async function buildPreview(input: SubmitAgentWorkspacePathOperationInput, request: StoredRequest): Promise<WorkspaceOperationReviewPreview> {
  if (request.kind === 'delete') return buildDeletePreview(input, request);
  const destination = input.destination ?? input.source;
  const plan = await buildWorkspaceFileOperationPreview({
    kind: request.kind,
    sourceWorkspaceId: input.source.workspace.workspaceId,
    destinationWorkspaceId: destination.workspace.workspaceId,
    sourceOptions: input.source.fileOptions,
    destinationOptions: destination.fileOptions,
    selections: request.selections.map((selection) => ({
      sourcePath: selection.sourcePath, destinationPath: selection.destinationPath!,
    })),
  });
  const { previewContents: _contents, ...publicPlan } = plan;
  return publicPlan;
}

async function policyReasons(input: SubmitAgentWorkspacePathOperationInput,
  preview: WorkspaceOperationReviewPreview): Promise<string[]> {
  const affectedPaths = 'deletedPaths' in preview
    ? [...preview.deletedPaths.map((entry) => entry.path), ...preview.potentialBrokenLinks.map((link) => link.sourcePath)]
    : [...preview.pathMappings.map((mapping) => mapping.sourcePath), ...preview.linkEdits.map((edit) => edit.sourcePathBefore)];
  if (affectedPaths.length === 0) return [];
  try {
    const rows = await all(`SELECT id, lineage_id FROM collaboration_documents
      WHERE workspace_id = $1 AND status = 'active' AND path = ANY($2::text[])`,
    [input.source.workspace.workspaceId, [...new Set(affectedPaths)] ]);
    if (rows.length > 1000 || rows.some((row) => !row.lineage_id)) return ['POLICY_UNAVAILABLE'];
    const access = { userId: input.actorUserId,
      authenticatedWorkspaceId: input.source.workspace.workspaceId,
      requestedWorkspaceId: input.source.workspace.workspaceId,
      membership: 'active' as const, permissionsResolved: true,
      canRead: input.source.workspace.permissions.canRead,
      canWrite: input.source.workspace.permissions.canWrite,
      canRunAgent: input.source.workspace.permissions.canRunAgent };
    for (const lineageId of new Set(rows.map((row) => String(row.lineage_id)))) {
      const policy = await fileReviewPolicyService.readAuthorized({ access, lineageId,
        evaluation: { hardSafetyRequiresReview: false, workspacePolicy: 'allow_user_choice',
          operationExplicitlyRequiresReview: false } });
      if (policy.effectiveMode === 'review_required') return ['REVIEW_POLICY'];
    }
    return [];
  } catch { return ['POLICY_UNAVAILABLE']; }
}

/** A path operation is a separate workspace-level review scope, never a document graph proposal. */
export async function submitAgentWorkspacePathOperation(input: SubmitAgentWorkspacePathOperationInput): Promise<WorkspaceOperationReviewSubmission> {
  const request = assertInput(input);
  const sourceWorkspaceId = input.source.workspace.workspaceId;
  const destinationWorkspaceId = (input.destination ?? input.source).workspace.workspaceId;
  const requestHash = sha({ request, sourceWorkspaceId, destinationWorkspaceId,
    actorUserId: input.actorUserId, actorId: input.actorId, actorSessionId: input.actorSessionId ?? null });
  const reviewId = input.idempotencyKey
    ? sha(['workspace-operation-review-v1', sourceWorkspaceId, input.actorUserId,
      input.actorSessionId ?? null, input.idempotencyKey]) : randomUUID();
  const existing = await one('SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1', [reviewId]);
  if (existing) {
    if (existing.request_hash !== requestHash) fail('REVIEW_IDEMPOTENCY_CONFLICT', 409, 'The review retry key belongs to another request.');
    const review = readRow(existing);
    return review.status === 'pending' ? { mode: 'needs_review', reviewId, planId: review.planId,
      status: 'pending', workspaceId: sourceWorkspaceId }
      : { mode: 'blocked', reviewId, planId: review.planId, workspaceId: sourceWorkspaceId,
        status: review.status, code: 'REVIEW_ALREADY_CLOSED', message: 'The earlier review is no longer pending.' };
  }
  const preview = await buildPreview(input, request);
  const blocked = preview.readiness !== 'ready';
  const collision = blocked && !('deletedPaths' in preview) && preview.collisions.length > 0;
  const reasons = ['AGENT_FILE_OPERATION'];
  if ('deletedPaths' in preview) reasons.push('DELETE');
  else {
    if (preview.linkEdits.length > 0) reasons.push('LINKS_REWRITTEN');
    if (preview.pathMappings.length > request.selections.length) reasons.push('DIRECTORY_SCOPE');
  }
  if (blocked) reasons.push(collision ? 'DESTINATION_COLLISION' : 'INCOMPLETE_PREVIEW');
  reasons.push(...await policyReasons(input, preview));
  const now = Date.now();
  const inserted = await one(`INSERT INTO workspace_file_operation_reviews
      (review_id, plan_id, request_hash, request_json, preview_json,
       source_workspace_id, destination_workspace_id, actor_user_id, actor_id,
       actor_session_id, actor_display_name, status, reason_codes_json, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
      ON CONFLICT (review_id) DO NOTHING RETURNING *`,
    [reviewId, preview.planId, requestHash, JSON.stringify(request), JSON.stringify(preview),
      sourceWorkspaceId, destinationWorkspaceId, input.actorUserId, input.actorId,
      input.actorSessionId ?? null, input.actorDisplayName, blocked ? 'blocked' : 'pending',
      JSON.stringify(reasons), now]);
  if (!inserted) {
    const concurrent = await one('SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1', [reviewId]);
    if (!concurrent || concurrent.request_hash !== requestHash || concurrent.plan_id !== preview.planId) {
      fail('REVIEW_IDEMPOTENCY_CONFLICT', 409, 'The review changed while creating it.');
    }
  } else {
    if (!preview.coverage.complete) observeWorkspaceOperation({ scope: 'review', kind: request.kind, phase: 'preview',
      outcome: 'incomplete_link_plan', omittedSourceCount: preview.coverage.omittedSources.length,
      unresolvedLinkCount: preview.coverage.unresolvedLinks.length });
    if (collision) observeWorkspaceOperation({ scope: 'review', kind: request.kind,
      phase: 'preview', outcome: 'conflict' });
  }
  return blocked
    ? { mode: 'blocked', reviewId, planId: preview.planId, workspaceId: sourceWorkspaceId,
      status: 'blocked', code: collision ? 'PREVIEW_UNSUPPORTED_OVERWRITE' : 'PREVIEW_BLOCKED',
      message: collision ? 'Overwrite requires a complete reviewed executor.' : 'The file operation preview is incomplete.' }
    : { mode: 'needs_review', reviewId, planId: preview.planId, status: 'pending', workspaceId: sourceWorkspaceId };
}

async function rawWorkspaceOperationReview(reviewId: string): Promise<ReviewRow | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(reviewId)) return null;
  return one('SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1', [reviewId]);
}

/** A process crash leaves `applying`; never blindly replay an unreceipted path step. */
export async function getWorkspaceOperationReview(reviewId: string): Promise<WorkspaceOperationReviewPublic | null> {
  const row = await rawWorkspaceOperationReview(reviewId);
  if (!row) return null;
  const review = readRow(row);
  if (review.batchId) return review;
  const auditRetry = review.status === 'needs_recovery' && review.errorCode === 'AUDIT_WRITE_FAILED';
  if (!auditRetry && (review.status !== 'applying' || Date.now() - review.updatedAt < 120_000)) return review;
  try {
    return await withWorkspaceMutationLock(review.sourceWorkspaceId, async () => {
      const currentRow = await rawWorkspaceOperationReview(reviewId);
      if (!currentRow) return null;
      const current = readRow(currentRow);
      if (current.status === 'needs_recovery' && current.errorCode === 'AUDIT_WRITE_FAILED'
        && current.operationId) {
        const request = JSON.parse(String(currentRow.request_json)) as StoredRequest;
        const recorded = await ensureReviewAudit({ reviewId, operationId: current.operationId,
          planId: current.planId, workspaceId: current.sourceWorkspaceId, organizationId: null,
          reviewerUserId: currentRow.reviewer_user_id === null ? null : String(currentRow.reviewer_user_id),
          actorId: current.actor.id, kind: current.kind, selections: request.selections,
          trashEntryIds: current.trashEntryIds, status: 'applied' });
        if (!recorded) return current;
        return await updateReview(reviewId, 'needs_recovery', 'applied',
          { operationId: current.operationId, errorCode: null }) ?? current;
      }
      if (current.status !== 'applying' || Date.now() - current.updatedAt < 120_000) return current;
      const journal = current.kind === 'delete' || !current.operationId ? null
        : await new WorkspaceOperationJournal().get(current.operationId).catch(() => null);
      const nextStatus: WorkspaceOperationReviewStatus = current.kind === 'delete'
        ? 'needs_recovery'
        : journal?.status === 'completed' ? 'applied'
          : journal?.status === 'failed' ? 'failed' : 'needs_recovery';
      let auditWritten = false;
      if (nextStatus === 'applied') {
        const request = JSON.parse(String(currentRow.request_json)) as StoredRequest;
        auditWritten = await ensureReviewAudit({ reviewId,
          operationId: current.operationId!, planId: current.planId,
          workspaceId: current.sourceWorkspaceId, organizationId: null,
          reviewerUserId: currentRow.reviewer_user_id === null ? null : String(currentRow.reviewer_user_id),
          actorId: current.actor.id, kind: current.kind, selections: request.selections,
          trashEntryIds: current.trashEntryIds, status: 'applied' });
      }
      const recordedStatus = nextStatus === 'applied' && !auditWritten ? 'needs_recovery' : nextStatus;
      return await updateReview(reviewId, 'applying', recordedStatus, {
        operationId: current.operationId, trashEntryIds: current.trashEntryIds,
        errorCode: nextStatus === 'applied' ? auditWritten ? null : 'AUDIT_WRITE_FAILED'
          : 'APPLY_INTERRUPTED',
      }) ?? readRow((await rawWorkspaceOperationReview(reviewId))!);
    });
  } catch {
    // A live writer may still own the lock; preserve its state until another read.
    return review;
  }
}

export async function listWorkspaceOperationReviews(workspaceId: string): Promise<WorkspaceOperationReviewPublic[]> {
  const rows = await all(`SELECT * FROM workspace_file_operation_reviews
    WHERE source_workspace_id = $1 AND successor_review_id IS NULL
      AND status IN ('pending','queued','blocked','stale','needs_recovery','failed','applying','applied')
    ORDER BY CASE WHEN status = 'applied' THEN 1 ELSE 0 END, created_at DESC, review_id DESC LIMIT 100`, [workspaceId]);
  return rows.map(readRow);
}

async function updateReview(reviewId: string, expectedStatus: WorkspaceOperationReviewStatus,
  status: WorkspaceOperationReviewStatus, changes: { operationId?: string | null; errorCode?: string | null;
    trashEntryIds?: string[]; reviewerUserId?: string } = {}): Promise<WorkspaceOperationReviewPublic | null> {
  const row = await one(`UPDATE workspace_file_operation_reviews SET status = $3,
    operation_id = COALESCE($4, operation_id), error_code = $5,
    trash_entry_ids_json = COALESCE($6, trash_entry_ids_json),
    reviewer_user_id = COALESCE($7, reviewer_user_id),
    revision = revision + 1, updated_at = $8
    WHERE review_id = $1 AND status = $2 RETURNING *`,
  [reviewId, expectedStatus, status, changes.operationId ?? null, changes.errorCode ?? null,
    changes.trashEntryIds ? JSON.stringify(changes.trashEntryIds) : null,
    changes.reviewerUserId ?? null, Date.now()]);
  if (!row) return null;
  const review = readRow(row);
  if (expectedStatus !== status) {
    const outcome = status === 'stale' ? 'conflict'
      : status === 'needs_recovery' ? 'needs_recovery'
        : status === 'failed' ? 'failed' : null;
    if (outcome) observeWorkspaceOperation({ scope: 'review', kind: review.kind,
      phase: status === 'needs_recovery' ? 'recovery' : 'apply', outcome });
  }
  return review;
}

export async function rejectWorkspaceOperationReview(reviewId: string, planId: string): Promise<WorkspaceOperationReviewPublic> {
  const review = await getWorkspaceOperationReview(reviewId);
  if (!review) fail('REVIEW_NOT_FOUND', 404, 'File operation review not found.');
  if (review.planId !== planId) fail('PREVIEW_STALE', 409, 'The reviewed plan identity changed.');
  if (review.status === 'rejected') return review;
  if (!['pending', 'blocked', 'stale'].includes(review.status)) {
    fail('REVIEW_CONFLICT', 409, 'This review has an operation outcome that cannot be dismissed.');
  }
  const changed = await updateReview(reviewId, review.status, 'rejected');
  if (!changed) fail('REVIEW_CONFLICT', 409, 'The review changed while rejecting it.');
  return changed;
}

export async function acceptWorkspaceOperationReview(input: {
  reviewId: string; planId: string; source: Scope; destination: Scope;
  reviewerUserId: string; reviewerDisplayName: string;
  /** Re-resolve membership and permissions after acquiring the mutation lock. */
  refreshAccess: () => Promise<{ source: Scope; destination: Scope }>;
}): Promise<WorkspaceOperationReviewPublic> {
  const review = await getWorkspaceOperationReview(input.reviewId);
  if (!review) fail('REVIEW_NOT_FOUND', 404, 'File operation review not found.');
  if (review.planId !== input.planId) fail('PREVIEW_STALE', 409, 'The reviewed plan identity changed.');
  if (review.status === 'applied') return review;
  if (review.status !== 'pending') fail('REVIEW_CONFLICT', 409, 'The review is no longer pending.');
  if (review.sourceWorkspaceId !== input.source.workspace.workspaceId
    || review.destinationWorkspaceId !== input.destination.workspace.workspaceId
    || !input.source.workspace.permissions.canRead || !input.destination.workspace.permissions.canWrite
    || review.kind !== 'copy' && (!input.source.workspace.permissions.canWrite
      || !input.source.workspace.permissions.canDelete)) {
    fail('REVIEW_ACCESS_DENIED', 403, 'Current workspace permissions are required to accept this review.');
  }
  const lock = review.kind === 'copy'
    ? <T>(operation: () => Promise<T>) => withWorkspaceCopyMutationLocks(input.source.fileOptions, input.destination.fileOptions, operation)
    : <T>(operation: () => Promise<T>) => withWorkspaceMutationLock(review.sourceWorkspaceId, operation);
  return lock(async () => {
    const fresh = await input.refreshAccess();
    if (fresh.source.workspace.workspaceId !== review.sourceWorkspaceId
      || fresh.destination.workspace.workspaceId !== review.destinationWorkspaceId
      || !fresh.source.workspace.permissions.canRead || !fresh.destination.workspace.permissions.canWrite
      || review.kind !== 'copy' && (!fresh.source.workspace.permissions.canWrite
        || !fresh.source.workspace.permissions.canDelete)
      || fresh.source.workspace.status && fresh.source.workspace.status !== 'active'
      || fresh.destination.workspace.status && fresh.destination.workspace.status !== 'active') {
      fail('REVIEW_ACCESS_DENIED', 403, 'Workspace access changed before accepting the review.');
    }
    const current = await getWorkspaceOperationReview(input.reviewId);
    if (!current || current.status !== 'pending' || current.planId !== input.planId) {
      fail('REVIEW_CONFLICT', 409, 'The review changed while accepting it.');
    }
    const stored = await one('SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1', [input.reviewId]);
    if (!stored) fail('REVIEW_NOT_FOUND', 404, 'File operation review not found.');
    const request = JSON.parse(String(stored.request_json)) as StoredRequest;
    if (request.kind !== 'copy' && request.selections.length > 1) {
      fail('BATCH_REVIEW_REQUIRED', 409,
        'Multiple selected paths require a fresh combined preview before approval.');
    }
    const actorId = String(stored.actor_id);
    const actorSessionId = stored.actor_session_id === null ? undefined : String(stored.actor_session_id);
    const buildInput: SubmitAgentWorkspacePathOperationInput = {
      kind: request.kind, selections: request.selections,
      source: fresh.source, destination: fresh.destination,
      actorUserId: String(stored.actor_user_id), actorId,
      actorDisplayName: String(stored.actor_display_name), actorSessionId,
    };
    const currentPreview = await buildPreview(buildInput, request);
    if (currentPreview.planId !== review.planId || currentPreview.readiness !== 'ready') {
      await updateReview(input.reviewId, 'pending', 'stale', { errorCode: 'PREVIEW_STALE' });
      fail('PREVIEW_STALE', 409, 'Files changed since this review. Create a fresh proposal.');
    }
    if ('deletedPaths' in currentPreview && currentPreview.potentialBrokenLinks.length > 0) {
      fail('BATCH_REVIEW_REQUIRED', 409,
        'This deletion affects Markdown links. Open a fresh combined preview to review link cleanup before approval.');
    }
    const operationId = sha(['workspace-operation-review-apply-v1', review.reviewId]);
    const reserved = await updateReview(input.reviewId, 'pending', 'applying',
      { operationId, reviewerUserId: input.reviewerUserId });
    if (!reserved) fail('REVIEW_CONFLICT', 409, 'Another reviewer accepted this proposal.');
    try {
      let trashEntryIds: string[] = [];
      let status: WorkspaceOperationReviewStatus = 'applied';
      if (request.kind === 'delete') {
        const trashed = await trashWorkspacePaths({ workspace: fresh.source.workspace,
          paths: request.selections.map((selection) => selection.sourcePath), deletedByUserId: input.reviewerUserId });
        trashEntryIds = trashed.trashed.map((entry) => entry.id);
        await updateReview(input.reviewId, 'applying', 'applying', { operationId, trashEntryIds });
        if (trashed.failed.length > 0 || trashEntryIds.length !== request.selections.length) {
          status = 'needs_recovery';
        }
        await archiveFileCollaborationPaths({ workspace: fresh.source.workspace,
          paths: trashed.trashed.map((entry) => ({ path: entry.originalPath, trashEntryId: entry.id })) });
        await syncPublicSharesAfterDelete(trashed.trashed.map((entry) => entry.originalPath), fresh.source.workspace);
        invalidateWorkspaceFileViews({ fileOptions: fresh.source.fileOptions, fullTree: true,
          mutations: trashed.trashed.map((entry) => ({ path: entry.originalPath, type: 'unlink' as const })) });
      } else {
        assertFreshWorkspaceFileOperationPlan(currentPreview as WorkspaceFileOperationPreview, input.planId);
        const execution = await executeWorkspaceFileOperationService({
          operationId, kind: request.kind,
          source: fresh.source, destination: fresh.destination,
          selections: request.selections.map((selection) => ({ sourcePath: selection.sourcePath,
            destinationPath: selection.destinationPath! })),
          expectedPlanId: input.planId,
          actorUserId: input.reviewerUserId, actorId: input.reviewerUserId,
          actorDisplayName: input.reviewerDisplayName,
          actorType: 'user',
        });
        status = execution.execution.status === 'complete' ? 'applied'
          : execution.execution.status === 'needs_recovery' ? 'needs_recovery' : 'failed';
        invalidateWorkspaceFileViews({ fileOptions: fresh.destination.fileOptions, fullTree: true });
      }
      const auditWritten = await ensureReviewAudit({ reviewId: review.reviewId, operationId,
        planId: input.planId, workspaceId: fresh.source.workspace.workspaceId,
        organizationId: fresh.source.workspace.organizationId ?? null,
        reviewerUserId: input.reviewerUserId, actorId,
        kind: request.kind, selections: request.selections, trashEntryIds, status });
      const recordedStatus = !auditWritten ? 'needs_recovery' : status;
      const completed = await updateReview(input.reviewId, 'applying', recordedStatus,
        { operationId, errorCode: !auditWritten ? 'AUDIT_WRITE_FAILED'
          : status === 'applied' ? null : 'OPERATION_INCOMPLETE', trashEntryIds });
      if (!completed) fail('REVIEW_CONFLICT', 409, 'The review result could not be recorded.');
      return completed;
    } catch (error) {
      const journal = request.kind === 'delete' ? null : await new WorkspaceOperationJournal().get(operationId).catch(() => null);
      const recoveryRequired = request.kind === 'delete' || journal?.status === 'running' || journal?.status === 'recovery_required';
      await updateReview(input.reviewId, 'applying', recoveryRequired ? 'needs_recovery' : 'failed',
        { operationId, errorCode: error instanceof Error ? error.name.slice(0, 128) : 'UNKNOWN' }).catch(() => null);
      throw error;
    }
  });
}

/** Preserve the accepted review's immutable bytes and make dependent open previews visibly stale. */
export async function markDependentWorkspaceOperationReviews(input: {
  scope: WorkspaceOperationBatchScope; plan: WorkspaceOperationBatchPlan;
  excludedReviewIds: string[]; undo?: boolean;
}): Promise<void> {
  const touched = [
    ...input.plan.pathSteps.flatMap((step) => [step.sourcePath, ...(step.destinationPath ? [step.destinationPath] : [])]),
    ...input.plan.linkEdits.flatMap((edit) => [edit.sourcePathBefore, edit.sourcePathAfter]),
  ];
  const rows = await all(`SELECT * FROM workspace_file_operation_reviews WHERE source_workspace_id = $1
    AND status IN ('pending','blocked','stale') AND successor_review_id IS NULL AND batch_id IS NULL`,
  [input.scope.workspace.workspaceId]);
  for (const row of rows) {
    if (input.excludedReviewIds.includes(String(row.review_id))) continue;
    const request = JSON.parse(String(row.request_json)) as StoredRequest;
    const preview = JSON.parse(String(row.preview_json)) as WorkspaceOperationReviewPreview;
    const paths = request.selections.flatMap((selection) => [selection.sourcePath,
      ...(selection.destinationPath ? [selection.destinationPath] : [])]);
    if ('expectedPathState' in preview) paths.push(...preview.expectedPathState.map((entry) => entry.path));
    else paths.push(...preview.potentialBrokenLinks.map((link) => link.sourcePath));
    if (!paths.some((candidate) => touched.some((changed) => isDescendant(candidate, changed) || isDescendant(changed, candidate)))) continue;
    await updateReview(String(row.review_id), row.status as WorkspaceOperationReviewStatus, 'stale',
      { errorCode: input.undo ? 'DEPENDENCY_UNDONE' : 'DEPENDENCY_CHANGED' });
  }
}

async function rebaseReviewSelections(review: WorkspaceOperationReviewPublic, request: StoredRequest,
  scope: Scope): Promise<StoredRequest> {
  const snapshot = await buildWorkspacePlannerSnapshot(scope.workspace.workspaceId, scope.fileOptions);
  const current = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const sameObject = (left: string, right: string) => left.split(':').slice(0, 2).join(':') === right.split(':').slice(0, 2).join(':');
  const originalIdentity = (sourcePath: string) => 'deletedPaths' in review.preview
    ? review.preview.deletedPaths.find((entry) => entry.path === sourcePath)?.identity
    : review.preview.pathMappings.find((mapping) => mapping.sourcePath === sourcePath)?.sourceIdentity;
  const applied = await all(`SELECT preview_json FROM workspace_file_operation_reviews
    WHERE source_workspace_id = $1 AND status = 'applied' AND updated_at >= $2`, [review.sourceWorkspaceId, review.createdAt]);
  const batches = await all(`SELECT plan_json FROM workspace_file_operation_batches
    WHERE workspace_id = $1 AND status = 'applied' AND updated_at >= $2`, [review.sourceWorkspaceId, review.createdAt]);
  const mappings: WorkspaceOperationBatchPlan['pathMappings'] = [];
  for (const row of [...applied, ...batches]) {
    const plan = JSON.parse(String(row.plan_json ?? row.preview_json)) as { kind?: string; pathMappings?: WorkspaceOperationBatchPlan['pathMappings'] };
    if (plan.kind === 'copy') continue;
    mappings.push(...(plan.pathMappings ?? []));
  }
  return { ...request, selections: request.selections.map((selection) => {
    if (current.has(selection.sourcePath)) return selection;
    const identity = originalIdentity(selection.sourcePath);
    if (!identity) return selection;
    const candidates = mappings.filter((mapping) => mapping.sourcePath === selection.sourcePath
      && sameObject(identity, mapping.sourceIdentity)
      && current.has(mapping.destinationPath)
      && sameObject(mapping.sourceIdentity, current.get(mapping.destinationPath)!.identity));
    const destinations = [...new Set(candidates.map((mapping) => mapping.destinationPath))];
    return destinations.length === 1 ? { ...selection, sourcePath: destinations[0]! } : selection;
  }) };
}

/** Refresh creates an immutable successor. The previous proposal remains addressable as history. */
export async function refreshWorkspaceOperationReview(input: {
  reviewId: string; planId: string; source: Scope; destination: Scope;
  reviewerUserId: string; refreshAccess: () => Promise<{ source: Scope; destination: Scope }>;
}): Promise<WorkspaceOperationReviewPublic> {
  const original = await rawWorkspaceOperationReview(input.reviewId);
  if (!original) fail('REVIEW_NOT_FOUND', 404, 'File operation review not found.');
  const review = readRow(original);
  if (review.planId !== input.planId) fail('PREVIEW_STALE', 409, 'The exact existing plan is required to refresh.');
  return withWorkspaceMutationLock(review.sourceWorkspaceId, async () => {
    const fresh = await input.refreshAccess();
    if (fresh.source.workspace.workspaceId !== review.sourceWorkspaceId
      || fresh.destination.workspace.workspaceId !== review.destinationWorkspaceId
      || !fresh.source.workspace.permissions.canRead || !fresh.destination.workspace.permissions.canWrite
      || review.kind !== 'copy' && (!fresh.source.workspace.permissions.canWrite || !fresh.source.workspace.permissions.canDelete)) {
      fail('REVIEW_ACCESS_DENIED', 403, 'Workspace access changed before refreshing the review.');
    }
    const current = await rawWorkspaceOperationReview(input.reviewId);
    if (!current) fail('REVIEW_NOT_FOUND', 404, 'File operation review not found.');
    if (current.successor_review_id) return (await getWorkspaceOperationReview(String(current.successor_review_id)))!;
    if (!['pending', 'blocked', 'stale'].includes(String(current.status)) || current.batch_id) {
      fail('REVIEW_CONFLICT', 409, 'Queued or executed actions cannot be refreshed as new proposals.');
    }
    const request = await rebaseReviewSelections(review, JSON.parse(String(current.request_json)) as StoredRequest, fresh.source);
    const buildInput: SubmitAgentWorkspacePathOperationInput = { kind: request.kind, selections: request.selections,
      source: fresh.source, destination: fresh.destination, actorUserId: String(current.actor_user_id),
      actorId: String(current.actor_id), actorDisplayName: String(current.actor_display_name),
      actorSessionId: current.actor_session_id == null ? undefined : String(current.actor_session_id) };
    const preview = await buildPreview(buildInput, request);
    const reviewId = randomUUID();
    const now = Date.now();
    const reasons = [review.actor.type === 'user' ? 'USER_FILE_OPERATION' : 'AGENT_FILE_OPERATION',
      'REFRESHED_PREVIEW', ...(preview.readiness === 'blocked' ? ['INCOMPLETE_PREVIEW'] : [])];
    return executeLifecycleTransaction({ openConnection: openDb, execute: async (db) => {
      const locked = await db.get(`SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1 FOR UPDATE`, [input.reviewId]) as ReviewRow;
      if (locked.successor_review_id) return readRow((await db.get(`SELECT * FROM workspace_file_operation_reviews WHERE review_id = $1`, [locked.successor_review_id])) as ReviewRow);
      if (locked.plan_id !== input.planId || !['pending', 'blocked', 'stale'].includes(String(locked.status)) || locked.batch_id) {
        fail('REVIEW_CONFLICT', 409, 'The review changed while refreshing it.');
      }
      const inserted = await db.get(`INSERT INTO workspace_file_operation_reviews
        (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
         actor_user_id,actor_id,actor_session_id,actor_display_name,status,reason_codes_json,previous_review_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
      [reviewId, preview.planId, sha({ request, previousReviewId: review.reviewId }), JSON.stringify(request), JSON.stringify(preview),
        review.sourceWorkspaceId, review.destinationWorkspaceId, current.actor_user_id, current.actor_id, current.actor_session_id,
        current.actor_display_name, preview.readiness === 'ready' ? 'pending' : 'blocked', JSON.stringify(reasons), review.reviewId, now]);
      await db.run(`UPDATE workspace_file_operation_reviews SET status = 'stale', error_code = 'REVIEW_REFRESHED',
        successor_review_id = $2, revision = revision + 1, updated_at = $3 WHERE review_id = $1`, [review.reviewId, reviewId, now]);
      return readRow(inserted as ReviewRow);
    }, recoverCommitted: async (value, commitError) => {
      const persisted = await getWorkspaceOperationReview(value.reviewId);
      if (persisted?.planId === value.planId && persisted.previousReviewId === review.reviewId) return persisted;
      throw commitError;
    } });
  });
}
