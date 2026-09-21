import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  PROPOSAL_GRAPH_LIMITS as Limits,
  ProposalGraphContractError,
  type ProposalArtifactReferenceV1,
  type ProposalCurrentProofV1,
  type ProposalDocumentScopeV1,
  type ProposalEvaluationStatusV1,
  type ProposalEvaluationV1,
  type ProposalGraphErrorCode,
  type ProposalSnapshotReferenceV1,
} from './contracts/proposal-graph-v1';
import {
  canonicalProposalJson,
  hashProposalEvaluationSelectionV1,
  hashProposalValue,
} from './proposal-action-fence';
import { resolveProposalClosure, type ProposalClosureReady } from './proposal-graph-model';
import { loadProposalNodeArtifacts } from './proposal-provenance-service';
import type { ProposalGraphStorageTransaction } from './proposal-storage';
import {
  composeProposalYjsCandidate,
  proposalYjsCurrentProof,
  type ProposalYjsCompositionEntry,
  type ProposalYjsRepresentation,
} from './proposal-yjs-candidate';

export type ProposalEvaluationCurrent = {
  scope: ProposalDocumentScopeV1;
  representation: ProposalYjsRepresentation;
  revisionId: string | null;
  update: Uint8Array;
};

export type ProposalReviewEvaluationAuthorization = {
  scope: ProposalDocumentScopeV1;
  /** Includes selected nodes, prerequisites and choice alternatives before reads. */
  proposalIds: string[];
};

export type ProposalReviewEvaluationInput = {
  scope: ProposalDocumentScopeV1;
  selectedProposalIds: readonly string[];
  transaction: ProposalGraphStorageTransaction;
  loadCurrent(): Promise<ProposalEvaluationCurrent>;
  /** Re-read authoritative current after the candidate is composed, before it is persisted. */
  confirmCurrent?(expected: ProposalCurrentProofV1): Promise<ProposalEvaluationCurrent>;
  authorize(input: ProposalReviewEvaluationAuthorization): Promise<void>;
  now?: () => number;
  createId?: () => string;
};

export type ProposalReviewEvaluationActionability =
  | 'accept'
  | 'complete_satisfied'
  | 'none';

export type ProposalReviewEvaluationResult = {
  status: ProposalEvaluationStatusV1;
  reasonCode: ProposalGraphErrorCode | null;
  current: ProposalCurrentProofV1 | null;
  graphRevision: number | null;
  selectedProposalIds: string[];
  dependencyProposalIds: string[];
  applyProposalIds: string[];
  prerequisiteProposalIds: string[];
  closureProposalIds: string[];
  /** Binds exact batch membership/order and all graph-derived acceptance effects. */
  selectionHash: string | null;
  actionability: ProposalReviewEvaluationActionability;
  evaluation: ProposalEvaluationV1 | null;
  effectiveCandidate: ProposalSnapshotReferenceV1 | null;
  candidateContent: string | null;
  candidateProof: ProposalCurrentProofV1 | null;
  appliedProposalIds: string[];
  satisfiedProposalIds: string[];
};

function sameScope(left: ProposalDocumentScopeV1, right: ProposalDocumentScopeV1): boolean {
  return left.workspaceId === right.workspaceId
    && left.lineageId === right.lineageId
    && left.documentId === right.documentId
    && left.lifecycleGeneration === right.lifecycleGeneration
    && left.schemaVersion === right.schemaVersion;
}

function plainRef(ref: { ref: string; sha256: string; sizeBytes: number }): ProposalArtifactReferenceV1 {
  return { ref: ref.ref, sha256: ref.sha256, sizeBytes: ref.sizeBytes };
}

function snapshotRef(ref: { ref: string; sha256: string; sizeBytes: number }): ProposalSnapshotReferenceV1 {
  return { ...plainRef(ref), encoding: 'yjs_full_update_v1' };
}

function failureStatus(code: ProposalGraphErrorCode): ProposalEvaluationStatusV1 {
  if (code === Codes.prerequisiteLost) return 'prerequisite_lost';
  if (code === Codes.dependencyBlocked || code === Codes.invalidTransition) return 'blocked_by_parent';
  if (code === Codes.batchConflict || code === Codes.choiceConflict) return 'conflicted';
  if (code === Codes.staleLifecycle) return 'stale_lifecycle';
  return 'unavailable';
}

function actionability(status: ProposalEvaluationStatusV1): ProposalReviewEvaluationActionability {
  if (status === 'clean' || status === 'clean_rebased') return 'accept';
  if (status === 'satisfied_elsewhere' || status === 'empty_effect') return 'complete_satisfied';
  return 'none';
}

function initialResult(input: ProposalReviewEvaluationInput): ProposalReviewEvaluationResult {
  return {
    status: 'unavailable', reasonCode: null, current: null, graphRevision: null,
    selectedProposalIds: [...input.selectedProposalIds], dependencyProposalIds: [], applyProposalIds: [],
    prerequisiteProposalIds: [], closureProposalIds: [], selectionHash: null, actionability: 'none', evaluation: null,
    effectiveCandidate: null, candidateContent: null, candidateProof: null,
    appliedProposalIds: [], satisfiedProposalIds: [],
  };
}

/**
 * Stable binding for a batch evaluation. EvaluationV1 predates batch fields, so
 * callers can carry this alongside V1 until the next additive contract is live.
 */
export function proposalEvaluationSelectionHash(closure: ProposalClosureReady): string {
  return hashProposalEvaluationSelectionV1({
    selectedProposalIds: closure.selectedProposalIds,
    closureProposalIds: closure.closureProposalIds,
    applyProposalIds: closure.applyProposalIds,
    graphRevision: closure.graphRevision,
  });
}

function fail(code: ProposalGraphErrorCode, message: string): never {
  throw new ProposalGraphContractError(code, message);
}

function exactSelection(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(Codes.invalidRequest, 'At least one proposal must be selected.');
  if (value.length > Limits.batchMembers) fail(Codes.limitExceeded, 'Too many proposals were selected.');
  const selected = [...value];
  if (new Set(selected).size !== selected.length) fail(Codes.invalidRequest, 'Each selected proposal must occur exactly once.');
  return selected;
}

function resultFromClosure(result: ProposalReviewEvaluationResult, closure: ProposalClosureReady): void {
  result.graphRevision = closure.graphRevision;
  result.selectedProposalIds = [...closure.selectedProposalIds];
  result.dependencyProposalIds = [...closure.dependencyProposalIds];
  result.applyProposalIds = [...closure.applyProposalIds];
  result.prerequisiteProposalIds = [...closure.prerequisiteProposalIds];
  result.closureProposalIds = [...closure.closureProposalIds];
  result.selectionHash = proposalEvaluationSelectionHash(closure);
}

function sameProof(left: ProposalCurrentProofV1, right: ProposalCurrentProofV1): boolean {
  return left.revisionId === right.revisionId
    && left.contentHash === right.contentHash
    && left.structureHash === right.structureHash
    && left.stateVectorHash === right.stateVectorHash
    && left.deleteSetHash === right.deleteSetHash
    && left.fullStateHash === right.fullStateHash;
}

function evaluationWitness(input: {
  kind: 'effective_candidate_anchor_map_v1' | 'effective_candidate_effect_preconditions_v1';
  closure: ProposalClosureReady;
  current: ProposalCurrentProofV1;
  candidate: ProposalCurrentProofV1;
  status: ProposalEvaluationStatusV1;
  appliedProposalIds: string[];
  satisfiedProposalIds: string[];
}): Uint8Array {
  return Buffer.from(canonicalProposalJson({
    contractVersion: 1,
    ...input,
  }), 'utf8');
}

async function persistFailureEvaluation(input: {
  request: ProposalReviewEvaluationInput;
  result: ProposalReviewEvaluationResult;
  current: ProposalCurrentProofV1;
  graphRevision: number;
  proposalId: string;
  now: () => number;
  createId: () => string;
}): Promise<void> {
  if (input.result.evaluation || input.result.reasonCode === null) return;
  const evaluatedAt = input.now();
  const evaluation: ProposalEvaluationV1 = {
    contractVersion: 1, evaluationId: input.createId(), proposalId: input.proposalId, scope: input.request.scope,
    current: input.current, graphRevision: input.graphRevision, status: input.result.status,
    reasonCode: input.result.reasonCode, effectiveCandidate: null, anchorMap: null, effectPreconditions: null,
    ...(input.result.selectionHash ? { selectionHash: input.result.selectionHash } : {}),
    evaluatedAt, expiresAt: evaluatedAt + Limits.fenceLifetimeMs,
  };
  await input.request.transaction.putEvaluation(evaluation);
  input.result.evaluation = evaluation;
}

/**
 * Purely additive, graph-aware preview evaluation. It never changes proposal
 * lifecycle or graph structure; callers retain the durable action/fence gate.
 */
export async function evaluateProposalReview(input: ProposalReviewEvaluationInput): Promise<ProposalReviewEvaluationResult> {
  const result = initialResult(input);
  const now = input.now ?? Date.now;
  const createId = input.createId ?? randomUUID;
  let current: ProposalEvaluationCurrent | null = null;
  let closure: ProposalClosureReady | null = null;
  let currentProof: ProposalCurrentProofV1 | null = null;
  let graphRevision: number | null = null;
  let selected: string[] | null = null;
  let authorizedPrimary = false;
  try {
    selected = exactSelection(input.selectedProposalIds);
    current = await input.loadCurrent();
    if (!sameScope(current.scope, input.scope)) fail(Codes.scopeMismatch, 'Authoritative current belongs to another document.');
    currentProof = proposalYjsCurrentProof({ update: current.update, representation: current.representation, revisionId: current.revisionId });
    result.current = currentProof;
    const graph = await input.transaction.loadGraph({ includeProposalIds: selected });
    if (!sameScope(graph.scope, input.scope)) fail(Codes.scopeMismatch, 'Proposal graph belongs to another document.');
    graphRevision = graph.graphRevision;
    result.graphRevision = graphRevision;
    // Do not expose graph-derived dependency IDs before the requested primary
    // selection itself was authorized.
    await input.authorize({ scope: input.scope, proposalIds: [...selected] });
    authorizedPrimary = true;
    const resolved = resolveProposalClosure({ graph, selectedProposalIds: selected });
    if (resolved.status !== 'ready') {
      result.status = failureStatus(resolved.reasonCode);
      result.reasonCode = resolved.reasonCode;
      await persistFailureEvaluation({ request: input, result, current: currentProof, graphRevision, proposalId: selected[0]!, now, createId });
      return result;
    }
    closure = resolved;
    resultFromClosure(result, closure);
    const exactSelected = selected;
    if (closure.selectedProposalIds.length !== exactSelected.length
      || closure.selectedProposalIds.some((id, index) => id !== exactSelected[index])) {
      fail(Codes.invalidRequest, 'Resolved proposal selection does not exactly match the request.');
    }

    // This has to happen before reading a single proposal artifact. Closing
    // alternatives are included deliberately: their IDs influence acceptance.
    if (closure.closureProposalIds.length !== exactSelected.length
      || closure.closureProposalIds.some((id, index) => id !== exactSelected[index])) {
      await input.authorize({ scope: input.scope, proposalIds: [...closure.closureProposalIds] });
    }

    const nodes = new Map(graph.nodes.map((node) => [node.proposalId, node]));
    const ordered: ProposalYjsCompositionEntry[] = [];
    for (const proposalId of closure.dependencyProposalIds) {
      const node = nodes.get(proposalId);
      if (!node) fail(Codes.sourceInvalid, 'Closure node is missing from the graph.');
      if (node.authoredCandidate.sourceProofHash !== hashProposalValue(node.source)) {
        fail(Codes.sourceInvalid, 'Proposal source provenance does not match its immutable hash.');
      }
      const stored = await loadProposalNodeArtifacts(input.transaction, node);
      ordered.push({
        proposalId,
        dependencyProposalId: node.relationships.dependency?.proposalId ?? null,
        mode: node.lifecycle === 'open' ? 'apply' : 'prerequisite',
        ...stored,
      });
    }

    const composed = composeProposalYjsCandidate({
      representation: current.representation,
      currentUpdate: current.update,
      revisionId: current.revisionId,
      ordered,
    });
    if (!('candidateUpdate' in composed)) {
      result.status = composed.status;
      result.reasonCode = composed.reasonCode;
      result.actionability = actionability(result.status);
      await persistFailureEvaluation({ request: input, result, current: currentProof, graphRevision: closure.graphRevision,
        proposalId: closure.selectedProposalIds[0]!, now, createId });
      return result;
    }

    result.status = composed.status;
    result.reasonCode = null;
    result.current = composed.current;
    result.candidateContent = composed.content;
    result.candidateProof = composed.candidate;
    result.appliedProposalIds = [...composed.appliedProposalIds];
    result.satisfiedProposalIds = [...composed.satisfiedProposalIds];
    result.actionability = actionability(composed.status);

    if (input.confirmCurrent) {
      const confirmed = await input.confirmCurrent(composed.current);
      if (!sameScope(confirmed.scope, input.scope)) fail(Codes.scopeMismatch, 'Confirmed current belongs to another document.');
      const confirmedProof = proposalYjsCurrentProof({
        update: confirmed.update, representation: confirmed.representation, revisionId: confirmed.revisionId,
      });
      if (confirmed.representation !== current.representation || !sameProof(confirmedProof, composed.current)) {
        fail(Codes.currentChanged, 'Authoritative current changed while the proposal was being evaluated.');
      }
    }

    const effectiveCandidate = snapshotRef(await input.transaction.putArtifact('yjs_full_update_v1', composed.candidateUpdate));
    const anchorMap = plainRef(await input.transaction.putArtifact('json_v1', evaluationWitness({
      kind: 'effective_candidate_anchor_map_v1', closure, current: composed.current, candidate: composed.candidate,
      status: composed.status, appliedProposalIds: composed.appliedProposalIds, satisfiedProposalIds: composed.satisfiedProposalIds,
    })));
    const effectPreconditions = plainRef(await input.transaction.putArtifact('json_v1', evaluationWitness({
      kind: 'effective_candidate_effect_preconditions_v1', closure, current: composed.current, candidate: composed.candidate,
      status: composed.status, appliedProposalIds: composed.appliedProposalIds, satisfiedProposalIds: composed.satisfiedProposalIds,
    })));
    const evaluatedAt = now();
    const evaluation: ProposalEvaluationV1 = {
      contractVersion: 1, evaluationId: createId(), proposalId: closure.selectedProposalIds[0]!, scope: input.scope,
      current: composed.current, graphRevision: closure.graphRevision, status: composed.status, reasonCode: null,
      effectiveCandidate, anchorMap, effectPreconditions, selectionHash: result.selectionHash!,
      evaluatedAt, expiresAt: evaluatedAt + Limits.fenceLifetimeMs,
    };
    await input.transaction.putEvaluation(evaluation);
    result.evaluation = evaluation;
    result.effectiveCandidate = effectiveCandidate;
    return result;
  } catch (error) {
    const code = error instanceof ProposalGraphContractError ? error.code : Codes.contentUnavailable;
    result.status = failureStatus(code);
    result.reasonCode = code;
    result.actionability = 'none';
    if (current && result.current === null) {
      try {
        result.current = proposalYjsCurrentProof({ update: current.update, representation: current.representation, revisionId: current.revisionId });
      } catch {
        // Keep the diagnosis fail-closed when the current bytes cannot be proved.
      }
    }
    if (authorizedPrimary && currentProof && graphRevision !== null && selected) {
      try {
        await persistFailureEvaluation({ request: input, result, current: currentProof, graphRevision, proposalId: selected[0]!, now, createId });
      } catch {
        // The diagnosis remains fail-closed if durable diagnostics are unavailable.
      }
    }
    return result;
  }
}
