import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { checkRenameConflict } from '@/app/lib/filesystem/workspace-files';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { buildWorkspacePathOperationPlan, getExistingDirectWorkspacePathOperation, submitDirectWorkspacePathOperation,
  waitForWorkspacePathOperation } from '@/app/lib/files/workspace-path-operation-service';
import { workspacePathOperationMetadata, workspacePathOperationResponse } from '@/app/lib/files/workspace-path-operation-response';
import { recordWorkspacePathOperationProblem } from '@/app/lib/files/workspace-path-operation-problems';
import { WorkspacePreviewBlockedError, WorkspacePreviewStaleError,
  WorkspacePreviewUnavailableError } from '@/app/lib/markdown/workspace-file-operation-preview';
import { applyRateLimit, invalidateWorkspaceFileViews, jsonError, jsonServerError,
  jsonSuccess, readJsonBody } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { workspacePathOperationPreview, workspacePathImportPreparationPreview } from '@/app/lib/files/workspace-path-operation-preview';
import { authenticatedNativeTextSessionEnabled } from '@/app/lib/collaboration/native-text-session-activation';
import { withWorkspaceRequestPrincipal } from '@/app/lib/workspaces/request-principal';
import { readWorkspacePathImportPreparationPlan } from '@/app/lib/files/workspace-path-import-operation-preview';
import { readWorkspacePathImportOperationHistory } from '@/app/lib/files/workspace-path-import-operation-history';
import { prepareWorkspacePathImportOperation } from '@/app/lib/files/workspace-path-import-operation';
import { WorkspaceOperationBatchError, type WorkspaceOperationBatchRecord } from '@/app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchScope } from '@/app/lib/files/workspace-operation-batch-contract';
import { prepareWorkspaceImplicitMoveOperation, WorkspaceImplicitMoveOperationError } from '@/app/lib/files/workspace-implicit-move-operation';
import { workspaceImplicitMoveResponse, workspaceImplicitMoveOperationPublic } from '@/app/lib/files/workspace-implicit-move-response';

interface RenameRequestBody {
  oldPath: string;
  newPath: string;
  overwrite?: boolean;
  updateLinks?: boolean;
  dryRun?: boolean;
  planId?: string;
  idempotencyKey?: string;
  ignoreMissing?: unknown;
}

export async function POST(request: NextRequest): Promise<Response> {
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
    kind: 'rename' as const, selections: [] as Array<{ sourcePath: string; destinationPath?: string }> };
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
    const limited = applyRateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'files-rename' });
    if (limited) return limited;
    const body = await readJsonBody<RenameRequestBody>(request);
    previewOnly = body?.dryRun === true;
    if (body?.ignoreMissing !== undefined) return jsonError('ignoreMissing is not supported for this file action.', 422,
      { code: 'PATH_IMPORT_OPTIONS_UNSUPPORTED' });
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
    const selected = await withWorkspaceMutationLock(workspaceResult.workspace.workspaceId, async () => {
      const fresh = await requireRequestWorkspace(original, { permissions: [...permissions] });
      if (fresh.response) return { mode: 'response' as const, response: fresh.response };
      if (fresh.workspace.workspaceId !== workspaceResult.workspace.workspaceId
        || fresh.workspace.rootPath !== workspaceResult.workspace.rootPath
        || fresh.session.user.id !== workspaceResult.session.user.id) {
        return { mode: 'response' as const, response: jsonError('Workspace access changed before the file action', 403) };
      }
      problem.workspace = fresh.workspace;
      const scope = { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      const input = { scope, kind: 'rename' as const, selections: [{ sourcePath: oldPath, destinationPath: newPath }], overwrite };
      const direct = { ...input, expectedPlanId: planId, idempotencyKey,
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
                if (!planId || overwrite) throw new WorkspaceOperationBatchError('PREVIEW_UNSUPPORTED_APPLY', 409,
                  'Retry the original file action with its preview and options.');
                preparation = { previewPlanId: historical.record.previewPlan.planId };
                historicalResult = true;
                return { mode: 'direct' as const, batch: historical.batch, scope };
              }
            }
            if (!dryRun && !overwrite && planId === undefined) {
              // Preserve original-import history before selecting a new arm.
              // Only data leaves this mutex; the actual drain starts outside.
              return { mode: 'implicit-move' as const, workspaceId: fresh.workspace.workspaceId,
                operationId: idempotencyKey ?? randomUUID(), kind: 'rename' as const, selections: input.selections };
            }
            if (!dryRun && idempotencyKey) {
              preparationReadOnly = false;
              const existing = await getExistingDirectWorkspacePathOperation(direct);
              if (existing) {
                historicalResult = true;
                return { mode: 'direct' as const, batch: existing, scope };
              }
            }
            preparationReadOnly = true;
            const preview = await readWorkspacePathImportPreparationPlan({ principal: selected,
              kind: input.kind, selections: input.selections });
            if (preview.readiness === 'native-ready') return null;
            if (dryRun) return { mode: 'response' as const, response: jsonSuccess({ dryRun: true,
              requiresRevalidation: true, plan: workspacePathImportPreparationPreview(preview) }) };
            if (preview.readiness === 'blocked') {
              if (planId && planId !== preview.planId) throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409,
                'The file action preview changed.');
              throw new WorkspaceOperationBatchError('PREVIEW_BLOCKED', 409,
                'The file action has unresolved link or path conflicts.');
            }
            if (preview.version !== 1 && preview.version !== 4) throw new WorkspaceOperationBatchError('PREVIEW_UNSUPPORTED_APPLY', 409,
              'This file action preview does not support importing Markdown.');
            if (overwrite) throw new WorkspaceOperationBatchError('PATH_IMPORT_OVERWRITE_UNSUPPORTED', 409,
              'Existing Markdown files cannot be imported while overwriting another path.');
            if (!idempotencyKey || !planId || planId !== preview.planId) {
              throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409, 'Check the file action preview before applying it.');
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
      const existing = await getExistingDirectWorkspacePathOperation(direct);
      if (existing) {
        historicalResult = true;
        return { mode: 'direct' as const, batch: existing, scope };
      }
      const batch = await submitDirectWorkspacePathOperation(direct);
      return { mode: 'direct' as const, batch, scope };
    });
    if (selected.mode === 'response') return selected.response;
    let result: { batch: WorkspaceOperationBatchRecord; scope: WorkspaceOperationBatchScope };
    let implicitResult: Extract<Awaited<ReturnType<typeof prepareWorkspaceImplicitMoveOperation>>, { state: 'batch' }> | undefined;
    if (selected.mode === 'implicit-move') {
      const prepared = await prepareWorkspaceImplicitMoveOperation(original, {
        workspaceId: selected.workspaceId, operationId: selected.operationId, kind: selected.kind, selections: selected.selections,
      });
      if (prepared.state !== 'batch') return workspaceImplicitMoveResponse(prepared, false);
      historicalResult = prepared.historical;
      implicitResult = prepared;
      result = { batch: prepared.batch, scope: prepared.scope };
    } else result = selected;
    // The worker acquires the same lock, so waiting begins after request preparation releases it.
    operation = { ...workspacePathOperationMetadata(result.batch), ...(preparation ? { preparation } : {}) };
    const batch = await waitForWorkspacePathOperation(result.batch);
    operation = { ...workspacePathOperationMetadata(batch), ...(preparation ? { preparation } : {}) };
    const payload = await workspacePathOperationResponse(batch, result.scope);
    if (implicitResult) {
      payload.operation = workspaceImplicitMoveOperationPublic(payload.operation, implicitResult);
      operation = payload.operation;
    }
    if (historicalResult) payload.historical = true;
    if (preparation) {
      payload.operation = { ...payload.operation, preparation };
      operation = payload.operation;
    }
    if (['queued', 'applying'].includes(batch.status)) return jsonSuccess(payload, { status: 202 });
    if (batch.status === 'blocked') {
      const conflict = await checkRenameConflict(oldPath, newPath, result.scope.fileOptions);
      if (conflict) return jsonError(conflict.message, 409, { ...payload, code: conflict.code,
        type: conflict.type, sourcePath: conflict.sourcePath, destPath: conflict.destPath });
    }
    if (batch.status !== 'applied') return jsonError('The file action and its link updates could not be completed.', 409,
      { ...payload, code: batch.errorCode ?? 'WORKSPACE_OPERATION_FAILED' });
    invalidateWorkspaceFileViews({ fileOptions: result.scope.fileOptions, fullTree: true,
      ...(historicalResult ? {} : { mutations: (payload.linkUpdates?.updatedFiles ?? []).map((path) => ({ path, type: 'change' as const })) }) });
    if (!historicalResult) {
      try {
        await recordAuditEvent({ organizationId: result.scope.workspace.organizationId, workspaceId: batch.workspaceId,
          userId: workspaceResult.session.user.id, source: 'files', eventType: 'file', entityType: 'workspace_path',
          entityId: newPath, action: 'file.rename', status: 'success', summary: `Path renamed from ${oldPath} to ${newPath}.`,
          metadata: { oldPath, newPath, overwrite, operationId: batch.batchId, planId: batch.planId,
            linkStatus: payload.linkStatus, linkUpdates: payload.linkUpdates, workspaceType: result.scope.workspace.workspaceType } });
      } catch { await recordFailure({ code: 'BATCH_AUDIT_FAILED' }); }
    }
    return jsonSuccess(payload);
  } catch (error) {
    await recordFailure(error);
    const message = error instanceof Error ? error.message : 'Failed to rename path';
    if (error instanceof WorkspaceImplicitMoveOperationError) return jsonError(
      'The original file preparation could not be confirmed.', error.status, { code: error.code,
        ...(error.operationId ? { operationId: error.operationId } : {}),
        ...(error.requestId ? { requestId: error.requestId } : {}) });
    if (error instanceof WorkspacePreviewStaleError) return jsonError(message, 409, { code: 'PREVIEW_STALE' });
    if (error instanceof WorkspacePreviewUnavailableError) return jsonError(message, 422, { code: 'PREVIEW_UNREADABLE' });
    if (error instanceof WorkspacePreviewBlockedError) return jsonError(message, 409, { code: 'PREVIEW_BLOCKED' });
    const failure = error as { status?: number; code?: string };
    if (failure?.status && [400, 401, 403, 409, 413, 422, 503].includes(failure.status)) {
      return jsonError(message, failure.status, { code: failure.code ?? 'WORKSPACE_OPERATION_FAILED',
        ...(operation ? { operation } : {}) });
    }
    return jsonServerError('[API] File rename error:', error, 'Failed to rename path');
  }
}
