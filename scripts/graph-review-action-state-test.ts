import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

import { beginGraphReviewPost, exactGraphReviewAction, forgetGraphReviewAction, graphReviewActionStorageKey,
  graphReviewPostInFlight, matchesGraphReviewActionIdentity, readGraphReviewActionIdentity,
  rememberGraphReviewAction } from '../app/components/file-version-center/graph-review-action-state';
import type { ProposalReviewActionApiRequestV1, ProposalReviewActionStatusRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { currentProofFixture, proposalScopeFixture } from './fixtures/proposal-graph-contract-v1';

const dom = new JSDOM('', { url: 'https://canvas.test/en/notebook' });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: dom.window.sessionStorage });

const document = { workspaceId: proposalScopeFixture.workspaceId, lineageId: proposalScopeFixture.lineageId,
  documentId: proposalScopeFixture.documentId };
const scope = { userId: 'reviewer', sessionId: 'session-one', epoch: 1 };
const key = graphReviewActionStorageKey(scope, document);

function action(id: string): ProposalReviewActionApiRequestV1 {
  return { contractVersion: 1, target: { kind: 'document', workspaceId: document.workspaceId, documentId: document.documentId },
    action: { contractVersion: 1, idempotencyKey: `idempotency-${id}-0001`, fenceToken: `pg1.${'A'.repeat(43)}`,
      creation: null, fence: { contractVersion: 1, fenceId: `fence-${id}`, scope: proposalScopeFixture,
        actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'auth-one' }, actionType: 'accept',
        current: currentProofFixture, graphRevision: 7, evaluationId: `evaluation-${id}`,
        effectiveCandidateHash: 'a'.repeat(64), closure: [{ proposalId: 'p1', casVersion: 1,
          candidateHash: 'a'.repeat(64) }], closureHash: 'b'.repeat(64), selectedProposalIds: ['p1'],
        applyProposalIds: ['p1'], batchHash: 'c'.repeat(64), choiceResolutions: [], requestDigest: id.repeat(64),
        issuedAt: 1_800_000_000_000, expiresAt: 1_800_000_060_000 } } };
}

test('late A completion cannot erase B identity, exact request, or in-flight marker', () => {
  const first = action('a');
  const second = action('b');
  const identityA = rememberGraphReviewAction(key, first);
  const endA = beginGraphReviewPost(key, identityA);
  assert.equal(forgetGraphReviewAction(key, identityA), true, 'A status receipt resolves A while its POST is still running');
  assert.equal(graphReviewPostInFlight(key, identityA), true, 'forgetting a receipt does not end its POST');

  const identityB = rememberGraphReviewAction(key, second);
  const endB = beginGraphReviewPost(key, identityB);
  assert.equal(forgetGraphReviewAction(key, identityA), false, 'late A result cannot forget B');
  endA();
  assert.deepEqual(readGraphReviewActionIdentity(key), identityB);
  assert.equal(exactGraphReviewAction(key), second);
  assert.equal(matchesGraphReviewActionIdentity(key, identityA), false);
  assert.equal(matchesGraphReviewActionIdentity(key, identityB), true);
  assert.equal(graphReviewPostInFlight(key, identityA), false);
  assert.equal(graphReviewPostInFlight(key, identityB), true);
  assert.equal(graphReviewPostInFlight(key), true);

  endB();
  assert.equal(graphReviewPostInFlight(key), false);
  assert.equal(forgetGraphReviewAction(key, identityB), true);
});

test('two concurrent same-identity POSTs retain their marker until both idempotent end calls finish', () => {
  const identity = rememberGraphReviewAction(key, action('c'));
  const endFirst = beginGraphReviewPost(key, identity);
  const endSecond = beginGraphReviewPost(key, identity);
  endFirst();
  endFirst();
  assert.equal(graphReviewPostInFlight(key, identity), true);
  endSecond();
  assert.equal(graphReviewPostInFlight(key, identity), false);
  assert.equal(forgetGraphReviewAction(key, identity), true);
});

test('another auth scope or altered target, digest, key, or expiry cannot match the stored identity', () => {
  const identity = rememberGraphReviewAction(key, action('d'));
  const otherKey = graphReviewActionStorageKey({ ...scope, sessionId: 'session-two' }, document);
  assert.equal(matchesGraphReviewActionIdentity(otherKey, identity), false);
  assert.equal(graphReviewPostInFlight(otherKey), false);
  for (const altered of [
    { ...identity, target: { kind: 'document' as const, workspaceId: document.workspaceId, documentId: 'another-document' } },
    { ...identity, requestDigest: 'f'.repeat(64) },
    { ...identity, idempotencyKey: 'idempotency-other-0001' },
    { ...identity, approvalExpiresAt: identity.approvalExpiresAt + 1 },
  ] satisfies ProposalReviewActionStatusRequestV1[]) {
    assert.equal(matchesGraphReviewActionIdentity(key, altered), false);
    assert.equal(forgetGraphReviewAction(key, altered), false);
    assert.deepEqual(readGraphReviewActionIdentity(key), identity);
  }
  assert.equal(forgetGraphReviewAction(key, identity), true);
});
