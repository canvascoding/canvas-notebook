import assert from 'node:assert/strict';
import { parseProposalReviewProjectionRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-api-v1';

const base = { contractVersion: 1 as const, target: { kind: 'document' as const, workspaceId: 'ws-1', documentId: 'doc-1', lineageId: 'lin-1' }, rootProposalId: 'p-1', selectedProposalIds: ['p-1'] };
assert.deepEqual(parseProposalReviewProjectionRequestV1(base), base);
assert.throws(() => parseProposalReviewProjectionRequestV1({ ...base, target: { ...base.target, workspaceId: 'other', path: '/secret' } }));
assert.throws(() => parseProposalReviewProjectionRequestV1({ ...base, selectedProposalIds: ['p-1', 'p-1'] }));
assert.throws(() => parseProposalReviewProjectionRequestV1({ ...base, limit: 257 }));
assert.throws(() => parseProposalReviewProjectionRequestV1({ ...base, cursor: ' ' }));
console.log('proposal review API contract: 5/5 passed');
