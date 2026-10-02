import { NextRequest } from 'next/server';
import { auth } from '@/app/lib/auth';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { getWorkspaceOperationCheck, getWorkspaceOperationCheckResult } from '@/app/lib/files/workspace-operation-check-service';
import { WorkspaceOperationBatchError } from '@/app/lib/files/workspace-operation-batch-store';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest, context: { params: Promise<{ checkId: string }> }) {
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'workspace-operation-check-status' });
  if (limited) return limited;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return jsonError('Unauthorized', 401);
    const checkId = (await context.params).checkId;
    const check = await getWorkspaceOperationCheck(checkId);
    if (!check) return jsonError('Review check not found', 404);
    const authorized = await requireSessionWorkspace(session, { workspaceId: check.workspaceId, permissions: 'canRead' });
    if (authorized.response) return authorized.response;
    const result = await getWorkspaceOperationCheckResult(checkId,
      { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) });
    return jsonSuccess(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] Review check status failed:', error, 'Could not read the file review check');
  }
}
