import { NextRequest } from 'next/server';

import { auth } from '@/app/lib/auth';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { acceptWorkspaceOperationReview, getWorkspaceOperationReview,
  refreshWorkspaceOperationReview, rejectWorkspaceOperationReview, WorkspaceOperationReviewError } from '@/app/lib/files/workspace-operation-review-service';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ reviewId: string }> };

async function authorize(request: NextRequest, reviewId: string, mutation: boolean) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: jsonError('Unauthorized', 401) } as const;
  const review = await getWorkspaceOperationReview(reviewId);
  if (!review) return { response: jsonError('Review not found', 404) } as const;
  const source = await requireSessionWorkspace(session, { workspaceId: review.sourceWorkspaceId,
    permissions: mutation && review.kind !== 'copy' ? ['canRead', 'canWrite', 'canDelete'] : 'canRead' });
  if (source.response) return { response: source.response } as const;
  const destination = await requireSessionWorkspace(session, { workspaceId: review.destinationWorkspaceId,
    permissions: mutation ? 'canWrite' : 'canRead' });
  if (destination.response) return { response: destination.response } as const;
  return { session, review, source: source.workspace, destination: destination.workspace } as const;
}

function errorResponse(error: unknown) {
  if (error instanceof WorkspaceOperationReviewError) {
    return jsonError(error.message, error.status, { code: error.code });
  }
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status : 500;
  if ([403, 409, 422, 503].includes(status)) {
    return jsonError(error instanceof Error ? error.message : 'File operation review failed', status,
      { code: error && typeof error === 'object' && 'code' in error ? error.code : 'REVIEW_APPLY_FAILED' });
  }
  return jsonServerError('[API] Workspace operation review error:', error,
    'Could not process file operation review');
}

export async function GET(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 90, windowMs: 60_000,
    keyPrefix: 'workspace-operation-review-detail' });
  if (limited) return limited;
  try {
    const { reviewId } = await context.params;
    const authorized = await authorize(request, reviewId, false);
    if ('response' in authorized) return authorized.response;
    return jsonSuccess({ review: authorized.review }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000,
    keyPrefix: 'workspace-operation-review-action' });
  if (limited) return limited;
  try {
    const { reviewId } = await context.params;
    const authorized = await authorize(request, reviewId, true);
    if ('response' in authorized) return authorized.response;
    const body = await request.json() as { action?: unknown; planId?: unknown };
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !['accept', 'reject', 'refresh'].includes(String(body.action))
      || typeof body.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(body.planId)) {
      return jsonError('A valid action and exact planId are required', 422);
    }
    if (body.action === 'refresh') {
      const review = await refreshWorkspaceOperationReview({ reviewId, planId: body.planId,
        source: { workspace: authorized.source, fileOptions: workspaceFileOptions(authorized.source) },
        destination: { workspace: authorized.destination, fileOptions: workspaceFileOptions(authorized.destination) },
        reviewerUserId: authorized.session.user.id, refreshAccess: async () => {
          const fresh = await authorize(request, reviewId, true);
          if ('response' in fresh || fresh.session.user.id !== authorized.session.user.id) {
            throw new WorkspaceOperationReviewError('REVIEW_ACCESS_DENIED', 403, 'Workspace access changed before refreshing.');
          }
          return { source: { workspace: fresh.source, fileOptions: workspaceFileOptions(fresh.source) },
            destination: { workspace: fresh.destination, fileOptions: workspaceFileOptions(fresh.destination) } };
        } });
      return jsonSuccess({ review, previousReviewId: reviewId }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const review = body.action === 'reject'
      ? await rejectWorkspaceOperationReview(reviewId, body.planId)
      : await acceptWorkspaceOperationReview({ reviewId, planId: body.planId,
        source: { workspace: authorized.source, fileOptions: workspaceFileOptions(authorized.source) },
        destination: { workspace: authorized.destination, fileOptions: workspaceFileOptions(authorized.destination) },
        reviewerUserId: authorized.session.user.id,
        reviewerDisplayName: authorized.session.user.name ?? 'Workspace user',
        refreshAccess: async () => {
          const freshSession = await auth.api.getSession({ headers: request.headers });
          if (!freshSession || freshSession.user.id !== authorized.session.user.id) {
            throw new WorkspaceOperationReviewError('REVIEW_ACCESS_DENIED', 403,
              'The reviewer session changed before accepting the review.');
          }
          const source = await requireSessionWorkspace(freshSession, {
            workspaceId: authorized.review.sourceWorkspaceId,
            permissions: authorized.review.kind === 'copy' ? 'canRead' : ['canRead', 'canWrite', 'canDelete'],
          });
          if (source.response) throw new WorkspaceOperationReviewError('REVIEW_ACCESS_DENIED', 403,
            'Workspace access changed before accepting the review.');
          const destination = await requireSessionWorkspace(freshSession, {
            workspaceId: authorized.review.destinationWorkspaceId, permissions: 'canWrite',
          });
          if (destination.response) throw new WorkspaceOperationReviewError('REVIEW_ACCESS_DENIED', 403,
            'Workspace access changed before accepting the review.');
          return { source: { workspace: source.workspace, fileOptions: workspaceFileOptions(source.workspace) },
            destination: { workspace: destination.workspace, fileOptions: workspaceFileOptions(destination.workspace) } };
        } });
    return jsonSuccess({ review, operation: review.operationId ? { operationId: review.operationId,
      status: review.status } : null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
