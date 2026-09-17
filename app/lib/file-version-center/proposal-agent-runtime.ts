import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

import type { WorkspaceContext } from '../workspaces/types';
import { readPostgresWorkspaceForActor } from '../workspaces/postgres-runtime';
import { resolveAgentExecutionContextForStoredSession, workspaceFromAgentExecutionContext } from '../pi/session-workspace-context';
import { loadCollaborationState } from '../collaboration/persistence';
import { readCurrentCollaborationDocument } from '../collaboration/document-access';
import { prepareProposalAgentOperation } from '../collaboration/agent-operations';
import { Y } from '../collaboration/server-runtime';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterTransaction } from './database';
import { createProposalGraphStorage } from './proposal-storage';
import { createProposalProvenanceService, type ProposalProvenanceAuthorization } from './proposal-provenance-service';
import { proposalYjsCurrentProof, type ProposalYjsRepresentation } from './proposal-yjs-candidate';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError,
  type ProposalCurrentProofV1, type ProposalDocumentScopeV1, type ProposalGraphErrorCode, type ProposalRelationshipsV1,
} from './contracts/proposal-graph-v1';

function fail(code: ProposalGraphErrorCode, message: string): never { throw new ProposalGraphContractError(code, message); }

/** Deliberately closed until FVRC-1008 completes integration/recovery/UI rollout. */
export function assertProposalToolsEnabled(): void {
  return fail(Codes.upgradeRequired, 'Graph-aware proposal tools are not enabled yet. No legacy write was attempted.');
}

type ScopedRow = {
  lineage_id: string; document_workspace_id: string; document_path: string; document_status: string; provider: string;
  lineage_workspace_id: string; lineage_path: string; lineage_status: string;
  workspace_id: string; organization_id: string | null; path: string; representation: ProposalYjsRepresentation;
  lifecycle_generation: number | string; schema_version: number | string; document_sequence: number | string;
  status: string; degraded: number | boolean;
};
type ExistingOperation = {
  operation_id: string; proposal_id: string | null; actor_id: string; initiated_by_user_id: string; actor_session_id: string | null;
  workspace_id: string; organization_id: string | null; document_path: string | null; document_representation: string | null;
  document_lifecycle_generation: number | string; schema_version: number | string; requested_mode: string; operation_type: string;
  file_edit_request_json: string | { fingerprint?: unknown } | null;
  graph_workspace_id: string | null; lineage_id: string | null; graph_document_id: string | null;
  graph_generation: number | string | null; graph_schema: number | string | null;
  authored_relationships: ProposalRelationshipsV1 | null;
};

/** Internal adapter, not a rollout switch. Public tool entrypoints must call the guard above. */
export async function createRuntimeProposalAgentService(input: {
  workspace: WorkspaceContext; documentId: string; path: string;
  identity: { initiatedByUserId: string; actorId: string; actorSessionId?: string };
}) {
  const { workspace, identity } = input;
  const database = createRuntimeFileVersionCenterDatabase();
  const activeTransaction = new AsyncLocalStorage<FileVersionCenterTransaction>();
  const query = <T>(action: (sql: FileVersionCenterTransaction) => Promise<T>): Promise<T> => {
    const active = activeTransaction.getStore();
    return active ? action(active) : database.transaction(action);
  };
  const freshWorkspace = async (write: boolean): Promise<WorkspaceContext> => {
    try {
      const fresh = identity.actorSessionId
        ? workspaceFromAgentExecutionContext(await resolveAgentExecutionContextForStoredSession({
          sessionId: identity.actorSessionId, userId: identity.initiatedByUserId, agentId: identity.actorId,
          permissions: write ? ['canRead', 'canRunAgent', 'canWrite'] : ['canRead', 'canRunAgent'],
        }))
        : await readPostgresWorkspaceForActor({ userId: identity.initiatedByUserId,
          role: workspace.actor?.userId === identity.initiatedByUserId ? workspace.actor.role : 'member' }, workspace.workspaceId);
      if (!fresh || fresh.workspaceId !== workspace.workspaceId || fresh.legacy
        || (fresh.organizationId ?? null) !== (workspace.organizationId ?? null)
        || !fresh.permissions.canRead || !fresh.permissions.canRunAgent || !workspace.permissions.canRead || !workspace.permissions.canRunAgent
        || (write && (!fresh.permissions.canWrite || !workspace.permissions.canWrite))) fail(Codes.accessDenied, 'The agent no longer has access to this workspace.');
      return { ...fresh, permissions: { ...fresh.permissions,
        canManageWorkspace: fresh.permissions.canManageWorkspace && workspace.permissions.canManageWorkspace,
        canWrite: fresh.permissions.canWrite && workspace.permissions.canWrite } };
    } catch (error) {
      if (error instanceof ProposalGraphContractError) throw error;
      return fail(Codes.accessDenied, 'The originating agent session or workspace permission is unavailable.');
    }
  };
  await freshWorkspace(false);
  const state = await loadCollaborationState(input.documentId);
  if (!state || state.status !== 'active' || state.degraded || state.workspaceId !== workspace.workspaceId
    || state.organizationId !== (workspace.organizationId ?? null) || state.path !== input.path) fail(Codes.staleLifecycle, 'The collaborative document is unavailable in this path and workspace.');

  const readScopedRow = async (sql: FileVersionCenterTransaction, lock: boolean): Promise<ScopedRow> => {
    const row = (await sql.query<ScopedRow>(`SELECT document.lineage_id, document.workspace_id AS document_workspace_id,
      document.path AS document_path, document.status AS document_status, document.provider,
      lineage.workspace_id AS lineage_workspace_id, lineage.path AS lineage_path, lineage.status AS lineage_status,
      state.workspace_id,state.organization_id,state.path,state.representation,state.lifecycle_generation,state.schema_version,
      state.document_sequence,state.status,state.degraded
      FROM collaboration_documents document JOIN file_collaboration_lineages lineage ON lineage.id=document.lineage_id
      JOIN collaboration_yjs_states state ON state.document_id=document.id
      WHERE document.id=$1 AND document.workspace_id=$2 AND lineage.workspace_id=$2 AND state.workspace_id=$2
      ${lock ? 'FOR UPDATE OF document,lineage,state' : ''}`, [input.documentId, workspace.workspaceId])).rows[0];
    if (!row || row.document_status !== 'active' || row.lineage_status !== 'active' || row.status !== 'active'
      || row.provider !== 'yjs' || row.degraded === true || Number(row.degraded) === 1
      || row.organization_id !== state.organizationId || row.path !== input.path || row.document_path !== input.path || row.lineage_path !== input.path
      || row.representation !== state.representation || Number(row.lifecycle_generation) !== state.lifecycleGeneration
      || Number(row.schema_version) !== state.schemaVersion) fail(Codes.staleLifecycle, 'The document identity, lifecycle or schema changed.');
    return row;
  };
  const initial = await database.transaction((sql) => readScopedRow(sql, false));
  const scope: ProposalDocumentScopeV1 = { workspaceId: workspace.workspaceId, lineageId: initial.lineage_id,
    documentId: state.documentId, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion };
  const sameScope = (candidate: ProposalDocumentScopeV1) => {
    if (!isDeepStrictEqual(scope, candidate)) fail(Codes.scopeMismatch, 'Proposal request belongs to another document scope.');
  };
  const authorize = async (request: ProposalProvenanceAuthorization) => {
    sameScope(request.scope);
    const fresh = await freshWorkspace(request.action !== 'read');
    if (!request.proposalIds.length) return;
    const rows = await query(async (sql) => (await sql.query<{
      proposal_id: string; initiated_by_user_id: string; actor_id: string;
    }>(`SELECT proposal.proposal_id, operation.initiated_by_user_id, operation.actor_id
      FROM file_change_proposals proposal JOIN file_proposal_graphs graph ON graph.graph_id=proposal.graph_id
      JOIN collaboration_agent_operations operation ON operation.operation_id=proposal.operation_id
      WHERE graph.workspace_id=$1 AND graph.lineage_id=$2 AND graph.document_id=$3 AND graph.lifecycle_generation=$4
      AND graph.schema_version=$5 AND proposal.proposal_id=ANY($6::text[])`,
    [scope.workspaceId, scope.lineageId, scope.documentId, scope.lifecycleGeneration, scope.schemaVersion, request.proposalIds])).rows);
    if (rows.length !== new Set(request.proposalIds).size) fail(Codes.sourceInvalid, 'An explicit proposal reference is unavailable in this document.');
    if (request.action !== 'read' && !fresh.permissions.canManageWorkspace
      && rows.some((row) => row.initiated_by_user_id !== identity.initiatedByUserId || row.actor_id !== identity.actorId)) {
      fail(Codes.accessDenied, 'This agent cannot manage another actor’s proposal.');
    }
  };
  const storage = createProposalGraphStorage({ database });
  const service = createProposalProvenanceService({ authorize,
    withTransaction: (requestedScope, action) => {
      sameScope(requestedScope);
      return storage.withLockedGraph(scope, {}, (graph, sql) => activeTransaction.run(sql, async () => {
        // Locks persist through graph+operation commit. They protect durable
        // identity/sequence, not in-memory room edits; those are compared below.
        const locked = await readScopedRow(sql, true);
        if (locked.lineage_id !== scope.lineageId) fail(Codes.staleLifecycle, 'Document lineage changed.');
        let expectedCurrent: ProposalCurrentProofV1 | null = null;
        const loadCurrent = async () => {
          const row = await readScopedRow(sql, true);
          if (row.lineage_id !== scope.lineageId || Number(row.document_sequence) !== Number(locked.document_sequence)) fail(Codes.currentChanged, 'Persisted document sequence changed during preparation.');
          const update = await readCurrentCollaborationDocument({ documentId: scope.documentId, workspaceId: scope.workspaceId,
            read: (doc) => Y.encodeStateAsUpdate(doc) });
          const current = proposalYjsCurrentProof({ update, representation: state.representation, revisionId: null });
          if (expectedCurrent && !isDeepStrictEqual(expectedCurrent, current)) fail(Codes.currentChanged, 'Live document changed during proposal preparation.');
          expectedCurrent ??= current;
          return { scope, representation: state.representation, revisionId: null, update };
        };
        const result = await action({ graph, loadCurrent,
          lookupOperation: async ({ idempotencyKey, requestDigest }) => {
            const row = (await sql.query<ExistingOperation>(`SELECT operation.operation_id,proposal.proposal_id,
              proposal.node_json->'relationships' AS authored_relationships,
              operation.actor_id,operation.initiated_by_user_id,operation.actor_session_id,operation.workspace_id,operation.organization_id,
              operation.document_path,operation.document_representation,operation.document_lifecycle_generation,operation.schema_version,
              operation.requested_mode,operation.operation_type,operation.file_edit_request_json,
              graph.workspace_id AS graph_workspace_id,graph.lineage_id,graph.document_id AS graph_document_id,
              graph.lifecycle_generation AS graph_generation,graph.schema_version AS graph_schema
              FROM collaboration_agent_operations operation LEFT JOIN file_change_proposals proposal ON proposal.operation_id=operation.operation_id
              LEFT JOIN file_proposal_graphs graph ON graph.graph_id=proposal.graph_id
              WHERE operation.document_id=$1 AND operation.initiated_by_user_id=$2 AND operation.idempotency_key=$3 LIMIT 1`,
            [scope.documentId, identity.initiatedByUserId, idempotencyKey])).rows[0];
            if (!row) return null;
            let receipt: { fingerprint?: unknown } | null = null;
            try { receipt = typeof row.file_edit_request_json === 'string' ? JSON.parse(row.file_edit_request_json) : row.file_edit_request_json; } catch { /* fail closed below */ }
            if (!row.proposal_id || !row.authored_relationships || row.graph_workspace_id !== scope.workspaceId || row.lineage_id !== scope.lineageId
              || row.graph_document_id !== scope.documentId || Number(row.graph_generation) !== scope.lifecycleGeneration || Number(row.graph_schema) !== scope.schemaVersion
              || row.workspace_id !== scope.workspaceId || row.organization_id !== state.organizationId
              || row.document_path !== input.path || row.document_representation !== state.representation
              || Number(row.document_lifecycle_generation) !== scope.lifecycleGeneration || Number(row.schema_version) !== scope.schemaVersion
              || row.actor_id !== identity.actorId || row.initiated_by_user_id !== identity.initiatedByUserId
              || row.actor_session_id !== (identity.actorSessionId ?? null) || row.operation_type !== 'apply' || row.requested_mode !== 'review'
              || receipt?.fingerprint !== requestDigest) fail(Codes.idempotencyMismatch, 'The operation retry does not match its exact scoped proposal request.');
            return { operationId: row.operation_id, proposalId: row.proposal_id, authoredRelationships: row.authored_relationships };
          },
          insertPreparedOperation: async (prepared) => {
            sameScope(prepared.scope);
            const fresh = await freshWorkspace(true);
            await loadCurrent();
            if (!isDeepStrictEqual(prepared.source.current, expectedCurrent) || prepared.representation !== state.representation || !prepared.reviewRequired) {
              fail(Codes.currentChanged, 'Prepared operation is not bound to the checked current document.');
            }
            await prepareProposalAgentOperation({ transaction: sql, operationId: prepared.operationId, documentId: scope.documentId,
              workspace: fresh, initiatedByUserId: identity.initiatedByUserId, actorId: identity.actorId, actorSessionId: identity.actorSessionId,
              idempotencyKey: prepared.idempotencyKey, targets: prepared.targets, documentPath: input.path,
              documentRepresentation: state.representation, documentLifecycleGeneration: scope.lifecycleGeneration, documentSchemaVersion: scope.schemaVersion,
              baseStateVector: prepared.sourceStateVector, baseDocumentSequence: Number(locked.document_sequence),
              fileEditRequest: { fingerprint: prepared.requestDigest, beforeSha256: prepared.beforeSha256, proposedSha256: prepared.proposedSha256 } });
          },
        });
        // Retry-only reads intentionally do not consult today's candidate. Any
        // newly evaluated/prepared content, however, must still match its read.
        if (expectedCurrent) await loadCurrent();
        return result;
      }));
    },
  });
  return { scope, state, service };
}
