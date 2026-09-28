import { NextRequest } from 'next/server';

import { auth } from '@/app/lib/auth';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { executeWorkspaceFileOperationService } from '@/app/lib/files/workspace-file-operation-service';
import { WorkspaceOperationJournal, type WorkspaceOperationRequest } from '@/app/lib/files/workspace-operation-journal';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ operationId: string }> };

async function authorizedOperation(request: NextRequest, operationId: string) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: jsonError('Unauthorized', 401) } as const;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(operationId)) {
    return { response: jsonError('Operation not found', 404) } as const;
  }
  const record = await new WorkspaceOperationJournal().get(operationId);
  if (!record || record.actor.id !== session.user.id) {
    return { response: jsonError('Operation not found', 404) } as const;
  }
  const durableRequest = JSON.parse(record.requestJson) as WorkspaceOperationRequest;
  const source = await requireSessionWorkspace(session, {
    workspaceId: record.sourceWorkspaceId,
    permissions: durableRequest.kind === 'copy' ? 'canRead' : ['canRead', 'canWrite', 'canDelete'],
  });
  if (source.response) return { response: source.response } as const;
  const destination = await requireSessionWorkspace(session, {
    workspaceId: record.destinationWorkspaceId, permissions: 'canWrite',
  });
  if (destination.response) return { response: destination.response } as const;
  return { session, record, durableRequest, source: source.workspace, destination: destination.workspace } as const;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'workspace-operation-get' });
  if (limited) return limited;
  try {
    const { operationId } = await context.params;
    const authorized = await authorizedOperation(request, operationId);
    if ('response' in authorized) return authorized.response;
    const { record, durableRequest } = authorized;
    return jsonSuccess({ operation: {
      operationId: record.operationId, planId: record.planId,
      kind: durableRequest.kind, selections: durableRequest.selections,
      sourceWorkspaceId: record.sourceWorkspaceId,
      destinationWorkspaceId: record.destinationWorkspaceId,
      status: record.status, phase: record.phase, revision: record.revision,
      errorCode: record.errorCode,
      steps: record.steps.map((step) => ({ key: step.stepKey, phase: step.phase, status: step.status })),
    } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonServerError('[API] File operation status error:', error, 'Could not read file operation status');
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'workspace-operation-recover' });
  if (limited) return limited;
  try {
    const { operationId } = await context.params;
    const authorized = await authorizedOperation(request, operationId);
    if ('response' in authorized) return authorized.response;
    const { session, record, durableRequest, source, destination } = authorized;
    const execution = await executeWorkspaceFileOperationService({
      operationId, kind: durableRequest.kind, selections: durableRequest.selections,
      expectedPlanId: record.planId,
      source: { workspace: source, fileOptions: workspaceFileOptions(source) },
      destination: { workspace: destination, fileOptions: {
        ...workspaceFileOptions(destination), mutationActorUserId: session.user.id,
      } },
      actorUserId: session.user.id, actorId: session.user.id,
      actorDisplayName: session.user.name ?? 'Workspace user',
      actorType: record.actor.type === 'agent' ? 'agent' : 'user',
    });
    return jsonSuccess({ operation: execution.execution,
      linkStatus: execution.execution.status === 'complete' ? 'complete' : 'partial' });
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status : 500;
    if ([403, 409, 422, 503].includes(status)) {
      return jsonError(error instanceof Error ? error.message : 'Could not resume file operation', status,
        { code: error && typeof error === 'object' && 'code' in error ? error.code : 'OPERATION_RECOVERY_FAILED' });
    }
    return jsonServerError('[API] File operation recovery error:', error, 'Could not resume file operation');
  }
}
