import type { ProposalReviewActionApiRequestV1, ProposalReviewActionStatusRequestV1,
  ProposalReviewActionStatusResponseV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';
import { ProposalReviewClientError, readProposalReviewActionStatus,
  readProposalReviewSession } from '@/app/lib/file-version-center/proposal-review-client';

export function isConcurrentGraphReviewRejection(error: unknown): boolean {
  return error instanceof ProposalReviewClientError && error.status === 409 && error.diagnosis.phase === 'action'
    && (error.code === 'PROPOSAL_GRAPH_CHANGED' || error.code === 'PROPOSAL_RECOVERY_REQUIRED');
}

/** Read-only proof: an obsolete, unreserved action can no longer acquire its old fence. */
export async function readGraphReviewActionResolution(identity: ProposalReviewActionStatusRequestV1,
  action: ProposalReviewActionApiRequestV1 | null, error: unknown, signal: AbortSignal,
): Promise<ProposalReviewActionStatusResponseV1 & { supersededWithoutReservation: boolean }> {
  let superseded = false;
  if (action && isConcurrentGraphReviewRejection(error)
    && action.action.idempotencyKey === identity.idempotencyKey
    && action.action.fence.requestDigest === identity.requestDigest
    && JSON.stringify(action.target) === JSON.stringify(identity.target)) {
    try {
      const { fence } = action.action;
      const fresh = await readProposalReviewSession({ contractVersion: 1, target: action.target,
        selection: { kind: 'proposals', proposalIds: fence.selectedProposalIds } }, signal);
      const context = fresh.mode === 'graph' ? fresh.context : undefined;
      const scope = context?.scope;
      superseded = Boolean(scope && context && context.graphRevision > fence.graphRevision
        && scope.workspaceId === fence.scope.workspaceId && scope.lineageId === fence.scope.lineageId
        && scope.documentId === fence.scope.documentId && scope.lifecycleGeneration === fence.scope.lifecycleGeneration
        && scope.schemaVersion === fence.scope.schemaVersion);
    } catch (error) {
      if (signal.aborted) throw error;
      // A failed/legacy read is not proof. Ordinary receipt recovery is still allowed.
    }
  }
  signal.throwIfAborted();
  // Order matters: status must be read AFTER the newer graph. A reservation
  // preceding that proof is visible here; a later copy cannot pass the old fence.
  const status = await readProposalReviewActionStatus(identity, signal);
  return { ...status, supersededWithoutReservation: superseded && status.receipt === null };
}
