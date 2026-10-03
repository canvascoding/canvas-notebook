import { NextRequest } from 'next/server';
import { auth } from '@/app/lib/auth';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { WorkspaceOperationBatchError, WorkspaceOperationBatchStore, workspaceOperationBatchAuthorityUserId,
  type WorkspaceOperationBatchRecord } from '@/app/lib/files/workspace-operation-batch-store';
import { workspacePathOperationResponse } from '@/app/lib/files/workspace-path-operation-response';
import { enqueueWorkspaceOperationBatch } from '@/app/lib/files/workspace-operation-batch-service';
import { assertWorkspaceOperationBatchUndoAvailable } from '@/app/lib/files/workspace-operation-batch-executor';
import { recordWorkspacePathOperationProblem } from '@/app/lib/files/workspace-path-operation-problems';
import type { WorkspaceOperationBatchScope } from '@/app/lib/files/workspace-operation-batch-contract';
import { openDb } from '@/app/lib/db';
import { readStoredAgentWorkspaceOnConnection } from '@/app/lib/pi/session-workspace-context';

type RouteContext = { params: Promise<{ batchId: string }> };

async function recordBatchProblem(batch: WorkspaceOperationBatchRecord | undefined,
  scope: WorkspaceOperationBatchScope | undefined, actorUserId: string | undefined, error: unknown): Promise<void> {
  const failure = error as { status?: number; code?: string };
  if (!batch || !scope || !actorUserId || failure?.status === 401 || failure?.status === 403
    || batch.workspaceId !== scope.workspace.workspaceId || !scope.workspace.permissions.canRead
    || scope.workspace.status !== 'active'
    || ['blocked', 'needs_review', 'needs_recovery', 'failed'].includes(batch.status)) return;
  const action = batch.plan.actions.at(-1)!;
  try { await recordWorkspacePathOperationProblem({ workspace: scope.workspace, actorUserId,
    kind: action.kind, selections: action.selections, error }); }
  catch { console.error('[File action] Could not persist problem.', 'WORKSPACE_OPERATION_PROBLEM_RECORD_FAILED'); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'workspace-path-operation-recovery' });
  if (limited) return limited;
  let problemBatch: WorkspaceOperationBatchRecord | undefined;
  let problemScope: WorkspaceOperationBatchScope | undefined;
  let actorUserId: string | undefined;
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
    problemBatch = batch;
    actorUserId = session.user.id;
    problemScope = { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) };
    const body = await request.json() as { action?: unknown; planId?: unknown };
    if (!body || Array.isArray(body) || !['resume', 'undo'].includes(String(body.action))
      || typeof body.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(body.planId)) {
      return jsonError('A recovery action and the exact planId are required', 422);
    }
    const scope = problemScope;
    await enqueueWorkspaceOperationBatch({ batchId: batch.batchId, planId: body.planId,
      action: body.action as 'resume' | 'undo', scope, userId: session.user.id,
      displayName: session.user.name ?? 'Workspace user', refreshScope: async () => {
        const fresh = await authorize();
        if (fresh.response) throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Workspace access changed.');
        return { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      } });
    const current = await store.get(batch.batchId);
    problemBatch = current ?? batch;
    return jsonSuccess(await workspacePathOperationResponse(current!, scope), { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    await recordBatchProblem(problemBatch, problemScope, actorUserId, error);
    if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] File action recovery failed:', error, 'Could not safely recover the file action');
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 240, windowMs: 60_000, keyPrefix: 'workspace-path-operation-status' });
  if (limited) return limited;
  let problemBatch: WorkspaceOperationBatchRecord | undefined;
  let problemScope: WorkspaceOperationBatchScope | undefined;
  let actorUserId: string | undefined;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return jsonError('Unauthorized', 401);
    const batch = await new WorkspaceOperationBatchStore().get((await context.params).batchId);
    if (!batch) return jsonError('File action not found', 404);
    const authorized = await requireSessionWorkspace(session, { workspaceId: batch.workspaceId, permissions: 'canRead' });
    if (authorized.response) return authorized.response;
    problemBatch = batch;
    actorUserId = session.user.id;
    const scope = { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) };
    problemScope = scope;
    const payload = await workspacePathOperationResponse(batch, scope);
    const canMutate = scope.workspace.workspaceId === batch.workspaceId && scope.workspace.status === 'active'
      && scope.workspace.permissions.canRead && scope.workspace.permissions.canWrite && scope.workspace.permissions.canDelete;
    const initiatingUser = workspaceOperationBatchAuthorityUserId(batch) === session.user.id;
    const recovery = { canResume: canMutate && initiatingUser && ['failed', 'needs_recovery'].includes(batch.status), canUndo: false };
    if (recovery.canResume && batch.actionMode === 'apply' && batch.authorization.mode === 'direct'
      && batch.authorization.actorType === 'agent') {
      recovery.canResume = false;
      if (scope.workspace.permissions.canRunAgent && batch.authorization.actorSessionId) {
        let db: Awaited<ReturnType<typeof openDb>> | undefined;
        try {
          db = await openDb();
          const current = await readStoredAgentWorkspaceOnConnection(db, { userId: session.user.id,
            agentId: batch.authorization.actorId, sessionId: batch.authorization.actorSessionId,
            workspaceId: batch.workspaceId, permissions: ['canRead', 'canRunAgent', 'canWrite', 'canDelete'] });
          recovery.canResume = current.rootPath === scope.workspace.rootPath && current.status === 'active';
        } catch { recovery.canResume = false; }
        finally { try { await db?.close(); } catch { recovery.canResume = false; } }
      }
    }
    if (canMutate && batch.status === 'applied' && (batch.authorization.mode === 'review' || initiatingUser)) {
      try { await assertWorkspaceOperationBatchUndoAvailable({ batchId: batch.batchId, scope }); recovery.canUndo = true; }
      catch { recovery.canUndo = false; }
    }
    return jsonSuccess({ ...payload, recovery }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    await recordBatchProblem(problemBatch, problemScope, actorUserId, error);
    if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] File action status failed:', error, 'Could not read file action status');
  }
}
