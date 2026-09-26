import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceContext } from '../workspaces/types';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from './contracts/proposal-graph-v1';
import { parseProposalReviewSummaryRequestV1, parseProposalReviewSummaryResponseV1,
  type ProposalReviewSummaryRequestV1, type ProposalReviewSummaryResponseV1 } from './contracts/proposal-review-summary-v1';
import { createRuntimeFileVersionCenterDatabase } from './database';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from './query-service';
import { createRuntimeProposalReviewService } from './proposal-review-runtime';
import { selectProposalReviewSession, type ProposalReviewSessionDependencies } from './proposal-review-session';
import { resolveFileVersionRolloutV1 } from './policy-v1';

/** Refresh visible card state without preparing actions or sending document content. */
export async function readProposalReviewSummary(input: {
  request: ProposalReviewSummaryRequestV1; target: ResolvedFileVersionTarget;
  workspace: WorkspaceContext; access: FileVersionCenterAccess;
  dependencies?: Pick<ProposalReviewSessionDependencies, 'database' | 'createReview' | 'now'>;
}): Promise<ProposalReviewSummaryResponseV1> {
  const { request, target, workspace, access, dependencies: deps } = input;
  parseProposalReviewSummaryRequestV1(request);
  if (!resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).compare) {
    throw new ProposalGraphContractError(Codes.upgradeRequired, 'Proposal summaries are not enabled.');
  }
  const database = deps?.database ?? createRuntimeFileVersionCenterDatabase();
  let review: Awaited<ReturnType<typeof createRuntimeProposalReviewService>> | null = null;
  let current: ProposalReviewSummaryResponseV1['current'] = null;
  let graphRevision: number | null = null;
  const items: ProposalReviewSummaryResponseV1['items'] = [];
  for (const operationId of request.operationIds) {
    const selection = await selectProposalReviewSession({ selection: { kind: 'operation', operationId },
      target, workspace, access, database });
    if (selection.kind === 'legacy') {
      items.push({ mode: 'legacy', operationId });
      continue;
    }
    review ??= await (deps?.createReview ?? createRuntimeProposalReviewService)({ target, workspace, access });
    const result = await review.evaluateSelection({ selectedProposalIds: selection.proposalIds });
    if (result.graphRevision !== null) {
      if (graphRevision !== null && graphRevision !== result.graphRevision) {
        throw new ProposalGraphContractError(Codes.graphChanged, 'The graph changed while refreshing review cards.');
      }
      graphRevision = result.graphRevision;
    }
    if (result.current) {
      if (current && !isDeepStrictEqual(current, result.current)) {
        throw new ProposalGraphContractError(Codes.currentChanged, 'The document changed while refreshing review cards.');
      }
      current = result.current;
    }
    const context = result.graphRevision === null ? null : await review.readContext({
      selectedProposalIds: selection.proposalIds, expectedGraphRevision: result.graphRevision,
    });
    const proposal = context?.proposals.find(node => node.proposalId === selection.proposalIds[0]
      && node.operationId === operationId) ?? null;
    items.push({ mode: 'graph', operationId, proposal,
      status: proposal ? result.status : 'unavailable',
      reasonCode: proposal ? result.reasonCode : context?.reasonCode ?? result.reasonCode ?? Codes.contentUnavailable });
  }
  return parseProposalReviewSummaryResponseV1({ contractVersion: 1,
    target: { workspaceId: target.workspaceId, lineageId: target.lineageId, documentId: target.documentId ?? null },
    current, graphRevision, items, checkedAt: (deps?.now ?? Date.now)() });
}
