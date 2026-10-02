import type { WorkspaceOperationReviewPublic } from './workspace-operation-review-contract';
import type { WorkspaceOperationBatchPublic } from './workspace-operation-batch-public';
import type { WorkspaceOperationCheckPublic, WorkspaceOperationCheckResponse } from './workspace-operation-check-contract';
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

export async function refreshWorkspaceOperationReview(input: {
  reviewId: string; workspaceId: string; planId: string;
}): Promise<WorkspaceOperationReviewPublic> {
  const response = await fetch(`/api/files/operation-reviews/${encodeURIComponent(input.reviewId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders(input.workspaceId) },
    credentials: 'include', body: JSON.stringify({ action: 'refresh', planId: input.planId }),
  });
  const payload = await readResponse<{ review: WorkspaceOperationReviewPublic }>(response);
  if (!payload.review || (payload.review.sourceWorkspaceId !== input.workspaceId
    && payload.review.destinationWorkspaceId !== input.workspaceId)) {
    throw new WorkspaceOperationReviewClientError('Review-Antwort passt nicht zum Workspace.', response.status, null);
  }
  return payload.review;
}

async function readBatchResponse(response: Response, workspaceId: string, batchId?: string): Promise<WorkspaceOperationBatchPublic> {
  const payload = await readResponse<{ batch: WorkspaceOperationBatchPublic }>(response);
  if (!payload.batch || payload.batch.workspaceId !== workspaceId
    || batchId && payload.batch.batchId !== batchId || !payload.batch.preview) {
    throw new WorkspaceOperationReviewClientError('Batch-Antwort passt nicht zur Anfrage.', response.status, null);
  }
  return payload.batch;
}

export async function previewWorkspaceOperationBatch(reviewIds: string[], workspaceId: string): Promise<WorkspaceOperationBatchPublic> {
  const response = await fetch('/api/files/operation-reviews/batches', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders(workspaceId) },
    credentials: 'include', body: JSON.stringify({ action: 'preview', reviewIds }),
  });
  return readBatchResponse(response, workspaceId);
}

export async function acceptWorkspaceOperationBatch(input: {
  batchId: string; workspaceId: string; planId: string;
}): Promise<WorkspaceOperationBatchPublic> {
  const response = await fetch('/api/files/operation-reviews/batches', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders(input.workspaceId) },
    credentials: 'include', body: JSON.stringify({ action: 'accept', batchId: input.batchId, planId: input.planId }),
  });
  return readBatchResponse(response, input.workspaceId, input.batchId);
}

export async function readWorkspaceOperationBatch(batchId: string, workspaceId: string, signal?: AbortSignal): Promise<WorkspaceOperationBatchPublic> {
  const response = await fetch(`/api/files/operation-reviews/batches/${encodeURIComponent(batchId)}`, {
    headers: workspaceHeaders(workspaceId), credentials: 'include', cache: 'no-store', signal,
  });
  return readBatchResponse(response, workspaceId, batchId);
}

export async function updateWorkspaceOperationBatch(input: {
  batchId: string; workspaceId: string; planId: string; action: 'resume' | 'undo';
}): Promise<WorkspaceOperationBatchPublic> {
  const response = await fetch(`/api/files/operation-reviews/batches/${encodeURIComponent(input.batchId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders(input.workspaceId) },
    credentials: 'include', body: JSON.stringify({ action: input.action, planId: input.planId }),
  });
  return readBatchResponse(response, input.workspaceId, input.batchId);
}

async function readCheckResponse(response: Response, workspaceId: string, expected: {
  checkId?: string; reviewIds?: string[];
}): Promise<WorkspaceOperationCheckResponse> {
  const payload = await readResponse<WorkspaceOperationCheckResponse>(response);
  const check = payload.check;
  if (!check || typeof check.checkId !== 'string' || !check.checkId || check.workspaceId !== workspaceId
    || !Array.isArray(check.reviewIds) || check.reviewIds.some((id) => typeof id !== 'string')
    || !['queued', 'checking', 'ready', 'blocked', 'failed'].includes(check.status)
    || expected.checkId && check.checkId !== expected.checkId
    || expected.reviewIds && JSON.stringify([...check.reviewIds].sort()) !== JSON.stringify([...new Set(expected.reviewIds)].sort())
    || payload.batch && (payload.batch.workspaceId !== workspaceId || payload.batch.batchId !== check.batchId
      || !payload.batch.preview || typeof payload.batch.planId !== 'string' || !payload.batch.planId
      || payload.batch.preview.planId !== payload.batch.planId
      || JSON.stringify([...payload.batch.reviewIds].sort()) !== JSON.stringify([...check.reviewIds].sort()))) {
    throw new WorkspaceOperationReviewClientError('Check-Antwort passt nicht zur Anfrage.', response.status, null);
  }
  if (['ready', 'blocked'].includes(check.status) && !payload.batch) {
    throw new WorkspaceOperationReviewClientError('Geprüfte Vorschau fehlt.', response.status, null);
  }
  return payload;
}

export async function startWorkspaceOperationCheck(reviewIds: string[], workspaceId: string): Promise<WorkspaceOperationCheckPublic> {
  const response = await fetch('/api/files/operation-reviews/checks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders(workspaceId) },
    credentials: 'include', body: JSON.stringify({ reviewIds }),
  });
  return (await readCheckResponse(response, workspaceId, { reviewIds })).check;
}

export async function readWorkspaceOperationCheck(checkId: string, workspaceId: string, signal?: AbortSignal): Promise<WorkspaceOperationCheckResponse> {
  const response = await fetch(`/api/files/operation-reviews/checks/${encodeURIComponent(checkId)}`, {
    headers: workspaceHeaders(workspaceId), credentials: 'include', cache: 'no-store', signal,
  });
  return readCheckResponse(response, workspaceId, { checkId });
}
