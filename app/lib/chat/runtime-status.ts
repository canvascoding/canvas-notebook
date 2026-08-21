import type { BrowserSessionSnapshot } from '@/app/lib/pi/browser/types';

export type RuntimeQueueItem = {
  id: string;
  text: string;
  attachmentCount: number;
  messageTimestamp?: number;
  signature?: string;
};

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
  includedSummary: boolean;
  omittedMessageCount: number;
  summaryUpdatedAt: string | null;
  lastCompactionAt: string | null;
  lastCompactionKind: 'manual' | 'automatic' | null;
  lastCompactionOmittedCount: number;
};

export function isRuntimeStatusStale(current: RuntimeStatus | null, next: RuntimeStatus): boolean {
  if (!current || current.sessionId !== next.sessionId) return false;
  return (next.revision ?? 0) < (current.revision ?? 0);
}
