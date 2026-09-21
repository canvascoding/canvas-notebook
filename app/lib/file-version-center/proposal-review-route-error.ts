import {
  PROPOSAL_GRAPH_ERROR_CODES as PROPOSAL_CODES,
  ProposalGraphContractError,
} from './contracts/proposal-graph-v1';
import {
  FILE_VERSION_CENTER_ERROR_CODES as FILE_CODES,
  FileVersionCenterContractError,
} from './contracts/v1';

const CONFLICT_CODES = new Set<string>([
  PROPOSAL_CODES.graphChanged,
  PROPOSAL_CODES.currentChanged,
  PROPOSAL_CODES.candidateChanged,
  PROPOSAL_CODES.parentChanged,
  PROPOSAL_CODES.batchConflict,
  PROPOSAL_CODES.choiceConflict,
  PROPOSAL_CODES.staleLifecycle,
  PROPOSAL_CODES.fenceExpired,
]);

export function toProposalReviewRouteError(error: unknown): unknown {
  if (!(error instanceof ProposalGraphContractError)) return error;
  const code = error.code === PROPOSAL_CODES.accessDenied
    ? FILE_CODES.accessDenied
    : error.code === PROPOSAL_CODES.sourceInvalid
      ? FILE_CODES.notFound
      : CONFLICT_CODES.has(error.code)
        ? FILE_CODES.conflict
        : FILE_CODES.invalidRequest;
  return new FileVersionCenterContractError(
    code,
    'The proposal review projection is not available for this document state.',
  );
}
