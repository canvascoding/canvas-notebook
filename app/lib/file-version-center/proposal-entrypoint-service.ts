import 'server-only';

import type { WorkspaceContext } from '../workspaces/types';
import { parseProposalEntryPointV1, type ProposalEntryPointV1 } from './contracts/proposal-entrypoint-v1';
import type { ProposalLifecycleV1 } from './contracts/proposal-graph-v1';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase } from './database';
import { fileVersionCenterQueryService, type FileVersionCenterAccess } from './query-service';
import { readProposalReviewSummary } from './proposal-review-summary';

type SuccessorRow = {
  proposal_id: string;
  operation_id: string;
  lifecycle: ProposalLifecycleV1;
  relation: 'extends' | 'replaces';
};

export type ProposalEntryPointReadInput = {
  workspace: WorkspaceContext;
  access: FileVersionCenterAccess;
  lineageId: string;
  operationId: string;
};

/** Reuses the review evaluator, and discloses only explicitly authorized successor identities. */
export async function readProposalEntryPoint(input: ProposalEntryPointReadInput, dependencies: {
  database?: FileVersionCenterDatabase;
  resolve?: typeof fileVersionCenterQueryService.resolve;
  summary?: typeof readProposalReviewSummary;
} = {}): Promise<ProposalEntryPointV1 | null> {
  const targetRequest = { kind: 'lineage' as const, workspaceId: input.workspace.workspaceId, lineageId: input.lineageId };
  const target = await (dependencies.resolve ?? fileVersionCenterQueryService.resolve)({
    target: targetRequest, access: input.access,
  });
  const summary = await (dependencies.summary ?? readProposalReviewSummary)({
    request: { contractVersion: 1, target: targetRequest, operationIds: [input.operationId] },
    target, workspace: input.workspace, access: input.access,
  });
  const item = summary.items.find(value => value.operationId === input.operationId);
  if (!item || item.mode === 'legacy') return null;
  if (!item.proposal || summary.graphRevision === null) throw new Error('Proposal entry-point context is unavailable.');
  const database = dependencies.database ?? createRuntimeFileVersionCenterDatabase();
  // Never choose the newest successor. Return every bounded direct choice, with
  // a visible overflow indicator; opening any reference reauthorizes it again.
  const rows = await database.transaction(async sql => {
    const graph = (await sql.query<{ graph_id: string; graph_revision: number | string }>(`
      SELECT graph.graph_id, graph.graph_revision FROM file_proposal_graphs graph
      JOIN file_change_proposals original ON original.graph_id=graph.graph_id AND original.operation_id=$4
      JOIN collaboration_yjs_states state ON state.document_id=graph.document_id AND state.workspace_id=graph.workspace_id
        AND state.lifecycle_generation=graph.lifecycle_generation AND state.schema_version=graph.schema_version
      WHERE graph.workspace_id=$1 AND graph.lineage_id=$2 AND graph.document_id=$3
        AND original.proposal_id=$5 AND state.status='active'
      FOR SHARE OF graph`,
    [target.workspaceId, target.lineageId, target.documentId, input.operationId, item.proposal!.proposalId])).rows[0];
    if (!graph || Number(graph.graph_revision) !== summary.graphRevision) throw new Error('Proposal entry-point graph changed.');
    return (await sql.query<SuccessorRow>(`
      SELECT successor.proposal_id, successor.operation_id, successor.lifecycle,
        CASE WHEN successor.replaces_proposal_id=$2 THEN 'replaces' ELSE 'extends' END AS relation
      FROM file_change_proposals successor
      JOIN collaboration_agent_operations operation ON operation.operation_id=successor.operation_id
        AND operation.workspace_id=$3 AND operation.document_id=$4
      WHERE successor.graph_id=$1
        AND (successor.replaces_proposal_id=$2 OR successor.dependency_proposal_id=$2)
        AND (operation.initiated_by_user_id=$5 OR $6::boolean)
      ORDER BY successor.created_at, successor.proposal_id LIMIT 33`,
    [graph.graph_id, item.proposal!.proposalId, target.workspaceId, target.documentId,
      input.access.userId, Boolean(input.access.canManageWorkspace && input.workspace.permissions.canManageWorkspace)])).rows;
  });
  return parseProposalEntryPointV1({ contractVersion: 1,
    proposalId: item.proposal.proposalId, rootProposalId: item.proposal.rootProposalId,
    lineageId: target.lineageId, graphRevision: summary.graphRevision,
    lifecycle: item.proposal.lifecycle, status: item.status,
    successors: rows.slice(0, 32).map(row => ({ proposalId: row.proposal_id, operationId: row.operation_id,
      relation: row.relation, lifecycle: row.lifecycle })),
    moreSuccessors: rows.length > 32,
  });
}
