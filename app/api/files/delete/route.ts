import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { buildWorkspacePathOperationPlan, getExistingDirectWorkspacePathOperation, submitDirectWorkspacePathOperation,
  waitForWorkspacePathOperation } from '@/app/lib/files/workspace-path-operation-service';
import { workspacePathOperationMetadata, workspacePathOperationResponse } from '@/app/lib/files/workspace-path-operation-response';
import { recordWorkspacePathOperationProblem } from '@/app/lib/files/workspace-path-operation-problems';
import { getExistingWorkspaceDeletionReview, reviewWorkspaceDeletionIfRequired } from '@/app/lib/files/workspace-operation-delete-review';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { applyRateLimit, invalidateWorkspaceFileViews, jsonError, jsonServerError,
  jsonSuccess, readJsonBody } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { workspacePathOperationPreview, workspacePathImportPreparationPreview } from '@/app/lib/files/workspace-path-operation-preview';
import { authenticatedNativeTextSessionEnabled } from '@/app/lib/collaboration/native-text-session-activation';
import { withWorkspaceRequestPrincipal } from '@/app/lib/workspaces/request-principal';
import { readWorkspacePathImportPreparationPlan } from '@/app/lib/files/workspace-path-import-operation-preview';
import { readWorkspacePathImportOperationHistory } from '@/app/lib/files/workspace-path-import-operation-history';
import { prepareWorkspacePathImportOperation } from '@/app/lib/files/workspace-path-import-operation';
import { WorkspaceOperationBatchError } from '@/app/lib/files/workspace-operation-batch-store';

export async function DELETE(request: NextRequest): Promise<Response> {
  // Native services require the local NextRequest constructor, also in compiled routes.
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const permissions = ['canRead', 'canWrite', 'canDelete'] as const;
  const workspaceResult = await requireRequestWorkspace(original, { permissions: [...permissions] });
  if (workspaceResult.response) return workspaceResult.response;
  let operation: ReturnType<typeof workspacePathOperationMetadata> | undefined;
  let preparation: { previewPlanId: string } | undefined;
  let previewOnly = false;
  let preparationReadOnly = false;
  let historicalResult = false;
  const problem = { workspace: workspaceResult.workspace, actorUserId: workspaceResult.session.user.id,
    kind: 'delete' as const, selections: [] as Array<{ sourcePath: string }> };
  const recordFailure = async (error: unknown) => {
    const failure = error as { status?: number; code?: string };
    if (previewOnly || preparationReadOnly || failure?.status === 401 || failure?.status === 403
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
    const body = await readJsonBody<{ path?: string | string[]; idempotencyKey?: string; dryRun?: boolean; planId?: string; ignoreMissing?: unknown }>(request);
    previewOnly = body?.dryRun === true;
    if (body?.ignoreMissing !== undefined) return jsonError('ignoreMissing is not supported for this file action.', 422,
      { code: 'PATH_IMPORT_OPTIONS_UNSUPPORTED' });
    const { path, idempotencyKey, dryRun = false, planId } = body;
    const paths = Array.isArray(path) ? path : [path];
    problem.selections = paths.filter((candidate): candidate is string => typeof candidate === 'string')
      .map((sourcePath) => ({ sourcePath }));
    if (!paths.length || paths.some((candidate) => typeof candidate !== 'string' || !candidate.trim())) {
      return invalid('Path(s) are required', 400);
    }
    if (typeof dryRun !== 'boolean' || idempotencyKey !== undefined && typeof idempotencyKey !== 'string'
      || planId !== undefined && (typeof planId !== 'string' || !/^[0-9a-f]{64}$/u.test(planId))) {
      return invalid('Invalid file action identity', 422);
    }
    const pathsToDelete = paths as string[];
    if (pathsToDelete.some((candidate) => isProtectedAppOutputFolder(candidate))) {
      return invalid('Protected app output folders cannot be deleted', 403, 'BATCH_PROTECTED_PATH');
    }
    const result = await withWorkspaceMutationLock(workspaceResult.workspace.workspaceId, async () => {
      const fresh = await requireRequestWorkspace(original, { permissions: [...permissions] });
      if (fresh.response) return { mode: 'response' as const, response: fresh.response };
      if (fresh.workspace.workspaceId !== workspaceResult.workspace.workspaceId
        || fresh.workspace.rootPath !== workspaceResult.workspace.rootPath
        || fresh.session.user.id !== workspaceResult.session.user.id) {
        return { mode: 'response' as const, response: jsonError('Workspace access changed before deletion', 403) };
      }
      problem.workspace = fresh.workspace;
      const scope = { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      const input = { scope, kind: 'delete' as const,
        selections: pathsToDelete.map((sourcePath) => ({ sourcePath })), idempotencyKey, expectedPlanId: planId,
        actorUserId: fresh.session.user.id, actorId: fresh.session.user.id,
        actorDisplayName: fresh.session.user.name || 'Workspace user', actorType: 'user' as const };
      if (authenticatedNativeTextSessionEnabled() && !fresh.workspace.legacy) {
        const prepared = await withWorkspaceRequestPrincipal(original,
          { permission: 'canWrite', workspaceId: fresh.workspace.workspaceId }, async principal => {
            const selected = { kind: 'request' as const, principal };
            preparationReadOnly = true;
            if (!dryRun && idempotencyKey) {
              const historical = await readWorkspacePathImportOperationHistory({ principal: selected, operationId: idempotencyKey,
                ...(planId ? { expected: { planId, request: { kind: input.kind, selections: input.selections } } } : {}) });
              if (historical) {
                if (!planId) throw new WorkspaceOperationBatchError('PREVIEW_UNSUPPORTED_APPLY', 409,
                  'Retry the original deletion with its preview.');
                preparation = { previewPlanId: historical.record.previewPlan.planId };
                historicalResult = true;
                return { mode: 'direct' as const, batch: historical.batch, scope };
              }
              preparationReadOnly = false;
              const existing = await getExistingDirectWorkspacePathOperation(input);
              if (existing) {
                historicalResult = true;
                return { mode: 'direct' as const, batch: existing, scope };
              }
              const existingReview = await getExistingWorkspaceDeletionReview({ scope, paths: pathsToDelete,
                userId: fresh.session.user.id, displayName: fresh.session.user.name || 'Workspace user', idempotencyKey });
              if (existingReview) return { mode: 'review' as const, review: existingReview };
            }
            // The additive import preparation initially supports exactly one file.
            // Existing multi-selection deletion keeps its ordinary planner/worker.
            if (pathsToDelete.length !== 1) return null;
            preparationReadOnly = true;
            const preview = await readWorkspacePathImportPreparationPlan({ principal: selected,
              kind: 'delete', selections: input.selections });
            if (preview.readiness === 'native-ready') return null;
            if (dryRun) return { mode: 'response' as const, response: jsonSuccess({ dryRun: true,
              requiresRevalidation: true, plan: workspacePathImportPreparationPreview(preview) }) };
            if (preview.readiness === 'blocked') throw new WorkspaceOperationBatchError('PREVIEW_BLOCKED', 409,
              'The deletion has unresolved link or path conflicts.');
            // Preserve the existing review requirement; import preparation must never bypass it.
            if (readDocumentReviewAvailability().documentReviewEnabled) return null;
            if (!idempotencyKey || !planId || planId !== preview.planId) {
              throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'Check the deletion preview before applying it.');
            }
            preparationReadOnly = false;
            const committed = await prepareWorkspacePathImportOperation({ principal: selected, operationId: idempotencyKey, plan: preview });
            preparation = { previewPlanId: committed.record.previewPlan.planId };
            return { mode: 'direct' as const, batch: committed.batch, scope };
          });
        preparationReadOnly = false;
        if (prepared) return prepared;
      }
      if (dryRun) {
        const plan = await buildWorkspacePathOperationPlan(input);
        return { mode: 'response' as const, response: jsonSuccess({ dryRun: true, requiresRevalidation: true,
          plan: workspacePathOperationPreview(plan) }) };
      }
      // A retry retains its original direct job even if an administrator enabled reviews afterwards.
      const existing = await getExistingDirectWorkspacePathOperation(input);
      if (existing) {
        historicalResult = true;
        return { mode: 'direct' as const, batch: existing, scope };
      }
      const reviewInput = { scope, paths: pathsToDelete, userId: fresh.session.user.id,
        displayName: fresh.session.user.name || 'Workspace user', idempotencyKey };
      // A stored proposal keeps its approval requirement across an ON-to-OFF toggle.
      const existingReview = await getExistingWorkspaceDeletionReview(reviewInput);
      if (existingReview) return { mode: 'review' as const, review: existingReview };
      if (readDocumentReviewAvailability().documentReviewEnabled) {
        const review = await reviewWorkspaceDeletionIfRequired(reviewInput);
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
    operation = { ...workspacePathOperationMetadata(result.batch), ...(preparation ? { preparation } : {}) };
    const batch = await waitForWorkspacePathOperation(result.batch);
    operation = { ...workspacePathOperationMetadata(batch), ...(preparation ? { preparation } : {}) };
    const payload = await workspacePathOperationResponse(batch, result.scope);
    if (historicalResult) payload.historical = true;
    if (preparation) {
      payload.operation = { ...payload.operation, preparation };
      operation = payload.operation;
    }
    if (['queued', 'applying'].includes(batch.status)) return jsonSuccess(payload, { status: 202 });
    if (batch.status !== 'applied') return jsonError('The deletion and its link updates could not be completed.', 409,
      { ...payload, code: batch.errorCode ?? 'WORKSPACE_OPERATION_FAILED' });
    const deleted = payload.deleted ?? [];
    invalidateWorkspaceFileViews({ fileOptions: result.scope.fileOptions, fullTree: true,
      ...(historicalResult ? {} : { mutations: [...deleted.map((path) => ({ path, type: 'unlink' as const })),
        ...(payload.linkUpdates?.updatedFiles ?? []).map((path) => ({ path, type: 'change' as const }))] }) });
    if (!historicalResult) {
      try {
        await recordAuditEvent({ organizationId: result.scope.workspace.organizationId, workspaceId: batch.workspaceId,
          userId: workspaceResult.session.user.id, source: 'files', eventType: 'file', entityType: 'workspace_path',
          entityId: deleted.join(','), action: 'file.delete', status: 'success',
          summary: `${deleted.length} path(s) moved to trash; linked documents updated.`,
          metadata: { deleteMode: 'trash', requestedPaths: pathsToDelete, trashed: payload.trashEntries, failed: [],
            operationId: batch.batchId, planId: batch.planId, workspaceType: result.scope.workspace.workspaceType } });
      } catch { await recordFailure({ code: 'BATCH_AUDIT_FAILED' }); }
    }
    return jsonSuccess(payload);
  } catch (error) {
    await recordFailure(error);
    const failure = error as { status?: number; code?: string };
    if (failure?.status && [400, 401, 403, 409, 413, 422, 503].includes(failure.status)) {
      return jsonError(error instanceof Error ? error.message : 'Failed to delete path', failure.status,
        { code: failure.code ?? 'WORKSPACE_OPERATION_FAILED', ...(operation ? { operation } : {}) });
    }
    return jsonServerError('[API] File delete error:', error, 'Failed to delete path');
  }
}
