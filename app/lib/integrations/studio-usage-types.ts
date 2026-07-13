export type StudioUsageMediaType = 'image' | 'video' | 'sound';

export type StudioUsageBreakdownBy = 'user' | 'provider' | 'model';

export type StudioUsageFilters = {
  from: Date;
  to: Date;
  userId?: string;
  provider?: string;
  model?: string;
  mediaType?: StudioUsageMediaType;
  status?: string;
};

export type SerializedStudioUsageFilters = {
  from: string;
  to: string;
  userId: string | null;
  provider: string | null;
  model: string | null;
  mediaType: StudioUsageMediaType | null;
  status: string | null;
};

export type StudioUsageTotals = {
  generationCount: number;
  completedGenerationCount: number;
  failedGenerationCount: number;
  outputCount: number;
  imageCount: number;
  videoCount: number;
  soundCount: number;
};

export type StudioUsageTimelineRow = {
  day: string;
  imageCount: number;
  videoCount: number;
  soundCount: number;
  outputCount: number;
};

export type StudioUsageBreakdownRow = {
  groupKey: string;
  label: string;
  outputCount: number;
  imageCount: number;
  videoCount: number;
  soundCount: number;
};

export type StudioUsageDashboardResponse = {
  filters: SerializedStudioUsageFilters;
  totals: StudioUsageTotals;
  timeline: StudioUsageTimelineRow[];
  breakdownBy: StudioUsageBreakdownBy;
  breakdown: StudioUsageBreakdownRow[];
};
