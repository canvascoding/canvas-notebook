/** Public errors retain typed codes, never arbitrary exception text or private paths. */
export function workspaceOperationBatchErrorCode(error: unknown, fallback = 'BATCH_EXECUTION_FAILED'): string {
  if (error instanceof Error && error.name === 'WorkspacePreviewStaleError') return 'PREVIEW_STALE';
  const code = error && typeof error === 'object' && 'code' in error ? error.code
    : error instanceof Error ? error.message : null;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/u.test(code) ? code : fallback;
}

const conflicts = new Set(['PREVIEW_STALE', 'BATCH_PLAN_STALE', 'BATCH_SOURCE_CHANGED', 'BATCH_CHECKPOINT_STATE_CHANGED',
  'BATCH_UNPROVEN_PATH_STATE', 'BATCH_UNPROVEN_PATH_INTENT', 'BATCH_UNPROVEN_LINK_STATE', 'LINK_WRITE_STALE', 'LINK_WRITE_STALE_DOCUMENT',
  'COLLABORATION_DOCUMENT_MISMATCH', 'COLLABORATION_LIFECYCLE_STALE', 'COLLABORATION_REPRESENTATION_MISMATCH']);

export function workspaceOperationBatchFailureStatus(code: string, mutationIntent: boolean): 'needs_review' | 'needs_recovery' | 'failed' {
  if (mutationIntent) return 'needs_recovery';
  return conflicts.has(code) ? 'needs_review' : 'failed';
}

/** A readable pristine journal proves no intent; absence alone does not. */
export type WorkspaceOperationBatchMutationEvidence = 'absent' | 'pristine' | 'started' | 'complete';
