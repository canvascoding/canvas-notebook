import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { getExistingDirectWorkspacePathOperation, submitDirectWorkspacePathOperation,
  waitForWorkspacePathOperation } from '@/app/lib/files/workspace-path-operation-service';
import { workspacePathOperationMetadata, workspacePathOperationResponse } from '@/app/lib/files/workspace-path-operation-response';
import { recordWorkspacePathOperationProblem } from '@/app/lib/files/workspace-path-operation-problems';
import { reviewWorkspaceDeletionIfRequired } from '@/app/lib/files/workspace-operation-delete-review';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { applyRateLimit, invalidateWorkspaceFileViews, jsonError, jsonServerError,
  jsonSuccess, readJsonBody } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function DELETE(request: NextRequest): Promise<Response> {
  const permissions = ['canRead', 'canWrite', 'canDelete'] as const;
  const workspaceResult = await requireRequestWorkspace(request, { permissions: [...permissions] });
  if (workspaceResult.response) return workspaceResult.response;
  let operation: ReturnType<typeof workspacePathOperationMetadata> | undefined;
  const problem = { workspace: workspaceResult.workspace, actorUserId: workspaceResult.session.user.id,
    kind: 'delete' as const, selections: [] as Array<{ sourcePath: string }> };
  const recordFailure = async (error: unknown) => {
    const failure = error as { status?: number; code?: string };
    if (failure?.status === 401 || failure?.status === 403
      || operation && ['blocked', 'needs_review', 'needs_recovery', 'failed'].includes(operation.status)) return;
    try { await recordWorkspacePathOperationProblem({ ...problem, error }); }
    catch { console.error('[File action] Could not persist problem.', 'WORKSPACE_OPERATION_PROBLEM_RECORD_FAILED'); }
  };
  const invalid = async (message: string, status: number, code = 'BATCH_INVALID_REQUEST') => {
    await recordFailure({ code });
    return jsonError(message, status, { code });
  };

  try {
    const limited = applyRateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'files-delete' });
    if (limited) return limited;
    const { path, idempotencyKey } = await readJsonBody<{ path?: string | string[]; idempotencyKey?: string }>(request);
    const paths = Array.isArray(path) ? path : [path];
    problem.selections = paths.filter((candidate): candidate is string => typeof candidate === 'string')
      .map((sourcePath) => ({ sourcePath }));
    if (!paths.length || paths.some((candidate) => typeof candidate !== 'string' || !candidate.trim())) {
      return invalid('Path(s) are required', 400);
    }
    if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
      return invalid('Invalid file action identity', 422);
    }
    const pathsToDelete = paths as string[];
    if (pathsToDelete.some((candidate) => isProtectedAppOutputFolder(candidate))) {
      return invalid('Protected app output folders cannot be deleted', 403, 'BATCH_PROTECTED_PATH');
    }
    const result = await withWorkspaceMutationLock(workspaceResult.workspace.workspaceId, async () => {
      const fresh = await requireRequestWorkspace(request, { permissions: [...permissions] });
      if (fresh.response) return { mode: 'response' as const, response: fresh.response };
      if (fresh.workspace.workspaceId !== workspaceResult.workspace.workspaceId
        || fresh.workspace.rootPath !== workspaceResult.workspace.rootPath
        || fresh.session.user.id !== workspaceResult.session.user.id) {
        return { mode: 'response' as const, response: jsonError('Workspace access changed before deletion', 403) };
      }
      problem.workspace = fresh.workspace;
      const scope = { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      const input = { scope, kind: 'delete' as const,
        selections: pathsToDelete.map((sourcePath) => ({ sourcePath })), idempotencyKey,
        actorUserId: fresh.session.user.id, actorId: fresh.session.user.id,
        actorDisplayName: fresh.session.user.name || 'Workspace user', actorType: 'user' as const };
      // A retry retains its original direct job even if an administrator enabled reviews afterwards.
      const existing = await getExistingDirectWorkspacePathOperation(input);
      if (existing) return { mode: 'direct' as const, batch: existing, scope };
      if (readDocumentReviewAvailability().documentReviewEnabled) {
        const review = await reviewWorkspaceDeletionIfRequired({ scope, paths: pathsToDelete,
          userId: fresh.session.user.id, displayName: fresh.session.user.name || 'Workspace user' });
        if (review) return { mode: 'review' as const, review };
      }
      const batch = await submitDirectWorkspacePathOperation(input);
      return { mode: 'direct' as const, batch, scope };
    });
    if (result.mode === 'response') return result.response;
    if (result.mode === 'review') {
      const review = result.review;
      const payload = { deleted: [], trashEntries: [], failed: [], reviewRequired: review.reviewRequired,
        code: review.blocked ? 'PREVIEW_BLOCKED' : 'BATCH_REVIEW_REQUIRED' };
      return review.blocked ? jsonError('Deletion requires resolving the blocked file action preview.', 409, payload)
        : jsonSuccess(payload);
    }
    // Release the request lock before the worker attempts durable path and link writes.
    operation = workspacePathOperationMetadata(result.batch);
    const batch = await waitForWorkspacePathOperation(result.batch);
    operation = workspacePathOperationMetadata(batch);
    const payload = await workspacePathOperationResponse(batch, result.scope);
    if (['queued', 'applying'].includes(batch.status)) return jsonSuccess(payload, { status: 202 });
    if (batch.status !== 'applied') return jsonError('The deletion and its link updates could not be completed.', 409,
      { ...payload, code: batch.errorCode ?? 'WORKSPACE_OPERATION_FAILED' });
    const deleted = payload.deleted ?? [];
    invalidateWorkspaceFileViews({ fileOptions: result.scope.fileOptions, fullTree: true,
      mutations: [...deleted.map((path) => ({ path, type: 'unlink' as const })),
        ...(payload.linkUpdates?.updatedFiles ?? []).map((path) => ({ path, type: 'change' as const }))] });
    try {
      await recordAuditEvent({ organizationId: result.scope.workspace.organizationId, workspaceId: batch.workspaceId,
        userId: workspaceResult.session.user.id, source: 'files', eventType: 'file', entityType: 'workspace_path',
        entityId: deleted.join(','), action: 'file.delete', status: 'success',
        summary: `${deleted.length} path(s) moved to trash; linked documents updated.`,
        metadata: { deleteMode: 'trash', requestedPaths: pathsToDelete, trashed: payload.trashEntries, failed: [],
          operationId: batch.batchId, planId: batch.planId, workspaceType: result.scope.workspace.workspaceType } });
    } catch { await recordFailure({ code: 'BATCH_AUDIT_FAILED' }); }
    return jsonSuccess(payload);
  } catch (error) {
    await recordFailure(error);
    const failure = error as { status?: number; code?: string };
    if (failure?.status && [400, 403, 409, 422, 503].includes(failure.status)) {
      return jsonError(error instanceof Error ? error.message : 'Failed to delete path', failure.status,
        { code: failure.code ?? 'WORKSPACE_OPERATION_FAILED', ...(operation ? { operation } : {}) });
    }
    return jsonServerError('[API] File delete error:', error, 'Failed to delete path');
  }
}
