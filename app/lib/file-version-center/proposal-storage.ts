import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { FileVersionCenterDatabase, FileVersionCenterTransaction } from './database';
import { loadStoredProposalGraph } from './proposal-storage-projection';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  PROPOSAL_GRAPH_LIMITS,
  ProposalGraphContractError,
  canTransitionProposalLifecycleV1,
  canTransitionProposalReceiptV1,
  parseProposalActionReceiptV1,
  parseProposalPreparedActionV1,
  parseProposalEvaluationV1,
  parseProposalGraphSnapshotV1,
  parseProposalNodeV1,
  type ProposalActionFenceV1,
  type ProposalActionReceiptV1,
  type ProposalArtifactReferenceV1,
  type ProposalChoiceGroupV1,
  type ProposalCreateRequestV1,
  type ProposalDocumentScopeV1,
  type ProposalEvaluationV1,
  type ProposalGraphSnapshotV1,
  type ProposalLifecycleV1,
  type ProposalNodeV1,
} from './contracts/proposal-graph-v1';

type Encoding = 'json_v1' | 'yjs_full_update_v1';
export type ProposalStoredArtifact = ProposalArtifactReferenceV1 & { encoding: Encoding };
export type ProposalStoredActionRequest = {
  fence: ProposalActionFenceV1;
  creation: ProposalCreateRequestV1 | null;
};
type GraphRow = {
  graph_id: string;
  graph_revision: number | string;
  active_action_id: string | null;
};
type NodeRow = {
  node_json: ProposalNodeV1 | string;
  lifecycle: ProposalLifecycleV1;
  cas_version: number | string;
  choice_group_id: string | null;
};

export type ProposalGraphStorageTransaction = {
  loadGraph(options?: { includeProposalIds?: readonly string[] }): Promise<ProposalGraphSnapshotV1>;
  getProposal(id: string): Promise<ProposalNodeV1 | null>;
  putArtifact(encoding: Encoding, payload: Uint8Array): Promise<ProposalStoredArtifact>;
  readArtifact(ref: ProposalArtifactReferenceV1): Promise<Uint8Array>;
  insertProposal(node: ProposalNodeV1): Promise<ProposalNodeV1>;
  transitionProposal(id: string, expectedCas: number, lifecycle: ProposalLifecycleV1): Promise<ProposalNodeV1>;
  putChoiceGroup(group: ProposalChoiceGroupV1, expectedRevision: number | null): Promise<void>;
  putEvaluation(evaluation: ProposalEvaluationV1): Promise<void>;
  getEvaluation(id: string): Promise<ProposalEvaluationV1 | null>;
  reserveAction(receipt: ProposalActionReceiptV1, request: ProposalStoredActionRequest): Promise<ProposalActionReceiptV1>;
  getAction(id: string): Promise<ProposalActionReceiptV1 | null>;
  getActionRequest(id: string): Promise<ProposalStoredActionRequest | null>;
  advanceAction(receipt: ProposalActionReceiptV1): Promise<void>;
  bindRevision(revisionId: string, actionId: string, bindings: Array<{
    proposalId: string; resolution: 'applied' | 'included'; applicationOrder: number;
  }>): Promise<void>;
  collectArtifacts(cutoff: number): Promise<{ deleted: number }>;
};

function fail(code: typeof Codes[keyof typeof Codes], message: string): never {
  throw new ProposalGraphContractError(code, message);
}

function parsed<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function sameScope(left: ProposalDocumentScopeV1, right: ProposalDocumentScopeV1): boolean {
  return left.workspaceId === right.workspaceId && left.lineageId === right.lineageId
    && left.documentId === right.documentId && left.lifecycleGeneration === right.lifecycleGeneration
    && left.schemaVersion === right.schemaVersion;
}

function nodeFromRow(row: NodeRow): ProposalNodeV1 {
  const authored = parsed(row.node_json);
  return parseProposalNodeV1({
    ...authored, lifecycle: row.lifecycle, casVersion: Number(row.cas_version),
    relationships: { ...authored.relationships, choiceGroupId: row.choice_group_id },
  });
}

function nodeArtifacts(node: ProposalNodeV1): ProposalArtifactReferenceV1[] {
  return [node.source.snapshot, node.source.anchorMap, node.authoredCandidate.incrementalPayload,
    node.authoredCandidate.cumulativeCandidate, node.authoredCandidate.effectPreconditions];
}

function evaluationArtifacts(evaluation: ProposalEvaluationV1): ProposalArtifactReferenceV1[] {
  return [evaluation.effectiveCandidate, evaluation.anchorMap, evaluation.effectPreconditions]
    .filter((ref): ref is NonNullable<typeof ref> => ref !== null);
}

/**
 * Scoped persistence mechanics, not an authorization boundary. Callers authorize the
 * entire action before invoking mutations. No document or agent operation is applied
 * here. A durable reservation survives transaction/connection loss until recovery.
 */
export function createProposalGraphStorage(input: {
  database: FileVersionCenterDatabase;
  now?: () => number;
  createId?: () => string;
}) {
  const now = input.now ?? Date.now;
  const createId = input.createId ?? randomUUID;
  return {
    async withLockedGraph<T>(
      scope: ProposalDocumentScopeV1,
      options: { actionId?: string },
      action: (transaction: ProposalGraphStorageTransaction, sql: FileVersionCenterTransaction) => Promise<T>,
    ): Promise<T> {
      // Validate the scope without introducing a second schema for it.
      parseProposalGraphSnapshotV1({ contractVersion: 1, scope, graphRevision: 0, nodes: [], choiceGroups: [] });
      return input.database.transaction(async (db) => {
        const values = [scope.workspaceId, scope.lineageId, scope.documentId, scope.lifecycleGeneration, scope.schemaVersion];
        await db.query(`INSERT INTO file_proposal_graphs
          (graph_id, workspace_id, lineage_id, document_id, lifecycle_generation, schema_version,
           graph_revision, active_action_id, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,0,NULL,$7,$7)
          ON CONFLICT (workspace_id,lineage_id,document_id,lifecycle_generation,schema_version) DO NOTHING`,
        [createId(), ...values, now()]);
        const row = (await db.query<GraphRow>(`SELECT graph_id, graph_revision, active_action_id
          FROM file_proposal_graphs WHERE workspace_id=$1 AND lineage_id=$2 AND document_id=$3
          AND lifecycle_generation=$4 AND schema_version=$5 FOR UPDATE`, values)).rows[0];
        if (!row) fail(Codes.scopeMismatch, 'Proposal graph scope is unavailable.');
        const state = { graphId: row.graph_id, revision: Number(row.graph_revision), activeActionId: row.active_action_id,
          actingActionId: options.actionId ?? null, changed: false, finalizedActions: new Set<string>() };
        const tx = createGraphTransaction({ db, scope, state, now, createId });
        // Operation creation shares this exact transaction; never commit an
        // applicable legacy operation before its graph/provenance association.
        const result = await action(tx, db);
        if (state.changed) parseProposalGraphSnapshotV1(await tx.loadGraph());
        for (const id of state.finalizedActions) {
          const receipt = await tx.getAction(id);
          if (!receipt || receipt.phase !== 'succeeded') fail(Codes.invalidTransition, 'Finalized action is unavailable.');
          const request = await tx.getActionRequest(id);
          if (!request) fail(Codes.sourceInvalid, 'Finalized action has no immutable approved request.');
          const expectedResolutions = new Map<string, ProposalLifecycleV1>();
          if (receipt.result.kind === 'content_changed') {
            for (const proposalId of request.fence.applyProposalIds) {
              expectedResolutions.set(proposalId, request.fence.selectedProposalIds.includes(proposalId) ? 'applied' : 'included');
            }
            for (const choice of request.fence.choiceResolutions) {
              for (const proposalId of choice.closingProposalIds) expectedResolutions.set(proposalId, 'alternative_not_selected');
            }
          } else {
            const resolutions: Partial<Record<ProposalActionReceiptV1['actionType'], ProposalLifecycleV1>> = {
              reject: 'rejected', branch_reject: 'rejected', replace: 'superseded', complete_satisfied: 'satisfied_elsewhere',
            };
            const lifecycle = resolutions[receipt.actionType];
            if (lifecycle) {
              for (const proposalId of receipt.actionType === 'branch_reject'
                ? request.fence.closure.map((member) => member.proposalId) : request.fence.selectedProposalIds) {
                expectedResolutions.set(proposalId, lifecycle);
              }
            }
          }
          if (receipt.result.resolutions.length !== expectedResolutions.size || receipt.result.resolutions.some((resolution) =>
            expectedResolutions.get(resolution.proposalId) !== resolution.lifecycle)) {
            fail(Codes.invalidTransition, 'Final result must resolve exactly the approved apply and choice set.');
          }
          if (!isDeepStrictEqual(receipt.result.createdProposalIds, request.creation ? [request.creation.proposalId] : [])) {
            fail(Codes.invalidTransition, 'Created proposal ID does not match the approved creation.');
          }
          for (const resolution of receipt.result.resolutions) {
            if ((await tx.getProposal(resolution.proposalId))?.lifecycle !== resolution.lifecycle) {
              fail(Codes.invalidTransition, 'Action result and proposal resolutions must commit together.');
            }
          }
          for (const createdId of receipt.result.createdProposalIds) {
            const created = await tx.getProposal(createdId);
            if (!created || created.lifecycle !== 'open' || !request.creation || created.operationId !== request.creation.operationId
              || !isDeepStrictEqual(created.source, request.creation.source)
              || !isDeepStrictEqual(created.relationships, request.creation.relationships)
              || !isDeepStrictEqual(created.authoredCandidate, request.creation.authoredCandidate)) {
              fail(Codes.invalidTransition, 'Created proposal and its exact approved content must commit together.');
            }
          }
          if (receipt.result.kind === 'content_changed') {
            const bindings = (await db.query<{ proposal_id: string; resolution: string; revision_id: string; application_order: number | string }>(
              `SELECT proposal_id,resolution,revision_id,application_order FROM file_revision_proposal_bindings
               WHERE graph_id=$1 AND action_id=$2 ORDER BY application_order`, [state.graphId, id])).rows;
            const expected = receipt.result.resolutions.filter((item) => item.lifecycle === 'applied' || item.lifecycle === 'included');
            if (bindings.length !== expected.length || bindings.some((binding, index) =>
              Number(binding.application_order) !== index || binding.revision_id !== receipt.result.revisionId
              || !expected.some((item) => item.proposalId === binding.proposal_id && item.lifecycle === binding.resolution))) {
              fail(Codes.invalidTransition, 'Durable success requires complete ordered revision bindings.');
            }
          }
        }
        return result;
      });
    },
  };
}

function createGraphTransaction(input: {
  db: FileVersionCenterTransaction;
  scope: ProposalDocumentScopeV1;
  state: { graphId: string; revision: number; activeActionId: string | null; actingActionId: string | null; changed: boolean; finalizedActions: Set<string> };
  now: () => number;
  createId: () => string;
}): ProposalGraphStorageTransaction {
  const { db, scope, state, now, createId } = input;
  const gid = state.graphId;
  const scoped = (candidate: ProposalDocumentScopeV1) => {
    if (!sameScope(scope, candidate)) fail(Codes.scopeMismatch, 'Proposal storage scope mismatch.');
  };
  const writable = () => {
    if (state.activeActionId && state.activeActionId !== state.actingActionId) {
      fail(Codes.recoveryRequired, 'Another proposal action is awaiting durable completion.');
    }
  };
  const touch = async () => {
    writable();
    if (state.changed) return;
    const result = await db.query<{ graph_revision: string | number }>(`UPDATE file_proposal_graphs
      SET graph_revision=graph_revision+1, updated_at=$2 WHERE graph_id=$1 RETURNING graph_revision`, [gid, now()]);
    state.revision = Number(result.rows[0]!.graph_revision);
    state.changed = true;
  };
  const getProposal = async (id: string) => {
    const row = (await db.query<NodeRow>(`SELECT node_json,lifecycle,cas_version,choice_group_id
      FROM file_change_proposals WHERE graph_id=$1 AND proposal_id=$2`, [gid, id])).rows[0];
    return row ? nodeFromRow(row) : null;
  };
  const getEvaluation = async (id: string) => {
    const row = (await db.query<{ evaluation_json: ProposalEvaluationV1 | string }>(`SELECT evaluation_json
      FROM file_proposal_evaluations WHERE graph_id=$1 AND evaluation_id=$2`, [gid, id])).rows[0];
    return row ? parseProposalEvaluationV1(parsed(row.evaluation_json)) : null;
  };
  const getAction = async (id: string) => {
    const row = (await db.query<{ receipt_json: ProposalActionReceiptV1 | string }>(`SELECT receipt_json
      FROM file_proposal_action_receipts WHERE graph_id=$1 AND action_id=$2`, [gid, id])).rows[0];
    return row ? parseProposalActionReceiptV1(parsed(row.receipt_json)) : null;
  };
  const readArtifact = async (ref: ProposalArtifactReferenceV1): Promise<Uint8Array> => {
    const row = (await db.query<{ sha256: string; size_bytes: number | string; payload: Uint8Array; encoding: Encoding }>(`SELECT sha256,size_bytes,payload,encoding
      FROM file_proposal_artifacts WHERE graph_id=$1 AND artifact_ref=$2`, [gid, ref.ref])).rows[0];
    if (!row || row.sha256 !== ref.sha256 || Number(row.size_bytes) !== ref.sizeBytes
      || row.payload.byteLength !== ref.sizeBytes || ref.sizeBytes > PROPOSAL_GRAPH_LIMITS.candidateBytes
      || createHash('sha256').update(row.payload).digest('hex') !== ref.sha256
      || row.encoding !== ('encoding' in ref ? ref.encoding : 'json_v1')) {
      fail(Codes.contentUnavailable, 'Pinned proposal artifact is missing or does not match its immutable identity.');
    }
    return Uint8Array.from(row.payload);
  };
  const pin = async (owner: { proposalId?: string; evaluationId?: string; actionId?: string }, refs: ProposalArtifactReferenceV1[]) => {
    for (const ref of new Map(refs.map((item) => [item.ref, item])).values()) {
      await readArtifact(ref);
      await db.query(`INSERT INTO file_proposal_artifact_pins
        (graph_id,artifact_ref,proposal_id,evaluation_id,action_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [gid, ref.ref, owner.proposalId ?? null, owner.evaluationId ?? null, owner.actionId ?? null, now()]);
    }
  };
  const loadGraph = async (options?: { includeProposalIds?: readonly string[] }): Promise<ProposalGraphSnapshotV1> =>
    parseProposalGraphSnapshotV1(await loadStoredProposalGraph(db, gid, scope, state.revision, options));
  return {
    loadGraph, getProposal, readArtifact, getEvaluation, getAction,
    async getActionRequest(id) {
      const row = (await db.query<{ request_json: ProposalStoredActionRequest | string }>(`SELECT request_json
        FROM file_proposal_action_receipts WHERE graph_id=$1 AND action_id=$2`, [gid, id])).rows[0];
      return row ? parseProposalPreparedActionV1(parsed(row.request_json)) : null;
    },
    async putArtifact(encoding, payload) {
      if (!['json_v1', 'yjs_full_update_v1'].includes(encoding) || payload.byteLength > PROPOSAL_GRAPH_LIMITS.candidateBytes) {
        fail(Codes.limitExceeded, 'Proposal artifact encoding or size is unsupported.');
      }
      const sha256 = createHash('sha256').update(payload).digest('hex');
      const existing = (await db.query<{ artifact_ref: string }>(`SELECT artifact_ref FROM file_proposal_artifacts
        WHERE graph_id=$1 AND sha256=$2 AND encoding=$3`, [gid, sha256, encoding])).rows[0];
      if (existing) return { ref: existing.artifact_ref, sha256, sizeBytes: payload.byteLength, encoding };
      const quota = (await db.query<{ count: string; bytes: string }>(`SELECT count(*)::text AS count,
        coalesce(sum(size_bytes),0)::text AS bytes FROM file_proposal_artifacts WHERE graph_id=$1`, [gid])).rows[0]!;
      if (Number(quota.count) >= PROPOSAL_GRAPH_LIMITS.artifactsPerGraph
        || Number(quota.bytes) + payload.byteLength > PROPOSAL_GRAPH_LIMITS.artifactBytesPerGraph) {
        fail(Codes.limitExceeded, 'Proposal artifact retention budget reached; pinned evidence cannot be evicted.');
      }
      const ref = createId();
      await db.query(`INSERT INTO file_proposal_artifacts
        (graph_id,artifact_ref,sha256,encoding,size_bytes,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (graph_id,sha256,encoding) DO NOTHING`, [gid, ref, sha256, encoding, payload.byteLength, Buffer.from(payload), now()]);
      const row = (await db.query<{ artifact_ref: string }>(`SELECT artifact_ref FROM file_proposal_artifacts
        WHERE graph_id=$1 AND sha256=$2 AND encoding=$3`, [gid, sha256, encoding])).rows[0]!;
      return { ref: row.artifact_ref, sha256, sizeBytes: payload.byteLength, encoding };
    },
    async insertProposal(value) {
      writable();
      const node = parseProposalNodeV1(value);
      scoped(node.scope);
      if (node.lifecycle !== 'open' || node.casVersion !== 1) fail(Codes.invalidTransition, 'New proposal must start open at CAS version one.');
      const existing = await getProposal(node.proposalId);
      if (existing) {
        if (isDeepStrictEqual(existing, node)) return existing;
        fail(Codes.idempotencyMismatch, 'Proposal ID already identifies another immutable proposal.');
      }
      for (const ref of nodeArtifacts(node)) await readArtifact(ref);
      if (node.source.kind === 'proposal') {
        const parent = await getProposal(node.source.proposalId);
        if (!parent || parent.casVersion !== node.source.proposalCasVersion
          || parent.authoredCandidate.cumulativeCandidate.sha256 !== node.source.authoredCandidateHash) {
          fail(Codes.parentChanged, 'The declared parent identity changed.');
        }
        if (node.source.evaluationId) {
          const evaluation = await getEvaluation(node.source.evaluationId);
          if (!evaluation || evaluation.proposalId !== parent.proposalId
            || !isDeepStrictEqual(evaluation.effectiveCandidate, node.source.snapshot)
            || !isDeepStrictEqual(evaluation.current, node.source.current)
            || !isDeepStrictEqual(evaluation.anchorMap, node.source.anchorMap)) {
            fail(Codes.sourceInvalid, 'The pinned source evaluation does not prove this parent candidate.');
          }
        } else if (!isDeepStrictEqual(node.source.snapshot, parent.authoredCandidate.cumulativeCandidate)) {
          fail(Codes.sourceInvalid, 'The source snapshot is not the authored parent candidate.');
        }
      }
      await db.query(`INSERT INTO file_change_proposals
        (proposal_id,graph_id,operation_id,cas_version,lifecycle,node_json,dependency_proposal_id,
         replaces_proposal_id,choice_group_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [node.proposalId, gid, node.operationId, node.casVersion, node.lifecycle, JSON.stringify(node),
        node.relationships.dependency?.proposalId ?? null, node.relationships.replacesProposalId,
        node.relationships.choiceGroupId, node.createdAt]);
      await pin({ proposalId: node.proposalId }, nodeArtifacts(node));
      await touch();
      return node;
    },
    async transitionProposal(id, expectedCas, lifecycle) {
      writable();
      const node = await getProposal(id);
      if (!node) fail(Codes.sourceInvalid, 'Proposal is unavailable in this scope.');
      if (node.casVersion !== expectedCas) fail(Codes.graphChanged, 'Proposal changed since it was read.');
      if (!canTransitionProposalLifecycleV1(node.lifecycle, lifecycle)) fail(Codes.invalidTransition, 'A resolved proposal cannot be reopened or resolved again.');
      if (node.lifecycle === lifecycle) return node;
      const result = await db.query<NodeRow>(`UPDATE file_change_proposals SET lifecycle=$4,cas_version=cas_version+1,updated_at=$5
        WHERE graph_id=$1 AND proposal_id=$2 AND cas_version=$3 RETURNING node_json,lifecycle,cas_version,choice_group_id`,
      [gid, id, expectedCas, lifecycle, now()]);
      if (result.rows.length !== 1) fail(Codes.graphChanged, 'Proposal CAS failed.');
      await touch();
      return nodeFromRow(result.rows[0]!);
    },
    async putChoiceGroup(group, expectedRevision) {
      writable();
      const existing = (await db.query<{ group_revision: number | string; chosen_proposal_id: string | null; dependency_proposal_id: string | null }>(
        `SELECT group_revision,chosen_proposal_id,dependency_proposal_id FROM file_proposal_choice_groups WHERE graph_id=$1 AND group_id=$2`, [gid, group.groupId])).rows[0];
      if (existing ? Number(existing.group_revision) !== expectedRevision : expectedRevision !== null) fail(Codes.graphChanged, 'Choice group changed.');
      if (group.groupRevision !== (expectedRevision === null ? 0 : expectedRevision + 1)
        || (existing && (existing.dependency_proposal_id !== group.dependencyProposalId
          || (existing.chosen_proposal_id !== null && existing.chosen_proposal_id !== group.chosenProposalId)))) {
        fail(Codes.choiceConflict, 'Choice group cannot change its prerequisite or resolved winner.');
      }
      const oldMembers = (await db.query<{ proposal_id: string }>(`SELECT proposal_id FROM file_proposal_choice_memberships
        WHERE graph_id=$1 AND group_id=$2`, [gid, group.groupId])).rows;
      if (oldMembers.some((member) => !group.memberProposalIds.includes(member.proposal_id))) fail(Codes.choiceConflict, 'Choice membership is append-only.');
      await db.query(`INSERT INTO file_proposal_choice_groups
        (graph_id,group_id,group_revision,dependency_proposal_id,chosen_proposal_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (graph_id,group_id) DO UPDATE SET
        group_revision=EXCLUDED.group_revision,chosen_proposal_id=EXCLUDED.chosen_proposal_id,updated_at=EXCLUDED.updated_at`,
      [gid, group.groupId, group.groupRevision, group.dependencyProposalId, group.chosenProposalId, now()]);
      for (const id of group.memberProposalIds) {
        const member = await getProposal(id);
        if (!member || (member.relationships.dependency?.proposalId ?? null) !== group.dependencyProposalId
          || (member.relationships.choiceGroupId !== null && member.relationships.choiceGroupId !== group.groupId)) {
          fail(Codes.choiceConflict, 'Choice members must belong to the same prerequisite.');
        }
        if (member.relationships.choiceGroupId === null) {
          await db.query(`UPDATE file_change_proposals SET choice_group_id=$3,cas_version=cas_version+1,updated_at=$4
            WHERE graph_id=$1 AND proposal_id=$2`, [gid, id, group.groupId, now()]);
        }
        if (!oldMembers.some((old) => old.proposal_id === id)) {
          await db.query(`INSERT INTO file_proposal_choice_memberships(graph_id,group_id,proposal_id)
            VALUES ($1,$2,$3)`, [gid, group.groupId, id]);
        }
      }
      await touch();
    },
    async putEvaluation(value) {
      const evaluation = parseProposalEvaluationV1(value);
      scoped(evaluation.scope);
      if (evaluation.graphRevision !== state.revision) fail(Codes.graphChanged, 'Evaluation is for another graph revision.');
      const existing = await getEvaluation(evaluation.evaluationId);
      if (existing) {
        if (!isDeepStrictEqual(existing, evaluation)) fail(Codes.candidateChanged, 'An evaluation is immutable.');
        return;
      }
      await db.query(`INSERT INTO file_proposal_evaluations(evaluation_id,graph_id,proposal_id,evaluation_json,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [evaluation.evaluationId, gid, evaluation.proposalId, JSON.stringify(evaluation), evaluation.evaluatedAt, evaluation.expiresAt]);
      await pin({ evaluationId: evaluation.evaluationId }, evaluationArtifacts(evaluation));
    },
    async reserveAction(value, request) {
      const receipt = parseProposalActionReceiptV1(value);
      scoped(receipt.scope);
      parseProposalPreparedActionV1(request);
      scoped(request.fence.scope);
      if (receipt.phase !== 'prepared' || receipt.actorId !== request.fence.actor.userId
        || receipt.requestDigest !== request.fence.requestDigest || receipt.actionType !== request.fence.actionType
        || !isDeepStrictEqual([...receipt.affectedProposalIds].sort(), request.fence.closure.map((member) => member.proposalId).sort())) {
        fail(Codes.invalidRequest, 'Prepared receipt must bind the authorized request and actor.');
      }
      const prior = (await db.query<{ graph_id: string; receipt_json: ProposalActionReceiptV1 | string; request_json: ProposalStoredActionRequest | string }>(
        `SELECT graph_id,receipt_json,request_json FROM file_proposal_action_receipts
         WHERE actor_id=$1 AND idempotency_key_hash=$2`, [receipt.actorId, receipt.idempotencyKeyHash])).rows[0];
      if (prior) {
        const previous = parseProposalActionReceiptV1(parsed(prior.receipt_json));
        if (prior.graph_id !== gid || previous.requestDigest !== receipt.requestDigest || !isDeepStrictEqual(parsed(prior.request_json), request)) {
          fail(Codes.idempotencyMismatch, 'Idempotency key was already used for another approved request.');
        }
        return previous;
      }
      writable();
      if (state.activeActionId) fail(Codes.recoveryRequired, 'Existing action must be resolved before reserving another.');
      if (request.fence.graphRevision !== state.revision) fail(Codes.graphChanged, 'Approved graph changed.');
      if (request.fence.expiresAt <= now()) fail(Codes.fenceExpired, 'Approval expired.');
      try {
        await db.query(`INSERT INTO file_proposal_action_receipts
          (action_id,graph_id,actor_id,idempotency_key_hash,request_digest,phase,operation_id,receipt_json,request_json,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [receipt.actionId, gid, receipt.actorId, receipt.idempotencyKeyHash,
          receipt.requestDigest, receipt.phase, receipt.operationId, JSON.stringify(receipt), JSON.stringify(request), receipt.createdAt, receipt.updatedAt]);
      } catch (error) {
        const constraint = error && typeof error === 'object' && 'constraint' in error ? error.constraint : null;
        if (constraint === 'proposal_action_idempotency') fail(Codes.idempotencyMismatch, 'Action key was concurrently used in another scope.');
        if (constraint === 'idx_proposal_one_active_action') fail(Codes.recoveryRequired, 'Another document generation still owns a pending action.');
        throw error;
      }
      const graph = await loadGraph();
      const nodes = new Map(graph.nodes.map((node) => [node.proposalId, node]));
      for (const member of request.fence.closure) {
        const node = nodes.get(member.proposalId);
        if (!node || node.casVersion !== member.casVersion
          || node.authoredCandidate.cumulativeCandidate.sha256 !== member.candidateHash) {
          fail(Codes.graphChanged, 'Approved proposal closure differs from the stored graph.');
        }
      }
      const keep = new Set(receipt.affectedProposalIds);
      for (const id of keep) {
        const node = nodes.get(id);
        if (!node) fail(Codes.sourceInvalid, 'Action refers to an unavailable proposal.');
        if (node.relationships.dependency) keep.add(node.relationships.dependency.proposalId);
        await pin({ actionId: receipt.actionId }, nodeArtifacts(node));
      }
      if (request.fence.evaluationId) {
        const evaluation = await getEvaluation(request.fence.evaluationId);
        if (!evaluation || evaluation.effectiveCandidate?.sha256 !== request.fence.effectiveCandidateHash
          || evaluation.graphRevision !== request.fence.graphRevision
          || !isDeepStrictEqual(evaluation.current, request.fence.current)
          || !request.fence.selectedProposalIds.includes(evaluation.proposalId)
          || evaluation.expiresAt <= now()
          || (['accept', 'batch_accept'].includes(receipt.actionType) && !['clean', 'clean_rebased'].includes(evaluation.status))
          || (receipt.actionType === 'complete_satisfied' && evaluation.status !== 'satisfied_elsewhere')) {
          fail(Codes.candidateChanged, 'Approved evaluation is unavailable or differs from the shown current state.');
        }
        await pin({ actionId: receipt.actionId }, evaluationArtifacts(evaluation));
      }
      if (request.creation) {
        await pin({ actionId: receipt.actionId }, [request.creation.source.snapshot, request.creation.source.anchorMap,
          request.creation.authoredCandidate.incrementalPayload, request.creation.authoredCandidate.cumulativeCandidate,
          request.creation.authoredCandidate.effectPreconditions]);
      }
      await db.query(`UPDATE file_proposal_graphs SET active_action_id=$2,updated_at=$3 WHERE graph_id=$1`, [gid, receipt.actionId, now()]);
      state.activeActionId = receipt.actionId;
      state.actingActionId = receipt.actionId;
      return receipt;
    },
    async advanceAction(value) {
      writable();
      const receipt = parseProposalActionReceiptV1(value);
      scoped(receipt.scope);
      const previous = await getAction(receipt.actionId);
      if (!previous || previous.actorId !== receipt.actorId || previous.requestDigest !== receipt.requestDigest
        || previous.idempotencyKeyHash !== receipt.idempotencyKeyHash || previous.actionType !== receipt.actionType
        || previous.createdAt !== receipt.createdAt || previous.updatedAt > receipt.updatedAt
        || !isDeepStrictEqual(previous.affectedProposalIds, receipt.affectedProposalIds)
        || (previous.operationId !== null && previous.operationId !== receipt.operationId)) fail(Codes.idempotencyMismatch, 'Receipt immutable identity changed.');
      if (!canTransitionProposalReceiptV1(previous.phase, receipt.phase)) fail(Codes.invalidTransition, 'Unsafe action phase transition.');
      if (['succeeded', 'failed'].includes(previous.phase)) {
        if (!isDeepStrictEqual(previous, receipt)) fail(Codes.invalidTransition, 'A terminal receipt is immutable.');
        return;
      }
      if (state.activeActionId !== receipt.actionId || state.actingActionId !== receipt.actionId) fail(Codes.recoveryRequired, 'Action does not own the document reservation.');
      if (receipt.phase === 'succeeded' && receipt.result.kind === 'content_changed') {
        const operation = (await db.query<{ persisted_at: string | number | null; version_revision_id: string | null; resulting_state_snapshot: Uint8Array | null }>(
          `SELECT persisted_at,version_revision_id,resulting_state_snapshot FROM collaboration_agent_operations
           WHERE operation_id=$1 AND document_id=$2 AND workspace_id=$3`, [receipt.operationId, scope.documentId, scope.workspaceId])).rows[0];
        if (operation?.persisted_at == null || !operation.resulting_state_snapshot || operation.version_revision_id !== receipt.result.revisionId) {
          fail(Codes.recoveryRequired, 'Underlying document operation has not durably confirmed this revision.');
        }
      }
      await db.query(`UPDATE file_proposal_action_receipts SET phase=$3,operation_id=$4,receipt_json=$5,updated_at=$6
        WHERE graph_id=$1 AND action_id=$2`, [gid, receipt.actionId, receipt.phase, receipt.operationId, JSON.stringify(receipt), receipt.updatedAt]);
      if (receipt.phase === 'succeeded' || receipt.phase === 'failed') {
        await db.query(`UPDATE file_proposal_graphs SET active_action_id=NULL,updated_at=$3
          WHERE graph_id=$1 AND active_action_id=$2`, [gid, receipt.actionId, now()]);
        state.activeActionId = null;
      }
      if (receipt.phase === 'succeeded') state.finalizedActions.add(receipt.actionId);
    },
    async bindRevision(revisionId, actionId, bindings) {
      writable();
      const receipt = await getAction(actionId);
      if (!receipt || receipt.phase !== 'succeeded' || receipt.result.kind !== 'content_changed'
        || receipt.result.revisionId !== revisionId) fail(Codes.invalidTransition, 'Revision binding requires a matching durable action result.');
      const expected = receipt.result.resolutions.filter((resolution) => ['applied', 'included'].includes(resolution.lifecycle));
      if (bindings.length !== expected.length || new Set(bindings.map((binding) => binding.proposalId)).size !== bindings.length
        || bindings.some((binding, index) => binding.applicationOrder !== index
          || !expected.some((item) => item.proposalId === binding.proposalId && item.lifecycle === binding.resolution))) {
        fail(Codes.invalidRequest, 'Revision audit must enumerate every applied proposal exactly once.');
      }
      for (const binding of bindings) {
        const previous = (await db.query<{ action_id: string; resolution: string; application_order: number | string }>(
          `SELECT action_id,resolution,application_order FROM file_revision_proposal_bindings
           WHERE graph_id=$1 AND revision_id=$2 AND proposal_id=$3`, [gid, revisionId, binding.proposalId])).rows[0];
        if (previous && (previous.action_id !== actionId || previous.resolution !== binding.resolution
          || Number(previous.application_order) !== binding.applicationOrder)) fail(Codes.idempotencyMismatch, 'Revision binding already has another immutable outcome.');
        await db.query(`INSERT INTO file_revision_proposal_bindings(graph_id,revision_id,proposal_id,action_id,resolution,application_order)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (graph_id,revision_id,proposal_id) DO NOTHING`,
        [gid, revisionId, binding.proposalId, actionId, binding.resolution, binding.applicationOrder]);
      }
    },
    async collectArtifacts(cutoff) {
      writable();
      if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > now()) fail(Codes.invalidRequest, 'Invalid retention boundary.');
      // Keep audit rows indefinitely, but do not allocate the entire historical graph
      // in application memory just to collect no-longer-required artifacts.
      const keepSql = `WITH RECURSIVE kept AS (
        SELECT proposal_id,dependency_proposal_id,source_evaluation_id FROM file_change_proposals
          WHERE graph_id=$1 AND (lifecycle='open' OR updated_at >= $2)
        UNION
        SELECT parent.proposal_id,parent.dependency_proposal_id,parent.source_evaluation_id
          FROM file_change_proposals parent JOIN kept child ON parent.proposal_id=child.dependency_proposal_id
          WHERE parent.graph_id=$1
      )`;
      await db.query(`${keepSql} DELETE FROM file_proposal_artifact_pins WHERE graph_id=$1 AND proposal_id IS NOT NULL
        AND proposal_id NOT IN (SELECT proposal_id FROM kept)`, [gid, cutoff]);
      await db.query(`${keepSql} DELETE FROM file_proposal_artifact_pins pins USING file_proposal_evaluations evaluations
        WHERE pins.graph_id=$1 AND evaluations.graph_id=pins.graph_id AND pins.evaluation_id=evaluations.evaluation_id
        AND evaluations.expires_at < $2 AND evaluations.evaluation_id NOT IN
          (SELECT source_evaluation_id FROM kept WHERE source_evaluation_id IS NOT NULL)`, [gid, cutoff]);
      await db.query(`DELETE FROM file_proposal_artifact_pins pins USING file_proposal_action_receipts actions
        WHERE pins.graph_id=$1 AND actions.graph_id=pins.graph_id AND pins.action_id=actions.action_id
        AND actions.phase IN ('succeeded','failed') AND actions.updated_at < $2`, [gid, cutoff]);
      const deleted = await db.query(`DELETE FROM file_proposal_artifacts artifacts WHERE graph_id=$1 AND created_at < $2
        AND NOT EXISTS (SELECT 1 FROM file_proposal_artifact_pins pins WHERE pins.graph_id=artifacts.graph_id
          AND pins.artifact_ref=artifacts.artifact_ref) RETURNING artifact_ref`, [gid, cutoff]);
      return { deleted: deleted.rows.length };
    },
  };
}
