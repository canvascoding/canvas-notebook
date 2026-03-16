export type RuntimeQueueItem = {
  id: string;
  text: string;
  attachmentCount: number;
};

export type RuntimeStatus = {
  sessionId: string;
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
