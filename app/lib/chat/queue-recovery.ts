import type { RuntimeQueueItem } from './runtime-status';

export type ChatQueueBlocker = {
  clientMessageId: string;
  reason: 'legacy' | 'unknown_queue_position' | 'outcome_unknown' | 'execution_in_progress';
};

/** Public presentation only. No execution handles, private targets or tokens. */
export type ChatQueueRecoveryStatus = {
  sessionId: string;
  items: RuntimeQueueItem[];
  blocked: readonly ChatQueueBlocker[];
};
