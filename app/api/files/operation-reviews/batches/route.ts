import { NextRequest } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { createWorkspaceOperationBatchReview, enqueueWorkspaceOperationBatch,
  getWorkspaceOperationBatchReview } from '@/app/lib/files/workspace-operation-batch-service';
import { WorkspaceOperationBatchError } from '@/app/lib/files/workspace-operation-batch-store';
import { requireRequestWorkspace, requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'workspace-operation-batch' });
  if (limited) return limited;
  try {
    const body = await request.json() as { action?: unknown; reviewIds?: unknown; batchId?: unknown; planId?: unknown };
    if (!body || Array.isArray(body) || typeof body !== 'object') return jsonError('A batch action is required', 422);
    if (body.action === 'preview') {
      const authorized = await requireRequestWorkspace(request, { permissions: ['canRead', 'canWrite', 'canDelete'] });
      if (authorized.response) return authorized.response;
      if (!Array.isArray(body.reviewIds) || body.reviewIds.some((id) => typeof id !== 'string')) {
        return jsonError('Select file reviews for the combined preview', 422);
      }
      if (!readDocumentReviewAvailability().documentReviewEnabled) {
        return jsonError('The experimental Review Center is disabled.', 409, { code: 'DOCUMENT_REVIEW_DISABLED' });
      }
      const batch = await createWorkspaceOperationBatchReview({
        scope: { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) },
        reviewIds: body.reviewIds as string[],
      });
      return jsonSuccess({ batch }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (body.action !== 'accept' || typeof body.batchId !== 'string'
      || typeof body.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(body.planId)) {
      return jsonError('A valid batch action, batchId, and exact planId are required', 422);
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return jsonError('Unauthorized', 401);
    const current = await getWorkspaceOperationBatchReview(body.batchId);
    if (!current) return jsonError('Batch not found', 404);
    const authorized = await requireSessionWorkspace(session, { workspaceId: current.workspaceId,
      permissions: ['canRead', 'canWrite', 'canDelete'] });
    if (authorized.response) return authorized.response;
    if (current.status === 'preview' && !readDocumentReviewAvailability().documentReviewEnabled) {
      return jsonError('The experimental Review Center is disabled.', 409, { code: 'DOCUMENT_REVIEW_DISABLED' });
    }
    const batch = await enqueueWorkspaceOperationBatch({ batchId: body.batchId, planId: body.planId,
      scope: { workspace: authorized.workspace, fileOptions: workspaceFileOptions(authorized.workspace) },
      userId: session.user.id, displayName: session.user.name ?? 'Workspace user', refreshScope: async () => {
        const freshSession = await auth.api.getSession({ headers: request.headers });
        if (!freshSession || freshSession.user.id !== session.user.id) {
          throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'The approving session changed.');
        }
        const fresh = await requireSessionWorkspace(freshSession, { workspaceId: current.workspaceId,
          permissions: ['canRead', 'canWrite', 'canDelete'] });
        if (fresh.response) throw new WorkspaceOperationBatchError('BATCH_ACCESS_DENIED', 403, 'Workspace access changed before approval.');
        return { workspace: fresh.workspace, fileOptions: workspaceFileOptions(fresh.workspace) };
      } });
    return jsonSuccess({ batch }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof WorkspaceOperationBatchError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] Batch preview/accept failed:', error, 'Could not process file action batch');
  }
}
