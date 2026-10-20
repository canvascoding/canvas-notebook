import 'server-only';

import { jsonError, jsonSuccess } from '../api/route-helpers';
import type { WorkspaceImplicitMoveOperationResult } from './workspace-implicit-move-operation';
import { workspacePathOperationResponse } from './workspace-path-operation-response';

export async function workspaceImplicitMoveResponse(result: WorkspaceImplicitMoveOperationResult, statusRead: boolean): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (result.state === 'pending') {
    return jsonSuccess({ preparation: { version: 1, kind: 'implicit-move-preparation', state: 'pending',
      workspaceId: result.workspaceId, operationId: result.operationId, requestId: result.requestId,
      selectionDigest: result.selectionDigest, statusUrl: result.statusUrl, resumeUrl: result.resumeUrl } },
    { status: statusRead ? 200 : 202, headers });
  }
  if (result.state === 'aborted') {
    if (statusRead) return jsonSuccess({ preparation: { version: 1, kind: 'implicit-move-preparation', state: 'aborted',
      workspaceId: result.workspaceId, operationId: result.operationId, requestId: result.requestId, reason: result.reason } }, { headers });
    return jsonError('The original file selection could not be moved. Make a new file request.', 409,
      { code: 'IMPLICIT_MOVE_PREPARATION_ABORTED', preparation: { version: 1, kind: 'implicit-move-preparation',
        state: 'aborted', workspaceId: result.workspaceId, operationId: result.operationId,
        requestId: result.requestId, reason: result.reason } });
  }
  const payload = await workspacePathOperationResponse(result.batch, result.scope);
  if (result.historical) payload.historical = true;
  const pending = result.batch.status === 'queued' || result.batch.status === 'applying';
  if (!statusRead && !pending && result.batch.status !== 'applied') return jsonError('The file action could not be completed.', 409,
    { ...payload, code: result.batch.errorCode ?? 'WORKSPACE_OPERATION_FAILED' });
  return jsonSuccess(payload, { status: pending && !statusRead ? 202 : 200, headers });
}
