import type { WorkspaceOperationReviewPublic } from './workspace-operation-review-contract';
import { workspaceHeaders } from './client';

export class WorkspaceOperationReviewClientError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'WorkspaceOperationReviewClientError';
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error
      : typeof payload?.message === 'string' ? payload.message : 'Dateioperation konnte nicht geladen werden.';
    throw new WorkspaceOperationReviewClientError(message, response.status,
      typeof payload?.code === 'string' ? payload.code : null);
  }
  if (!payload || typeof payload !== 'object') {
    throw new WorkspaceOperationReviewClientError('Ungültige Antwort für die Dateioperation.', response.status, null);
  }
  return payload as T;
}

export async function listWorkspaceOperationReviews(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceOperationReviewPublic[]> {
  const query = new URLSearchParams({ workspaceId });
  const response = await fetch(`/api/files/operation-reviews?${query}`, {
    headers: workspaceHeaders(workspaceId), credentials: 'include', cache: 'no-store', signal,
  });
  const payload = await readResponse<{ reviews: WorkspaceOperationReviewPublic[] }>(response);
  if (!Array.isArray(payload.reviews)) throw new WorkspaceOperationReviewClientError('Ungültige Review-Liste.', response.status, null);
  if (payload.reviews.some((review) => review.sourceWorkspaceId !== workspaceId
    && review.destinationWorkspaceId !== workspaceId)) {
    throw new WorkspaceOperationReviewClientError('Review-Liste passt nicht zum Workspace.', response.status, null);
  }
  return payload.reviews;
}

export async function readWorkspaceOperationReview(
  reviewId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceOperationReviewPublic> {
  const response = await fetch(`/api/files/operation-reviews/${encodeURIComponent(reviewId)}`, {
    headers: workspaceHeaders(workspaceId), credentials: 'include', cache: 'no-store', signal,
  });
  const payload = await readResponse<{ review: WorkspaceOperationReviewPublic }>(response);
  if (!payload.review || payload.review.reviewId !== reviewId
    || (payload.review.sourceWorkspaceId !== workspaceId
      && payload.review.destinationWorkspaceId !== workspaceId)) {
    throw new WorkspaceOperationReviewClientError('Review-Antwort passt nicht zur Anfrage.', response.status, null);
  }
  return payload.review;
}

export async function decideWorkspaceOperationReview(input: {
  reviewId: string;
  workspaceId: string;
  planId: string;
  action: 'accept' | 'reject';
}): Promise<WorkspaceOperationReviewPublic> {
  const response = await fetch(`/api/files/operation-reviews/${encodeURIComponent(input.reviewId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders(input.workspaceId) },
    credentials: 'include',
    body: JSON.stringify({ action: input.action, planId: input.planId }),
  });
  const payload = await readResponse<{ review: WorkspaceOperationReviewPublic }>(response);
  if (!payload.review || payload.review.reviewId !== input.reviewId
    || (payload.review.sourceWorkspaceId !== input.workspaceId
      && payload.review.destinationWorkspaceId !== input.workspaceId)) {
    throw new WorkspaceOperationReviewClientError('Review-Antwort passt nicht zur Anfrage.', response.status, null);
  }
  return payload.review;
}
