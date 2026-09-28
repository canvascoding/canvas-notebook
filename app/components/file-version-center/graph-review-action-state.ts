'use client';

import type { ProposalReviewActionApiRequestV1, ProposalReviewActionStatusRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalReviewActionStatusRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';

const PREFIX = 'fvrc-graph-action:';
const exactActions = new Map<string, ProposalReviewActionApiRequestV1>();
const activePosts = new Map<string, Map<string, number>>();

function identityToken(identity: ProposalReviewActionStatusRequestV1): string {
  const target = identity.target;
  const targetToken = target.kind === 'document' ? [target.kind, target.workspaceId, target.documentId]
    : target.kind === 'lineage' ? [target.kind, target.workspaceId, target.lineageId]
      : target.kind === 'change_group' ? [target.kind, target.workspaceId, target.changeGroupId, target.entryId ?? null]
        : [target.kind, target.workspaceId, target.pathHint];
  return JSON.stringify([identity.contractVersion, targetToken, identity.idempotencyKey,
    identity.requestDigest, identity.approvalExpiresAt]);
}

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

export function matchesGraphReviewActionIdentity(key: string, expected: ProposalReviewActionStatusRequestV1): boolean {
  const current = readGraphReviewActionIdentity(key);
  return current !== null && identityToken(current) === identityToken(expected);
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

export function beginGraphReviewPost(key: string, identity: ProposalReviewActionStatusRequestV1): () => void {
  const token = identityToken(parseProposalReviewActionStatusRequestV1(identity));
  const posts = activePosts.get(key) ?? new Map<string, number>();
  posts.set(token, (posts.get(token) ?? 0) + 1);
  activePosts.set(key, posts);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const current = activePosts.get(key);
    if (!current) return;
    const count = current.get(token);
    if (count === undefined) return;
    if (count > 1) current.set(token, count - 1);
    else current.delete(token);
    if (current.size === 0) activePosts.delete(key);
  };
}

export function graphReviewPostInFlight(key: string, identity?: ProposalReviewActionStatusRequestV1): boolean {
  const posts = activePosts.get(key);
  return identity ? Boolean(posts?.get(identityToken(identity))) : Boolean(posts?.size);
}

export function forgetGraphReviewAction(key: string, expected?: ProposalReviewActionStatusRequestV1): boolean {
  if (expected && !matchesGraphReviewActionIdentity(key, expected)) return false;
  try { sessionStorage.removeItem(key); } catch { return false; }
  exactActions.delete(key);
  // A terminal receipt may be observed before its original POST returns. Its
  // late completion must not erase a newer action's independent in-flight mark.
  return true;
}
