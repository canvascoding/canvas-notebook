import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProposalActionFence, signProposalActionFence, type ProposalFenceState } from '../app/lib/file-version-center/proposal-action-fence';
import { parseProposalReviewActionApiRequestV1, parseProposalReviewSessionRequestV1,
  parseProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { currentProofFixture, proposalScopeFixture } from './fixtures/proposal-graph-contract-v1';

const requestTarget = { kind: 'document' as const, workspaceId: proposalScopeFixture.workspaceId,
  documentId: proposalScopeFixture.documentId };
const sessionTarget = { ...requestTarget, lineageId: proposalScopeFixture.lineageId };
const secret = 'proposal-review-contract-test-signing-secret-32-bytes';
const selectedProposalIds = ['p1'];
const binding = { evaluationId: 'evaluation-1', selectionHash: 'a'.repeat(64), selectedProposalIds,
  current: currentProofFixture, graphRevision: 7 };

function prepared(actionType: ProposalFenceState['actionType']) {
  const noEval = actionType === 'reject';
  const writesContent = actionType === 'accept' || actionType === 'batch_accept';
  const fence = buildProposalActionFence({ state: {
    scope: proposalScopeFixture, actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'auth-1' },
    actionType, current: noEval ? null : currentProofFixture, graphRevision: 7,
    evaluationId: noEval ? null : binding.evaluationId,
    effectiveCandidateHash: noEval ? null : 'c'.repeat(64),
    closure: [{ proposalId: 'p1', casVersion: 2, candidateHash: '8'.repeat(64) }],
    selectedProposalIds, applyProposalIds: writesContent ? selectedProposalIds : [], choiceResolutions: [],
  }, fenceId: `fence-${actionType}`, now: 1_800_000_000_000, expiresAt: 1_800_000_060_000 });
  return { fence, fenceToken: signProposalActionFence(fence, secret) };
}

function compare(input: { contentAvailable?: boolean; noEffect?: boolean; bindingValue?: unknown } = {}) {
  return {
    contractVersion: 1,
    binding: input.bindingValue === undefined ? binding : input.bindingValue,
    status: input.noEffect ? 'empty_effect' : 'clean',
    candidate: { contentAvailable: input.contentAvailable ?? !input.noEffect, noEffect: input.noEffect ?? false },
    summary: { additions: 0, deletions: 0, unchanged: input.noEffect ? 0 : 1 },
    hunks: [], page: { hasMore: false, nextCursor: null },
    diagnosis: { availability: 'available', reasonCode: null },
  };
}

function session(overrides: Record<string, unknown> = {}) {
  const accept = prepared('accept');
  return {
    contractVersion: 1, mode: 'graph', target: sessionTarget, selectedProposalIds,
    status: 'clean', reasonCode: null,
    compare: compare(), actions: { accept }, capability: { write: true },
    diagnosis: { reasonCode: null, phase: 'review', correlationId: 'corr-1', timestamp: 1_800_000_000_000,
      buildMarker: 'fvrc-1006' },
    ...overrides,
  };
}

test('session request admits exact single, all, and bounded explicit selections only', () => {
  assert.deepEqual(parseProposalReviewSessionRequestV1({ contractVersion: 1, target: requestTarget,
    selection: { kind: 'operation', operationId: 'operation-1' } }).selection,
  { kind: 'operation', operationId: 'operation-1' });
  assert.deepEqual(parseProposalReviewSessionRequestV1({ contractVersion: 1, target: requestTarget, selection: { kind: 'all' } }).selection,
    { kind: 'all' });
  assert.throws(() => parseProposalReviewSessionRequestV1({ contractVersion: 1, target: requestTarget,
    selection: { kind: 'proposals', proposalIds: ['p1', 'p1'] } }));
  assert.throws(() => parseProposalReviewSessionRequestV1({ contractVersion: 1, target: requestTarget,
    selection: { kind: 'all', limit: 5 } }));
});

test('prepared action and compare binding must match the exact session selection and current fence', () => {
  const parsed = parseProposalReviewSessionResponseV1(session());
  assert.equal(parsed.mode, 'graph');

  const wrongSelection = session({ selectedProposalIds: ['p2'] });
  assert.throws(() => parseProposalReviewSessionResponseV1(wrongSelection), /invalid|contract/u);

  const wrongCurrent = prepared('accept');
  wrongCurrent.fence.current!.fullStateHash = 'f'.repeat(64);
  assert.throws(() => parseProposalReviewSessionResponseV1(session({ actions: { accept: wrongCurrent } })));

  const wrongEval = prepared('accept');
  wrongEval.fence.evaluationId = 'other-evaluation';
  assert.throws(() => parseProposalReviewSessionResponseV1(session({ actions: { accept: wrongEval } })));
});

test('malformed prepared token and additional unknown fields fail schema validation', () => {
  const invalidToken = prepared('accept');
  invalidToken.fenceToken = 'raw-secret-token';
  assert.throws(() => parseProposalReviewSessionResponseV1(session({ actions: { accept: invalidToken } })));
  assert.throws(() => parseProposalReviewSessionResponseV1(session({ unexpectedCandidateBytes: 'must not cross the boundary' })));
});

test('the contract accepts a successful no-effect preview with a genuine +0 / -0 summary', () => {
  const completeSatisfied = prepared('complete_satisfied');
  const noEffect = session({ status: 'empty_effect', actions: { completeSatisfied },
    compare: compare({ noEffect: true }) });
  const parsed = parseProposalReviewSessionResponseV1(noEffect);
  assert.equal(parsed.mode, 'graph');
  if (parsed.mode !== 'graph') return;
  assert.deepEqual(parsed.compare?.summary, { additions: 0, deletions: 0, unchanged: 0 });
  assert.equal(parsed.compare?.candidate.noEffect, true);
  assert.equal(parsed.actions.completeSatisfied?.fence.actionType, 'complete_satisfied');
});

test('zero hunks without a proven no-effect candidate is not accepted as a successful null preview', () => {
  assert.throws(() => parseProposalReviewSessionResponseV1(session({
    compare: compare({ contentAvailable: false, noEffect: false }),
  })));
});

test('action API request permits only supported non-creation actions with a valid parsed fence', () => {
  const reject = prepared('reject');
  const action = { contractVersion: 1, fence: reject.fence, fenceToken: reject.fenceToken,
    idempotencyKey: 'review-action-idempotency-001', creation: null };
  assert.equal(parseProposalReviewActionApiRequestV1({ contractVersion: 1, target: requestTarget, action }).action.fence.actionType, 'reject');
  assert.throws(() => parseProposalReviewActionApiRequestV1({ contractVersion: 1, target: requestTarget,
    action: { ...action, creation: { unexpected: true } } }));
  const rebase = prepared('rebase');
  assert.throws(() => parseProposalReviewActionApiRequestV1({ contractVersion: 1, target: requestTarget, action: {
    ...action, fence: rebase.fence, fenceToken: rebase.fenceToken,
  } }));
});

test('compare selection mismatch is rejected even when the outer schema is otherwise valid', () => {
  const bad = compare({ bindingValue: { ...binding, selectedProposalIds: ['p2'] } });
  assert.throws(() => parseProposalReviewSessionResponseV1(session({ compare: bad })));
});
