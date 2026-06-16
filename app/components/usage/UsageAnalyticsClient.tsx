'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { BarChart3, CalendarRange, Filter, Layers3, RefreshCw } from 'lucide-react';

import type {
  UsageEventsResponse,
  UsageSummaryGroupBy,
  UsageSummaryRow,
  UsageSummaryResponse,
  UsageUserOption,
  UsageUsersResponse,
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

const FILTER_FIELD_CLASS_NAME = 'min-w-0 space-y-1 text-sm';
const FILTER_LABEL_CLASS_NAME = 'block truncate text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground';
const FILTER_SELECT_CLASS_NAME = 'flex h-10 w-full min-w-0 max-w-full border border-border bg-background px-3 text-sm';

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

function buildUsersQueryString(filters: FilterState): string {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
  });

  return params.toString();
}

function safeNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
        <div className="break-words text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
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
  const [users, setUsers] = useState<UsageUsersResponse | null>(null);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => buildQueryString(activeFilters, page), [activeFilters, page]);
  const usersQueryString = useMemo(() => buildUsersQueryString(activeFilters), [activeFilters]);
  const canGoNext = events ? page * events.pageSize < events.totalRows : false;
  const activeStopReasonLabel =
    stopReasonOptions.find((option) => option.value === activeFilters.stopReason)?.label || t('scope.all');
  const activeGroupByLabel =
    groupByOptions.find((option) => option.value === activeFilters.groupBy)?.label || activeFilters.groupBy;
  const summaryRows = summary?.rows ?? [];
  const userOptions = users?.users ?? [];
  const integerFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 0,
      }),
    [locale],
  );
  const costFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [locale],
  );

  const formatInteger = (value: number | null | undefined) => integerFormatter.format(safeNumber(value));
  const formatCost = (value: number | null | undefined) => costFormatter.format(safeNumber(value));
  const formatSummaryBreakdown = (row: UsageSummaryRow) =>
    t('summary.breakdown', {
      input: formatInteger(row.inputTokens),
      output: formatInteger(row.outputTokens),
      cache: formatInteger(row.cacheTokens),
    });
  const formatUserOptionLabel = (userOption: UsageUserOption) =>
    t('filters.userOption', {
      label: userOption.label,
      count: formatInteger(userOption.usageEventCount),
    });
  const activeUserLabel =
    activeFilters.userId
      ? userOptions.find((userOption) => userOption.id === activeFilters.userId)?.label || activeFilters.userId
      : t('scope.allUsers');

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
        const [summaryRes, eventsRes, usersRes] = await Promise.all([
          fetch(`/api/usage/summary?${queryString}`),
          fetch(`/api/usage/events?${queryString}`),
          isAdmin ? fetch(`/api/usage/users?${usersQueryString}`) : Promise.resolve(null),
        ]);

        const summaryPayload = await summaryRes.json();
        const eventsPayload = await eventsRes.json();
        const usersPayload = usersRes ? await usersRes.json() : null;

        if (!summaryRes.ok || !summaryPayload.success) {
          throw new Error(summaryPayload.error || t('errors.loadSummary', { status: summaryRes.status }));
        }

        if (!eventsRes.ok || !eventsPayload.success) {
          throw new Error(eventsPayload.error || t('errors.loadEvents', { status: eventsRes.status }));
        }

        if (usersRes && (!usersRes.ok || !usersPayload.success)) {
          throw new Error(usersPayload.error || t('errors.loadUsers', { status: usersRes.status }));
        }

        if (!cancelled) {
          setSummary(summaryPayload as UsageSummaryResponse);
          setEvents(eventsPayload as UsageEventsResponse);
          setUsers(usersPayload ? usersPayload as UsageUsersResponse : null);
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
  }, [isAdmin, queryString, t, usersQueryString]);

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
    <div data-testid="usage-page" className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-5 px-4 py-5 md:px-6 md:gap-6 md:py-8">
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <Card className="min-w-0 border-border/70 bg-card/95">
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

            <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className={FILTER_FIELD_CLASS_NAME}>
                <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.from')}</span>
                <Input
                  type="date"
                  value={draftFilters.from}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, from: event.target.value }))}
                />
              </label>
              <label className={FILTER_FIELD_CLASS_NAME}>
                <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.to')}</span>
                <Input
                  type="date"
                  value={draftFilters.to}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, to: event.target.value }))}
                />
              </label>
              <label className={FILTER_FIELD_CLASS_NAME}>
                <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.provider')}</span>
                <Input
                  placeholder={t('filters.providerPlaceholder')}
                  value={draftFilters.provider}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, provider: event.target.value }))}
                />
              </label>
              <label className={FILTER_FIELD_CLASS_NAME}>
                <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.model')}</span>
                <Input
                  placeholder={t('filters.modelPlaceholder')}
                  value={draftFilters.model}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, model: event.target.value }))}
                />
              </label>
              <label className={FILTER_FIELD_CLASS_NAME}>
                <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.session')}</span>
                <Input
                  placeholder={t('filters.sessionPlaceholder')}
                  value={draftFilters.sessionQuery}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, sessionQuery: event.target.value }))}
                />
              </label>
              <label className={FILTER_FIELD_CLASS_NAME}>
                <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.stopReason')}</span>
                <select
                  className={FILTER_SELECT_CLASS_NAME}
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
              <label className={FILTER_FIELD_CLASS_NAME}>
                <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.groupBy')}</span>
                <select
                  className={FILTER_SELECT_CLASS_NAME}
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
                <label className={FILTER_FIELD_CLASS_NAME}>
                  <span className={FILTER_LABEL_CLASS_NAME}>{t('filters.user')}</span>
                  <select
                    className={FILTER_SELECT_CLASS_NAME}
                    value={draftFilters.userId}
                    onChange={(event) => setDraftFilters((prev) => ({ ...prev, userId: event.target.value }))}
                  >
                    <option value="">{t('filters.allUsers')}</option>
                    {userOptions.map((userOption) => (
                      <option key={userOption.id} value={userOption.id}>
                        {formatUserOptionLabel(userOption)}
                      </option>
                    ))}
                  </select>
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

        <Card className="min-w-0 border-border/70 bg-card/95">
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
              <div>{t('scope.userScope', { value: activeUserLabel })}</div>
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
          value={formatCost(summary?.totals.totalCost)}
          subtitle={t('stats.totalCost.subtitle')}
        />
        <StatCard
          title={t('stats.totalTokens.title')}
          value={formatInteger(summary?.totals.totalTokens)}
          subtitle={t('stats.totalTokens.subtitle')}
        />
        <StatCard
          title={t('stats.input.title')}
          value={formatInteger(summary?.totals.inputTokens)}
          subtitle={t('stats.input.subtitle')}
        />
        <StatCard
          title={t('stats.output.title')}
          value={formatInteger(summary?.totals.outputTokens)}
          subtitle={t('stats.output.subtitle')}
        />
        <StatCard
          title={t('stats.cache.title')}
          value={formatInteger(summary?.totals.cacheTokens)}
          subtitle={t('stats.cache.subtitle')}
        />
        <StatCard
          title={t('stats.sessions.title')}
          value={formatInteger(summary?.totals.sessionCount)}
          subtitle={t('stats.sessions.subtitle', { count: formatInteger(summary?.totals.eventCount) })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="min-w-0 border-border/70 bg-card/95">
          <CardHeader className="px-4 pb-3 sm:px-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-base">{t('summary.title')}</CardTitle>
              <span className="w-fit border border-border/70 bg-muted/70 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {activeGroupByLabel}
              </span>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
            <div data-testid="usage-summary-desktop" className="hidden overflow-x-auto rounded-md border border-border/70 md:block">
              <table data-testid="usage-summary-table" className="min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/60 text-left text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    <th className="w-[42%] px-3 py-2.5">{t('summary.columns.group')}</th>
                    <th className="w-[16%] px-3 py-2.5 text-right">{t('summary.columns.cost')}</th>
                    <th className="w-[18%] px-3 py-2.5 text-right">{t('summary.columns.tokens')}</th>
                    <th className="w-[12%] px-3 py-2.5 text-right">{t('summary.columns.sessions')}</th>
                    <th className="w-[12%] px-3 py-2.5 text-right">{t('summary.columns.events')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {summaryRows.length ? (
                    summaryRows.map((row) => (
                      <tr key={row.groupKey} className="align-top transition-colors hover:bg-muted/35">
                        <td className="min-w-0 px-3 py-3">
                          <div className="break-words font-medium leading-snug">{row.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatSummaryBreakdown(row)}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right font-medium tabular-nums">{formatCost(row.totalCost)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatInteger(row.totalTokens)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatInteger(row.sessionCount)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatInteger(row.eventCount)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-sm text-muted-foreground">
                        {isLoading ? t('summary.loading') : t('summary.empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div data-testid="usage-summary-mobile" className="divide-y divide-border rounded-md border border-border/70 md:hidden">
              {summaryRows.length ? (
                summaryRows.map((row) => (
                  <article key={row.groupKey} data-testid="usage-summary-mobile-row" className="space-y-3 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="break-words font-medium leading-snug">{row.label}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{formatSummaryBreakdown(row)}</div>
                      </div>
                      <div className="shrink-0 text-right text-sm font-semibold tabular-nums">{formatCost(row.totalCost)}</div>
                    </div>
                    <dl className="grid grid-cols-3 gap-2 text-xs">
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">{t('summary.columns.tokens')}</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">{formatInteger(row.totalTokens)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">{t('summary.columns.sessions')}</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">{formatInteger(row.sessionCount)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">{t('summary.columns.events')}</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">{formatInteger(row.eventCount)}</dd>
                      </div>
                    </dl>
                  </article>
                ))
              ) : (
                <div className="p-4 text-sm text-muted-foreground">
                  {isLoading ? t('summary.loading') : t('summary.empty')}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 border-border/70 bg-card/95">
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
                        <div className="text-right text-sm font-medium tabular-nums">{formatCost(row.totalCost)}</div>
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
