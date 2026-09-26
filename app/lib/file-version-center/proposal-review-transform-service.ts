import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { AgentTextTarget } from '../collaboration/agent-operations';
import { hashProposalValue } from './proposal-action-fence';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes, PROPOSAL_GRAPH_LIMITS as Limits, ProposalGraphContractError,
  parseProposalCreateRequestV1, type ProposalCreateRequestV1, type ProposalCurrentProofV1,
  type ProposalDocumentScopeV1, type ProposalGraphSnapshotV1, type ProposalNodeV1, type ProposalSourceProofV1,
} from './contracts/proposal-graph-v1';
import { loadProposalNodeArtifacts, persistProposalAuthoredCandidate } from './proposal-provenance-service';
import type { ProposalGraphStorageTransaction } from './proposal-storage';
import { composeProposalYjsCandidate, type ProposalYjsRepresentation } from './proposal-yjs-candidate';

export type ProposalReviewTransformKind = 'detach' | 'replace';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function fail(code: typeof Codes[keyof typeof Codes], message: string): never { throw new ProposalGraphContractError(code, message); }

/** Validate the old authored plan against its immutable Yjs witnesses before replaying any targets. */
export async function loadVerifiedProposalTargets(input: {
  transaction: ProposalGraphStorageTransaction; node: ProposalNodeV1; representation: ProposalYjsRepresentation;
}): Promise<AgentTextTarget[]> {
  if (input.node.authoredCandidate.sourceProofHash !== hashProposalValue(input.node.source)) {
    fail(Codes.sourceInvalid, 'The original proposal source proof changed.');
  }
  const stored = await loadProposalNodeArtifacts(input.transaction, input.node);
  const checked = composeProposalYjsCandidate({ representation: input.representation, currentUpdate: stored.sourceUpdate,
    revisionId: null, ordered: [{ proposalId: input.node.proposalId, dependencyProposalId: null, mode: 'apply', ...stored }] });
  if (!('candidateUpdate' in checked)) fail(checked.reasonCode, 'The original proposal target plan cannot be verified.');
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.artifacts.incrementalPayload)); }
  catch { fail(Codes.sourceInvalid, 'The original proposal target plan is invalid.'); }
  if (!payload || typeof payload !== 'object' || !('version' in payload) || payload.version !== 1
    || !('targets' in payload) || !Array.isArray(payload.targets)) {
    fail(Codes.sourceInvalid, 'The original proposal target plan is unavailable.');
  }
  // The composition verifier validated every target, its witness and the authored delta.
  return structuredClone(payload.targets) as AgentTextTarget[];
}

export async function prepareProposalReviewTransformation(input: {
  scope: ProposalDocumentScopeV1;
  graph: ProposalGraphSnapshotV1;
  transaction: ProposalGraphStorageTransaction;
  kind: ProposalReviewTransformKind;
  sourceProposalId: string;
  expectedGraphRevision: number;
  current: ProposalCurrentProofV1;
  representation: ProposalYjsRepresentation;
  actorId: string;
  authorize(proposalIds: string[]): Promise<void>;
  readSource(proposalId: string | null): Promise<{ source: ProposalSourceProofV1; content: string }>;
  createId(): string;
}): Promise<{ creation: ProposalCreateRequestV1; beforeContent: string; proposedContent: string;
  beforeSha256: string; proposedSha256: string }> {
  const { graph, transaction, scope } = input;
  if (graph.graphRevision !== input.expectedGraphRevision) fail(Codes.graphChanged, 'The proposal graph changed before transformation.');
  const nodes = new Map(graph.nodes.map((node) => [node.proposalId, node]));
  const original = nodes.get(input.sourceProposalId);
  if (!original || original.lifecycle !== 'open') {
    fail(Codes.graphChanged, 'The exact original proposal is no longer open at the shown version.');
  }
  const ancestors = new Set<string>();
  let cursor: ProposalNodeV1 | undefined = original;
  while (cursor) {
    if (ancestors.has(cursor.proposalId) || ancestors.size >= Limits.closureNodes) fail(Codes.cycle, 'Proposal ancestry is invalid.');
    ancestors.add(cursor.proposalId);
    const parentId: string | undefined = cursor.relationships.dependency?.proposalId;
    if (parentId && !nodes.has(parentId)) fail(Codes.sourceInvalid, 'The original prerequisite is unavailable.');
    cursor = parentId ? nodes.get(parentId) : undefined;
  }
  const choice = original.relationships.choiceGroupId
    ? graph.choiceGroups.find((group) => group.groupId === original.relationships.choiceGroupId) : null;
  if (input.kind === 'replace' && original.relationships.choiceGroupId
    && (!choice || choice.chosenProposalId !== null || !choice.memberProposalIds.includes(original.proposalId))) {
    fail(Codes.choiceConflict, 'The original alternative group changed.');
  }
  const authorizationIds = new Set([...ancestors, ...(input.kind === 'replace' ? choice?.memberProposalIds ?? [] : [])]);
  await input.authorize([...authorizationIds]);
  const targets = await loadVerifiedProposalTargets({ transaction, node: original, representation: input.representation });
  const prerequisiteId = input.kind === 'replace' ? original.relationships.dependency?.proposalId ?? null : null;
  const sourceRead = await input.readSource(prerequisiteId);
  if (!isDeepStrictEqual(sourceRead.source.current, input.current)) {
    fail(Codes.currentChanged, 'The transformation source no longer matches current content.');
  }
  if (input.kind === 'detach' && sourceRead.source.kind !== 'authoritative') {
    fail(Codes.sourceInvalid, 'Detached content must be authored from current content.');
  }
  if (input.kind === 'replace' && prerequisiteId !== null
    && (sourceRead.source.kind !== 'proposal' || sourceRead.source.proposalId !== prerequisiteId)) {
    fail(Codes.sourceInvalid, 'Replacement did not retain its exact prerequisite.');
  }
  const sourceUpdate = await transaction.readArtifact(sourceRead.source.snapshot);
  const authored = await persistProposalAuthoredCandidate({ graph: transaction, source: sourceRead.source,
    sourceUpdate, representation: input.representation, targets });
  if (input.kind === 'replace'
    && authored.authoredCandidate.cumulativeCandidate.sha256 === original.authoredCandidate.cumulativeCandidate.sha256) {
    fail(Codes.noEffect, 'Replaying the original intent did not produce a new replacement.');
  }
  const creation = parseProposalCreateRequestV1({ contractVersion: 1, proposalId: input.createId(), operationId: input.createId(),
    scope, source: sourceRead.source,
    relationships: { dependency: sourceRead.source.kind === 'proposal'
      ? { proposalId: sourceRead.source.proposalId, candidateHash: sourceRead.source.authoredCandidateHash } : null,
      replacesProposalId: input.kind === 'replace' ? original.proposalId : null,
      choiceGroupId: input.kind === 'replace' ? original.relationships.choiceGroupId : null },
    authoredCandidate: authored.authoredCandidate, creationKind: input.kind === 'replace' ? 'replacement' : 'detached',
    detachedFromProposalId: input.kind === 'detach' ? original.proposalId : null, reviewRequired: true });
  return { creation, beforeContent: sourceRead.content, proposedContent: authored.content,
    beforeSha256: hash(sourceRead.content), proposedSha256: hash(authored.content) };
}
