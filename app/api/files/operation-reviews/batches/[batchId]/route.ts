import { NextRequest } from 'next/server';
import { auth } from '@/app/lib/auth';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { enqueueWorkspaceOperationBatch, getWorkspaceOperationBatchReview } from '@/app/lib/files/workspace-operation-batch-service';
import { WorkspaceOperationBatchError } from '@/app/lib/files/workspace-operation-batch-store';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ batchId: string }> };

async function authorizedBatch(request: NextRequest, batchId: string, mutation: boolean) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: jsonError('Unauthorized', 401) } as const;
  const batch = await getWorkspaceOperationBatchReview(batchId);
  if (!batch) return { response: jsonError('Batch not found', 404) } as const;
  const authorized = await requireSessionWorkspace(session, { workspaceId: batch.workspaceId,
    permissions: mutation ? ['canRead', 'canWrite', 'canDelete'] : 'canRead' });
  if (authorized.response) return { response: authorized.response } as const;
  const current = await getWorkspaceOperationBatchReview(batchId,
    { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) });
  return { batch: current!, session, workspace: authorized.workspace } as const;
}

function errorResponse(error: unknown) {
  if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
  return jsonServerError('[API] Batch status/action failed:', error, 'Could not process file action batch');
}

export async function GET(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'workspace-operation-batch-status' });
  if (limited) return limited;
  try {
    const authorized = await authorizedBatch(request, (await context.params).batchId, false);
    if ('response' in authorized) return authorized.response;
    return jsonSuccess({ batch: authorized.batch }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'workspace-operation-batch-resume' });
  if (limited) return limited;
  try {
    const authorized = await authorizedBatch(request, (await context.params).batchId, true);
    if ('response' in authorized) return authorized.response;
    const body = await request.json() as { action?: unknown; planId?: unknown };
    if (!body || Array.isArray(body) || !['resume', 'undo'].includes(String(body.action))
      || typeof body.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(body.planId)) {
      return jsonError('A valid recovery action and exact planId are required', 422);
    }
    const batch = await enqueueWorkspaceOperationBatch({ batchId: authorized.batch.batchId,
      planId: body.planId, action: body.action as 'resume' | 'undo',
      scope: { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) },
      userId: authorized.session.user.id, displayName: authorized.session.user.name ?? 'Workspace user',
      refreshScope: async () => {
        const fresh = await authorizedBatch(request, authorized.batch.batchId, true);
        if ('response' in fresh || fresh.session.user.id !== authorized.session.user.id) {
          throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Workspace access changed before approval.');
        }
        return { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      } });
    return jsonSuccess({ batch }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
