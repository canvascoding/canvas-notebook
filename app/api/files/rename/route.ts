import { NextRequest } from 'next/server';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { checkRenameConflict } from '@/app/lib/filesystem/workspace-files';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { buildWorkspacePathOperationPlan, submitDirectWorkspacePathOperation,
  waitForWorkspacePathOperation } from '@/app/lib/files/workspace-path-operation-service';
import { workspacePathOperationMetadata, workspacePathOperationResponse } from '@/app/lib/files/workspace-path-operation-response';
import { recordWorkspacePathOperationProblem } from '@/app/lib/files/workspace-path-operation-problems';
import { WorkspacePreviewBlockedError, WorkspacePreviewStaleError,
  WorkspacePreviewUnavailableError } from '@/app/lib/markdown/workspace-file-operation-preview';
import { applyRateLimit, invalidateWorkspaceFileViews, jsonError, jsonServerError,
  jsonSuccess, readJsonBody } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

interface RenameRequestBody {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
  updateLinks?: boolean;
  dryRun?: boolean;
  planId?: string;
  idempotencyKey?: string;
}

export async function POST(request: NextRequest): Promise<Response> {
  const permissions = ['canRead', 'canWrite', 'canDelete'] as const;
  const workspaceResult = await requireRequestWorkspace(request, { permissions: [...permissions] });
  if (workspaceResult.response) return workspaceResult.response;
  let operation: ReturnType<typeof workspacePathOperationMetadata> | undefined;
  let previewOnly = false;
  const problem = { workspace: workspaceResult.workspace, actorUserId: workspaceResult.session.user.id,
    kind: 'rename' as const, selections: [] as Array<{ sourcePath: string; destinationPath?: string }> };
  const recordFailure = async (error: unknown) => {
    const failure = error as { status?: number; code?: string };
    if (previewOnly || failure?.status === 401 || failure?.status === 403
      || operation && ['blocked', 'needs_review', 'needs_recovery', 'failed'].includes(operation.status)) return;
    try { await recordWorkspacePathOperationProblem({ ...problem, error }); }
    catch { console.error('[File action] Could not persist problem.', 'WORKSPACE_OPERATION_PROBLEM_RECORD_FAILED'); }
  };
  const invalid = async (message: string, status: number, code = 'BATCH_INVALID_REQUEST') => {
    await recordFailure({ code });
    return jsonError(message, status, { code });
  };

  try {
    const limited = applyRateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'files-rename' });
    if (limited) return limited;
    const body = await readJsonBody<RenameRequestBody>(request);
    previewOnly = body?.dryRun === true;
    const { oldPath, newPath, overwrite = false, dryRun = false, planId, idempotencyKey } = body;
    problem.selections = typeof oldPath === 'string'
      ? [{ sourcePath: oldPath, ...(typeof newPath === 'string' ? { destinationPath: newPath } : {}) }] : [];
    if (typeof oldPath !== 'string' || typeof newPath !== 'string' || !oldPath.trim() || !newPath.trim()) {
      return invalid('oldPath and newPath are required', 400);
    }
    if (typeof overwrite !== 'boolean' || typeof dryRun !== 'boolean'
      || idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
      return invalid('Invalid file action options', 422);
    }
    if (isProtectedAppOutputFolder(oldPath) || isProtectedAppOutputFolder(newPath)) {
      return invalid('Protected app output folders cannot be modified or overwritten', 403, 'BATCH_PROTECTED_PATH');
    }
    if (planId !== undefined && (typeof planId !== 'string' || !/^[0-9a-f]{64}$/u.test(planId))) {
      return invalid('Invalid file action preview identity', 422, 'PREVIEW_UNSUPPORTED_APPLY');
    }
    const result = await withWorkspaceMutationLock(workspaceResult.workspace.workspaceId, async () => {
      const fresh = await requireRequestWorkspace(request, { permissions: [...permissions] });
      if (fresh.response) return { mode: 'response' as const, response: fresh.response };
      if (fresh.workspace.workspaceId !== workspaceResult.workspace.workspaceId
        || fresh.workspace.rootPath !== workspaceResult.workspace.rootPath
        || fresh.session.user.id !== workspaceResult.session.user.id) {
        return { mode: 'response' as const, response: jsonError('Workspace access changed before the file action', 403) };
      }
      problem.workspace = fresh.workspace;
      const scope = { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      const input = { scope, kind: 'rename' as const, selections: [{ sourcePath: oldPath, destinationPath: newPath }], overwrite };
      if (dryRun) {
        const plan = await buildWorkspacePathOperationPlan(input);
        const { previewContents: _privateContents, ...publicPlan } = plan.linkPlan;
        return { mode: 'response' as const, response: jsonSuccess({ dryRun: true, requiresRevalidation: true,
          plan: { ...publicPlan, planId: plan.planId, readiness: plan.readiness } }) };
      }
      const batch = await submitDirectWorkspacePathOperation({ ...input, expectedPlanId: planId, idempotencyKey,
        actorUserId: fresh.session.user.id, actorId: fresh.session.user.id,
        actorDisplayName: fresh.session.user.name || 'Workspace user', actorType: 'user' });
      return { mode: 'direct' as const, batch, scope };
    });
    if (result.mode === 'response') return result.response;
    // The worker acquires the same lock, so waiting begins after request preparation releases it.
    operation = workspacePathOperationMetadata(result.batch);
    const batch = await waitForWorkspacePathOperation(result.batch);
    operation = workspacePathOperationMetadata(batch);
    const payload = await workspacePathOperationResponse(batch, result.scope);
    if (['queued', 'applying'].includes(batch.status)) return jsonSuccess(payload, { status: 202 });
    if (batch.status === 'blocked') {
      const conflict = await checkRenameConflict(oldPath, newPath, result.scope.fileOptions);
      if (conflict) return jsonError(conflict.message, 409, { ...payload, code: conflict.code,
        type: conflict.type, sourcePath: conflict.sourcePath, destPath: conflict.destPath });
    }
    if (batch.status !== 'applied') return jsonError('The file action and its link updates could not be completed.', 409,
      { ...payload, code: batch.errorCode ?? 'WORKSPACE_OPERATION_FAILED' });
    invalidateWorkspaceFileViews({ fileOptions: result.scope.fileOptions, fullTree: true,
      mutations: (payload.linkUpdates?.updatedFiles ?? []).map((path) => ({ path, type: 'change' as const })) });
    try {
      await recordAuditEvent({ organizationId: result.scope.workspace.organizationId, workspaceId: batch.workspaceId,
        userId: workspaceResult.session.user.id, source: 'files', eventType: 'file', entityType: 'workspace_path',
        entityId: newPath, action: 'file.rename', status: 'success', summary: `Path renamed from ${oldPath} to ${newPath}.`,
        metadata: { oldPath, newPath, overwrite, operationId: batch.batchId, planId: batch.planId,
          linkStatus: payload.linkStatus, linkUpdates: payload.linkUpdates, workspaceType: result.scope.workspace.workspaceType } });
    } catch { await recordFailure({ code: 'BATCH_AUDIT_FAILED' }); }
    return jsonSuccess(payload);
  } catch (error) {
    await recordFailure(error);
    const message = error instanceof Error ? error.message : 'Failed to rename path';
    if (error instanceof WorkspacePreviewStaleError) return jsonError(message, 409, { code: 'PREVIEW_STALE' });
    if (error instanceof WorkspacePreviewUnavailableError) return jsonError(message, 422, { code: 'PREVIEW_UNREADABLE' });
    if (error instanceof WorkspacePreviewBlockedError) return jsonError(message, 409, { code: 'PREVIEW_BLOCKED' });
    const failure = error as { status?: number; code?: string };
    if (failure?.status && [400, 403, 409, 422, 503].includes(failure.status)) {
      return jsonError(message, failure.status, { code: failure.code ?? 'WORKSPACE_OPERATION_FAILED',
        ...(operation ? { operation } : {}) });
    }
    return jsonServerError('[API] File rename error:', error, 'Failed to rename path');
  }
}
