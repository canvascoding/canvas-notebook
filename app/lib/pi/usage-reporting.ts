import { and, asc, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm';

import { db } from '../db';
import { piUsageEvents, user } from '../db/schema';
import type { UsageSummaryGroupBy } from './usage-events';

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_SUMMARY_LIMIT = 100;

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

export type UsageSummaryResponse = {
  filters: ReturnType<typeof serializeUsageFilters>;
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
  filters: ReturnType<typeof serializeUsageFilters>;
  page: number;
  pageSize: number;
  totalRows: number;
  rows: UsageEventRow[];
};

type UsageAccess = {
  effectiveUserId?: string;
  isAdmin: boolean;
};

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

function parseDateBoundary(value: string | null, boundary: 'start' | 'end'): Date | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const suffix = boundary === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
    const parsed = new Date(`${trimmed}${suffix}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createDefaultWindow(now = new Date()) {
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (DEFAULT_WINDOW_DAYS - 1));
  from.setUTCHours(0, 0, 0, 0);
  to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

function normalizeOptionalString(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseGroupBy(value: string | null): UsageSummaryGroupBy {
  switch (value) {
    case 'provider':
    case 'model':
    case 'user':
    case 'session':
      return value;
    default:
      return 'day';
  }
}

export function parseUsageFilters(searchParams: URLSearchParams): UsageFilters {
  const fallback = createDefaultWindow();
  const from = parseDateBoundary(searchParams.get('from'), 'start') ?? fallback.from;
  const to = parseDateBoundary(searchParams.get('to'), 'end') ?? fallback.to;

  return {
    from,
    to,
    provider: normalizeOptionalString(searchParams.get('provider')),
    model: normalizeOptionalString(searchParams.get('model')),
    sessionId: normalizeOptionalString(searchParams.get('sessionId')),
    sessionQuery: normalizeOptionalString(searchParams.get('sessionQuery')),
    stopReason: normalizeOptionalString(searchParams.get('stopReason')),
    groupBy: parseGroupBy(searchParams.get('groupBy')),
    userId: normalizeOptionalString(searchParams.get('userId')),
  };
}

export function parsePage(searchParams: URLSearchParams): number {
  const raw = Number.parseInt(searchParams.get('page') || '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function parsePageSize(searchParams: URLSearchParams): number {
  const raw = Number.parseInt(searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PAGE_SIZE;
  }

  return Math.min(raw, MAX_PAGE_SIZE);
}

function buildSessionQueryPattern(value: string): string {
  return `%${value.replace(/[%_]/g, '\\$&')}%`;
}

function serializeUsageFilters(filters: UsageFilters, access: UsageAccess) {
  return {
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
    provider: filters.provider ?? null,
    model: filters.model ?? null,
    sessionId: filters.sessionId ?? null,
    sessionQuery: filters.sessionQuery ?? null,
    stopReason: filters.stopReason ?? null,
    groupBy: filters.groupBy,
    userId: access.effectiveUserId ?? null,
  };
}

export function resolveUsageAccess(
  filters: UsageFilters,
  viewer: { id: string; role?: string | null },
): UsageAccess {
  const isAdmin = viewer.role === 'admin';

  if (filters.userId && !isAdmin) {
    throw new Error('FORBIDDEN_USER_FILTER');
  }

  if (filters.groupBy === 'user' && !isAdmin) {
    throw new Error('FORBIDDEN_USER_GROUPING');
  }

  return {
    effectiveUserId: filters.userId ?? (isAdmin ? undefined : viewer.id),
    isAdmin,
  };
}

function buildWhere(filters: UsageFilters, access: UsageAccess) {
  const conditions = [
    gte(piUsageEvents.assistantTimestamp, filters.from),
    lte(piUsageEvents.assistantTimestamp, filters.to),
  ];

  if (access.effectiveUserId) {
    conditions.push(eq(piUsageEvents.userId, access.effectiveUserId));
  }

  if (filters.provider) {
    conditions.push(eq(piUsageEvents.provider, filters.provider));
  }

  if (filters.model) {
    conditions.push(eq(piUsageEvents.model, filters.model));
  }

  if (filters.sessionId) {
    conditions.push(eq(piUsageEvents.sessionId, filters.sessionId));
  }

  if (filters.stopReason) {
    conditions.push(eq(piUsageEvents.stopReason, filters.stopReason));
  }

  if (filters.sessionQuery) {
    const pattern = buildSessionQueryPattern(filters.sessionQuery);
    conditions.push(
      or(
        like(piUsageEvents.sessionId, pattern),
        like(piUsageEvents.sessionTitleSnapshot, pattern),
      )!,
    );
  }

  return and(...conditions);
}

async function loadTotals(whereClause: ReturnType<typeof buildWhere>): Promise<UsageTotals> {
  const totalCostExpr = sql<number>`coalesce(sum(${piUsageEvents.totalCost}), 0)`;
  const totalTokensExpr = sql<number>`coalesce(sum(${piUsageEvents.totalTokens}), 0)`;
  const inputTokensExpr = sql<number>`coalesce(sum(${piUsageEvents.inputTokens}), 0)`;
  const outputTokensExpr = sql<number>`coalesce(sum(${piUsageEvents.outputTokens}), 0)`;
  const cacheTokensExpr =
    sql<number>`coalesce(sum(${piUsageEvents.cacheReadTokens} + ${piUsageEvents.cacheWriteTokens}), 0)`;
  const sessionCountExpr = sql<number>`count(distinct ${piUsageEvents.sessionId})`;
  const eventCountExpr = sql<number>`count(*)`;

  const [row] = await db
    .select({
      totalCost: totalCostExpr,
      totalTokens: totalTokensExpr,
      inputTokens: inputTokensExpr,
      outputTokens: outputTokensExpr,
      cacheTokens: cacheTokensExpr,
      sessionCount: sessionCountExpr,
      eventCount: eventCountExpr,
    })
    .from(piUsageEvents)
    .where(whereClause);

  return {
    totalCost: toNumber(row?.totalCost),
    totalTokens: toNumber(row?.totalTokens),
    inputTokens: toNumber(row?.inputTokens),
    outputTokens: toNumber(row?.outputTokens),
    cacheTokens: toNumber(row?.cacheTokens),
    sessionCount: toNumber(row?.sessionCount),
    eventCount: toNumber(row?.eventCount),
  };
}

function getGrouping(filters: UsageFilters) {
  switch (filters.groupBy) {
    case 'provider':
      return {
        groupKey: piUsageEvents.provider,
        label: piUsageEvents.provider,
        orderBy: desc(sql<number>`coalesce(sum(${piUsageEvents.totalCost}), 0)`),
      };
    case 'model':
      return {
        groupKey: piUsageEvents.model,
        label: piUsageEvents.model,
        orderBy: desc(sql<number>`coalesce(sum(${piUsageEvents.totalCost}), 0)`),
      };
    case 'user':
      return {
        groupKey: piUsageEvents.userId,
        label: sql<string>`coalesce(${user.name}, ${user.email}, ${piUsageEvents.userId})`,
        orderBy: desc(sql<number>`coalesce(sum(${piUsageEvents.totalCost}), 0)`),
      };
    case 'session':
      return {
        groupKey: piUsageEvents.sessionId,
        label: sql<string>`coalesce(nullif(${piUsageEvents.sessionTitleSnapshot}, ''), ${piUsageEvents.sessionId})`,
        orderBy: desc(sql<number>`coalesce(sum(${piUsageEvents.totalCost}), 0)`),
      };
    case 'day':
    default:
      return {
        groupKey: sql<string>`strftime('%Y-%m-%d', ${piUsageEvents.assistantTimestamp} / 1000, 'unixepoch')`,
        label: sql<string>`strftime('%Y-%m-%d', ${piUsageEvents.assistantTimestamp} / 1000, 'unixepoch')`,
        orderBy: asc(sql<string>`strftime('%Y-%m-%d', ${piUsageEvents.assistantTimestamp} / 1000, 'unixepoch')`),
      };
  }
}

export async function getUsageSummary(
  filters: UsageFilters,
  viewer: { id: string; role?: string | null },
): Promise<UsageSummaryResponse> {
  const access = resolveUsageAccess(filters, viewer);
  const whereClause = buildWhere(filters, access);
  const totals = await loadTotals(whereClause);
  const grouping = getGrouping(filters);
  const groupKeyExpr = grouping.groupKey.as('groupKey');
  const labelExpr = grouping.label.as('label');
  const totalCostExpr = sql<number>`coalesce(sum(${piUsageEvents.totalCost}), 0)`.as('totalCost');
  const totalTokensExpr = sql<number>`coalesce(sum(${piUsageEvents.totalTokens}), 0)`.as('totalTokens');
  const inputTokensExpr = sql<number>`coalesce(sum(${piUsageEvents.inputTokens}), 0)`.as('inputTokens');
  const outputTokensExpr = sql<number>`coalesce(sum(${piUsageEvents.outputTokens}), 0)`.as('outputTokens');
  const cacheTokensExpr =
    sql<number>`coalesce(sum(${piUsageEvents.cacheReadTokens} + ${piUsageEvents.cacheWriteTokens}), 0)`.as('cacheTokens');
  const sessionCountExpr = sql<number>`count(distinct ${piUsageEvents.sessionId})`.as('sessionCount');
  const eventCountExpr = sql<number>`count(*)`.as('eventCount');

  const rows = await db
    .select({
      groupKey: groupKeyExpr,
      label: labelExpr,
      totalCost: totalCostExpr,
      totalTokens: totalTokensExpr,
      inputTokens: inputTokensExpr,
      outputTokens: outputTokensExpr,
      cacheTokens: cacheTokensExpr,
      sessionCount: sessionCountExpr,
      eventCount: eventCountExpr,
    })
    .from(piUsageEvents)
    .leftJoin(user, eq(piUsageEvents.userId, user.id))
    .where(whereClause)
    .groupBy(groupKeyExpr, labelExpr)
    .orderBy(grouping.orderBy)
    .limit(DEFAULT_SUMMARY_LIMIT);

  return {
    filters: serializeUsageFilters(filters, access),
    totals,
    rows: rows.map((row) => ({
      groupKey: row.groupKey,
      label: row.label,
      totalCost: toNumber(row.totalCost),
      totalTokens: toNumber(row.totalTokens),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      cacheTokens: toNumber(row.cacheTokens),
      sessionCount: toNumber(row.sessionCount),
      eventCount: toNumber(row.eventCount),
    })),
  };
}

export async function getUsageEvents(
  filters: UsageFilters,
  viewer: { id: string; role?: string | null },
  page: number,
  pageSize: number,
): Promise<UsageEventsResponse> {
  const access = resolveUsageAccess(filters, viewer);
  const whereClause = buildWhere(filters, access);
  const [{ totalRows }] = await db
    .select({
      totalRows: sql<number>`count(*)`,
    })
    .from(piUsageEvents)
    .where(whereClause);

  const rows = await db
    .select({
      id: piUsageEvents.id,
      userId: piUsageEvents.userId,
      userLabel: sql<string>`coalesce(${user.name}, ${user.email}, ${piUsageEvents.userId})`,
      sessionId: piUsageEvents.sessionId,
      sessionTitleSnapshot: piUsageEvents.sessionTitleSnapshot,
      provider: piUsageEvents.provider,
      model: piUsageEvents.model,
      stopReason: piUsageEvents.stopReason,
      assistantTimestamp: piUsageEvents.assistantTimestamp,
      totalTokens: piUsageEvents.totalTokens,
      inputTokens: piUsageEvents.inputTokens,
      outputTokens: piUsageEvents.outputTokens,
      cacheTokens: sql<number>`${piUsageEvents.cacheReadTokens} + ${piUsageEvents.cacheWriteTokens}`,
      totalCost: piUsageEvents.totalCost,
    })
    .from(piUsageEvents)
    .leftJoin(user, eq(piUsageEvents.userId, user.id))
    .where(whereClause)
    .orderBy(desc(piUsageEvents.assistantTimestamp))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    filters: serializeUsageFilters(filters, access),
    page,
    pageSize,
    totalRows: toNumber(totalRows),
    rows: rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      userLabel: row.userLabel,
      sessionId: row.sessionId,
      sessionTitleSnapshot: row.sessionTitleSnapshot,
      provider: row.provider,
      model: row.model,
      stopReason: row.stopReason,
      assistantTimestamp: row.assistantTimestamp.toISOString(),
      totalTokens: toNumber(row.totalTokens),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      cacheTokens: toNumber(row.cacheTokens),
      totalCost: toNumber(row.totalCost),
    })),
  };
}
