import { NextRequest } from 'next/server';
import { auth } from '@/app/lib/auth';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { WorkspaceOperationBatchError, WorkspaceOperationBatchStore } from '@/app/lib/files/workspace-operation-batch-store';
import { workspacePathOperationResponse } from '@/app/lib/files/workspace-path-operation-response';
import { enqueueWorkspaceOperationBatch } from '@/app/lib/files/workspace-operation-batch-service';

type RouteContext = { params: Promise<{ batchId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'workspace-path-operation-recovery' });
  if (limited) return limited;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return jsonError('Unauthorized', 401);
    const store = new WorkspaceOperationBatchStore();
    const batch = await store.get((await context.params).batchId);
    if (!batch) return jsonError('File action not found', 404);
    const authorize = () => requireSessionWorkspace(session, { workspaceId: batch.workspaceId,
      permissions: ['canRead', 'canWrite', 'canDelete'] });
    const authorized = await authorize();
    if (authorized.response) return authorized.response;
    const body = await request.json() as { action?: unknown; planId?: unknown };
    if (!body || Array.isArray(body) || !['resume', 'undo'].includes(String(body.action))
      || typeof body.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(body.planId)) {
      return jsonError('A recovery action and the exact planId are required', 422);
    }
    const scope = { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) };
    await enqueueWorkspaceOperationBatch({ batchId: batch.batchId, planId: body.planId,
      action: body.action as 'resume' | 'undo', scope, userId: session.user.id,
      displayName: session.user.name ?? 'Workspace user', refreshScope: async () => {
        const fresh = await authorize();
        if (fresh.response) throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Workspace access changed.');
        return { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      } });
    const current = await store.get(batch.batchId);
    return jsonSuccess(await workspacePathOperationResponse(current!, scope), { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] File action recovery failed:', error, 'Could not safely recover the file action');
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 240, windowMs: 60_000, keyPrefix: 'workspace-path-operation-status' });
  if (limited) return limited;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return jsonError('Unauthorized', 401);
    const batch = await new WorkspaceOperationBatchStore().get((await context.params).batchId);
    if (!batch) return jsonError('File action not found', 404);
    const authorized = await requireSessionWorkspace(session, { workspaceId: batch.workspaceId, permissions: 'canRead' });
    if (authorized.response) return authorized.response;
    const payload = await workspacePathOperationResponse(batch,
      { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) });
    return jsonSuccess(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] File action status failed:', error, 'Could not read file action status');
  }
}
