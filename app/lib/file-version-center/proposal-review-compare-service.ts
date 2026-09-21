import 'server-only';

import { createHash } from 'node:crypto';

import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  ProposalGraphContractError,
  type ProposalCurrentProofV1,
  type ProposalEvaluationStatusV1,
  type ProposalEvaluationV1,
} from './contracts/proposal-graph-v1';
import {
  PROPOSAL_REVIEW_COMPARE_CONTRACT_VERSION,
  assertProposalReviewCompareRequestV1,
  type ProposalReviewCompareBindingV1,
  type ProposalReviewCompareRequestV1,
  type ProposalReviewCompareResponseV1,
} from './contracts/proposal-review-compare-v1';
import { FILE_VERSION_CENTER_CONTRACT_LIMITS } from './contracts/v1';
import { FILE_VERSION_CENTER_LIMITS_V1 } from './policy-v1';
import type { ProposalReviewEvaluationResult } from './proposal-review-evaluation';
import { fileVersionTextLines, projectFileVersionTextDiff } from './text-diff';

type Material = {
  evaluation: ProposalEvaluationV1;
  selectionHash: string;
  selectedProposalIds: string[];
  graphRevision: number;
  currentGraphRevision: number;
  candidateContent: string | null;
  status: ProposalEvaluationStatusV1;
  nullEffectProven: boolean;
};

export type ProposalReviewCompareDependencies = {
  evaluateSelection(input: { selectedProposalIds: readonly string[] }): Promise<ProposalReviewEvaluationResult>;
  /** Must reauthorize scope/ownership and read immutable evaluation evidence. */
  loadEvaluation(input: { evaluationId: string; selectedProposalIds: readonly string[] }): Promise<Material | null>;
  loadCurrent(): Promise<{ content: string; proof: ProposalCurrentProofV1 }>;
};

function proofEquals(left: ProposalCurrentProofV1, right: ProposalCurrentProofV1): boolean {
  return left.revisionId === right.revisionId && left.contentHash === right.contentHash
    && left.structureHash === right.structureHash && left.stateVectorHash === right.stateVectorHash
    && left.deleteSetHash === right.deleteSetHash && left.fullStateHash === right.fullStateHash;
}

function bindingsEqual(left: ProposalReviewCompareBindingV1, right: ProposalReviewCompareBindingV1): boolean {
  return left.evaluationId === right.evaluationId && left.selectionHash === right.selectionHash
    && left.graphRevision === right.graphRevision && proofEquals(left.current, right.current)
    && left.selectedProposalIds.length === right.selectedProposalIds.length
    && left.selectedProposalIds.every((id, index) => id === right.selectedProposalIds[index]);
}

function toBinding(material: Material): ProposalReviewCompareBindingV1 {
  return { evaluationId: material.evaluation.evaluationId, selectionHash: material.selectionHash,
    selectedProposalIds: [...material.selectedProposalIds], current: material.evaluation.current,
    graphRevision: material.graphRevision };
}

function unavailable(reasonCode: typeof Codes[keyof typeof Codes], status: ProposalEvaluationStatusV1 | null = null,
  binding: ProposalReviewCompareBindingV1 | null = null): ProposalReviewCompareResponseV1 {
  return { contractVersion: PROPOSAL_REVIEW_COMPARE_CONTRACT_VERSION, binding, status,
    candidate: { contentAvailable: false, noEffect: false }, summary: { additions: 0, deletions: 0, unchanged: 0 }, hunks: [],
    page: { hasMore: false, nextCursor: null }, diagnosis: { availability: 'unavailable', reasonCode } };
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function cursor(binding: ProposalReviewCompareBindingV1, offset: number): string {
  return Buffer.from(JSON.stringify({ offset, binding: hash(JSON.stringify(binding)) }), 'utf8').toString('base64url');
}
function parseCursor(value: string | null | undefined, binding: ProposalReviewCompareBindingV1): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { offset?: unknown; binding?: unknown };
    if (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 || parsed.binding !== hash(JSON.stringify(binding))) throw new Error();
    return parsed.offset as number;
  } catch {
    throw new ProposalGraphContractError(Codes.candidateChanged, 'The comparison page is bound to a different evaluated candidate.');
  }
}

function admittedLines(value: string): string[] {
  if (Buffer.byteLength(value, 'utf8') > FILE_VERSION_CENTER_LIMITS_V1.maxCompareBytesPerSide) {
    throw new ProposalGraphContractError(Codes.limitExceeded, 'Comparison content exceeds the bounded preview size.');
  }
  const result = fileVersionTextLines(value);
  if (result.length > FILE_VERSION_CENTER_LIMITS_V1.maxCompareLinesPerSide
    || result.some((line) => line.length > FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters)) {
    throw new ProposalGraphContractError(Codes.limitExceeded, 'Comparison content exceeds the bounded line limits.');
  }
  return result;
}

function materialFromEvaluation(result: ProposalReviewEvaluationResult): Material | null {
  if (!result.evaluation || !result.selectionHash || result.graphRevision === null) return null;
  return { evaluation: result.evaluation, selectionHash: result.selectionHash,
    selectedProposalIds: [...result.selectedProposalIds], graphRevision: result.graphRevision,
    currentGraphRevision: result.graphRevision, candidateContent: result.candidateContent, status: result.status,
    nullEffectProven: result.current !== null && result.candidateProof !== null && proofEquals(result.current, result.candidateProof) };
}

export function createProposalReviewCompareService(dependencies: ProposalReviewCompareDependencies) {
  return {
    async compare(request: ProposalReviewCompareRequestV1): Promise<ProposalReviewCompareResponseV1> {
      assertProposalReviewCompareRequestV1(request);
      let material: Material | null;
      try {
        if (request.binding) {
          material = await dependencies.loadEvaluation({ evaluationId: request.binding.evaluationId,
            selectedProposalIds: request.selectedProposalIds });
        } else {
          material = materialFromEvaluation(await dependencies.evaluateSelection({ selectedProposalIds: request.selectedProposalIds }));
        }
      } catch (error) {
        if (error instanceof ProposalGraphContractError) return unavailable(error.code);
        return unavailable(Codes.contentUnavailable);
      }
      if (!material) return unavailable(Codes.contentUnavailable);
      const binding = toBinding(material);
      if (request.binding && !bindingsEqual(request.binding, binding)) return unavailable(Codes.candidateChanged, material.status, binding);
      if (material.evaluation.expiresAt <= Date.now()) return unavailable(Codes.fenceExpired, material.status, binding);
      if (material.currentGraphRevision !== material.graphRevision) return unavailable(Codes.graphChanged, material.status, binding);
      let current: { content: string; proof: ProposalCurrentProofV1 };
      try { current = await dependencies.loadCurrent(); } catch (error) {
        return unavailable(error instanceof ProposalGraphContractError ? error.code : Codes.contentUnavailable, material.status, binding);
      }
      if (!proofEquals(current.proof, material.evaluation.current)) return unavailable(Codes.currentChanged, material.status, binding);
      if (material.status === 'conflicted') return unavailable(Codes.batchConflict, material.status, binding);
      if (material.status === 'blocked_by_parent') return unavailable(Codes.dependencyBlocked, material.status, binding);
      if (material.status === 'prerequisite_lost') return unavailable(Codes.prerequisiteLost, material.status, binding);
      if (!['clean', 'clean_rebased', 'satisfied_elsewhere', 'empty_effect'].includes(material.status)) {
        return unavailable(Codes.contentUnavailable, material.status, binding);
      }
      if ((material.status === 'satisfied_elsewhere' || material.status === 'empty_effect') && !material.nullEffectProven) {
        return unavailable(Codes.candidateChanged, material.status, binding);
      }
      // The only successful null-diff state is a proven empty effect. Any other
      // absent effective candidate is fail-closed and is never rendered as no-op.
      if (material.candidateContent === null
        && material.status !== 'empty_effect'
        && material.status !== 'satisfied_elsewhere') {
        return unavailable(Codes.contentUnavailable, material.status, binding);
      }
      if (material.status === 'empty_effect' || material.status === 'satisfied_elsewhere') {
        return { contractVersion: PROPOSAL_REVIEW_COMPARE_CONTRACT_VERSION, binding, status: material.status,
          candidate: { contentAvailable: material.candidateContent !== null, noEffect: true },
          summary: { additions: 0, deletions: 0, unchanged: 0 }, hunks: [], page: { hasMore: false, nextCursor: null },
          diagnosis: { availability: 'available', reasonCode: null } };
      }
      const candidate = material.candidateContent ?? current.content;
      let projection: ReturnType<typeof projectFileVersionTextDiff>;
      try {
        projection = projectFileVersionTextDiff(admittedLines(current.content), admittedLines(candidate));
        if (projection.hunks.length > FILE_VERSION_CENTER_LIMITS_V1.maxDiffHunks) {
          throw new ProposalGraphContractError(Codes.limitExceeded, 'Comparison produces too many bounded hunks.');
        }
      } catch (error) {
        return unavailable(error instanceof ProposalGraphContractError ? error.code : Codes.contentUnavailable, material.status, binding);
      }
      const { hunks, summary } = projection;
      const offset = parseCursor(request.cursor, binding); const limit = request.limit ?? 64;
      if (offset > hunks.length) throw new ProposalGraphContractError(Codes.invalidRequest, 'The comparison cursor is outside the available hunks.');
      const page = hunks.slice(offset, offset + limit); const nextOffset = offset + page.length;
      return { contractVersion: PROPOSAL_REVIEW_COMPARE_CONTRACT_VERSION, binding, status: material.status,
          candidate: { contentAvailable: material.candidateContent !== null, noEffect: false }, summary,
        hunks: page, page: { hasMore: nextOffset < hunks.length, nextCursor: nextOffset < hunks.length ? cursor(binding, nextOffset) : null },
        diagnosis: { availability: 'available', reasonCode: null } };
    },
  };
}
