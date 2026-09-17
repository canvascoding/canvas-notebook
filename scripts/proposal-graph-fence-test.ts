import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildProposalActionFence, canonicalProposalJson, hashProposalValue,
  signProposalActionFence, verifyProposalActionFence, type ProposalFenceState,
} from '../app/lib/file-version-center/proposal-action-fence';
import {
  PROPOSAL_GRAPH_LIMITS, ProposalGraphContractError, parseProposalActionFenceV1, parseProposalNodeV1,
  type ProposalCreateRequestV1, type ProposalGraphErrorCode,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { acceptFenceFixture, replacementChildFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const now = 1_789_646_400_000;
const secret = 'test-only-signing-secret-32-bytes-long';

function state(): ProposalFenceState {
  const parsed = parseProposalActionFenceV1(JSON.parse(JSON.stringify(acceptFenceFixture)));
  return {
    scope: parsed.scope, actor: parsed.actor, actionType: parsed.actionType,
    current: parsed.current, graphRevision: parsed.graphRevision,
    evaluationId: parsed.evaluationId, effectiveCandidateHash: parsed.effectiveCandidateHash,
    closure: parsed.closure, selectedProposalIds: parsed.selectedProposalIds,
    applyProposalIds: parsed.applyProposalIds, choiceResolutions: parsed.choiceResolutions,
  };
}

function fixture() {
  const expected = state();
  const fence = buildProposalActionFence({ state: expected, fenceId: 'approval-1', now });
  return { fence, expected, token: signProposalActionFence(fence, secret), secret, now: now + 1 };
}

function rejects(action: () => unknown, code: ProposalGraphErrorCode) {
  assert.throws(action, (error: unknown) => error instanceof ProposalGraphContractError && error.code === code);
}

test('canonical proof has a fixed independent SHA oracle and ignores JSON object key order', () => {
  assert.equal(canonicalProposalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(hashProposalValue({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.equal(hashProposalValue({ a: [1, { z: 2, b: 3 }] }), hashProposalValue({ a: [1, { b: 3, z: 2 }] }));
  assert.notEqual(hashProposalValue([1, 2]), hashProposalValue([2, 1]));
});

test('canonical proof rejects non-JSON data without invoking accessors', () => {
  let called = false;
  const getter = { get value() { called = true; return 1; } };
  const array: number[] = [];
  Object.defineProperty(array, '0', { enumerable: true, get() { called = true; return 1; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const invalid of [getter, array, cycle, new Date(), undefined, Number.NaN, Infinity, () => 1, [undefined], Array(1)]) {
    rejects(() => canonicalProposalJson(invalid), 'PROPOSAL_INVALID_REQUEST');
  }
  assert.equal(called, false);
  const shared = { value: 1 };
  assert.equal(canonicalProposalJson([shared, shared]), '[{"value":1},{"value":1}]');
  rejects(() => canonicalProposalJson('a'.repeat(PROPOSAL_GRAPH_LIMITS.payloadBytes + 1)), 'PROPOSAL_LIMIT_EXCEEDED');
  let nested: unknown = null;
  for (let index = 0; index < 34; index++) nested = [nested];
  rejects(() => canonicalProposalJson(nested), 'PROPOSAL_LIMIT_EXCEEDED');
});

test('issuance detaches caller objects, is deterministic and bounds approval lifetime', () => {
  const expected = state();
  const fence = buildProposalActionFence({ state: expected, fenceId: 'approval-1', now, expiresAt: now + 999_999_999 });
  assert.equal(fence.expiresAt, now + PROPOSAL_GRAPH_LIMITS.fenceLifetimeMs);
  assert.deepEqual(fence, buildProposalActionFence({ state: state(), fenceId: 'approval-1', now }));
  expected.closure[0].casVersion++;
  assert.equal(fence.closure[0].casVersion, 1);
  rejects(() => buildProposalActionFence({ state: state(), fenceId: 'expired', now, expiresAt: now }), 'PROPOSAL_FENCE_EXPIRED');
});

test('signed approval verifies only with its exact token and protected key', () => {
  const input = fixture();
  assert.deepEqual(verifyProposalActionFence(input), input.fence);
  rejects(() => verifyProposalActionFence({ ...input, token: '' }), 'PROPOSAL_ACCESS_DENIED');
  rejects(() => verifyProposalActionFence({ ...input, token: `${input.token}x` }), 'PROPOSAL_ACCESS_DENIED');
  rejects(() => verifyProposalActionFence({ ...input, secret: 'other-test-only-secret-of-32-bytes' }), 'PROPOSAL_ACCESS_DENIED');
  rejects(() => signProposalActionFence(input.fence, 'short'), 'PROPOSAL_ACCESS_DENIED');
  rejects(() => verifyProposalActionFence({ ...input, fence: { ...input.fence, graphRevision: 4 } }), 'PROPOSAL_ACCESS_DENIED');
  assert.ok(!JSON.stringify(input.fence).includes(secret));
});

test('expiration and future-issued approvals require a fresh user review', () => {
  const input = fixture();
  for (const invalidNow of [input.fence.expiresAt, now - 1, Number.NaN]) {
    rejects(() => verifyProposalActionFence({ ...input, now: invalidNow }), 'PROPOSAL_FENCE_EXPIRED');
  }
  verifyProposalActionFence({ ...input, now: input.fence.expiresAt - 1 });
});

test('actor, rights revision, workspace and lifecycle are fenced independently', () => {
  for (const actorKey of ['userId', 'actorId', 'authorizationRevision'] as const) {
    const input = fixture(); input.expected.actor[actorKey] += '-changed';
    rejects(() => verifyProposalActionFence(input), 'PROPOSAL_ACCESS_DENIED');
  }
  for (const scopeKey of ['workspaceId', 'lineageId', 'documentId'] as const) {
    const input = fixture(); input.expected.scope[scopeKey] += '-other';
    rejects(() => verifyProposalActionFence(input), 'PROPOSAL_SCOPE_MISMATCH');
  }
  for (const scopeKey of ['lifecycleGeneration', 'schemaVersion'] as const) {
    const input = fixture(); input.expected.scope[scopeKey]++;
    rejects(() => verifyProposalActionFence(input), 'PROPOSAL_STALE_LIFECYCLE');
  }
});

test('every current-state proof field matters, including deletion with an unchanged state vector', () => {
  for (const key of ['revisionId', 'contentHash', 'structureHash', 'stateVectorHash', 'deleteSetHash', 'fullStateHash'] as const) {
    const input = fixture();
    assert.ok(input.expected.current);
    input.expected.current[key] = key === 'revisionId' ? 'revision-new' : 'f'.repeat(64);
    rejects(() => verifyProposalActionFence(input), 'PROPOSAL_CURRENT_CHANGED');
  }
});

test('graph revisions, CAS closure and evaluated candidates cannot change after preview', () => {
  const revision = fixture(); revision.expected.graphRevision++;
  rejects(() => verifyProposalActionFence(revision), 'PROPOSAL_GRAPH_CHANGED');
  const cas = fixture(); cas.expected.closure[0].casVersion++;
  rejects(() => verifyProposalActionFence(cas), 'PROPOSAL_GRAPH_CHANGED');
  const memberCandidate = fixture(); memberCandidate.expected.closure[0].candidateHash = 'f'.repeat(64);
  rejects(() => verifyProposalActionFence(memberCandidate), 'PROPOSAL_GRAPH_CHANGED');
  const closure = fixture(); closure.expected.closure.pop();
  rejects(() => verifyProposalActionFence(closure), 'PROPOSAL_GRAPH_CHANGED');
  const evaluation = fixture(); evaluation.expected.evaluationId = 'evaluation-new';
  rejects(() => verifyProposalActionFence(evaluation), 'PROPOSAL_CANDIDATE_CHANGED');
  const candidate = fixture(); candidate.expected.effectiveCandidateHash = 'f'.repeat(64);
  rejects(() => verifyProposalActionFence(candidate), 'PROPOSAL_CANDIDATE_CHANGED');
});

test('action, batch ordering and alternative closure are part of displayed approval', () => {
  const action = fixture(); action.expected.actionType = 'batch_accept';
  rejects(() => verifyProposalActionFence(action), 'PROPOSAL_INVALID_REQUEST');
  const order = fixture(); order.expected.applyProposalIds.reverse();
  rejects(() => verifyProposalActionFence(order), 'PROPOSAL_INVALID_REQUEST');
  const selection = fixture(); selection.expected.selectedProposalIds = ['p1'];
  rejects(() => verifyProposalActionFence(selection), 'PROPOSAL_INVALID_REQUEST');
  const choice = fixture(); choice.expected.choiceResolutions[0].groupRevision++;
  rejects(() => verifyProposalActionFence(choice), 'PROPOSAL_INVALID_REQUEST');
  const closing = fixture(); closing.expected.choiceResolutions[0].closingProposalIds = [];
  rejects(() => verifyProposalActionFence(closing), 'PROPOSAL_INVALID_REQUEST');
});

test('even a correctly signed but internally inconsistent proof is rejected', () => {
  for (const key of ['requestDigest', 'closureHash', 'batchHash'] as const) {
    const input = fixture(); input.fence[key] = 'f'.repeat(64);
    input.token = signProposalActionFence(input.fence, secret);
    rejects(() => verifyProposalActionFence(input), 'PROPOSAL_INVALID_REQUEST');
  }
});

test('reject remains possible without document bytes but is still scoped, signed and CAS fenced', () => {
  const expected = state();
  Object.assign(expected, { actionType: 'reject', current: null, evaluationId: null,
    effectiveCandidateHash: null, applyProposalIds: [], choiceResolutions: [] });
  const fence = buildProposalActionFence({ state: expected, fenceId: 'reject-1', now });
  const input = { fence, expected, token: signProposalActionFence(fence, secret), secret, now: now + 1 };
  verifyProposalActionFence(input);
  expected.closure[1].casVersion++;
  rejects(() => verifyProposalActionFence(input), 'PROPOSAL_GRAPH_CHANGED');
});

test('replacement approval binds the exact new source, candidate and identity', () => {
  const expected = state();
  Object.assign(expected, { actionType: 'replace', applyProposalIds: [], choiceResolutions: [] });
  const node = parseProposalNodeV1(replacementChildFixture);
  const creation: ProposalCreateRequestV1 = {
    contractVersion: 1, proposalId: node.proposalId, operationId: node.operationId,
    scope: node.scope, source: node.source, relationships: node.relationships,
    authoredCandidate: node.authoredCandidate, creationKind: 'replacement',
    detachedFromProposalId: null, reviewRequired: true,
  };
  const fence = buildProposalActionFence({ state: expected, fenceId: 'replace-1', now, creation });
  const input = { fence, expected, token: signProposalActionFence(fence, secret), secret, now: now + 1, creation };
  verifyProposalActionFence(input);
  const changed = JSON.parse(JSON.stringify(creation)) as ProposalCreateRequestV1;
  changed.authoredCandidate.sourceProofHash = 'f'.repeat(64);
  rejects(() => verifyProposalActionFence({ ...input, creation: changed }), 'PROPOSAL_INVALID_REQUEST');
  rejects(() => verifyProposalActionFence({ ...input, creation: { ...creation, proposalId: 'another-new-proposal' } }), 'PROPOSAL_INVALID_REQUEST');
  rejects(() => verifyProposalActionFence({ ...input, creation: null }), 'PROPOSAL_INVALID_REQUEST');
});

test('detach approval binds its independent source and cannot be redirected to another proposal', () => {
  const expected = state();
  Object.assign(expected, { actionType: 'detach', applyProposalIds: [], choiceResolutions: [] });
  const node = parseProposalNodeV1(rootProposalFixture);
  const creation: ProposalCreateRequestV1 = {
    contractVersion: 1, proposalId: 'detached-new', operationId: 'operation-detached-new',
    scope: node.scope, source: node.source, relationships: { dependency: null, replacesProposalId: null, choiceGroupId: null },
    authoredCandidate: node.authoredCandidate, creationKind: 'detached',
    detachedFromProposalId: 'p2', reviewRequired: true,
  };
  const fence = buildProposalActionFence({ state: expected, fenceId: 'detach-1', now, creation });
  const input = { fence, expected, token: signProposalActionFence(fence, secret), secret, now: now + 1, creation };
  verifyProposalActionFence(input);
  const changed = JSON.parse(JSON.stringify(creation)) as ProposalCreateRequestV1;
  changed.source.current.deleteSetHash = 'f'.repeat(64);
  rejects(() => verifyProposalActionFence({ ...input, creation: changed }), 'PROPOSAL_INVALID_REQUEST');
  rejects(() => verifyProposalActionFence({ ...input, creation: { ...creation, operationId: 'other-operation' } }), 'PROPOSAL_INVALID_REQUEST');
  rejects(() => verifyProposalActionFence({ ...input, creation: { ...creation, detachedFromProposalId: 'p1' } }), 'PROPOSAL_SOURCE_INVALID');
  rejects(() => verifyProposalActionFence({ ...input, creation: null }), 'PROPOSAL_INVALID_REQUEST');
});
