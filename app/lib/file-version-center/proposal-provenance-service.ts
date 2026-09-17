import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { JSONContent } from '@tiptap/core';

import { Y } from '../collaboration/server-runtime';
import type { AgentTextTarget } from '../collaboration/agent-operations';
import { readAgentBlockStructure, type AgentBlockStructure } from '../collaboration/agent-block-structure';
import { richMarkdownFromYDoc } from '../collaboration/markdown-state';
import { readRichDocumentJson } from '../collaboration/rich-document';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes, PROPOSAL_GRAPH_LIMITS as Limits,
  PROPOSAL_PREREQUISITE_RULES_V1, ProposalGraphContractError, parseProposalNodeV1,
  type ProposalArtifactReferenceV1, type ProposalDocumentScopeV1, type ProposalEvaluationV1,
  type ProposalGraphErrorCode, type ProposalGraphSnapshotV1, type ProposalNodeV1,
  type ProposalRelationshipsV1, type ProposalSnapshotReferenceV1, type ProposalSourceProofV1,
} from './contracts/proposal-graph-v1';
import {
  parseProposalToolEditV1, parseProposalToolReadRequestV1, parseProposalToolReadResultV1, parseProposalToolCreationResultV1,
  type ProposalToolEditV1, type ProposalToolReadResultV1, type ProposalToolCreationResultV1,
} from './contracts/proposal-tools-v1';
import { canonicalProposalJson, hashProposalValue } from './proposal-action-fence';
import { resolveProposalClosure } from './proposal-graph-model';
import type { ProposalGraphStorageTransaction } from './proposal-storage';
import {
  authorProposalYjsCandidate, composeProposalYjsCandidate, proposalYjsCurrentProof,
  type ProposalYjsArtifacts, type ProposalYjsCompositionEntry, type ProposalYjsRepresentation,
} from './proposal-yjs-candidate';

export type ProposalProvenanceCurrent = {
  scope: ProposalDocumentScopeV1;
  representation: ProposalYjsRepresentation;
  revisionId: string | null;
  /** Server-owned authoritative bytes, never accepted from a tool argument. */
  update: Uint8Array;
};
export type ProposalProvenanceStructure = { blocks: AgentBlockStructure[] } | { document: JSONContent } | null;
export type ProposalProvenanceView = { content: string; structure: ProposalProvenanceStructure };
export type ProposalAuthoringPreview = { beforeContent: string; proposedContent: string; beforeSha256: string; proposedSha256: string };
export type ProposalOperationLookup = { operationId: string; proposalId: string; authoredRelationships: ProposalRelationshipsV1 };
export type ProposalPreparedOperationInput = {
  operationId: string; proposalId: string; scope: ProposalDocumentScopeV1;
  representation: ProposalYjsRepresentation; source: ProposalSourceProofV1;
  targets: AgentTextTarget[]; idempotencyKey: string; requestDigest: string; reviewRequired: true;
  beforeSha256: string; proposedSha256: string; sourceStateVector: string;
};

/** Every method belongs to ONE graph/operation SQL transaction, owned by the caller. */
export type ProposalProvenanceTransaction = {
  graph: ProposalGraphStorageTransaction;
  loadCurrent(): Promise<ProposalProvenanceCurrent>;
  /** Checks exact scoped request digest; legacy/unbound operations are never adopted. */
  lookupOperation(input: { idempotencyKey: string; requestDigest: string }): Promise<ProposalOperationLookup | null>;
  /** Must insert a new review-only operation or throw; an existing row is not success. */
  insertPreparedOperation(input: ProposalPreparedOperationInput): Promise<void>;
};
export type ProposalProvenanceAuthorization = {
  scope: ProposalDocumentScopeV1;
  action: 'read' | 'create' | 'manage_relationship';
  proposalIds: string[];
};
export type ProposalRelationshipPolicy = (input: {
  transaction: ProposalProvenanceTransaction;
  scope: ProposalDocumentScopeV1;
  actorId: string;
  proposalId: string;
  request: ProposalToolEditV1;
  dependency: ProposalRelationshipsV1['dependency'];
}) => Promise<{
  relationships: ProposalRelationshipsV1;
  /** Domain-owned replacement/choice mutation, called only inside the same atomic unit. */
  apply(node: ProposalNodeV1): Promise<void>;
}>;
export type ProposalProvenanceDependencies = {
  withTransaction<T>(scope: ProposalDocumentScopeV1, action: (transaction: ProposalProvenanceTransaction) => Promise<T>): Promise<T>;
  /** Domain policy must cover document access and target-specific management separately. */
  authorize(input: ProposalProvenanceAuthorization): Promise<void>;
  relationshipPolicy?: ProposalRelationshipPolicy;
  now?: () => number;
  createId?: () => string;
};

type WitnessEnvelope = { contractVersion: 1; kind: 'proposal_candidate_witnesses'; effectPreconditions: unknown; anchorMap: unknown };
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function fail(code: ProposalGraphErrorCode, message: string): never { throw new ProposalGraphContractError(code, message); }
function sameScope(actual: ProposalDocumentScopeV1, expected: ProposalDocumentScopeV1): void {
  if (actual.workspaceId !== expected.workspaceId || actual.lineageId !== expected.lineageId || actual.documentId !== expected.documentId) {
    fail(Codes.scopeMismatch, 'Proposal source belongs to another document.');
  }
  if (actual.lifecycleGeneration !== expected.lifecycleGeneration || actual.schemaVersion !== expected.schemaVersion) {
    fail(Codes.staleLifecycle, 'Proposal source belongs to another document lifecycle.');
  }
}
function encodeJson(value: unknown): Uint8Array { return Buffer.from(canonicalProposalJson(value), 'utf8'); }
function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > Limits.payloadBytes) fail(Codes.limitExceeded, 'Proposal source metadata is too large.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail(Codes.sourceInvalid, 'Proposal source metadata is invalid.'); }
}
function plainRef(ref: ProposalArtifactReferenceV1): ProposalArtifactReferenceV1 {
  return { ref: ref.ref, sha256: ref.sha256, sizeBytes: ref.sizeBytes };
}
function fullRef(ref: ProposalArtifactReferenceV1): ProposalSnapshotReferenceV1 {
  return { ...plainRef(ref), encoding: 'yjs_full_update_v1' };
}
function view(update: Uint8Array, representation: ProposalYjsRepresentation): ProposalProvenanceView {
  // Current proof also rejects pending causal data and invalid representations.
  proposalYjsCurrentProof({ update, representation, revisionId: null });
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, update);
    return representation === 'plain_text' ? { content: doc.getText('content').toString(), structure: null }
      : { content: richMarkdownFromYDoc(doc), structure: representation === 'tiptap_blocks'
        ? { blocks: readAgentBlockStructure(doc) } : { document: readRichDocumentJson(doc) } };
  } finally { doc.destroy(); }
}
function sourceReceipt(update: Uint8Array, representation: ProposalYjsRepresentation): unknown {
  const proof = proposalYjsCurrentProof({ update, representation, revisionId: null });
  // This receipt identifies the complete source-ID space. Actual Yjs IDs and
  // relative-anchor material remain in the pinned, full source snapshot.
  return { contractVersion: 1, kind: 'proposal_source_identity', representation, snapshotSha256: hash(update),
    structureHash: proof.structureHash, stateVectorHash: proof.stateVectorHash, deleteSetHash: proof.deleteSetHash };
}
async function persistSourceSnapshot(graph: ProposalGraphStorageTransaction, update: Uint8Array, representation: ProposalYjsRepresentation) {
  const snapshot = fullRef(await graph.putArtifact('yjs_full_update_v1', update));
  const anchorMap = plainRef(await graph.putArtifact('json_v1', encodeJson(sourceReceipt(update, representation))));
  return { snapshot, anchorMap };
}

/** Source identity receipts and per-proposal effect witnesses have distinct owners. */
export async function loadProposalNodeArtifacts(graph: ProposalGraphStorageTransaction, node: ProposalNodeV1): Promise<{
  sourceUpdate: Uint8Array; artifacts: ProposalYjsArtifacts;
}> {
  const sourceUpdate = await graph.readArtifact(node.source.snapshot);
  const envelope = decodeJson(await graph.readArtifact(node.authoredCandidate.effectPreconditions)) as Partial<WitnessEnvelope> | null;
  if (!envelope || envelope.contractVersion !== 1 || envelope.kind !== 'proposal_candidate_witnesses'
    || !Object.hasOwn(envelope, 'effectPreconditions') || !Object.hasOwn(envelope, 'anchorMap')) {
    fail(Codes.upgradeRequired, 'Proposal witnesses do not have the supported provenance encoding.');
  }
  return { sourceUpdate, artifacts: {
    incrementalPayload: await graph.readArtifact(node.authoredCandidate.incrementalPayload),
    cumulativeCandidate: await graph.readArtifact(node.authoredCandidate.cumulativeCandidate),
    effectPreconditions: encodeJson(envelope.effectPreconditions), anchorMap: encodeJson(envelope.anchorMap),
  } };
}
function closureForSource(graph: ProposalGraphSnapshotV1, selected: ProposalNodeV1) {
  if (PROPOSAL_PREREQUISITE_RULES_V1[selected.lifecycle] === 'blocked') fail(Codes.dependencyBlocked, 'This proposal is no longer a usable source.');
  // The pure model's public selection means accept(open). Historical exact reads
  // need the same ancestry/choice validation but retain their original proof mode.
  const structural = selected.lifecycle === 'open' ? graph
    : { ...graph, nodes: graph.nodes.map((node) => node.proposalId === selected.proposalId ? { ...node, lifecycle: 'open' as const } : node) };
  const closure = resolveProposalClosure({ graph: structural, selectedProposalIds: [selected.proposalId] });
  if (closure.status !== 'ready') fail(closure.reasonCode, 'Proposal ancestry is not currently usable.');
  return closure;
}
async function evaluateSource(input: {
  transaction: ProposalProvenanceTransaction; current: ProposalProvenanceCurrent; graph: ProposalGraphSnapshotV1;
  selected: ProposalNodeV1; authorize: ProposalProvenanceDependencies['authorize'];
}) {
  const closure = closureForSource(input.graph, input.selected);
  await input.authorize({ scope: input.current.scope, action: 'read', proposalIds: closure.dependencyProposalIds });
  const nodes = new Map(input.graph.nodes.map((node) => [node.proposalId, node]));
  const ordered: ProposalYjsCompositionEntry[] = [];
  for (const id of closure.dependencyProposalIds) {
    const node = nodes.get(id)!;
    if (node.authoredCandidate.sourceProofHash !== hashProposalValue(node.source)) fail(Codes.sourceInvalid, 'Authored source proof was changed.');
    const stored = await loadProposalNodeArtifacts(input.transaction.graph, node);
    ordered.push({ proposalId: id, dependencyProposalId: node.relationships.dependency?.proposalId ?? null,
      mode: node.lifecycle === 'open' ? 'apply' : 'prerequisite', ...stored });
  }
  const result = composeProposalYjsCandidate({ representation: input.current.representation,
    currentUpdate: input.current.update, revisionId: input.current.revisionId, ordered });
  if (!('candidateUpdate' in result)) fail(result.reasonCode, 'Proposal content cannot be used as a current authoring source.');
  if (result.status === 'empty_effect' || (result.status === 'satisfied_elsewhere' && input.selected.lifecycle === 'open')) {
    fail(Codes.noEffect, 'Resolve the already-satisfied or empty proposal before extending it.');
  }
  return result;
}
function creationResult(node: ProposalNodeV1, creationKind: ProposalToolEditV1['creationKind']): ProposalToolCreationResultV1 {
  return parseProposalToolCreationResultV1({ contractVersion: 1, proposalId: node.proposalId, operationId: node.operationId,
    scope: node.scope, creationKind, casVersion: 1, candidateHash: node.authoredCandidate.cumulativeCandidate.sha256,
    source: node.source, relationships: node.relationships, reviewRequired: true });
}
function preview(beforeContent: string, proposedContent: string): ProposalAuthoringPreview {
  return { beforeContent, proposedContent, beforeSha256: hash(beforeContent), proposedSha256: hash(proposedContent) };
}
async function storedPreview(transaction: ProposalProvenanceTransaction, node: ProposalNodeV1): Promise<ProposalAuthoringPreview> {
  const receipt = decodeJson(await transaction.graph.readArtifact(node.source.anchorMap)) as { representation?: unknown } | null;
  const representation = receipt?.representation;
  if (representation !== 'plain_text' && representation !== 'tiptap_xml' && representation !== 'tiptap_blocks') {
    fail(Codes.sourceInvalid, 'Stored source representation is unavailable.');
  }
  const source = await transaction.graph.readArtifact(node.source.snapshot);
  const candidate = await transaction.graph.readArtifact(node.authoredCandidate.cumulativeCandidate);
  return preview(view(source, representation).content, view(candidate, representation).content);
}

/**
 * Server-only capability blocks. No runtime route is enabled here. The domain
 * supplies authorization, current bytes, target preparation and a truly shared
 * transaction; this module never opens a connection or trusts client Yjs data.
 */
export function createProposalProvenanceService(dependencies: ProposalProvenanceDependencies) {
  const now = dependencies.now ?? Date.now; const createId = dependencies.createId ?? randomUUID;
  return {
    async readExact(input: { scope: ProposalDocumentScopeV1; proposalId: string | null }): Promise<{
      metadata: ProposalToolReadResultV1; content: string; structure: ProposalProvenanceStructure; sourceStateVector: string;
    }> {
      parseProposalToolReadRequestV1({ contractVersion: 1, proposalId: input.proposalId, expectedScope: input.scope });
      await dependencies.authorize({ scope: input.scope, action: 'read', proposalIds: input.proposalId ? [input.proposalId] : [] });
      return dependencies.withTransaction(input.scope, async (transaction) => {
        const current = await transaction.loadCurrent(); sameScope(current.scope, input.scope);
        const graph = await transaction.graph.loadGraph({ includeProposalIds: input.proposalId ? [input.proposalId] : [] });
        sameScope(graph.scope, input.scope);
        const currentProof = proposalYjsCurrentProof({ update: current.update, representation: current.representation, revisionId: current.revisionId });
        let source: ProposalSourceProofV1; let sourceUpdate = current.update;
        if (input.proposalId === null) {
          source = { kind: 'authoritative', scope: input.scope, current: currentProof,
            ...await persistSourceSnapshot(transaction.graph, sourceUpdate, current.representation) };
        } else {
          const selected = graph.nodes.find((node) => node.proposalId === input.proposalId);
          if (!selected) fail(Codes.sourceInvalid, 'The exact proposal is unavailable in this document.');
          const result = await evaluateSource({ transaction, current, graph, selected, authorize: dependencies.authorize });
          sourceUpdate = result.candidateUpdate;
          const refs = await persistSourceSnapshot(transaction.graph, sourceUpdate, current.representation);
          const evaluatedAt = now();
          const evaluation: ProposalEvaluationV1 = { contractVersion: 1, evaluationId: createId(), proposalId: selected.proposalId,
            scope: input.scope, current: currentProof, graphRevision: graph.graphRevision, status: result.status,
            reasonCode: null, effectiveCandidate: refs.snapshot, anchorMap: refs.anchorMap,
            effectPreconditions: selected.authoredCandidate.effectPreconditions, evaluatedAt, expiresAt: evaluatedAt + Limits.fenceLifetimeMs };
          await transaction.graph.putEvaluation(evaluation);
          source = { kind: 'proposal', scope: input.scope, current: currentProof, ...refs,
            proposalId: selected.proposalId, proposalCasVersion: selected.casVersion,
            authoredCandidateHash: selected.authoredCandidate.cumulativeCandidate.sha256,
            evaluationId: evaluation.evaluationId, candidateHash: refs.snapshot.sha256 };
        }
        const result = view(sourceUpdate, current.representation);
        return { ...result, sourceStateVector: Buffer.from(Y.encodeStateVectorFromUpdate(sourceUpdate)).toString('base64'),
          metadata: parseProposalToolReadResultV1({ contractVersion: 1, source,
          contentSha256: hash(result.content), graphRevision: graph.graphRevision }) };
      });
    },

    async create(input: {
      scope: ProposalDocumentScopeV1; actorId: string; idempotencyKey: string; proposal: ProposalToolEditV1;
      /** Exact canonical tool mutation arguments; included in durable retry identity. */
      mutation: unknown;
      buildTargets(source: ProposalProvenanceView & { update: Uint8Array; representation: ProposalYjsRepresentation }): AgentTextTarget[] | Promise<AgentTextTarget[]>;
    }): Promise<{ node: ProposalNodeV1; proposal: ProposalToolCreationResultV1; reused: boolean; authoringPreview: ProposalAuthoringPreview }> {
      // Detach caller-owned proof objects before any asynchronous preparation.
      const request = parseProposalToolEditV1(JSON.parse(canonicalProposalJson(input.proposal))); sameScope(request.source.scope, input.scope);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.actorId)
        || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) fail(Codes.invalidRequest, 'Invalid proposal actor or retry identity.');
      const referencedIds = [...new Set([request.source.kind === 'proposal' ? request.source.proposalId : null,
        request.replaces?.proposalId, request.choice?.kind === 'alternative_to' ? request.choice.proposalId : null].filter((id): id is string => Boolean(id)))];
      await dependencies.authorize({ scope: input.scope, action: 'create', proposalIds: referencedIds });
      const requestDigest = hashProposalValue({ scope: input.scope, actorId: input.actorId, proposal: request, mutation: input.mutation });
      return dependencies.withTransaction(input.scope, async (transaction) => {
        // A verified durable retry precedes source/current freshness checks. It
        // returns the same node even when that node has since been resolved.
        const existing = await transaction.lookupOperation({ idempotencyKey: input.idempotencyKey, requestDigest });
        if (existing) {
          const node = await transaction.graph.getProposal(existing.proposalId);
          if (!node || node.operationId !== existing.operationId) fail(Codes.recoveryRequired, 'Prepared operation has no matching proposal.');
          sameScope(node.scope, input.scope);
          const graph = await transaction.graph.loadGraph({ includeProposalIds: [node.proposalId] });
          const nodes = new Map(graph.nodes.map((entry) => [entry.proposalId, entry]));
          const ancestors: string[] = []; let cursor: ProposalNodeV1 | undefined = node;
          while (cursor) {
            if (ancestors.includes(cursor.proposalId) || ancestors.length >= Limits.closureNodes) fail(Codes.sourceInvalid, 'Stored proposal ancestry is invalid.');
            ancestors.push(cursor.proposalId);
            const parentId: string | undefined = cursor.relationships.dependency?.proposalId;
            if (parentId && !nodes.has(parentId)) fail(Codes.sourceInvalid, 'Stored proposal ancestry is unavailable.');
            cursor = parentId ? nodes.get(parentId) : undefined;
          }
          await dependencies.authorize({ scope: input.scope, action: 'read', proposalIds: ancestors });
          return { node, proposal: creationResult({ ...node, relationships: existing.authoredRelationships }, request.creationKind),
            reused: true, authoringPreview: await storedPreview(transaction, node) };
        }
        if ((request.replaces || request.choice) && !dependencies.relationshipPolicy) fail(Codes.upgradeRequired, 'Relationship mutation requires the graph-aware domain orchestrator.');
        const graph = await transaction.graph.loadGraph({ includeProposalIds: referencedIds }); sameScope(graph.scope, input.scope);
        await dependencies.authorize({ scope: input.scope, action: 'read', proposalIds: referencedIds });
        const current = await transaction.loadCurrent(); sameScope(current.scope, input.scope);
        const currentProof = proposalYjsCurrentProof({ update: current.update, representation: current.representation, revisionId: current.revisionId });
        if (!isDeepStrictEqual(request.source.current, currentProof)) fail(Codes.currentChanged, 'The authoring source must be read again after the current document changes.');
        // An effective parent snapshot already contains the ancestor closure.
        // Authorize that entire content set BEFORE reading even its first byte.
        let parent: ProposalNodeV1 | null = null;
        if (request.source.kind === 'proposal') {
          const source = request.source;
          parent = graph.nodes.find((node) => node.proposalId === source.proposalId) ?? null;
          if (!parent || parent.casVersion !== source.proposalCasVersion
            || parent.authoredCandidate.cumulativeCandidate.sha256 !== source.authoredCandidateHash) fail(Codes.parentChanged, 'The explicit parent changed.');
          const closure = closureForSource(graph, parent);
          await dependencies.authorize({ scope: input.scope, action: 'read', proposalIds: closure.dependencyProposalIds });
        }
        const sourceUpdate = await transaction.graph.readArtifact(request.source.snapshot);
        const receipt = decodeJson(await transaction.graph.readArtifact(request.source.anchorMap));
        if (!isDeepStrictEqual(receipt, sourceReceipt(sourceUpdate, current.representation))) fail(Codes.sourceInvalid, 'The source identity receipt does not match its snapshot.');
        if (request.source.kind === 'authoritative') {
          const proof = proposalYjsCurrentProof({ update: sourceUpdate, representation: current.representation, revisionId: current.revisionId });
          if (!isDeepStrictEqual(proof, currentProof)) fail(Codes.sourceInvalid, 'The declared authoritative source is not current.');
        } else {
          if (!parent) fail(Codes.parentChanged, 'The explicit parent is unavailable.');
          if (request.source.evaluationId === null) fail(Codes.upgradeRequired, 'Read this exact proposal to obtain a current server evaluation.');
          const evaluation = await transaction.graph.getEvaluation(request.source.evaluationId);
          if (!evaluation || evaluation.proposalId !== parent.proposalId || evaluation.graphRevision !== graph.graphRevision
            || evaluation.expiresAt <= now() || !['clean', 'clean_rebased', 'satisfied_elsewhere'].includes(evaluation.status)
            || !isDeepStrictEqual(evaluation.current, currentProof) || !isDeepStrictEqual(evaluation.effectiveCandidate, request.source.snapshot)
            || !isDeepStrictEqual(evaluation.anchorMap, request.source.anchorMap)) fail(Codes.parentChanged, 'The explicit evaluated candidate is stale or unavailable.');
          // Do not silently refresh/rebase the source on create. Evaluation pins
          // exact current state; recheck present prerequisites against that state.
          const checked = await evaluateSource({ transaction, current, graph, selected: parent, authorize: dependencies.authorize });
          if (hash(checked.candidateUpdate) !== request.source.candidateHash) fail(Codes.candidateChanged, 'The evaluated source candidate changed.');
        }
        const proposalId = createId(); const operationId = createId();
        const dependency = request.source.kind === 'proposal'
          ? { proposalId: request.source.proposalId, candidateHash: request.source.authoredCandidateHash } : null;
        let relationshipPlan: Awaited<ReturnType<ProposalRelationshipPolicy>> | null = null;
        if (request.replaces || request.choice) {
          const manageIds = [request.replaces?.proposalId, request.choice?.kind === 'alternative_to' ? request.choice.proposalId : null]
            .filter((id): id is string => Boolean(id));
          if (request.choice?.kind === 'existing') {
            const choice = request.choice;
            const group = graph.choiceGroups.find((item) => item.groupId === choice.groupId);
            if (!group || group.groupRevision !== choice.expectedGroupRevision || group.chosenProposalId !== null
              || group.dependencyProposalId !== (dependency?.proposalId ?? null)) fail(Codes.choiceConflict, 'Choice group changed or has a different source.');
            manageIds.push(...group.memberProposalIds);
          }
          await dependencies.authorize({ scope: input.scope, action: 'manage_relationship', proposalIds: [...new Set(manageIds)] });
          for (const reference of [request.replaces, request.choice?.kind === 'alternative_to' ? request.choice : null]) {
            if (!reference) continue;
            const target = await transaction.graph.getProposal(reference.proposalId);
            if (!target || target.lifecycle !== 'open' || target.casVersion !== reference.expectedCasVersion
              || target.authoredCandidate.cumulativeCandidate.sha256 !== reference.expectedCandidateHash) fail(Codes.parentChanged, 'The explicit relationship target changed.');
            sameScope(target.scope, input.scope);
            if (!isDeepStrictEqual(target.relationships.dependency, dependency)) fail(Codes.sourceInvalid, 'A replacement or alternative must retain its target prerequisite.');
          }
          relationshipPlan = await dependencies.relationshipPolicy!({ transaction, scope: input.scope, actorId: input.actorId, proposalId, request, dependency });
          if (!isDeepStrictEqual(relationshipPlan.relationships.dependency, dependency)
            || relationshipPlan.relationships.replacesProposalId !== (request.replaces?.proposalId ?? null)) fail(Codes.sourceInvalid, 'Relationship policy changed the declared source.');
        }
        const sourceView = view(sourceUpdate, current.representation);
        const targets = await input.buildTargets({ ...sourceView, update: Uint8Array.from(sourceUpdate), representation: current.representation });
        const authored = authorProposalYjsCandidate({ representation: current.representation, sourceUpdate, targets });
        const envelope: WitnessEnvelope = { contractVersion: 1, kind: 'proposal_candidate_witnesses',
          effectPreconditions: decodeJson(authored.effectPreconditions), anchorMap: decodeJson(authored.anchorMap) };
        // One combined bound prevents splitting an oversized witness across two
        // individually valid JSON artifacts. Source receipt remains independent.
        const effectPreconditions = plainRef(await transaction.graph.putArtifact('json_v1', encodeJson(envelope)));
        const incrementalPayload = plainRef(await transaction.graph.putArtifact('json_v1', authored.incrementalPayload));
        const cumulativeCandidate = fullRef(await transaction.graph.putArtifact('yjs_full_update_v1', authored.cumulativeCandidate));
        const node = parseProposalNodeV1({ contractVersion: 1, proposalId, operationId, scope: input.scope, casVersion: 1,
          source: request.source, relationships: relationshipPlan?.relationships ?? { dependency, replacesProposalId: null, choiceGroupId: null },
          authoredCandidate: { incrementalPayload, cumulativeCandidate, effectPreconditions, sourceProofHash: hashProposalValue(request.source) },
          lifecycle: 'open', createdAt: now(), createdByActorId: input.actorId });
        const beforeInsert = await transaction.loadCurrent(); sameScope(beforeInsert.scope, input.scope);
        if (beforeInsert.representation !== current.representation || !isDeepStrictEqual(currentProof,
          proposalYjsCurrentProof({ update: beforeInsert.update, representation: beforeInsert.representation, revisionId: beforeInsert.revisionId }))) {
          fail(Codes.currentChanged, 'The document changed during proposal preparation.');
        }
        await transaction.insertPreparedOperation({ operationId, proposalId, scope: input.scope, representation: current.representation,
          source: request.source, targets, idempotencyKey: input.idempotencyKey, requestDigest, reviewRequired: true,
          beforeSha256: hash(sourceView.content), proposedSha256: hash(authored.content),
          sourceStateVector: Buffer.from(Y.encodeStateVectorFromUpdate(sourceUpdate)).toString('base64') });
        const inserted = await transaction.graph.insertProposal(node);
        await relationshipPlan?.apply(inserted);
        const final = await transaction.graph.getProposal(proposalId);
        if (!final || final.operationId !== operationId) fail(Codes.recoveryRequired, 'Atomic proposal insertion was not completed.');
        return { node: final, proposal: creationResult(final, request.creationKind), reused: false, authoringPreview: preview(sourceView.content, authored.content) };
      });
    },
  };
}
