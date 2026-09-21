import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  ProposalGraphContractError,
  type ProposalCurrentProofV1,
  type ProposalEvaluationStatusV1,
} from './proposal-graph-v1';

/**
 * Read-only compare binding for an already evaluated graph proposal selection.
 * The candidate itself is never accepted, applied, or reconstructed from a
 * mutable agent-operation preview on this boundary.
 */
export const PROPOSAL_REVIEW_COMPARE_CONTRACT_VERSION = 1 as const;

export type ProposalReviewCompareBindingV1 = {
  evaluationId: string;
  selectionHash: string;
  selectedProposalIds: string[];
  current: ProposalCurrentProofV1;
  graphRevision: number;
};

export type ProposalReviewCompareRequestV1 = {
  selectedProposalIds: readonly string[];
  /** Required on every follow-up page; absent only when creating a fresh evaluation. */
  binding?: ProposalReviewCompareBindingV1;
  cursor?: string | null;
  limit?: number;
};

export type ProposalReviewCompareDiagnosisV1 = {
  availability: 'available' | 'unavailable';
  reasonCode: typeof Codes[keyof typeof Codes] | null;
};

export type ProposalReviewCompareLineV1 = {
  kind: 'context' | 'addition' | 'deletion';
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
};

export type ProposalReviewCompareHunkV1 = {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ProposalReviewCompareLineV1[];
};

export type ProposalReviewCompareResponseV1 = {
  contractVersion: typeof PROPOSAL_REVIEW_COMPARE_CONTRACT_VERSION;
  binding: ProposalReviewCompareBindingV1 | null;
  status: ProposalEvaluationStatusV1 | null;
  candidate: { contentAvailable: boolean; noEffect: boolean };
  summary: { additions: number; deletions: number; unchanged: number };
  hunks: ProposalReviewCompareHunkV1[];
  page: { hasMore: boolean; nextCursor: string | null };
  diagnosis: ProposalReviewCompareDiagnosisV1;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export function assertProposalReviewCompareRequestV1(value: ProposalReviewCompareRequestV1): void {
  if (!Array.isArray(value.selectedProposalIds) || value.selectedProposalIds.length === 0
    || value.selectedProposalIds.length > 32 || new Set(value.selectedProposalIds).size !== value.selectedProposalIds.length
    || value.selectedProposalIds.some((id) => typeof id !== 'string' || !ID.test(id))) {
    throw new ProposalGraphContractError(Codes.invalidRequest, 'A comparison requires one exact, bounded proposal selection.');
  }
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 64)) {
    throw new ProposalGraphContractError(Codes.invalidRequest, 'The comparison page size is invalid.');
  }
  if (value.cursor !== undefined && value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 512)) {
    throw new ProposalGraphContractError(Codes.invalidRequest, 'The comparison cursor is invalid.');
  }
  if (value.cursor && !value.binding) {
    throw new ProposalGraphContractError(Codes.invalidRequest, 'A comparison cursor requires its exact evaluation binding.');
  }
  const binding = value.binding;
  if (!binding) return;
  if (!ID.test(binding.evaluationId) || !HASH.test(binding.selectionHash)
    || !Number.isSafeInteger(binding.graphRevision) || binding.graphRevision < 0
    || binding.selectedProposalIds.length !== value.selectedProposalIds.length
    || binding.selectedProposalIds.some((id, index) => id !== value.selectedProposalIds[index])) {
    throw new ProposalGraphContractError(Codes.candidateChanged, 'The comparison binding does not match the selected proposals.');
  }
}
