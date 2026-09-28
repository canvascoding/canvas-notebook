import type { ProposalCurrentProofV1, ProposalEvaluationStatusV1 } from './contracts/proposal-graph-v1';

/**
 * A composed cancellation can preserve content and stable semantic structure
 * while adding CRDT structs/tombstones. Never canonicalize its authored IDs.
 * Already-present effects remain identity-sensitive. This proves only the
 * candidate's null effect, NOT freshness: callers must still fence the full
 * current proof, graph, selection and immutable candidate artifact.
 */
export function hasProposalNullEffectProof(status: ProposalEvaluationStatusV1,
  current: ProposalCurrentProofV1 | null, candidate: ProposalCurrentProofV1 | null): boolean {
  if (!current || !candidate || current.contentHash !== candidate.contentHash
    || current.structureHash !== candidate.structureHash) return false;
  if (status === 'empty_effect') return true;
  return status === 'satisfied_elsewhere' && current.revisionId === candidate.revisionId
    && current.stateVectorHash === candidate.stateVectorHash
    && current.deleteSetHash === candidate.deleteSetHash
    && current.fullStateHash === candidate.fullStateHash;
}
