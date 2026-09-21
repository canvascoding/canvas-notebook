import 'server-only';

import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import type { PersistedCollaborationState } from '@/app/lib/collaboration/persistence';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase } from './database';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError, type ProposalDocumentScopeV1 } from './contracts/proposal-graph-v1';
import { projectProposalReviewPage } from './proposal-review-projection-service';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from './query-service';
import { loadStoredProposalGraph } from './proposal-storage-projection';
import type { ProposalReviewProjectionRequestV1 } from './contracts/proposal-review-api-v1';

function fail(code: typeof Codes[keyof typeof Codes], message: string): never { throw new ProposalGraphContractError(code, message); }

export async function readProposalReviewProjection(input: {
  request: ProposalReviewProjectionRequestV1;
  target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext;
  access: FileVersionCenterAccess;
  database?: FileVersionCenterDatabase;
  loadState?: (documentId: string) => Promise<PersistedCollaborationState | null>;
  loadGraph?: typeof loadStoredProposalGraph;
}) {
  const { request, target, workspace, access } = input;
  if (!access.canRead || access.membership !== 'active' || !access.permissionsResolved || !workspace.permissions.canRead
    || request.target.workspaceId !== workspace.workspaceId || target.workspaceId !== workspace.workspaceId
    || target.documentId !== request.target.documentId || target.lineageId !== request.target.lineageId || !target.documentId) {
    fail(Codes.accessDenied, 'The proposal projection is not available in this workspace.');
  }
  const state = await (input.loadState ?? loadCollaborationState)(target.documentId);
  if (!state || state.workspaceId !== workspace.workspaceId || state.organizationId !== (workspace.organizationId ?? null)
    || state.path !== target.path || state.status !== 'active' || state.degraded
    || !Number.isSafeInteger(state.lifecycleGeneration) || state.lifecycleGeneration < 1
    || !Number.isSafeInteger(state.schemaVersion) || state.schemaVersion < 1) {
    fail(Codes.staleLifecycle, 'The collaborative document lifecycle is no longer active.');
  }
  const scope: ProposalDocumentScopeV1 = { workspaceId: workspace.workspaceId, lineageId: target.lineageId, documentId: target.documentId,
    lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion };
  const database = input.database ?? createRuntimeFileVersionCenterDatabase();
  return database.transaction(async (db) => {
    const graph = (await db.query<{ graph_id: string; graph_revision: number | string }>(`SELECT graph_id,graph_revision FROM file_proposal_graphs
      WHERE workspace_id=$1 AND lineage_id=$2 AND document_id=$3 AND lifecycle_generation=$4 AND schema_version=$5`,
    [scope.workspaceId, scope.lineageId, scope.documentId, scope.lifecycleGeneration, scope.schemaVersion])).rows[0];
    if (!graph) fail(Codes.sourceInvalid, 'The proposal graph is unavailable for this document.');
    const snapshot = await (input.loadGraph ?? loadStoredProposalGraph)(db, graph.graph_id, scope, Number(graph.graph_revision), { includeProposalIds: request.selectedProposalIds });
    const owners = (await db.query<{ proposal_id: string; initiated_by_user_id: string }>(`SELECT p.proposal_id,o.initiated_by_user_id
      FROM file_change_proposals p JOIN collaboration_agent_operations o ON o.operation_id=p.operation_id
      WHERE p.graph_id=$1 AND p.proposal_id=ANY($2::text[])`, [graph.graph_id, snapshot.nodes.map((node) => node.proposalId)])).rows;
    const visible = access.canManageWorkspace && workspace.permissions.canManageWorkspace
      ? snapshot.nodes.map((node) => node.proposalId)
      : owners.filter((row) => row.initiated_by_user_id === access.userId).map((row) => row.proposal_id);
    const page = projectProposalReviewPage({ graph: { ...snapshot, graphRevision: Number(graph.graph_revision) },
      permission: { canRead: true, canWrite: Boolean(access.canWrite), canManage: Boolean(access.canManageWorkspace && workspace.permissions.canManageWorkspace),
        ownedProposalIds: visible, readableProposalIds: visible }, selectedProposalIds: request.selectedProposalIds,
      rootProposalId: request.rootProposalId, cursor: request.cursor ?? null, limit: request.limit });
    return page;
  });
}
