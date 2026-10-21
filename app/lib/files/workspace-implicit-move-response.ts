import 'server-only';

import { jsonError, jsonSuccess } from '../api/route-helpers';
import type { WorkspaceImplicitMoveOperationResult } from './workspace-implicit-move-operation';
import { workspacePathOperationResponse } from './workspace-path-operation-response';
import type { WorkspacePathOperationPublic } from './workspace-path-operation-public';
import type { WorkspaceImplicitMovePreparationPublicV2 } from './workspace-implicit-move-public';
import { readWorkspaceImplicitMoveBinding, readWorkspaceImplicitMoveLegacyReplay } from './workspace-implicit-move-parser';

/** Bound data is supplied only by strict Coordinator history, never recomputed from a batch ID. */
export function workspaceImplicitMoveOperationPublic(operation: WorkspacePathOperationPublic,
  result: Extract<WorkspaceImplicitMoveOperationResult, { state: 'batch' }>): WorkspacePathOperationPublic {
  if (result.legacy) {
    const auth = result.batch.authorization;
    if (result.implicitBinding !== undefined || result.historical !== true || result.requestId !== undefined
      || operation.implicitBinding !== undefined || operation.preparation !== undefined
      || auth.mode !== 'direct' || auth.actorType !== 'user'
      || operation.batchId !== result.batch.batchId || operation.planId !== result.batch.planId
      || operation.workspaceId !== result.batch.workspaceId) throw new Error('Legacy file action replay changed.');
    const legacyImplicitReplay = readWorkspaceImplicitMoveLegacyReplay(result.legacyImplicitReplay,
      { actorUserId: auth.actorUserId, workspaceId: result.batch.workspaceId, operationId: result.operationId,
        batchId: result.batch.batchId, planId: result.batch.planId });
    return { ...operation, legacyImplicitReplay };
  }
  if (result.legacyImplicitReplay !== undefined || operation.legacyImplicitReplay !== undefined) {
    throw new Error('Implicit preparation cannot adopt a legacy replay tag.');
  }
  const auth = result.batch.authorization;
  if (auth.mode !== 'direct' || auth.actorType !== 'user' || operation.preparation
    || operation.batchId !== result.batch.batchId || operation.planId !== result.batch.planId
    || operation.workspaceId !== result.batch.workspaceId) throw new Error('Implicit file action mapping changed.');
  const binding = readWorkspaceImplicitMoveBinding(result.implicitBinding, { actorUserId: auth.actorUserId,
    workspaceId: result.batch.workspaceId, operationId: result.operationId, requestId: result.requestId });
  return { ...operation, implicitBinding: binding };
}
function publicPreparation(result: Exclude<WorkspaceImplicitMoveOperationResult, { state: 'batch' }>): WorkspaceImplicitMovePreparationPublicV2 {
  const common = { version: 2 as const, kind: 'implicit-move-preparation' as const, actorUserId: result.actorUserId,
    workspaceId: result.workspaceId, operationId: result.operationId, requestId: result.requestId,
    selectionDigest: result.selectionDigest, action: result.action, selections: result.selections.map(item => ({ ...item })) };
  return result.state === 'pending' ? { ...common, state: 'pending', status: result.status, canResume: result.canResume, statusUrl: result.statusUrl, resumeUrl: result.resumeUrl }
    : { ...common, state: 'aborted', reason: result.reason };
}

export async function workspaceImplicitMoveResponse(result: WorkspaceImplicitMoveOperationResult, statusRead: boolean): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (result.state === 'pending') return jsonSuccess({ preparation: publicPreparation(result) },
    { status: statusRead ? 200 : 202, headers });
  if (result.state === 'aborted') {
    const preparation = publicPreparation(result);
    if (statusRead) return jsonSuccess({ preparation }, { headers });
    return jsonError('The original file selection could not be moved. Make a new file request.', 409,
      { code: 'IMPLICIT_MOVE_PREPARATION_ABORTED', preparation });
  }
  const payload = await workspacePathOperationResponse(result.batch, result.scope);
  payload.operation = workspaceImplicitMoveOperationPublic(payload.operation, result);
  if (result.historical) payload.historical = true;
  const pending = result.batch.status === 'queued' || result.batch.status === 'applying';
  if (!statusRead && !pending && result.batch.status !== 'applied') return jsonError('The file action could not be completed.', 409,
    { ...payload, code: result.batch.errorCode ?? 'WORKSPACE_OPERATION_FAILED' });
  return jsonSuccess(payload, { status: pending && !statusRead ? 202 : 200, headers });
}
