import 'server-only';

import { randomUUID } from 'node:crypto';
import type { WorkspaceContext } from '../workspaces/types';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, PROPOSAL_GRAPH_LIMITS, ProposalGraphContractError } from './contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1, type ProposalReviewGraphSessionV1, type ProposalReviewSessionRequestV1,
  type ProposalReviewSessionResponseV1 } from './contracts/proposal-review-session-v1';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase } from './database';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from './query-service';
import { createRuntimeProposalReviewService } from './proposal-review-runtime';
import { createRuntimeProposalReviewActionService } from './proposal-review-action-runtime';
import { proposalReviewWritesEnabled } from './proposal-review-capability';
import { resolveFileVersionRolloutV1 } from './policy-v1';
import { proposalReviewBuildMarker } from './proposal-review-build-marker';

type SelectionRow = { operation_id: string; proposal_id: string | null };
type ReviewService = Awaited<ReturnType<typeof createRuntimeProposalReviewService>>;
type ActionService = Awaited<ReturnType<typeof createRuntimeProposalReviewActionService>>;
export type ProposalReviewSessionDependencies = {
  database?: FileVersionCenterDatabase;
  createReview?: typeof createRuntimeProposalReviewService;
  createActions?: typeof createRuntimeProposalReviewActionService;
  writesEnabled?: () => boolean;
  now?: () => number;
  correlationId?: () => string;
};

/** Resolve the entire authorized selection, not the currently visible timeline page. */
export async function selectProposalReviewSession(input: {
  selection: ProposalReviewSessionRequestV1['selection']; target: ResolvedFileVersionTarget;
  access: FileVersionCenterAccess; workspace: WorkspaceContext; database: FileVersionCenterDatabase;
}): Promise<{ kind: 'legacy' } | { kind: 'graph'; proposalIds: string[] }> {
  const { selection, target, workspace, access } = input;
  if (!access.canRead || access.membership !== 'active' || !access.permissionsResolved || !workspace.permissions.canRead
    || workspace.legacy || target.workspaceId !== workspace.workspaceId || access.requestedWorkspaceId !== workspace.workspaceId
    || access.authenticatedWorkspaceId !== workspace.workspaceId) {
    throw new ProposalGraphContractError(Codes.accessDenied, 'Proposal selection is not authorized.');
  }
  // Explicit IDs are reauthorized (including dependencies) by the read runtime.
  if (selection.kind === 'proposals') return { kind: 'graph', proposalIds: [...selection.proposalIds] };
  if (!target.documentId) {
    if (selection.kind === 'operation') return { kind: 'legacy' };
    throw new ProposalGraphContractError(Codes.contentUnavailable, 'This document has no collaborative proposal graph.');
  }
  const manage = Boolean(access.canManageWorkspace && workspace.permissions.canManageWorkspace);
  const rows = await input.database.transaction(async sql => (await sql.query<SelectionRow>(`
    SELECT operation.operation_id, proposal.proposal_id
    FROM collaboration_agent_operations operation
    JOIN collaboration_documents document ON document.id=operation.document_id AND document.workspace_id=operation.workspace_id
    LEFT JOIN file_change_proposals proposal ON proposal.operation_id=operation.operation_id
    WHERE operation.workspace_id=$1 AND document.lineage_id=$2 AND document.id=$3 AND document.status='active'
      AND (operation.initiated_by_user_id=$4 OR $5::boolean)
      AND ($6::text IS NULL OR operation.operation_id=$6)
      AND ($6::text IS NOT NULL OR proposal.lifecycle='open' OR (proposal.proposal_id IS NULL
        AND operation.status IN ('needs_review','partially_applied','semantic_conflict')))
    ORDER BY operation.created_at,operation.operation_id LIMIT $7`,
  [target.workspaceId, target.lineageId, target.documentId, access.userId, manage,
    selection.kind === 'operation' ? selection.operationId : null, PROPOSAL_GRAPH_LIMITS.batchMembers + 1])).rows);
  if (rows.length > PROPOSAL_GRAPH_LIMITS.batchMembers) {
    throw new ProposalGraphContractError(Codes.limitExceeded, 'The full proposal selection exceeds the review limit; no subset was selected.');
  }
  if (!rows.length) throw new ProposalGraphContractError(Codes.sourceInvalid, 'No selected proposals are available.');
  if (selection.kind === 'operation' && rows.length === 1 && rows[0]!.proposal_id === null) return { kind: 'legacy' };
  if (rows.some(row => row.proposal_id === null)) {
    throw new ProposalGraphContractError(Codes.legacyBlocked, 'The complete selection includes proposals without graph provenance.');
  }
  return { kind: 'graph', proposalIds: rows.map(row => row.proposal_id!) };
}

/** Read, evaluate and prepare approval for the same immutable selection. Never applies content. */
export async function readProposalReviewSession(input: {
  request: ProposalReviewSessionRequestV1; target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext; access: FileVersionCenterAccess; dependencies?: ProposalReviewSessionDependencies;
}): Promise<ProposalReviewSessionResponseV1> {
  const { request, target, workspace, access } = input;
  const deps = input.dependencies ?? {};
  const rollout = resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE);
  if (!rollout.compare) throw new ProposalGraphContractError(Codes.upgradeRequired, 'Proposal review is not available in this rollout mode.');
  const selection = await selectProposalReviewSession({ selection: request.selection, target, workspace, access,
    database: deps.database ?? createRuntimeFileVersionCenterDatabase() });
  if (selection.kind === 'legacy') return { contractVersion: 1, mode: 'legacy' };
  const review: ReviewService = await (deps.createReview ?? createRuntimeProposalReviewService)({ target, workspace, access });
  const result = await review.evaluateSelection({ selectedProposalIds: selection.proposalIds });
  const binding = result.evaluation && result.selectionHash && result.current && result.graphRevision !== null ? {
    evaluationId: result.evaluation.evaluationId, selectionHash: result.selectionHash,
    selectedProposalIds: [...result.selectedProposalIds], current: result.current, graphRevision: result.graphRevision,
  } : undefined;
  const compare = binding ? await review.createCompareService().compare({ selectedProposalIds: selection.proposalIds, binding }) : null;
  const context = result.graphRevision !== null ? await review.readContext({
    selectedProposalIds: selection.proposalIds, expectedGraphRevision: result.graphRevision,
  }) : undefined;
  const canWrite = rollout.restore && (deps.writesEnabled ?? proposalReviewWritesEnabled)() && Boolean(access.canWrite && workspace.permissions.canWrite);
  const actions: ProposalReviewGraphSessionV1['actions'] = {};
  const selectedAreOpen = Boolean(context && selection.proposalIds.every(id =>
    context.proposals.some(proposal => proposal.proposalId === id && proposal.lifecycle === 'open')));
  // Historical links keep their exact proposal identity. Closed selections are
  // readable, but cannot prepare fresh reject/accept permissions or be reopened.
  if (canWrite && selectedAreOpen) {
    const service: ActionService = await (deps.createActions ?? createRuntimeProposalReviewActionService)({ target, workspace, access });
    if (compare?.diagnosis.availability === 'available' && binding) {
      if (result.actionability === 'accept') {
        actions.accept = await service.prepare({ selectedProposalIds: selection.proposalIds,
          actionType: selection.proposalIds.length > 1 ? 'batch_accept' : 'accept', binding });
      } else if (result.actionability === 'complete_satisfied' && selection.proposalIds.length === 1) {
        actions.completeSatisfied = await service.prepare({ selectedProposalIds: selection.proposalIds, actionType: 'complete_satisfied', binding });
      }
    }
    if (selection.proposalIds.length === 1) {
      actions.reject = await service.prepare({ selectedProposalIds: selection.proposalIds, actionType: 'reject' });
      // Rejecting a whole branch requires fresh permission for every affected
      // descendant. An inaccessible sibling must not hide the selected diff.
      try {
        const branch = await service.prepare({ selectedProposalIds: selection.proposalIds, actionType: 'branch_reject' });
        if (branch.fence.closure.length > 1) actions.branchReject = branch;
      } catch (error) {
        if (!(error instanceof ProposalGraphContractError)
          || ![Codes.accessDenied, Codes.invalidTransition].includes(error.code as typeof Codes.accessDenied)) throw error;
      }
    }
  }
  if (context && Object.values(actions).some(action => action?.fence.graphRevision !== context.graphRevision)) {
    throw new ProposalGraphContractError(Codes.graphChanged, 'The graph changed while preparing the displayed approval.');
  }
  const reasonCode = compare?.diagnosis.reasonCode ?? result.reasonCode;
  return parseProposalReviewSessionResponseV1({ contractVersion: 1, mode: 'graph',
    target: { kind: 'document', workspaceId: target.workspaceId, lineageId: target.lineageId, documentId: target.documentId },
    selectedProposalIds: selection.proposalIds, status: result.status, reasonCode, compare, context, actions, capability: { write: canWrite },
    diagnosis: { reasonCode, phase: 'review', correlationId: (deps.correlationId ?? randomUUID)(), timestamp: (deps.now ?? Date.now)(), buildMarker: proposalReviewBuildMarker() },
  });
}
