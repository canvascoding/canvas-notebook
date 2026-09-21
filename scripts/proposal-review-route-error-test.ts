import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROPOSAL_GRAPH_ERROR_CODES,
  ProposalGraphContractError,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import {
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
} from '../app/lib/file-version-center/contracts/v1';
import { toProposalReviewRouteError } from '../app/lib/file-version-center/proposal-review-route-error';

for (const [proposalCode, fileCode] of [
  [PROPOSAL_GRAPH_ERROR_CODES.accessDenied, FILE_VERSION_CENTER_ERROR_CODES.accessDenied],
  [PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, FILE_VERSION_CENTER_ERROR_CODES.notFound],
  [PROPOSAL_GRAPH_ERROR_CODES.graphChanged, FILE_VERSION_CENTER_ERROR_CODES.conflict],
  [PROPOSAL_GRAPH_ERROR_CODES.currentChanged, FILE_VERSION_CENTER_ERROR_CODES.conflict],
  [PROPOSAL_GRAPH_ERROR_CODES.candidateChanged, FILE_VERSION_CENTER_ERROR_CODES.conflict],
  [PROPOSAL_GRAPH_ERROR_CODES.staleLifecycle, FILE_VERSION_CENTER_ERROR_CODES.conflict],
  [PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, FILE_VERSION_CENTER_ERROR_CODES.invalidRequest],
] as const) {
  test(`${proposalCode} maps to ${fileCode} without exposing its internal message`, () => {
    const mapped = toProposalReviewRouteError(new ProposalGraphContractError(proposalCode, 'private-internal-detail'));
    assert.ok(mapped instanceof FileVersionCenterContractError);
    assert.equal(mapped.code, fileCode);
    assert.doesNotMatch(mapped.message, /private-internal-detail/u);
  });
}

test('non-proposal errors remain available to the shared generic handler', () => {
  const error = new Error('generic');
  assert.equal(toProposalReviewRouteError(error), error);
});
