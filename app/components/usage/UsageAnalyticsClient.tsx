'use client';

import { useEffect, useMemo, useState } from 'react';

import { BarChart3, CalendarRange, Filter, Layers3, RefreshCw } from 'lucide-react';

import { formatUsageCost, formatUsageTimestamp } from '@/app/lib/pi/usage-format';
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

const STOP_REASON_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'stop', label: 'stop' },
  { value: 'toolUse', label: 'toolUse' },
  { value: 'length', label: 'length' },
  { value: 'aborted', label: 'aborted' },
  { value: 'error', label: 'error' },
];

const GROUP_BY_OPTIONS: Array<{ value: UsageSummaryGroupBy; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'provider', label: 'Provider' },
  { value: 'model', label: 'Model' },
  { value: 'session', label: 'Session' },
  { value: 'user', label: 'User' },
];

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
  const [draftFilters, setDraftFilters] = useState<FilterState>(() => createDefaultFilters());
  const [activeFilters, setActiveFilters] = useState<FilterState>(() => createDefaultFilters());
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [events, setEvents] = useState<UsageEventsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => buildQueryString(activeFilters, page), [activeFilters, page]);
  const canGoNext = events ? page * events.pageSize < events.totalRows : false;

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
          throw new Error(summaryPayload.error || `Failed to load summary (${summaryRes.status})`);
        }

        if (!eventsRes.ok || !eventsPayload.success) {
          throw new Error(eventsPayload.error || `Failed to load events (${eventsRes.status})`);
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
  }, [queryString]);

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
    <div data-testid="usage-page" className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-border/70 bg-card/95">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted">
                <BarChart3 className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-xl">Usage Analytics</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Tokens und Kosten auf Basis der PI-Usage-Events ab Rollout des Ledgers.
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {[7, 30, 90].map((days) => (
                <Button
                  key={days}
                  type="button"
                  variant={days === 30 ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => setPresetRange(days)}
                >
                  Last {days}d
                </Button>
              ))}
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">From</span>
                <Input
                  type="date"
                  value={draftFilters.from}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, from: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">To</span>
                <Input
                  type="date"
                  value={draftFilters.to}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, to: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Provider</span>
                <Input
                  placeholder="openai, anthropic, ollama"
                  value={draftFilters.provider}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, provider: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Model</span>
                <Input
                  placeholder="gpt-4o, claude-sonnet-4"
                  value={draftFilters.model}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, model: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Session</span>
                <Input
                  placeholder="Session title or id"
                  value={draftFilters.sessionQuery}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, sessionQuery: event.target.value }))}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Stop reason</span>
                <select
                  className="flex h-10 w-full border border-border bg-background px-3 text-sm"
                  value={draftFilters.stopReason}
                  onChange={(event) => setDraftFilters((prev) => ({ ...prev, stopReason: event.target.value }))}
                >
                  {STOP_REASON_OPTIONS.map((option) => (
                    <option key={option.label} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Group by</span>
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
                  {GROUP_BY_OPTIONS.filter((option) => isAdmin || option.value !== 'user').map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {isAdmin ? (
                <label className="space-y-1 text-sm">
                  <span className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">User id</span>
                  <Input
                    placeholder="Optional admin-wide filter"
                    value={draftFilters.userId}
                    onChange={(event) => setDraftFilters((prev) => ({ ...prev, userId: event.target.value }))}
                  />
                </label>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" className="gap-2" onClick={applyFilters}>
                <Filter className="h-4 w-4" />
                Apply filters
              </Button>
              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={resetFilters}>
                <RefreshCw className="h-4 w-4" />
                Reset
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/95">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers3 className="h-4 w-4" />
              Active scope
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <div className="flex items-start gap-2">
              <CalendarRange className="mt-0.5 h-4 w-4 text-foreground" />
              <span>
                {activeFilters.from} to {activeFilters.to}
              </span>
            </div>
            <div>Provider: {activeFilters.provider || 'all'}</div>
            <div>Model: {activeFilters.model || 'all'}</div>
            <div>Session: {activeFilters.sessionQuery || 'all'}</div>
            <div>Stop reason: {activeFilters.stopReason || 'all'}</div>
            <div>Grouped by: {activeFilters.groupBy}</div>
            {isAdmin ? <div>User scope: {activeFilters.userId || 'all users'}</div> : <div>User scope: current user</div>}
          </CardContent>
        </Card>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/10">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <StatCard
          title="Total cost"
          value={formatUsageCost(summary?.totals.totalCost ?? 0)}
          subtitle="PI pricing based"
        />
        <StatCard
          title="Total tokens"
          value={String(summary?.totals.totalTokens ?? 0)}
          subtitle="Across filtered usage events"
        />
        <StatCard
          title="Input"
          value={String(summary?.totals.inputTokens ?? 0)}
          subtitle="Prompt and context tokens"
        />
        <StatCard
          title="Output"
          value={String(summary?.totals.outputTokens ?? 0)}
          subtitle="Assistant generation tokens"
        />
        <StatCard
          title="Cache"
          value={String(summary?.totals.cacheTokens ?? 0)}
          subtitle="Read and write cache tokens"
        />
        <StatCard
          title="Sessions"
          value={String(summary?.totals.sessionCount ?? 0)}
          subtitle={`${summary?.totals.eventCount ?? 0} usage events`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="border-border/70 bg-card/95">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Grouped summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table data-testid="usage-summary-table" className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-0 py-2">Group</th>
                    <th className="px-0 py-2">Cost</th>
                    <th className="px-0 py-2">Tokens</th>
                    <th className="px-0 py-2">Sessions</th>
                    <th className="px-0 py-2">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {summary?.rows.length ? (
                    summary.rows.map((row) => (
                      <tr key={row.groupKey} className="border-b border-border/60 align-top">
                        <td className="px-0 py-3">
                          <div className="font-medium">{row.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {row.inputTokens} in / {row.outputTokens} out / {row.cacheTokens} cache
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
                        {isLoading ? 'Loading summary...' : 'No usage events found for the current filters.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/95">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">Recent usage events</CardTitle>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((prev) => prev - 1)}>
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">Page {page}</span>
                <Button type="button" variant="outline" size="sm" disabled={!canGoNext} onClick={() => setPage((prev) => prev + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
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
                        <span>{formatUsageTimestamp(row.assistantTimestamp)}</span>
                        <span>{row.totalTokens} tok</span>
                        <span>{row.inputTokens} in / {row.outputTokens} out</span>
                        <span>{row.cacheTokens} cache</span>
                        <span>{row.stopReason}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <div className="py-6 text-sm text-muted-foreground">
                {isLoading ? 'Loading events...' : 'No usage events found for the current filters.'}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
