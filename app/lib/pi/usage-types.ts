export type UsageSummaryGroupBy = 'day' | 'provider' | 'model' | 'user' | 'session';

export type UsageFilters = {
  from: Date;
  to: Date;
  provider?: string;
  model?: string;
  sessionId?: string;
  sessionQuery?: string;
  stopReason?: string;
  groupBy: UsageSummaryGroupBy;
  userId?: string;
};

export type UsageTotals = {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  sessionCount: number;
  eventCount: number;
};

export type UsageSummaryRow = {
  groupKey: string;
  label: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  sessionCount: number;
  eventCount: number;
};

export type SerializedUsageFilters = {
  from: string;
  to: string;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  sessionQuery: string | null;
  stopReason: string | null;
  groupBy: UsageSummaryGroupBy;
  userId: string | null;
};

export type UsageSummaryResponse = {
  filters: SerializedUsageFilters;
  totals: UsageTotals;
  rows: UsageSummaryRow[];
};

export type UsageEventRow = {
  id: number;
  userId: string;
  userLabel: string;
  sessionId: string;
  sessionTitleSnapshot: string | null;
  provider: string;
  model: string;
  stopReason: string;
  assistantTimestamp: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalCost: number;
};

export type UsageEventsResponse = {
  filters: SerializedUsageFilters;
  page: number;
  pageSize: number;
  totalRows: number;
  rows: UsageEventRow[];
};
