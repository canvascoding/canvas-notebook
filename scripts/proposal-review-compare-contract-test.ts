import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseProposalReviewCompareApiRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-compare-api-v1';
import { assertProposalReviewCompareRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-compare-v1';

const hash = 'a'.repeat(64);
const current = {
  revisionId: null,
  contentHash: hash,
  structureHash: hash,
  stateVectorHash: hash,
  deleteSetHash: hash,
  fullStateHash: hash,
};
const binding = {
  evaluationId: 'evaluation-1',
  selectionHash: hash,
  selectedProposalIds: ['proposal-1'],
  current,
  graphRevision: 4,
};

test('compare API accepts an exact, closed, current-bound request', () => {
  const parsed = parseProposalReviewCompareApiRequestV1({
    contractVersion: 1,
    target: { kind: 'document', workspaceId: 'workspace-1', documentId: 'document-1', lineageId: 'lineage-1' },
    selectedProposalIds: ['proposal-1'],
    binding,
    cursor: null,
    limit: 20,
  });
  assert.equal(parsed.binding?.current.fullStateHash, hash);
  assertProposalReviewCompareRequestV1(parsed);
});

test('compare API rejects extra fields and malformed current proofs', () => {
  assert.throws(() => parseProposalReviewCompareApiRequestV1({
    contractVersion: 1,
    target: { kind: 'document', workspaceId: 'workspace-1', documentId: 'document-1', lineageId: 'lineage-1' },
    selectedProposalIds: ['proposal-1'],
    binding: { ...binding, current: { ...current, contentHash: 'not-a-hash' } },
    leakedPath: '/private/file.md',
  }));
});

test('domain contract rejects a binding for another exact selection', () => {
  assert.throws(() => assertProposalReviewCompareRequestV1({
    selectedProposalIds: ['proposal-2'],
    binding,
  }));
});

test('a paged cursor requires the evaluation binding it was issued with', () => {
  assert.throws(() => assertProposalReviewCompareRequestV1({
    selectedProposalIds: ['proposal-1'],
    cursor: 'opaque-page',
  }));
});
