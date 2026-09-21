import 'server-only';

import { isDeepStrictEqual } from 'node:util';

import { readCurrentCollaborationDocument } from '../collaboration/document-access';
import { loadCollaborationState, type PersistedCollaborationState } from '../collaboration/persistence';
import { Y } from '../collaboration/server-runtime';
import type { WorkspaceContext } from '../workspaces/types';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase, type FileVersionCenterTransaction } from './database';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  ProposalGraphContractError,
  type ProposalDocumentScopeV1,
  type ProposalGraphErrorCode,
} from './contracts/proposal-graph-v1';
import { evaluateProposalReview, type ProposalReviewEvaluationResult } from './proposal-review-evaluation';
import { createProposalReviewCompareService } from './proposal-review-compare-service';
import { hashProposalEvaluationSelectionV1 } from './proposal-action-fence';
import { resolveProposalClosure } from './proposal-graph-model';
import { createProposalGraphStorage, type ProposalGraphStorageTransaction } from './proposal-storage';
import { proposalYjsCurrentProof, proposalYjsSnapshotContent, type ProposalYjsRepresentation } from './proposal-yjs-candidate';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from './query-service';

type CollaborationIdentityRow = {
  lineage_id: string;
  document_workspace_id: string;
  document_path: string;
  document_status: string;
  provider: string;
  lineage_workspace_id: string;
  lineage_path: string;
  lineage_status: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  representation: ProposalYjsRepresentation;
  lifecycle_generation: number | string;
  schema_version: number | string;
  document_sequence: number | string;
  status: string;
  degraded: number | boolean;
};

type ProposalOwnerRow = { proposal_id: string; initiated_by_user_id: string };

type ProposalStorage = {
  withLockedGraph<T>(
    scope: ProposalDocumentScopeV1,
    options: { actionId?: string },
    action: (transaction: ProposalGraphStorageTransaction, sql: FileVersionCenterTransaction) => Promise<T>,
  ): Promise<T>;
};

export type RuntimeProposalReviewDependencies = {
  database?: FileVersionCenterDatabase;
  storage?: ProposalStorage;
  loadState?: (documentId: string) => Promise<PersistedCollaborationState | null>;
  readCurrent?: (input: { documentId: string; workspaceId: string }) => Promise<Uint8Array>;
  evaluate?: typeof evaluateProposalReview;
};

function fail(code: ProposalGraphErrorCode, message: string): never {
  throw new ProposalGraphContractError(code, message);
}

function assertReadAccess(input: { workspace: WorkspaceContext; access: FileVersionCenterAccess }): void {
  const { workspace, access } = input;
  if (!access.canRead || access.membership !== 'active' || !access.permissionsResolved
    || access.authenticatedWorkspaceId !== workspace.workspaceId || access.requestedWorkspaceId !== workspace.workspaceId
    || !workspace.permissions.canRead || workspace.legacy) {
    fail(Codes.accessDenied, 'The active user cannot review proposals in this workspace.');
  }
}

function assertState(input: {
  state: PersistedCollaborationState | null;
  target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext;
}): PersistedCollaborationState {
  const { state, target, workspace } = input;
  if (!state || !target.documentId || state.documentId !== target.documentId || state.workspaceId !== workspace.workspaceId
    || state.organizationId !== (workspace.organizationId ?? null) || state.path !== target.path
    || state.status !== 'active' || state.degraded) {
    return fail(Codes.staleLifecycle, 'The collaborative document identity is no longer active.');
  }
  return state;
}

function assertIdentity(row: CollaborationIdentityRow | undefined, input: {
  scope: ProposalDocumentScopeV1;
  target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext;
  state: PersistedCollaborationState;
}): CollaborationIdentityRow {
  const { scope, target, workspace, state } = input;
  if (!row || row.lineage_id !== target.lineageId || row.document_workspace_id !== workspace.workspaceId
    || row.lineage_workspace_id !== workspace.workspaceId || row.workspace_id !== workspace.workspaceId
    || row.organization_id !== (workspace.organizationId ?? null) || row.document_path !== target.path
    || row.lineage_path !== target.path || row.path !== target.path || row.document_status !== 'active'
    || row.lineage_status !== 'active' || row.status !== 'active' || row.provider !== 'yjs'
    || row.degraded === true || Number(row.degraded) === 1 || row.representation !== state.representation
    || Number(row.lifecycle_generation) !== scope.lifecycleGeneration || Number(row.schema_version) !== scope.schemaVersion) {
    return fail(Codes.staleLifecycle, 'The collaborative document lifecycle changed while preparing the review.');
  }
  return row;
}

async function loadIdentity(sql: FileVersionCenterTransaction, input: {
  documentId: string;
  workspaceId: string;
}): Promise<CollaborationIdentityRow | undefined> {
  return (await sql.query<CollaborationIdentityRow>(`SELECT document.lineage_id, document.workspace_id AS document_workspace_id,
    document.path AS document_path, document.status AS document_status, document.provider,
    lineage.workspace_id AS lineage_workspace_id, lineage.path AS lineage_path, lineage.status AS lineage_status,
    state.workspace_id, state.organization_id, state.path, state.representation, state.lifecycle_generation,
    state.schema_version, state.document_sequence, state.status, state.degraded
    FROM collaboration_documents document
    JOIN file_collaboration_lineages lineage ON lineage.id = document.lineage_id
    JOIN collaboration_yjs_states state ON state.document_id = document.id
    WHERE document.id = $1 AND document.workspace_id = $2 AND lineage.workspace_id = $2 AND state.workspace_id = $2
    FOR UPDATE OF document, lineage, state`, [input.documentId, input.workspaceId])).rows[0];
}

/**
 * Server-side preview adapter. This deliberately exposes no graph writes or
 * activation path: its only durable writes are immutable evaluation artifacts.
 */
export async function createRuntimeProposalReviewService(input: {
  target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext;
  access: FileVersionCenterAccess;
  dependencies?: RuntimeProposalReviewDependencies;
}) {
  const { target, workspace, access } = input;
  if (!target.documentId || target.workspaceId !== workspace.workspaceId) {
    fail(Codes.scopeMismatch, 'A current collaborative document target is required for proposal review.');
  }
  assertReadAccess({ workspace, access });
  const loadState = input.dependencies?.loadState ?? loadCollaborationState;
  const readCurrent = input.dependencies?.readCurrent ?? (async ({ documentId, workspaceId }) =>
    readCurrentCollaborationDocument({ documentId, workspaceId, read: (doc) => Y.encodeStateAsUpdate(doc) }));
  const state = assertState({ state: await loadState(target.documentId), target, workspace });
  const database = input.dependencies?.database ?? createRuntimeFileVersionCenterDatabase();
  const storage = input.dependencies?.storage ?? createProposalGraphStorage({ database });
  const evaluate = input.dependencies?.evaluate ?? evaluateProposalReview;

  await database.transaction(async (sql) => assertIdentity(await loadIdentity(sql, {
    documentId: target.documentId!, workspaceId: workspace.workspaceId,
  }), { scope: { workspaceId: workspace.workspaceId, lineageId: target.lineageId, documentId: state.documentId,
    lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion }, target, workspace, state }));
  const scope: ProposalDocumentScopeV1 = {
    workspaceId: workspace.workspaceId, lineageId: target.lineageId, documentId: state.documentId,
    lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion,
  };

  const loadCurrent = async (sql: FileVersionCenterTransaction, expectedSequence: number) => {
    const latestState = assertState({ state: await loadState(scope.documentId), target, workspace });
    const identity = assertIdentity(await loadIdentity(sql, { documentId: scope.documentId, workspaceId: scope.workspaceId }),
      { scope, target, workspace, state: latestState });
    if (Number(identity.document_sequence) !== expectedSequence) {
      fail(Codes.currentChanged, 'The persisted document sequence changed while evaluating proposals.');
    }
    return {
      scope, representation: latestState.representation, revisionId: null,
      update: await readCurrent({ documentId: scope.documentId, workspaceId: scope.workspaceId }),
    };
  };

  const authorize = async (sql: FileVersionCenterTransaction, requestedScope: ProposalDocumentScopeV1, proposalIds: readonly string[]) => {
    if (!isDeepStrictEqual(scope, requestedScope) || proposalIds.length === 0) {
      fail(Codes.scopeMismatch, 'Proposal authorization is not bound to this document scope.');
    }
    const unique = [...new Set(proposalIds)];
    if (unique.length !== proposalIds.length) fail(Codes.invalidRequest, 'Proposal authorization contains duplicate IDs.');
    const rows = (await sql.query<ProposalOwnerRow>(`SELECT proposal.proposal_id, operation.initiated_by_user_id
      FROM file_change_proposals proposal
      JOIN file_proposal_graphs graph ON graph.graph_id = proposal.graph_id
      JOIN collaboration_agent_operations operation ON operation.operation_id = proposal.operation_id
      WHERE graph.workspace_id = $1 AND graph.lineage_id = $2 AND graph.document_id = $3
        AND graph.lifecycle_generation = $4 AND graph.schema_version = $5
        AND proposal.proposal_id = ANY($6::text[])`,
    [scope.workspaceId, scope.lineageId, scope.documentId, scope.lifecycleGeneration, scope.schemaVersion, unique])).rows;
    if (rows.length !== unique.length || new Set(rows.map((row) => row.proposal_id)).size !== unique.length) {
      fail(Codes.sourceInvalid, 'A selected proposal is unavailable in this exact document scope.');
    }
    if (!(access.canManageWorkspace && workspace.permissions.canManageWorkspace)
      && rows.some((row) => row.initiated_by_user_id !== access.userId)) {
      fail(Codes.accessDenied, 'Only a workspace manager may review another user’s proposal.');
    }
  };

  const evaluateSelection = async (inputSelection: { selectedProposalIds: readonly string[] }): Promise<ProposalReviewEvaluationResult> => {
    return storage.withLockedGraph(scope, {}, async (transaction, sql) => {
        const locked = assertIdentity(await loadIdentity(sql, { documentId: scope.documentId, workspaceId: scope.workspaceId }),
          { scope, target, workspace, state: assertState({ state: await loadState(scope.documentId), target, workspace }) });
        const sequence = Number(locked.document_sequence);
        const current = () => loadCurrent(sql, sequence);
        return evaluate({
          scope, selectedProposalIds: inputSelection.selectedProposalIds, transaction,
          loadCurrent: current,
          confirmCurrent: async () => current(),
          authorize: async (request) => authorize(sql, request.scope, request.proposalIds),
        });
    });
  };

  return {
    scope,
    evaluateSelection,
    /**
     * A read-only adapter for display pagination. It reauthorizes the entire
     * graph closure and verifies the durable evaluation/artifact on every page.
     */
    createCompareService() {
      return createProposalReviewCompareService({
        evaluateSelection,
        loadCurrent: async () => database.transaction(async (sql) => {
          const locked = assertIdentity(await loadIdentity(sql, { documentId: scope.documentId, workspaceId: scope.workspaceId }),
            { scope, target, workspace, state: assertState({ state: await loadState(scope.documentId), target, workspace }) });
          const current = await loadCurrent(sql, Number(locked.document_sequence));
          return { content: proposalYjsSnapshotContent({ update: current.update, representation: current.representation }),
            proof: proposalYjsCurrentProof({ update: current.update, representation: current.representation, revisionId: current.revisionId }) };
        }),
        loadEvaluation: async ({ evaluationId, selectedProposalIds }) => storage.withLockedGraph(scope, {}, async (transaction, sql) => {
          assertIdentity(await loadIdentity(sql, { documentId: scope.documentId, workspaceId: scope.workspaceId }),
            { scope, target, workspace, state: assertState({ state: await loadState(scope.documentId), target, workspace }) });
          await authorize(sql, scope, selectedProposalIds);
          const graph = await transaction.loadGraph({ includeProposalIds: selectedProposalIds });
          const closure = resolveProposalClosure({ graph, selectedProposalIds: [...selectedProposalIds] });
          if (closure.status !== 'ready') fail(closure.reasonCode, 'The evaluated proposal closure is no longer reviewable.');
          await authorize(sql, scope, closure.closureProposalIds);
          const evaluation = await transaction.getEvaluation(evaluationId);
          if (!evaluation || !isDeepStrictEqual(evaluation.scope, scope) || evaluation.proposalId !== selectedProposalIds[0]) {
            fail(Codes.candidateChanged, 'The displayed evaluation is unavailable for this proposal selection.');
          }
          const selectionHash = hashProposalEvaluationSelectionV1({ selectedProposalIds: closure.selectedProposalIds,
            closureProposalIds: closure.closureProposalIds, applyProposalIds: closure.applyProposalIds, graphRevision: closure.graphRevision });
          if (evaluation.selectionHash !== selectionHash) fail(Codes.candidateChanged, 'The displayed evaluation belongs to a different proposal selection.');
          const stateNow = assertState({ state: await loadState(scope.documentId), target, workspace });
          let candidateContent: string | null = null;
          let nullEffectProven = false;
          if (evaluation.effectiveCandidate) {
            const update = await transaction.readArtifact(evaluation.effectiveCandidate);
            candidateContent = proposalYjsSnapshotContent({ update, representation: stateNow.representation });
            const candidateProof = proposalYjsCurrentProof({ update, representation: stateNow.representation, revisionId: null });
            if ((evaluation.status === 'satisfied_elsewhere' || evaluation.status === 'empty_effect')
              && !isDeepStrictEqual(candidateProof, evaluation.current)) {
              fail(Codes.candidateChanged, 'A satisfied proposal must prove a null effective diff.');
            }
            nullEffectProven = evaluation.status === 'satisfied_elsewhere' || evaluation.status === 'empty_effect';
          }
          if (evaluation.status === 'satisfied_elsewhere' || evaluation.status === 'empty_effect') {
            if (!evaluation.effectiveCandidate || !evaluation.anchorMap || !evaluation.effectPreconditions || !nullEffectProven) {
              fail(Codes.candidateChanged, 'A satisfied proposal requires immutable null-effect evidence.');
            }
            candidateContent = null;
          }
          return { evaluation, selectionHash, selectedProposalIds: [...closure.selectedProposalIds], graphRevision: evaluation.graphRevision,
            currentGraphRevision: graph.graphRevision, candidateContent, status: evaluation.status, nullEffectProven };
        }),
      });
    },
  };
}
