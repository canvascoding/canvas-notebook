import type { BrowserSessionSnapshot } from '@/app/lib/pi/browser/types';

export type RuntimeQueueItem = {
  id: string;
  text: string;
  attachmentCount: number;
  messageTimestamp?: number;
  signature?: string;
};

export type RuntimeCompactionStatus = {
  state: 'idle' | 'running' | 'succeeded' | 'no_op' | 'deferred' | 'failed' | 'aborted' | 'stale';
  attemptId: string | null;
  trigger: 'automatic' | 'manual' | 'automation' | null;
  reasonCode: string | null;
  retryAfter: string | null;
  omittedMessageCount: number;
};

export const IDLE_RUNTIME_COMPACTION_STATUS: RuntimeCompactionStatus = Object.freeze({
  state: 'idle',
  attemptId: null,
  trigger: null,
  reasonCode: null,
  retryAfter: null,
  omittedMessageCount: 0,
});

export type RuntimeCompactionTranslationKey =
  | 'compactionStatusRunning'
  | 'compactionStatusSucceeded'
  | 'compactionStatusNoop'
  | 'compactionStatusDeferred'
  | 'compactionStatusTooLarge'
  | 'compactionStatusAborted'
  | 'compactionStatusStale'
  | 'compactionStatusFailed';

export function getRuntimeCompactionStatusTranslationKey(
  status: RuntimeCompactionStatus | null | undefined,
): RuntimeCompactionTranslationKey | null {
  if (!status || status.state === 'idle') return null;
  if (status.state === 'running') return 'compactionStatusRunning';
  if (status.state === 'succeeded') return 'compactionStatusSucceeded';
  if (status.state === 'no_op') return 'compactionStatusNoop';
  if (status.reasonCode === 'fixed_context_too_large' || status.reasonCode === 'payload_bytes_exceeded') {
    return 'compactionStatusTooLarge';
  }
  if (status.state === 'deferred') return 'compactionStatusDeferred';
  if (status.state === 'aborted') return 'compactionStatusAborted';
  if (status.state === 'stale') return 'compactionStatusStale';
  return 'compactionStatusFailed';
}

export type RuntimeStatus = {
  sessionId: string;
  /** Server-assigned monotonic revision used to reject stale transport paths. */
  revision?: number;
  browser?: BrowserSessionSnapshot;
  phase: 'idle' | 'streaming' | 'running_tool' | 'aborting';
  activeTool: { toolCallId: string; name: string } | null;
  pendingToolCalls: number;
  followUpQueue: RuntimeQueueItem[];
  steeringQueue: RuntimeQueueItem[];
  canAbort: boolean;
  contextWindow: number;
  estimatedHistoryTokens: number;
  availableHistoryTokens: number;
  contextUsagePercent: number;
  /**
   * Exact final request size, including instructions, tools, normalized images,
   * output reserve, and safety margin. Null until a provider-ready payload has
   * been built for the current turn.
   */
  finalRequestTokens?: number | null;
  finalRequestBudgetExceeded?: boolean;
  /**
   * The provider-reported input usage for the most recently completed request.
   * This is an observed value, not a local token estimate.
   */
  lastProviderInputTokens?: number | null;
  lastProviderInputAt?: string | null;
  /**
   * Estimated size of the next fully serialized provider request. This uses the
   * exact payload shape, but token accounting remains an estimate.
   */
  nextRequestEstimatedTokens?: number | null;
  nextRequestBudgetExceeded?: boolean;
  includedSummary: boolean;
  omittedMessageCount: number;
  summaryUpdatedAt: string | null;
  lastCompactionAt: string | null;
  lastCompactionKind: 'manual' | 'automatic' | null;
  lastCompactionOmittedCount: number;
  compactionStatus?: RuntimeCompactionStatus;
};

export function isRuntimeStatusStale(current: RuntimeStatus | null, next: RuntimeStatus): boolean {
  if (!current || current.sessionId !== next.sessionId) return false;
  return (next.revision ?? 0) < (current.revision ?? 0);
}
