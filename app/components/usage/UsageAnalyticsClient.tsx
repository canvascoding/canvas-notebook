'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import {
  ChevronDown,
  ChevronRight,
  Filter,
  Layers3,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type {
  UsageDashboardResponse,
  UsageEventsResponse,
  UsageSummaryGroupBy,
  UsageSummaryRow,
  UsageSummaryResponse,
  UsageUserOption,
  UsageUsersResponse,
} from '@/app/lib/pi/usage-types';
import type {
  StudioUsageDashboardResponse,
  StudioUsageMediaType,
} from '@/app/lib/integrations/studio-usage-types';
import { MEMORY_MANAGER_AGENT_ID } from '@/app/lib/memory/constants';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

type FilterState = {
  from: string;
  to: string;
  provider: string;
  model: string;
  sessionQuery: string;
  stopReason: string;
  workspaceType: string;
  agentId: string;
  studioMediaType: StudioUsageMediaType | '';
  studioStatus: string;
  groupBy: UsageSummaryGroupBy;
  userId: string;
};

type UsageAnalyticsClientProps = {
  isAdmin: boolean;
};

type NumericValue = number | string | ReadonlyArray<number | string> | null | undefined;

type UsageTooltipProps = {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{
    dataKey?: unknown;
    color?: string;
    name?: string | number;
    value?: NumericValue;
  }>;
};

const FILTER_FIELD_CLASS_NAME = 'min-w-0 space-y-1.5 text-sm';
const FILTER_LABEL_CLASS_NAME = 'block truncate text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted-foreground';
const FILTER_SELECT_CLASS_NAME = 'flex h-10 w-full min-w-0 max-w-full border border-border bg-background px-3 text-base outline-none transition-colors focus:border-primary sm:text-sm';

const tokenChartConfig = {
  input: { label: 'Input', color: 'var(--chart-1)' },
  output: { label: 'Output', color: 'var(--chart-2)' },
  cache: { label: 'Cache', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const breakdownChartConfig = {
  tokens: { label: 'Tokens', color: 'var(--chart-4)' },
} satisfies ChartConfig;

const studioChartConfig = {
  image: { label: 'Images', color: 'var(--chart-1)' },
  video: { label: 'Videos', color: 'var(--chart-2)' },
  sound: { label: 'Sound', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const studioBreakdownChartConfig = {
  outputs: { label: 'Outputs', color: 'var(--chart-5)' },
} satisfies ChartConfig;

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function createDefaultFilters(): FilterState {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 29);
  return {
    from: formatDateInput(from),
    to: formatDateInput(now),
    provider: '',
    model: '',
    sessionQuery: '',
    stopReason: '',
    workspaceType: '',
    agentId: '',
    studioMediaType: '',
    studioStatus: '',
    groupBy: 'day',
    userId: '',
  };
}

function buildQueryString(filters: FilterState, page = 1, pageSize = 50): string {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    groupBy: filters.groupBy,
    page: String(page),
    pageSize: String(pageSize),
  });

  if (filters.provider) params.set('provider', filters.provider);
  if (filters.model) params.set('model', filters.model);
  if (filters.sessionQuery) params.set('sessionQuery', filters.sessionQuery);
  if (filters.stopReason) params.set('stopReason', filters.stopReason);
  if (filters.workspaceType) params.set('workspaceType', filters.workspaceType);
  if (filters.agentId) params.set('agentId', filters.agentId);
  if (filters.studioMediaType) params.set('studioMediaType', filters.studioMediaType);
  if (filters.studioStatus) params.set('studioStatus', filters.studioStatus);
  if (filters.userId) params.set('userId', filters.userId);

  return params.toString();
}

function buildUsersQueryString(filters: FilterState): string {
  const { userId: _userId, groupBy: _groupBy, ...userFilters } = filters;
  return buildQueryString({ ...userFilters, userId: '', groupBy: 'day' });
}

function safeNumber(value: NumericValue): number {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const numberValue = typeof normalizedValue === 'number' ? normalizedValue : Number(normalizedValue);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function shortenLabel(value: string, maxLength = 16): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle: string;
}) {
  return (
    <Card className="min-w-0 gap-0 border-border/70 bg-card/95 py-0 shadow-none">
      <CardContent className="space-y-1 px-4 py-4 sm:px-5">
        <div className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
        <div className="break-words text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">{value}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </CardContent>
    </Card>
  );
}

function ChartLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span className="h-2 w-2" style={{ backgroundColor: item.color }} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function TokenTooltip({
  active,
  label,
  payload,
  formatInteger,
}: UsageTooltipProps & { formatInteger: (value: NumericValue) => string }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="min-w-36 border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-2 font-semibold">{label}</div>
      <div className="space-y-1.5">
        {payload.map((entry) => (
          <div key={String(entry.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2" style={{ backgroundColor: entry.color }} />
              {entry.name}
            </span>
            <span className="font-medium tabular-nums">{formatInteger(entry.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownTooltip({
  active,
  label,
  payload,
  formatInteger,
  unit,
}: UsageTooltipProps & { formatInteger: (value: NumericValue) => string; unit: string }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="min-w-36 border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1.5 font-semibold">{label}</div>
      <div className="font-medium tabular-nums">{formatInteger(payload[0]?.value)} {unit}</div>
    </div>
  );
}

export function UsageAnalyticsClient({ isAdmin }: UsageAnalyticsClientProps) {
  const t = useTranslations('usage');
  const locale = useLocale();
  const stopReasonOptions = [
    { value: '', label: t('stopReasons.all') },
    { value: 'stop', label: t('stopReasons.stop') },
    { value: 'toolUse', label: t('stopReasons.toolUse') },
    { value: 'length', label: t('stopReasons.length') },
    { value: 'aborted', label: t('stopReasons.aborted') },
    { value: 'error', label: t('stopReasons.error') },
  ];
  const workspaceTypeOptions = [
    { value: '', label: t('filters.allWorkspaceTypes') },
    { value: 'personal', label: t('filters.workspaceTypes.personal') },
    { value: 'team', label: t('filters.workspaceTypes.team') },
    { value: 'organization', label: t('filters.workspaceTypes.organization') },
    { value: 'project', label: t('filters.workspaceTypes.project') },
  ];
  const studioMediaTypeOptions: Array<{ value: StudioUsageMediaType | ''; label: string }> = [
    { value: '', label: t('studio.filters.allMedia') },
    { value: 'image', label: t('studio.media.image') },
    { value: 'video', label: t('studio.media.video') },
    { value: 'sound', label: t('studio.media.sound') },
  ];
  const studioStatusOptions = [
    { value: '', label: t('studio.filters.allStatuses') },
    { value: 'completed', label: t('studio.status.completed') },
    { value: 'failed', label: t('studio.status.failed') },
    { value: 'pending', label: t('studio.status.pending') },
    { value: 'generating', label: t('studio.status.generating') },
  ];
  const groupByOptions: Array<{ value: UsageSummaryGroupBy; label: string }> = [
    { value: 'day', label: t('groupBy.day') },
    { value: 'provider', label: t('groupBy.provider') },
    { value: 'model', label: t('groupBy.model') },
    { value: 'agent', label: t('groupBy.agent') },
    { value: 'session', label: t('groupBy.session') },
    { value: 'user', label: t('groupBy.user') },
  ];
  const [draftFilters, setDraftFilters] = useState<FilterState>(() => createDefaultFilters());
  const [activeFilters, setActiveFilters] = useState<FilterState>(() => createDefaultFilters());
  const [dashboard, setDashboard] = useState<UsageDashboardResponse | null>(null);
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [events, setEvents] = useState<UsageEventsResponse | null>(null);
  const [users, setUsers] = useState<UsageUsersResponse | null>(null);
  const [studioDashboard, setStudioDashboard] = useState<StudioUsageDashboardResponse | null>(null);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const queryString = useMemo(() => buildQueryString(activeFilters, page), [activeFilters, page]);
  const usersQueryString = useMemo(() => buildUsersQueryString(activeFilters), [activeFilters]);
  const canGoNext = events ? page * events.pageSize < events.totalRows : false;
  const activeStopReasonLabel =
    stopReasonOptions.find((option) => option.value === activeFilters.stopReason)?.label || t('scope.all');
  const summaryRows = summary?.rows ?? [];
  const userOptions = users?.users ?? [];
  const integerFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0, notation: 'compact', compactDisplay: 'short' }),
    [locale],
  );
  const fullIntegerFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );
  const costFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    [locale],
  );
  const formatInteger = (value: NumericValue) => fullIntegerFormatter.format(safeNumber(value));
  const formatCompactInteger = (value: NumericValue) => integerFormatter.format(safeNumber(value));
  const formatCost = (value: number | null | undefined) => costFormatter.format(safeNumber(value));
  const formatSummaryBreakdown = (row: UsageSummaryRow) =>
    t('summary.breakdown', {
      input: formatInteger(row.inputTokens),
      output: formatInteger(row.outputTokens),
      cache: formatInteger(row.cacheTokens),
    });
  const formatUserOptionLabel = (userOption: UsageUserOption) => userOption.label;
  const activeUserLabel = activeFilters.userId
    ? userOptions.find((userOption) => userOption.id === activeFilters.userId)?.label || activeFilters.userId
    : t('scope.allUsers');
  const activeFilterCount = [
    activeFilters.provider,
    activeFilters.model,
    activeFilters.sessionQuery,
    activeFilters.stopReason,
    activeFilters.workspaceType,
    activeFilters.agentId,
    activeFilters.studioMediaType,
    activeFilters.studioStatus,
    activeFilters.userId,
  ].filter(Boolean).length;
  const dashboardTotals = dashboard?.totals ?? summary?.totals;
  const timelineData = (dashboard?.timeline ?? []).map((row) => ({
    label: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(`${row.label}T00:00:00.000Z`)),
    input: row.inputTokens,
    output: row.outputTokens,
    cache: row.cacheTokens,
  }));
  const breakdownData = (dashboard?.breakdown ?? []).map((row) => ({
    label: row.label,
    shortLabel: shortenLabel(row.label),
    tokens: row.totalTokens,
  }));
  const breakdownTitle = dashboard?.breakdownBy === 'user'
    ? t('charts.breakdown.users')
    : dashboard?.breakdownBy === 'provider'
      ? t('charts.breakdown.providers')
      : t('charts.breakdown.models');
  const studioTimelineData = (studioDashboard?.timeline ?? []).map((row) => ({
    label: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(`${row.day}T00:00:00.000Z`)),
    image: row.imageCount,
    video: row.videoCount,
    sound: row.soundCount,
  }));
  const studioBreakdownData = (studioDashboard?.breakdown ?? []).map((row) => ({
    label: row.label,
    shortLabel: shortenLabel(row.label),
    outputs: row.outputCount,
  }));
  const studioBreakdownTitle = studioDashboard?.breakdownBy === 'user'
    ? t('studio.charts.breakdown.users')
    : studioDashboard?.breakdownBy === 'provider'
      ? t('studio.charts.breakdown.providers')
      : t('studio.charts.breakdown.models');

  function formatTimestamp(value: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const [dashboardRes, summaryRes, eventsRes, usersRes, studioRes] = await Promise.all([
          fetch(`/api/usage/dashboard?${queryString}`),
          fetch(`/api/usage/summary?${queryString}`),
          fetch(`/api/usage/events?${queryString}`),
          isAdmin ? fetch(`/api/usage/users?${usersQueryString}`) : Promise.resolve(null),
          fetch(`/api/usage/studio?${queryString}`),
        ]);

        const dashboardPayload = await dashboardRes.json();
        const summaryPayload = await summaryRes.json();
        const eventsPayload = await eventsRes.json();
        const usersPayload = usersRes ? await usersRes.json() : null;
        const studioPayload = await studioRes.json();

        if (!dashboardRes.ok || !dashboardPayload.success) {
          throw new Error(dashboardPayload.error || t('errors.loadDashboard', { status: dashboardRes.status }));
        }
        if (!summaryRes.ok || !summaryPayload.success) {
          throw new Error(summaryPayload.error || t('errors.loadSummary', { status: summaryRes.status }));
        }
        if (!eventsRes.ok || !eventsPayload.success) {
          throw new Error(eventsPayload.error || t('errors.loadEvents', { status: eventsRes.status }));
        }
        if (usersRes && (!usersRes.ok || !usersPayload.success)) {
          throw new Error(usersPayload.error || t('errors.loadUsers', { status: usersRes.status }));
        }
        if (!studioRes.ok || !studioPayload.success) {
          throw new Error(studioPayload.error || t('studio.errors.load', { status: studioRes.status }));
        }

        if (!cancelled) {
          setDashboard(dashboardPayload as UsageDashboardResponse);
          setSummary(summaryPayload as UsageSummaryResponse);
          setEvents(eventsPayload as UsageEventsResponse);
          setUsers(usersPayload ? usersPayload as UsageUsersResponse : null);
          setStudioDashboard(studioPayload as StudioUsageDashboardResponse);
        }
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [isAdmin, queryString, t, usersQueryString]);

  const setPresetRange = (days: number) => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - (days - 1));
    const nextFilters = { ...draftFilters, from: formatDateInput(from), to: formatDateInput(now) };
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    setPage(1);
  };

  const applyFilters = () => {
    setActiveFilters(draftFilters);
    setPage(1);
    setFiltersOpen(false);
  };

  const resetFilters = () => {
    const nextFilters = createDefaultFilters();
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    setPage(1);
  };

  return (
    <div data-testid="usage-page" className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-4 px-3 py-4 sm:px-5 sm:py-6 lg:gap-6 lg:px-6 lg:py-8">
      <section className="border border-border bg-card/95 shadow-sm">
        <div className="relative border-b border-border bg-muted/45 px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="text-[0.68rem] font-bold uppercase tracking-[0.2em] text-primary">{t('eyebrow')}</div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('header.title')}</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('header.description')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {[7, 30, 90].map((days) => (
                <Button key={days} type="button" variant={days === 30 ? 'secondary' : 'outline'} size="sm" onClick={() => setPresetRange(days)}>
                  {t('presets.lastDays', { days })}
                </Button>
              ))}
              <Collapsible className="static" open={filtersOpen} onOpenChange={setFiltersOpen}>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="gap-2">
                    <SlidersHorizontal className="h-4 w-4" />
                    {t('actions.filters')}
                    {activeFilterCount ? <span className="bg-primary px-1.5 py-0.5 text-[0.65rem] leading-none text-primary-foreground">{activeFilterCount}</span> : null}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="absolute left-0 right-0 z-10 mt-2 border border-border bg-card p-4 shadow-lg sm:p-5 lg:left-auto lg:right-6 lg:w-[min(44rem,calc(100vw-3rem))]">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{t('filters.title')}</div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('filters.description')}</p>
                    </div>
                    <Button type="button" variant="ghost" size="sm" className="h-auto px-0 text-xs" onClick={resetFilters}>{t('actions.reset')}</Button>
                  </div>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.from')}</span>
                      <Input type="date" className="text-base sm:text-sm" value={draftFilters.from} onChange={(event) => setDraftFilters((prev) => ({ ...prev, from: event.target.value }))} />
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.to')}</span>
                      <Input type="date" className="text-base sm:text-sm" value={draftFilters.to} onChange={(event) => setDraftFilters((prev) => ({ ...prev, to: event.target.value }))} />
                    </label>
                    {isAdmin ? (
                      <label className={FILTER_FIELD_CLASS_NAME}>
                        <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.user')}</span>
                        <select className={FILTER_SELECT_CLASS_NAME} value={draftFilters.userId} onChange={(event) => setDraftFilters((prev) => ({ ...prev, userId: event.target.value }))}>
                          <option value="">{t('filters.allUsers')}</option>
                          {userOptions.map((userOption) => <option key={userOption.id} value={userOption.id}>{formatUserOptionLabel(userOption)}</option>)}
                        </select>
                      </label>
                    ) : null}
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.provider')}</span>
                      <Input className="text-base sm:text-sm" placeholder={t('filters.providerPlaceholder')} value={draftFilters.provider} onChange={(event) => setDraftFilters((prev) => ({ ...prev, provider: event.target.value }))} />
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.model')}</span>
                      <Input className="text-base sm:text-sm" placeholder={t('filters.modelPlaceholder')} value={draftFilters.model} onChange={(event) => setDraftFilters((prev) => ({ ...prev, model: event.target.value }))} />
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.agent')}</span>
                      <Input className="text-base sm:text-sm" placeholder={t('filters.agentPlaceholder')} value={draftFilters.agentId} onChange={(event) => setDraftFilters((prev) => ({ ...prev, agentId: event.target.value }))} />
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.workspaceType')}</span>
                      <select className={FILTER_SELECT_CLASS_NAME} value={draftFilters.workspaceType} onChange={(event) => setDraftFilters((prev) => ({ ...prev, workspaceType: event.target.value }))}>
                        {workspaceTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.stopReason')}</span>
                      <select className={FILTER_SELECT_CLASS_NAME} value={draftFilters.stopReason} onChange={(event) => setDraftFilters((prev) => ({ ...prev, stopReason: event.target.value }))}>
                        {stopReasonOptions.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('studio.filters.mediaType')}</span>
                      <select className={FILTER_SELECT_CLASS_NAME} value={draftFilters.studioMediaType} onChange={(event) => setDraftFilters((prev) => ({ ...prev, studioMediaType: event.target.value as StudioUsageMediaType | '' }))}>
                        {studioMediaTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('studio.filters.status')}</span>
                      <select className={FILTER_SELECT_CLASS_NAME} value={draftFilters.studioStatus} onChange={(event) => setDraftFilters((prev) => ({ ...prev, studioStatus: event.target.value }))}>
                        {studioStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className={FILTER_FIELD_CLASS_NAME}>
                      <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.session')}</span>
                      <Input className="text-base sm:text-sm" placeholder={t('filters.sessionPlaceholder')} value={draftFilters.sessionQuery} onChange={(event) => setDraftFilters((prev) => ({ ...prev, sessionQuery: event.target.value }))} />
                    </label>
                  </div>
                  <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button type="button" variant="outline" size="sm" onClick={resetFilters}>{t('actions.reset')}</Button>
                    <Button type="button" size="sm" className="gap-2" onClick={applyFilters}><Filter className="h-4 w-4" />{t('actions.applyFilters')}</Button>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 px-4 py-3 text-xs text-muted-foreground sm:px-6">
          <span className="border border-border bg-background px-2 py-1">{t('scope.range', { from: activeFilters.from, to: activeFilters.to })}</span>
          {activeFilters.provider ? <span className="border border-border bg-background px-2 py-1">{t('scope.provider', { value: activeFilters.provider })}</span> : null}
          {activeFilters.model ? <span className="border border-border bg-background px-2 py-1">{t('scope.model', { value: activeFilters.model })}</span> : null}
          {activeFilters.sessionQuery ? <span className="border border-border bg-background px-2 py-1">{t('scope.session', { value: activeFilters.sessionQuery })}</span> : null}
          {activeFilters.workspaceType ? <span className="border border-border bg-background px-2 py-1">{t('scope.workspaceType', { value: activeFilters.workspaceType })}</span> : null}
          {activeFilters.agentId ? <span className="border border-border bg-background px-2 py-1">{t('scope.agent', { value: activeFilters.agentId })}</span> : null}
          {activeFilters.stopReason ? <span className="border border-border bg-background px-2 py-1">{t('scope.stopReason', { value: activeStopReasonLabel })}</span> : null}
          {activeFilters.studioMediaType ? <span className="border border-border bg-background px-2 py-1">{t('studio.scope.mediaType', { value: t(`studio.media.${activeFilters.studioMediaType}`) })}</span> : null}
          {activeFilters.studioStatus ? <span className="border border-border bg-background px-2 py-1">{t('studio.scope.status', { value: studioStatusOptions.find((option) => option.value === activeFilters.studioStatus)?.label || activeFilters.studioStatus })}</span> : null}
          {isAdmin && activeFilters.userId ? <span className="border border-primary/40 bg-primary/5 px-2 py-1 text-foreground">{t('scope.userScope', { value: activeUserLabel })}</span> : null}
        </div>
      </section>

      {error ? <Card className="border-destructive/40 bg-destructive/10 py-0"><CardContent className="p-4 text-sm text-destructive">{error}</CardContent></Card> : null}

      <section aria-label={t('overview.label')} className="grid gap-2 min-[420px]:grid-cols-2 sm:gap-3 xl:grid-cols-6">
        <StatCard title={t('stats.totalCost.title')} value={isLoading ? '—' : formatCost(dashboardTotals?.totalCost)} subtitle={t('stats.totalCost.subtitle')} />
        <StatCard title={t('stats.totalTokens.title')} value={isLoading ? '—' : formatInteger(dashboardTotals?.totalTokens)} subtitle={t('stats.totalTokens.subtitle')} />
        <StatCard title={t('stats.input.title')} value={isLoading ? '—' : formatInteger(dashboardTotals?.inputTokens)} subtitle={t('stats.input.subtitle')} />
        <StatCard title={t('stats.output.title')} value={isLoading ? '—' : formatInteger(dashboardTotals?.outputTokens)} subtitle={t('stats.output.subtitle')} />
        <StatCard title={t('stats.cache.title')} value={isLoading ? '—' : formatInteger(dashboardTotals?.cacheTokens)} subtitle={t('stats.cache.subtitle')} />
        <StatCard title={t('stats.sessions.title')} value={isLoading ? '—' : formatInteger(dashboardTotals?.sessionCount)} subtitle={t('stats.sessions.subtitle', { count: formatInteger(dashboardTotals?.eventCount) })} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(19rem,0.75fr)]">
        <Card className="min-w-0 gap-0 border-border/70 bg-card/95 py-0 shadow-sm">
          <CardHeader className="gap-2 border-b border-border px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-base">{t('charts.trend.title')}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{t('charts.trend.description')}</p>
              </div>
              <ChartLegend items={[
                { label: t('charts.input'), color: 'var(--chart-1)' },
                { label: t('charts.output'), color: 'var(--chart-2)' },
                { label: t('charts.cache'), color: 'var(--chart-3)' },
              ]} />
            </div>
          </CardHeader>
          <CardContent className="px-2 pb-3 pt-4 sm:px-4 sm:pb-4">
            {timelineData.length ? (
              <ChartContainer config={tokenChartConfig} className="min-h-[14rem] sm:min-h-[17rem]" aria-label={t('charts.trend.ariaLabel')}>
                <AreaChart data={timelineData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="usage-input" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="var(--color-input)" stopOpacity={0.32} /><stop offset="95%" stopColor="var(--color-input)" stopOpacity={0.02} /></linearGradient>
                    <linearGradient id="usage-output" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="var(--color-output)" stopOpacity={0.32} /><stop offset="95%" stopColor="var(--color-output)" stopOpacity={0.02} /></linearGradient>
                    <linearGradient id="usage-cache" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="var(--color-cache)" stopOpacity={0.32} /><stop offset="95%" stopColor="var(--color-cache)" stopOpacity={0.02} /></linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={26} tickMargin={8} />
                  <YAxis axisLine={false} tickLine={false} tickFormatter={formatCompactInteger} width={42} />
                  <Tooltip cursor={{ stroke: 'var(--border)' }} content={(props) => <TokenTooltip {...props} formatInteger={formatInteger} />} />
                  <Area dataKey="input" name={t('charts.input')} stackId="usage" type="monotone" stroke="var(--color-input)" fill="url(#usage-input)" strokeWidth={2} />
                  <Area dataKey="output" name={t('charts.output')} stackId="usage" type="monotone" stroke="var(--color-output)" fill="url(#usage-output)" strokeWidth={2} />
                  <Area dataKey="cache" name={t('charts.cache')} stackId="usage" type="monotone" stroke="var(--color-cache)" fill="url(#usage-cache)" strokeWidth={2} />
                </AreaChart>
              </ChartContainer>
            ) : <div className="flex min-h-[14rem] items-center justify-center px-6 text-center text-sm text-muted-foreground">{isLoading ? t('charts.loading') : t('charts.empty')}</div>}
          </CardContent>
        </Card>

        <Card className="min-w-0 gap-0 border-border/70 bg-card/95 py-0 shadow-sm">
          <CardHeader className="gap-2 border-b border-border px-4 py-4 sm:px-5">
            <CardTitle className="flex items-center gap-2 text-base"><UsersRound className="h-4 w-4 text-primary" />{breakdownTitle}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('charts.breakdown.description')}</p>
          </CardHeader>
          <CardContent className="px-2 pb-3 pt-4 sm:px-3 sm:pb-4">
            {breakdownData.length ? (
              <ChartContainer config={breakdownChartConfig} className="min-h-[14rem] sm:min-h-[17rem]" aria-label={t('charts.breakdown.ariaLabel', { group: breakdownTitle })}>
                <BarChart data={breakdownData} layout="vertical" margin={{ top: 2, right: 14, left: 2, bottom: 2 }} barCategoryGap="24%">
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" axisLine={false} tickLine={false} tickFormatter={formatCompactInteger} />
                  <YAxis dataKey="shortLabel" type="category" axisLine={false} tickLine={false} width={88} />
                  <Tooltip cursor={{ fill: 'var(--muted)' }} content={(props) => <BreakdownTooltip {...props} formatInteger={formatInteger} unit={t('charts.tokens')} />} />
                  <Bar dataKey="tokens" name={t('charts.tokens')} fill="var(--color-tokens)" radius={0} />
                </BarChart>
              </ChartContainer>
            ) : <div className="flex min-h-[14rem] items-center justify-center px-6 text-center text-sm text-muted-foreground">{isLoading ? t('charts.loading') : t('charts.empty')}</div>}
          </CardContent>
        </Card>
      </section>

      <Collapsible open={studioOpen} onOpenChange={setStudioOpen} className="border border-border bg-card/95 shadow-sm">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/60 sm:px-5" aria-label={t('studio.toggle')}>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-base font-semibold"><Layers3 className="h-4 w-4 text-primary" />{t('studio.title')}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{t('studio.description')}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">{studioOpen ? t('details.hide') : t('details.show')}<ChevronRight className={`h-4 w-4 transition-transform ${studioOpen ? 'rotate-90' : ''}`} /></span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border">
          <div className="space-y-4 p-3 sm:space-y-5 sm:p-4">
            <section aria-label={t('studio.overviewLabel')} className="grid gap-2 min-[420px]:grid-cols-2 sm:gap-3 xl:grid-cols-6">
              <StatCard title={t('studio.stats.generations.title')} value={isLoading ? '—' : formatInteger(studioDashboard?.totals.generationCount)} subtitle={t('studio.stats.generations.subtitle', { count: formatInteger(studioDashboard?.totals.completedGenerationCount) })} />
              <StatCard title={t('studio.stats.outputs.title')} value={isLoading ? '—' : formatInteger(studioDashboard?.totals.outputCount)} subtitle={t('studio.stats.outputs.subtitle')} />
              <StatCard title={t('studio.stats.images.title')} value={isLoading ? '—' : formatInteger(studioDashboard?.totals.imageCount)} subtitle={t('studio.stats.images.subtitle')} />
              <StatCard title={t('studio.stats.videos.title')} value={isLoading ? '—' : formatInteger(studioDashboard?.totals.videoCount)} subtitle={t('studio.stats.videos.subtitle')} />
              <StatCard title={t('studio.stats.sound.title')} value={isLoading ? '—' : formatInteger(studioDashboard?.totals.soundCount)} subtitle={t('studio.stats.sound.subtitle')} />
              <StatCard title={t('studio.stats.failed.title')} value={isLoading ? '—' : formatInteger(studioDashboard?.totals.failedGenerationCount)} subtitle={t('studio.stats.failed.subtitle')} />
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(19rem,0.75fr)]">
              <Card className="min-w-0 gap-0 border-border/70 bg-background/35 py-0 shadow-none">
                <CardHeader className="gap-2 border-b border-border px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-base">{t('studio.charts.trend.title')}</CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">{t('studio.charts.trend.description')}</p>
                    </div>
                    <ChartLegend items={[
                      { label: t('studio.media.image'), color: 'var(--chart-1)' },
                      { label: t('studio.media.video'), color: 'var(--chart-2)' },
                      { label: t('studio.media.sound'), color: 'var(--chart-3)' },
                    ]} />
                  </div>
                </CardHeader>
                <CardContent className="px-2 pb-3 pt-4 sm:px-4 sm:pb-4">
                  {studioTimelineData.length ? (
                    <ChartContainer config={studioChartConfig} className="min-h-[14rem] sm:min-h-[17rem]" aria-label={t('studio.charts.trend.ariaLabel')}>
                      <BarChart data={studioTimelineData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={26} tickMargin={8} />
                        <YAxis axisLine={false} tickLine={false} tickFormatter={formatCompactInteger} width={42} />
                        <Tooltip cursor={{ fill: 'var(--muted)' }} content={(props) => <TokenTooltip {...props} formatInteger={formatInteger} />} />
                        <Bar dataKey="image" name={t('studio.media.image')} stackId="studio" fill="var(--color-image)" radius={0} />
                        <Bar dataKey="video" name={t('studio.media.video')} stackId="studio" fill="var(--color-video)" radius={0} />
                        <Bar dataKey="sound" name={t('studio.media.sound')} stackId="studio" fill="var(--color-sound)" radius={0} />
                      </BarChart>
                    </ChartContainer>
                  ) : <div className="flex min-h-[14rem] items-center justify-center px-6 text-center text-sm text-muted-foreground">{isLoading ? t('charts.loading') : t('studio.charts.empty')}</div>}
                </CardContent>
              </Card>

              <Card className="min-w-0 gap-0 border-border/70 bg-background/35 py-0 shadow-none">
                <CardHeader className="gap-2 border-b border-border px-4 py-4 sm:px-5">
                  <CardTitle className="flex items-center gap-2 text-base"><UsersRound className="h-4 w-4 text-primary" />{studioBreakdownTitle}</CardTitle>
                  <p className="text-sm text-muted-foreground">{t('studio.charts.breakdown.description')}</p>
                </CardHeader>
                <CardContent className="px-2 pb-3 pt-4 sm:px-3 sm:pb-4">
                  {studioBreakdownData.length ? (
                    <ChartContainer config={studioBreakdownChartConfig} className="min-h-[14rem] sm:min-h-[17rem]" aria-label={t('studio.charts.breakdown.ariaLabel', { group: studioBreakdownTitle })}>
                      <BarChart data={studioBreakdownData} layout="vertical" margin={{ top: 2, right: 14, left: 2, bottom: 2 }} barCategoryGap="24%">
                        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                        <XAxis type="number" axisLine={false} tickLine={false} tickFormatter={formatCompactInteger} />
                        <YAxis dataKey="shortLabel" type="category" axisLine={false} tickLine={false} width={88} />
                        <Tooltip cursor={{ fill: 'var(--muted)' }} content={(props) => <BreakdownTooltip {...props} formatInteger={formatInteger} unit={t('studio.outputsUnit')} />} />
                        <Bar dataKey="outputs" name={t('studio.outputsUnit')} fill="var(--color-outputs)" radius={0} />
                      </BarChart>
                    </ChartContainer>
                  ) : <div className="flex min-h-[14rem] items-center justify-center px-6 text-center text-sm text-muted-foreground">{isLoading ? t('charts.loading') : t('studio.charts.empty')}</div>}
                </CardContent>
              </Card>
            </section>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="border border-border bg-card/95 shadow-sm">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/60 sm:px-5" aria-label={t('details.toggle')}>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-base font-semibold"><Layers3 className="h-4 w-4 text-primary" />{t('details.title')}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{t('details.description')}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">{detailsOpen ? t('details.hide') : t('details.show')}<ChevronRight className={`h-4 w-4 transition-transform ${detailsOpen ? 'rotate-90' : ''}`} /></span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border">
          <div className="grid gap-4 p-3 sm:p-4 xl:grid-cols-[0.95fr_1.05fr]">
            <section className="min-w-0 border border-border/70 bg-background/35">
              <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-base font-semibold">{t('summary.title')}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{t('summary.description')}</p>
                </div>
                <label className="flex min-w-40 flex-col gap-1 text-xs font-medium text-muted-foreground">
                  {t('filters.groupBy')}
                  <select className={FILTER_SELECT_CLASS_NAME} value={draftFilters.groupBy} onChange={(event) => {
                    const nextFilters = { ...draftFilters, groupBy: event.target.value as UsageSummaryGroupBy };
                    setDraftFilters(nextFilters);
                    setActiveFilters(nextFilters);
                    setPage(1);
                  }}>
                    {groupByOptions.filter((option) => isAdmin || option.value !== 'user').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              <div data-testid="usage-summary-desktop" className="hidden overflow-x-auto md:block">
                <table data-testid="usage-summary-table" className="min-w-[680px] border-collapse text-sm">
                  <thead><tr className="border-b border-border bg-muted/50 text-left text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground"><th className="w-[42%] px-3 py-2.5">{t('summary.columns.group')}</th><th className="w-[16%] px-3 py-2.5 text-right">{t('summary.columns.cost')}</th><th className="w-[18%] px-3 py-2.5 text-right">{t('summary.columns.tokens')}</th><th className="w-[12%] px-3 py-2.5 text-right">{t('summary.columns.sessions')}</th><th className="w-[12%] px-3 py-2.5 text-right">{t('summary.columns.events')}</th></tr></thead>
                  <tbody className="divide-y divide-border/60">
                    {summaryRows.length ? summaryRows.map((row) => <tr key={row.groupKey} className="align-top hover:bg-muted/35"><td className="min-w-0 px-3 py-3"><div className="break-words font-medium leading-snug">{row.label}</div><div className="text-xs text-muted-foreground">{formatSummaryBreakdown(row)}</div></td><td className="px-3 py-3 text-right font-medium tabular-nums">{formatCost(row.totalCost)}</td><td className="px-3 py-3 text-right tabular-nums">{formatInteger(row.totalTokens)}</td><td className="px-3 py-3 text-right tabular-nums">{formatInteger(row.sessionCount)}</td><td className="px-3 py-3 text-right tabular-nums">{formatInteger(row.eventCount)}</td></tr>) : <tr><td colSpan={5} className="px-3 py-6 text-sm text-muted-foreground">{isLoading ? t('summary.loading') : t('summary.empty')}</td></tr>}
                  </tbody>
                </table>
              </div>
              <div data-testid="usage-summary-mobile" className="divide-y divide-border md:hidden">
                {summaryRows.length ? summaryRows.map((row) => <article key={row.groupKey} data-testid="usage-summary-mobile-row" className="space-y-3 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="break-words font-medium leading-snug">{row.label}</div><div className="mt-1 text-xs text-muted-foreground">{formatSummaryBreakdown(row)}</div></div><div className="shrink-0 text-right text-sm font-semibold tabular-nums">{formatCost(row.totalCost)}</div></div><dl className="grid grid-cols-3 gap-2 text-xs"><div><dt className="text-muted-foreground">{t('summary.columns.tokens')}</dt><dd className="mt-0.5 font-medium tabular-nums">{formatInteger(row.totalTokens)}</dd></div><div><dt className="text-muted-foreground">{t('summary.columns.sessions')}</dt><dd className="mt-0.5 font-medium tabular-nums">{formatInteger(row.sessionCount)}</dd></div><div><dt className="text-muted-foreground">{t('summary.columns.events')}</dt><dd className="mt-0.5 font-medium tabular-nums">{formatInteger(row.eventCount)}</dd></div></dl></article>) : <div className="p-4 text-sm text-muted-foreground">{isLoading ? t('summary.loading') : t('summary.empty')}</div>}
              </div>
            </section>

            <section className="min-w-0 border border-border/70 bg-background/35">
              <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div><h2 className="text-base font-semibold">{t('events.title')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('events.description')}</p></div>
                <div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((prev) => prev - 1)}>{t('events.previous')}</Button><span className="text-xs text-muted-foreground">{t('events.page', { page })}</span><Button type="button" variant="outline" size="sm" disabled={!canGoNext} onClick={() => setPage((prev) => prev + 1)}>{t('events.next')}</Button></div>
              </div>
              <div className="p-3 sm:p-4">
                {events?.rows.length ? (
                  <ScrollArea className="h-[25rem] sm:h-[30rem]">
                    <div className="space-y-3 pr-3">
                      {events.rows.map((row) => (
                        <div key={row.id} data-testid="usage-event-row" className="border border-border/70 bg-card p-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="font-medium">{row.sessionTitleSnapshot || row.sessionId}</div>
                              <div className="text-xs text-muted-foreground">{row.provider} / {row.model}{isAdmin ? ` / ${row.userLabel}` : ''}</div>
                            </div>
                            <div className="text-right text-sm font-medium tabular-nums">{formatCost(row.totalCost)}</div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            <span data-testid="usage-event-agent" className="border border-border bg-muted/55 px-2 py-1 text-muted-foreground">
                              {t('events.executionAgent', { agent: row.agentId })}
                            </span>
                            {isAdmin && row.agentId === MEMORY_MANAGER_AGENT_ID ? (
                              <span data-testid="usage-event-source-agent" className="border border-primary/30 bg-primary/5 px-2 py-1 text-primary">
                                {row.sourceAgentId
                                  ? t('events.reviewForAgent', { agent: row.sourceAgentId })
                                  : t('events.reviewForUnknownAgent')}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>{formatTimestamp(row.assistantTimestamp)}</span>
                            <span>{t('events.tokens', { count: formatInteger(row.totalTokens) })}</span>
                            <span>{t('events.inputOutput', { input: formatInteger(row.inputTokens), output: formatInteger(row.outputTokens) })}</span>
                            <span>{t('events.cache', { count: formatInteger(row.cacheTokens) })}</span>
                            <span>{row.stopReason}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <div className="py-6 text-sm text-muted-foreground">{isLoading ? t('events.loading') : t('events.empty')}</div>
                )}
              </div>
            </section>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
