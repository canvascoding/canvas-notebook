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
  proposalVersion?: string | null;
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
    blockId?: string | null;
  }>;
};

export type CollaborationAgentOperationAction = 'accept' | 'reject' | 'cancel' | 'revert';

export function canAcceptCollaborationAgentOperation(operation: CollaborationAgentOperation): boolean {
  return operation.actionsAllowed
    && (operation.operationStatus === 'needs_review' || operation.operationStatus === 'partially_applied')
    && typeof operation.proposalVersion === 'string' && /^v1\.[a-f0-9]{64}$/u.test(operation.proposalVersion);
}

export function prepareCollaborationAgentAction(
  operation: CollaborationAgentOperation,
  action: CollaborationAgentOperationAction,
  actionKeys: Map<string, string>,
  createKey: () => string = () => crypto.randomUUID(),
): { key: string; body: { idempotencyKey: string; proposalVersion?: string } } | null {
  if (!operation.actionsAllowed || (action === 'accept' && !canAcceptCollaborationAgentOperation(operation))) return null;
  const key = `${operation.operationId}:${action}:${operation.proposalVersion ?? ''}`;
  const idempotencyKey = actionKeys.get(key) || createKey();
  actionKeys.set(key, idempotencyKey);
  return { key, body: { idempotencyKey, ...(action === 'accept' ? { proposalVersion: operation.proposalVersion! } : {}) } };
}

export function collaborationAgentAcceptanceOutcome(value: unknown): 'accepted' | 'review' | 'pending' | 'failed' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'failed';
  const operation = value as Partial<CollaborationAgentOperation>;
  if (!Array.isArray(operation.conflicts)) return 'failed';
  if (operation.conflicts.length > 0 || ['needs_review', 'partially_applied', 'semantic_conflict'].includes(operation.operationStatus ?? '')
    || ['needs_review', 'partially_applied', 'semantic_conflict'].includes(operation.status ?? '')) return 'review';
  if (['persisted_yjs', 'checkpointed_file', 'reverted'].includes(operation.operationStatus ?? '')
    && (operation.durability === 'persisted_yjs' || operation.durability === 'checkpointed_file')) return 'accepted';
  if (['preparing', 'ready', 'applying', 'applied_to_ydoc'].includes(operation.operationStatus ?? '')) return 'pending';
  return 'failed';
}

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
