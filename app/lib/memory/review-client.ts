import type { MemoryReviewDecision, MemoryReviewEntry, MemoryReviewTarget } from './contract';

export class MemoryReviewClientError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

function params(target: MemoryReviewTarget) {
  const value = new URLSearchParams({ collectionId: target.collectionId, scope: target.scope });
  if (target.workspaceId) value.set('workspaceId', target.workspaceId);
  return value;
}

async function responseData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: string } | null;
  if (!response.ok || !payload?.success || payload.data === undefined) {
    throw new MemoryReviewClientError(payload?.error || 'Unable to complete memory review.', response.status);
  }
  return payload.data;
}

export async function loadMemoryReview(target: MemoryReviewTarget, signal?: AbortSignal): Promise<MemoryReviewEntry> {
  const query = params(target);
  const response = await fetch(`/api/memory/reviews/${encodeURIComponent(target.entryId)}?${query}`, { signal });
  return responseData<MemoryReviewEntry>(response);
}

export async function decideMemoryReviewClient(
  entry: MemoryReviewEntry,
  decision: MemoryReviewDecision,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/memory/reviews/${encodeURIComponent(entry.target.entryId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ ...entry.target, decision, expectedRevision: entry.revision }),
  });
  return responseData(response);
}
