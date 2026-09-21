import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProposalReviewProjectionV1 } from '../app/lib/file-version-center/contracts/proposal-review-projection-v1';

const scope = { workspaceId: 'w', lineageId: 'l', documentId: 'd', lifecycleGeneration: 1, schemaVersion: 1 };
const proof = { revisionId: 'r', contentHash: 'a'.repeat(64), structureHash: 'b'.repeat(64), stateVectorHash: 'c'.repeat(64), deleteSetHash: 'd'.repeat(64), fullStateHash: 'e'.repeat(64) };
const base = {
  contractVersion: 1,
  graph: { scope, graphRevision: 3, rootProposalId: 'p' },
  proposal: { proposalId: 'p', operationId: 'op', rootProposalId: 'p', parentProposalId: null, relation: 'root', relationships: { dependency: null, replacesProposalId: null, choiceGroupId: null }, lifecycle: 'open', createdAt: 10, createdByActorId: 'actor' },
  evaluation: { evaluationId: 'ev', proposalId: 'p', status: 'clean', current: proof, candidateHash: 'f'.repeat(64), evaluatedAt: 11 },
  authorizedProposalIds: ['p'],
  selection: { selectionId: 'selection', selectedProposalIds: ['p'], graphRevision: 3 },
  actionability: { read: 'available', write: 'stale', inspect: 'available', compare: 'available', accept: 'stale', reject: 'denied', restore: 'denied', continueEditing: 'available' },
  page: { pageIndex: 0, pageSize: 25, nextCursor: null, previousCursor: null, cursorRevision: 3 },
  diagnosis: { availability: 'available', reasonCode: null, correlationId: 'corr', timestamp: 12, buildMarker: 'build' },
};

test('FVRC-1005 accepts bounded projection and separates read/write actionability', () => {
  const result = parseProposalReviewProjectionV1(base);
  assert.equal(result.actionability.read, 'available');
  assert.equal(result.actionability.write, 'stale');
  assert.equal(result.actionability.accept, 'stale');
  assert.equal('path' in result.graph.scope, false);
  assert.equal('content' in result, false);
});

test('FVRC-1005 rejects mismatched evaluation, root, and unknown fields', () => {
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, evaluation: { ...base.evaluation, proposalId: 'other' } }));
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, proposal: { ...base.proposal, rootProposalId: 'other' } }));
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, extra: true }));
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, authorizedProposalIds: [] }));
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, selection: { ...base.selection, graphRevision: 2 } }));
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, page: { ...base.page, cursorRevision: 2 } }));
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, selection: { ...base.selection, selectedProposalIds: ['other'] } }));
});

test('FVRC-1005 accepts every graph error diagnosis reason and rejects unbounded cursors', () => {
  const reasons = ['graph_unavailable', 'scope_mismatch', 'stale_evaluation', 'content_unavailable', 'access_denied', 'invalid_projection', 'invalid_request', 'unsupported_version', 'limit_exceeded', 'source_invalid', 'parent_changed', 'cycle', 'dependency_blocked', 'prerequisite_lost', 'graph_changed', 'current_changed', 'candidate_changed', 'choice_conflict', 'batch_conflict', 'stale_lifecycle', 'fence_expired', 'invalid_transition', 'idempotency_mismatch', 'recovery_required', 'no_effect', 'legacy_blocked', 'upgrade_required'] as const;
  for (const reasonCode of reasons) {
    const parsed = parseProposalReviewProjectionV1({ ...base, diagnosis: { ...base.diagnosis, availability: 'unavailable', reasonCode } });
    assert.equal(parsed.diagnosis.reasonCode, reasonCode);
  }
  assert.throws(() => parseProposalReviewProjectionV1({ ...base, page: { ...base.page, nextCursor: 'x'.repeat(257) } }));
});
