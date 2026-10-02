import { NextRequest } from 'next/server';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { enqueueWorkspaceOperationCheck } from '@/app/lib/files/workspace-operation-check-service';
import { WorkspaceOperationBatchError } from '@/app/lib/files/workspace-operation-batch-store';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'workspace-operation-check' });
  if (limited) return limited;
  try {
    const authorized = await requireRequestWorkspace(request, { permissions: ['canRead','canWrite','canDelete'] });
    if (authorized.response) return authorized.response;
    const body = await request.json() as { reviewIds?: unknown };
    if (!body || Array.isArray(body) || !Array.isArray(body.reviewIds) || body.reviewIds.some((id) => typeof id !== 'string')) {
      return jsonError('Select file reviews for a background check', 422);
    }
    const check = await enqueueWorkspaceOperationCheck({
      scope: { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) },
      reviewIds: body.reviewIds as string[], requesterUserId: authorized.session.user.id,
    });
    return jsonSuccess({ check }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] Review check enqueue failed:', error, 'Could not queue the file review check');
  }
}
