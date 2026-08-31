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
  /** Client-only marker for a phase shown before the runtime confirms it. */
  optimistic?: boolean;
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
  includedSummary: boolean;
  omittedMessageCount: number;
  summaryUpdatedAt: string | null;
  lastCompactionAt: string | null;
  lastCompactionKind: 'manual' | 'automatic' | null;
  lastCompactionOmittedCount: number;
  compactionStatus?: RuntimeCompactionStatus;
};

export function isConfirmedResponsePreparation(
  status: RuntimeStatus | null | undefined,
  assistantBubble: { present: boolean; hasVisibleOutput: boolean },
): boolean {
  return status?.phase === 'streaming'
    && status.optimistic !== true
    && assistantBubble.present
    && !assistantBubble.hasVisibleOutput;
}

export function isRuntimeStatusStale(current: RuntimeStatus | null, next: RuntimeStatus): boolean {
  if (!current || current.sessionId !== next.sessionId) return false;
  if (
    current.optimistic === true
    && current.phase === 'aborting'
    && next.phase !== 'aborting'
    && next.phase !== 'idle'
  ) {
    return true;
  }
  return (next.revision ?? 0) < (current.revision ?? 0);
}
