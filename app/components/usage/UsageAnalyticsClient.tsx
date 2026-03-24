'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { BarChart3, CalendarRange, Filter, Layers3, RefreshCw } from 'lucide-react';

import { formatUsageCost } from '@/app/lib/pi/usage-format';
import type {
  UsageEventsResponse,
  UsageSummaryGroupBy,
  UsageSummaryResponse,
} from '@/app/lib/pi/usage-types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

type FilterState = {
  from: string;
  to: string;
  provider: string;
  model: string;
  sessionQuery: string;
  stopReason: string;
  groupBy: UsageSummaryGroupBy;
  userId: string;
};

type UsageAnalyticsClientProps = {
  isAdmin: boolean;
};

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
  if (filters.userId) params.set('userId', filters.userId);

  return params.toString();
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
    <Card className="border-border/70 bg-card/95">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </CardContent>
    </Card>
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
  const groupByOptions: Array<{ value: UsageSummaryGroupBy; label: string }> = [
    { value: 'day', label: t('groupBy.day') },
    { value: 'provider', label: t('groupBy.provider') },
    { value: 'model', label: t('groupBy.model') },
    { value: 'session', label: t('groupBy.session') },
    { value: 'user', label: t('groupBy.user') },
  ];
  const [draftFilters, setDraftFilters] = useState<FilterState>(() => createDefaultFilters());
  const [activeFilters, setActiveFilters] = useState<FilterState>(() => createDefaultFilters());
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [events, setEvents] = useState<UsageEventsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => buildQueryString(activeFilters, page), [activeFilters, page]);
  const canGoNext = events ? page * events.pageSize < events.totalRows : false;
  const activeStopReasonLabel =
    stopReasonOptions.find((option) => option.value === activeFilters.stopReason)?.label || t('scope.all');
  const activeGroupByLabel =
    groupByOptions.find((option) => option.value === activeFilters.groupBy)?.label || activeFilters.groupBy;

  function formatTimestamp(value: string): string {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        const [summaryRes, eventsRes] = await Promise.all([
          fetch(`/api/usage/summary?${queryString}`),
          fetch(`/api/usage/events?${queryString}`),
        ]);

        const summaryPayload = await summaryRes.json();
        const eventsPayload = await eventsRes.json();

        if (!summaryRes.ok || !summaryPayload.success) {
          throw new Error(summaryPayload.error || t('errors.loadSummary', { status: summaryRes.status }));
        }

        if (!eventsRes.ok || !eventsPayload.success) {
          throw new Error(eventsPayload.error || t('errors.loadEvents', { status: eventsRes.status }));
        }

        if (!cancelled) {
          setSummary(summaryPayload as UsageSummaryResponse);
          setEvents(eventsPayload as UsageEventsResponse);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [queryString, t]);

  const setPresetRange = (days: number) => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - (days - 1));
    const nextFilters = {
      ...draftFilters,
      from: formatDateInput(from),
      to: formatDateInput(now),
    };
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    setPage(1);
  };

  const applyFilters = () => {
    setActiveFilters(draftFilters);
    setPage(1);
  };

  const resetFilters = () => {
    const nextFilters = createDefaultFilters();
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    setPage(1);
  };

  return (
    <div data-testid="usage-page" className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 md:px-6 md:gap-6 md:py-8">
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-border/70 bg-card/95">
          <CardHeader className="px-4 pb-4 sm:px-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted">
                <BarChart3 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-lg sm:text-xl">{t('header.title')}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {t('header.description')}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="flex flex-wrap gap-2">
              {[7, 30, 90].map((days) => (
                <Button
                  key={days}
                  type="button"
                  variant={days === 30 ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => setPresetRange(days)}
                >
                  {t('presets.lastDays', { days })}
                </Button>
              ))}
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.from')}</span>
                <Input
                  type="date"
                  value={draftFilters.from}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, from: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.to')}</span>
                <Input
                  type="date"
                  value={draftFilters.to}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, to: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.provider')}</span>
                <Input
                  placeholder={t('filters.providerPlaceholder')}
                  value={draftFilters.provider}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, provider: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.model')}</span>
                <Input
                  placeholder={t('filters.modelPlaceholder')}
                  value={draftFilters.model}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, model: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.session')}</span>
                <Input
                  placeholder={t('filters.sessionPlaceholder')}
                  value={draftFilters.sessionQuery}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, sessionQuery: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.stopReason')}</span>
                <select
                  className="flex h-10 w-full border border-border bg-background px-3 text-sm"
                  value={draftFilters.stopReason}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, stopReason: event.target.value }))}
                >
                  {stopReasonOptions.map((option) => (
                    <option key={option.label} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.groupBy')}</span>
                <select
                  className="flex h-10 w-full border border-border bg-background px-3 text-sm"
                  value={draftFilters.groupBy}
                  onChange={(event) =>
                    setDraftFilters((prev) => ({
                      ...prev,
                      groupBy: event.target.value as UsageSummaryGroupBy,
                    }))
                  }
                >
                  {groupByOptions.filter((option) => isAdmin || option.value !== 'user').map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {isAdmin ? (
                <label className="space-y-1 text-sm">
                  <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('filters.userId')}</span>
                  <Input
                    placeholder={t('filters.userIdPlaceholder')}
                    value={draftFilters.userId}
                    onChange={(event) => setDraftFilters((prev) => ({ ...prev, userId: event.target.value }))}
                  />
                </label>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button type="button" size="sm" className="w-full gap-2 sm:w-auto" onClick={applyFilters}>
                <Filter className="h-4 w-4" />
                {t('actions.applyFilters')}
              </Button>
              <Button type="button" variant="outline" size="sm" className="w-full gap-2 sm:w-auto" onClick={resetFilters}>
                <RefreshCw className="h-4 w-4" />
                {t('actions.reset')}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/95">
          <CardHeader className="px-4 pb-4 sm:px-6">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers3 className="h-4 w-4" />
              {t('scope.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4 text-sm text-muted-foreground sm:px-6 sm:pb-6">
            <div className="flex items-start gap-2">
              <CalendarRange className="mt-0.5 h-4 w-4 text-foreground" />
              <span className="break-words">
                {t('scope.range', { from: activeFilters.from, to: activeFilters.to })}
              </span>
            </div>
            <div>{t('scope.provider', { value: activeFilters.provider || t('scope.all') })}</div>
            <div>{t('scope.model', { value: activeFilters.model || t('scope.all') })}</div>
            <div>{t('scope.session', { value: activeFilters.sessionQuery || t('scope.all') })}</div>
            <div>{t('scope.stopReason', { value: activeStopReasonLabel })}</div>
            <div>{t('scope.groupedBy', { value: activeGroupByLabel })}</div>
            {isAdmin ? (
              <div>{t('scope.userScope', { value: activeFilters.userId || t('scope.allUsers') })}</div>
            ) : (
              <div>{t('scope.userScope', { value: t('scope.currentUser') })}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 min-[480px]:grid-cols-2 xl:grid-cols-6">
        <StatCard
          title={t('stats.totalCost.title')}
          value={formatUsageCost(summary?.totals.totalCost ?? 0)}
          subtitle={t('stats.totalCost.subtitle')}
        />
        <StatCard
          title={t('stats.totalTokens.title')}
          value={String(summary?.totals.totalTokens ?? 0)}
          subtitle={t('stats.totalTokens.subtitle')}
        />
        <StatCard
          title={t('stats.input.title')}
          value={String(summary?.totals.inputTokens ?? 0)}
          subtitle={t('stats.input.subtitle')}
        />
        <StatCard
          title={t('stats.output.title')}
          value={String(summary?.totals.outputTokens ?? 0)}
          subtitle={t('stats.output.subtitle')}
        />
        <StatCard
          title={t('stats.cache.title')}
          value={String(summary?.totals.cacheTokens ?? 0)}
          subtitle={t('stats.cache.subtitle')}
        />
        <StatCard
          title={t('stats.sessions.title')}
          value={String(summary?.totals.sessionCount ?? 0)}
          subtitle={t('stats.sessions.subtitle', { count: summary?.totals.eventCount ?? 0 })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="border-border/70 bg-card/95">
          <CardHeader className="px-4 pb-3 sm:px-6">
            <CardTitle className="text-base">{t('summary.title')}</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="overflow-x-auto">
              <table data-testid="usage-summary-table" className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-0 py-2">{t('summary.columns.group')}</th>
                    <th className="px-0 py-2">{t('summary.columns.cost')}</th>
                    <th className="px-0 py-2">{t('summary.columns.tokens')}</th>
                    <th className="px-0 py-2">{t('summary.columns.sessions')}</th>
                    <th className="px-0 py-2">{t('summary.columns.events')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary?.rows.length ? (
                    summary.rows.map((row) => (
                      <tr key={row.groupKey} className="border-b border-border/60 align-top">
                        <td className="px-0 py-3">
                          <div className="font-medium">{row.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {t('summary.breakdown', {
                              input: row.inputTokens,
                              output: row.outputTokens,
                              cache: row.cacheTokens,
                            })}
                          </div>
                        </td>
                        <td className="px-0 py-3 font-medium">{formatUsageCost(row.totalCost)}</td>
                        <td className="px-0 py-3">{row.totalTokens}</td>
                        <td className="px-0 py-3">{row.sessionCount}</td>
                        <td className="px-0 py-3">{row.eventCount}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-0 py-6 text-sm text-muted-foreground">
                        {isLoading ? t('summary.loading') : t('summary.empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/95">
          <CardHeader className="px-4 pb-3 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <CardTitle className="text-base">{t('events.title')}</CardTitle>
              <div className="flex flex-col gap-2 min-[480px]:flex-row min-[480px]:items-center">
                <Button type="button" variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((prev) => prev - 1)}>
                  {t('events.previous')}
                </Button>
                <span className="text-xs text-muted-foreground">{t('events.page', { page })}</span>
                <Button type="button" variant="outline" size="sm" disabled={!canGoNext} onClick={() => setPage((prev) => prev + 1)}>
                  {t('events.next')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
            {events?.rows.length ? (
              <ScrollArea className="h-[24rem] md:h-[32rem]">
                <div className="space-y-3 pr-4">
                  {events.rows.map((row) => (
                    <div key={row.id} data-testid="usage-event-row" className="border border-border/70 bg-background/60 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="font-medium">
                            {row.sessionTitleSnapshot || row.sessionId}
                          </div>
                        <div className="text-xs text-muted-foreground">
                          {row.provider} / {row.model}
                          {isAdmin ? ` / ${row.userLabel}` : ''}
                          </div>
                        </div>
                        <div className="text-right text-sm font-medium">{formatUsageCost(row.totalCost)}</div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{formatTimestamp(row.assistantTimestamp)}</span>
                        <span>{t('events.tokens', { count: row.totalTokens })}</span>
                        <span>{t('events.inputOutput', { input: row.inputTokens, output: row.outputTokens })}</span>
                        <span>{t('events.cache', { count: row.cacheTokens })}</span>
                        <span>{row.stopReason}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <div className="py-6 text-sm text-muted-foreground">
                {isLoading ? t('events.loading') : t('events.empty')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
