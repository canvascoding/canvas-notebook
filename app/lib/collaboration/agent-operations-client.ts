export type CollaborationAgentOperationStatus =
  | 'preparing'
  | 'ready'
  | 'applying'
  | 'applied_to_ydoc'
  | 'persisted_yjs'
  | 'checkpointed_file'
  | 'partially_applied'
  | 'needs_review'
  | 'semantic_conflict'
  | 'cancel_requested'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'failed'
  | 'rejected'
  | 'reverted';

export type CollaborationAgentOperation = {
  operationId: string;
  operationStatus: CollaborationAgentOperationStatus;
  status: 'applied_to_ydoc' | 'partially_applied' | 'needs_review' | 'semantic_conflict';
  durability: 'pending' | 'applied_to_ydoc' | 'persisted_yjs' | 'checkpointed_file' | 'needs_review';
  actorId: string;
  initiatedByDisplayName?: string;
  initiatedByCurrentUser?: boolean;
  actionsAllowed: boolean;
  appliedTargetIds: string[];
  conflicts: Array<{ targetId: string; groupId: string; code: string }>;
  reviewTargets?: Array<{
    targetId: string;
    groupId: string;
    proposedReplacement: string;
    currentText: string | null;
  }>;
  targetAnchors: Array<{
    targetId: string;
    groupId: string;
    startAnchor: string;
    endAnchor: string;
  }>;
};

interface LoadCollaborationAgentOperationsOptions {
  documentId: string;
  headers: HeadersInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function loadCollaborationAgentOperations({
  documentId,
  headers,
  signal,
  fetchImpl = fetch,
}: LoadCollaborationAgentOperationsOptions): Promise<CollaborationAgentOperation[] | null> {
  try {
    const response = await fetchImpl(
      `/api/files/collaboration/operations?documentId=${encodeURIComponent(documentId)}`,
      { headers, cache: 'no-store', signal },
    );
    if (!response.ok || signal?.aborted) return null;
    const payload = await response.json() as { operations?: unknown };
    if (signal?.aborted) return null;
    return Array.isArray(payload.operations)
      ? (payload.operations as CollaborationAgentOperation[]).slice(0, 20)
      : [];
  } catch {
    // Polling is best-effort. Mobile browsers commonly reject fetches while the
    // app is backgrounded or changing networks; the next interval will retry.
    return null;
  }
}
