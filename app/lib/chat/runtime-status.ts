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
  cause?: 'manual' | 'threshold' | 'hard_limit' | 'provider_overflow' | 'idle' | 'automation' | null;
  reasonCode: string | null;
  retryAfter: string | null;
  omittedMessageCount: number;
  beforeTokens?: number | null;
  afterTokens?: number | null;
  triggerTokens?: number | null;
  targetTokens?: number | null;
  focusApplied?: boolean;
};

export const IDLE_RUNTIME_COMPACTION_STATUS: RuntimeCompactionStatus = Object.freeze({
  state: 'idle',
  attemptId: null,
  trigger: null,
  cause: null,
  reasonCode: null,
  retryAfter: null,
  omittedMessageCount: 0,
  beforeTokens: null,
  afterTokens: null,
  triggerTokens: null,
  targetTokens: null,
  focusApplied: false,
});

export type RuntimeCompactionTranslationKey =
  | 'compactionStatusRunning'
  | 'compactionStatusSucceeded'
  | 'compactionStatusNoop'
  | 'compactionStatusBelowTrigger'
  | 'compactionStatusNothingEligible'
  | 'compactionStatusActiveToolChain'
  | 'compactionStatusHistoryNotDurable'
  | 'compactionStatusDeferred'
  | 'compactionStatusCooldown'
  | 'compactionStatusBreaker'
  | 'compactionStatusAlreadyRunning'
  | 'compactionStatusTooLarge'
  | 'compactionStatusSummaryProviderError'
  | 'compactionStatusSummaryIdleTimeout'
  | 'compactionStatusSummaryTotalTimeout'
  | 'compactionStatusPersistenceConflict'
  | 'compactionStatusProviderOverflow'
  | 'compactionStatusAborted'
  | 'compactionStatusStale'
  | 'compactionStatusFailed';

export function getRuntimeCompactionStatusTranslationKey(
  status: RuntimeCompactionStatus | null | undefined,
): RuntimeCompactionTranslationKey | null {
  if (!status || status.state === 'idle') return null;
  if (status.state === 'running') return 'compactionStatusRunning';
  if (status.state === 'succeeded') return 'compactionStatusSucceeded';
  switch (status.reasonCode) {
    case 'soft_threshold_not_reached':
      return 'compactionStatusBelowTrigger';
    case 'nothing_eligible':
      return 'compactionStatusNothingEligible';
    case 'latest_unit_too_large':
    case 'fixed_context_too_large':
    case 'payload_bytes_exceeded':
      return 'compactionStatusTooLarge';
    case 'active_tool_chain':
      return 'compactionStatusActiveToolChain';
    case 'history_not_durable':
      return 'compactionStatusHistoryNotDurable';
    case 'cooldown_active':
      return 'compactionStatusCooldown';
    case 'breaker_active':
      return 'compactionStatusBreaker';
    case 'already_running':
      return 'compactionStatusAlreadyRunning';
    case 'summary_provider_error':
      return 'compactionStatusSummaryProviderError';
    case 'summary_idle_timeout':
    case 'summary_timeout':
      return 'compactionStatusSummaryIdleTimeout';
    case 'summary_total_timeout':
      return 'compactionStatusSummaryTotalTimeout';
    case 'persistence_conflict':
      return 'compactionStatusPersistenceConflict';
    case 'provider_context_overflow':
      return 'compactionStatusProviderOverflow';
    default:
      break;
  }
  if (status.state === 'no_op') return 'compactionStatusNoop';
  if (status.state === 'deferred') return 'compactionStatusDeferred';
  if (status.state === 'aborted') return 'compactionStatusAborted';
  if (status.state === 'stale') return 'compactionStatusStale';
  return 'compactionStatusFailed';
}

export type RuntimeCompactionCauseTranslationKey =
  | 'compactionCauseManual'
  | 'compactionCauseThreshold'
  | 'compactionCauseHardLimit'
  | 'compactionCauseProviderOverflow'
  | 'compactionCauseIdle'
  | 'compactionCauseAutomation';

export function getRuntimeCompactionCauseTranslationKey(
  cause: RuntimeCompactionStatus['cause'],
): RuntimeCompactionCauseTranslationKey | null {
  switch (cause) {
    case 'manual': return 'compactionCauseManual';
    case 'threshold': return 'compactionCauseThreshold';
    case 'hard_limit': return 'compactionCauseHardLimit';
    case 'provider_overflow': return 'compactionCauseProviderOverflow';
    case 'idle': return 'compactionCauseIdle';
    case 'automation': return 'compactionCauseAutomation';
    default: return null;
  }
}

export type RuntimeContextPressure = {
  /** Projected history pressure evaluated against the same trigger used by compaction. */
  pressureTokens: number;
  source: 'rough_estimate' | 'serialized_request';
  effectiveInputBudgetTokens: number;
  triggerTokens: number;
  targetTokens: number;
  percentOfTrigger: number;
};

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
  nextRequestEstimateSource?: 'rough_estimate' | 'serialized_request' | null;
  contextPressure?: RuntimeContextPressure;
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
