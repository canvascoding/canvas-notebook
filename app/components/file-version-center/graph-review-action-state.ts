'use client';

import type { ProposalReviewActionApiRequestV1, ProposalReviewActionStatusRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalReviewActionStatusRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';

const PREFIX = 'fvrc-graph-action:';
const exactActions = new Map<string, ProposalReviewActionApiRequestV1>();
const activePosts = new Set<string>();

export function graphReviewActionStorageKey(authScope: unknown, document: {
  workspaceId: string; lineageId: string; documentId?: string | null;
}): string {
  return `${PREFIX}${JSON.stringify([authScope, document.workspaceId, document.lineageId, document.documentId ?? null])}`;
}

export function readGraphReviewActionIdentity(key: string): ProposalReviewActionStatusRequestV1 | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return parseProposalReviewActionStatusRequestV1(JSON.parse(raw));
  } catch {
    try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
    return null;
  }
}

export function exactGraphReviewAction(key: string): ProposalReviewActionApiRequestV1 | null {
  return exactActions.get(key) ?? null;
}

export function rememberGraphReviewAction(key: string, request: ProposalReviewActionApiRequestV1): ProposalReviewActionStatusRequestV1 {
  if (readGraphReviewActionIdentity(key)) throw new Error('A review action is already unresolved for this document.');
  const identity: ProposalReviewActionStatusRequestV1 = {
    contractVersion: 1, target: request.target,
    idempotencyKey: request.action.idempotencyKey, requestDigest: request.action.fence.requestDigest,
    approvalExpiresAt: request.action.fence.expiresAt,
  };
  // Persist only the receipt lookup identity. The signed fence stays in memory.
  sessionStorage.setItem(key, JSON.stringify(identity));
  exactActions.set(key, request);
  return identity;
}

export function markGraphReviewPost(key: string, active: boolean): void {
  if (active) activePosts.add(key);
  else activePosts.delete(key);
}

export function graphReviewPostInFlight(key: string): boolean {
  return activePosts.has(key);
}

export function forgetGraphReviewAction(key: string): void {
  exactActions.delete(key);
  activePosts.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}
