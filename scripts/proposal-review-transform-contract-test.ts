import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseProposalReviewTransformRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-transform-v1';

const request = { contractVersion: 1, target: { kind: 'document', workspaceId: 'workspace-one', documentId: 'document-one' },
  sourceProposalId: 'proposal-one', kind: 'replace', expectedGraphRevision: 3 };

test('transform preview binds only a displayed graph revision and exact source ID', () => {
  assert.deepEqual(parseProposalReviewTransformRequestV1(request), request);
  assert.throws(() => parseProposalReviewTransformRequestV1({ ...request, expectedGraphRevision: 2.5 }));
  assert.throws(() => parseProposalReviewTransformRequestV1({ ...request, kind: 'rebase' }));
  assert.throws(() => parseProposalReviewTransformRequestV1({ ...request, expectedSourceCandidateHash: '0'.repeat(64) }));
});
