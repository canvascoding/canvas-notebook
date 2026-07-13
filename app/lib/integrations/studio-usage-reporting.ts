import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import { studioGenerationOutputs, studioGenerations, user } from '@/app/lib/db/schema';

import type {
  SerializedStudioUsageFilters,
  StudioUsageBreakdownBy,
  StudioUsageDashboardResponse,
  StudioUsageFilters,
  StudioUsageMediaType,
} from './studio-usage-types';

const DEFAULT_WINDOW_DAYS = 30;
const DASHBOARD_BREAKDOWN_LIMIT = 8;
const MEDIA_TYPES = new Set<StudioUsageMediaType>(['image', 'video', 'sound']);

type StudioUsageAccess = {
  effectiveUserId?: string;
  isAdmin: boolean;
};

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

function parseDateBoundary(value: string | null, boundary: 'start' | 'end'): Date | null {
  if (!value?.trim()) return null;

  const trimmed = value.trim();
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
  return trimmed || undefined;
}

function parseMediaType(value: string | null): StudioUsageMediaType | undefined {
  const trimmed = value?.trim();
  return trimmed && MEDIA_TYPES.has(trimmed as StudioUsageMediaType)
    ? trimmed as StudioUsageMediaType
    : undefined;
}

export function parseStudioUsageFilters(searchParams: URLSearchParams): StudioUsageFilters {
  const fallback = createDefaultWindow();

  return {
    from: parseDateBoundary(searchParams.get('from'), 'start') ?? fallback.from,
    to: parseDateBoundary(searchParams.get('to'), 'end') ?? fallback.to,
    userId: normalizeOptionalString(searchParams.get('userId')),
    provider: normalizeOptionalString(searchParams.get('provider')),
    model: normalizeOptionalString(searchParams.get('model')),
    mediaType: parseMediaType(searchParams.get('studioMediaType')),
    status: normalizeOptionalString(searchParams.get('studioStatus')),
  };
}

function resolveStudioUsageAccess(
  filters: StudioUsageFilters,
  viewer: { id: string; role?: string | null },
): StudioUsageAccess {
  const isAdmin = viewer.role === 'admin';
  if (filters.userId && !isAdmin) {
    throw new Error('FORBIDDEN_USER_FILTER');
  }

  return {
    effectiveUserId: filters.userId ?? (isAdmin ? undefined : viewer.id),
    isAdmin,
  };
}

function creatorCondition(userId: string) {
  return sql`coalesce(${studioGenerations.createdByUserId}, ${studioGenerations.userId}) = ${userId}`;
}

function buildGenerationWhere(filters: StudioUsageFilters, access: StudioUsageAccess) {
  const conditions = [
    gte(studioGenerations.createdAt, filters.from),
    lte(studioGenerations.createdAt, filters.to),
  ];

  if (access.effectiveUserId) conditions.push(creatorCondition(access.effectiveUserId));
  if (filters.provider) conditions.push(eq(studioGenerations.provider, filters.provider));
  if (filters.model) conditions.push(eq(studioGenerations.model, filters.model));
  if (filters.mediaType) conditions.push(eq(studioGenerations.mode, filters.mediaType));
  if (filters.status) conditions.push(eq(studioGenerations.status, filters.status));

  return and(...conditions);
}

function buildOutputWhere(filters: StudioUsageFilters, access: StudioUsageAccess) {
  const conditions = [
    gte(studioGenerationOutputs.createdAt, filters.from),
    lte(studioGenerationOutputs.createdAt, filters.to),
  ];

  if (access.effectiveUserId) conditions.push(creatorCondition(access.effectiveUserId));
  if (filters.provider) conditions.push(eq(studioGenerations.provider, filters.provider));
  if (filters.model) conditions.push(eq(studioGenerations.model, filters.model));
  if (filters.mediaType) conditions.push(eq(studioGenerationOutputs.type, filters.mediaType));
  if (filters.status) conditions.push(eq(studioGenerations.status, filters.status));

  return and(...conditions);
}

function serializeFilters(filters: StudioUsageFilters, access: StudioUsageAccess): SerializedStudioUsageFilters {
  return {
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
    userId: access.effectiveUserId ?? null,
    provider: filters.provider ?? null,
    model: filters.model ?? null,
    mediaType: filters.mediaType ?? null,
    status: filters.status ?? null,
  };
}

function dayExpression() {
  if (getDatabaseProvider() === 'postgres') {
    return sql<string>`to_char(to_timestamp(${studioGenerationOutputs.createdAt}), 'YYYY-MM-DD')`;
  }

  return sql<string>`strftime('%Y-%m-%d', ${studioGenerationOutputs.createdAt}, 'unixepoch')`;
}

async function loadGenerationTotals(whereClause: ReturnType<typeof buildGenerationWhere>) {
  const [row] = await db
    .select({
      generationCount: sql<number>`count(*)`,
      completedGenerationCount: sql<number>`coalesce(sum(case when ${studioGenerations.status} = 'completed' then 1 else 0 end), 0)`,
      failedGenerationCount: sql<number>`coalesce(sum(case when ${studioGenerations.status} = 'failed' then 1 else 0 end), 0)`,
    })
    .from(studioGenerations)
    .where(whereClause);

  return {
    generationCount: toNumber(row?.generationCount),
    completedGenerationCount: toNumber(row?.completedGenerationCount),
    failedGenerationCount: toNumber(row?.failedGenerationCount),
  };
}

async function loadOutputTotals(whereClause: ReturnType<typeof buildOutputWhere>) {
  const [row] = await db
    .select({
      outputCount: sql<number>`count(*)`,
      imageCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'image' then 1 else 0 end), 0)`,
      videoCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'video' then 1 else 0 end), 0)`,
      soundCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'sound' then 1 else 0 end), 0)`,
    })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .where(whereClause);

  return {
    outputCount: toNumber(row?.outputCount),
    imageCount: toNumber(row?.imageCount),
    videoCount: toNumber(row?.videoCount),
    soundCount: toNumber(row?.soundCount),
  };
}

async function loadTimeline(whereClause: ReturnType<typeof buildOutputWhere>) {
  const day = dayExpression();
  const rows = await db
    .select({
      day,
      imageCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'image' then 1 else 0 end), 0)`,
      videoCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'video' then 1 else 0 end), 0)`,
      soundCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'sound' then 1 else 0 end), 0)`,
      outputCount: sql<number>`count(*)`,
    })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .where(whereClause)
    .groupBy(day)
    .orderBy(asc(day));

  return rows.map((row) => ({
    day: row.day,
    imageCount: toNumber(row.imageCount),
    videoCount: toNumber(row.videoCount),
    soundCount: toNumber(row.soundCount),
    outputCount: toNumber(row.outputCount),
  }));
}

function getBreakdownGrouping(breakdownBy: StudioUsageBreakdownBy) {
  switch (breakdownBy) {
    case 'user': {
      const ownerId = sql<string>`coalesce(${studioGenerations.createdByUserId}, ${studioGenerations.userId})`;
      return {
        groupKey: ownerId,
        label: sql<string>`coalesce(${user.name}, ${user.email}, ${ownerId})`,
      };
    }
    case 'provider':
      return {
        groupKey: studioGenerations.provider,
        label: studioGenerations.provider,
      };
    case 'model':
    default:
      return {
        groupKey: studioGenerations.model,
        label: studioGenerations.model,
      };
  }
}

async function loadBreakdown(
  whereClause: ReturnType<typeof buildOutputWhere>,
  breakdownBy: StudioUsageBreakdownBy,
) {
  const grouping = getBreakdownGrouping(breakdownBy);
  const outputCount = sql<number>`count(*)`;
  const rows = await db
    .select({
      groupKey: grouping.groupKey,
      label: grouping.label,
      outputCount,
      imageCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'image' then 1 else 0 end), 0)`,
      videoCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'video' then 1 else 0 end), 0)`,
      soundCount: sql<number>`coalesce(sum(case when ${studioGenerationOutputs.type} = 'sound' then 1 else 0 end), 0)`,
    })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .leftJoin(user, sql`${user.id} = coalesce(${studioGenerations.createdByUserId}, ${studioGenerations.userId})`)
    .where(whereClause)
    .groupBy(grouping.groupKey, grouping.label)
    .orderBy(desc(outputCount))
    .limit(DASHBOARD_BREAKDOWN_LIMIT);

  return rows.map((row) => ({
    groupKey: row.groupKey,
    label: row.label,
    outputCount: toNumber(row.outputCount),
    imageCount: toNumber(row.imageCount),
    videoCount: toNumber(row.videoCount),
    soundCount: toNumber(row.soundCount),
  }));
}

export async function getStudioUsageDashboard(
  filters: StudioUsageFilters,
  viewer: { id: string; role?: string | null },
): Promise<StudioUsageDashboardResponse> {
  const access = resolveStudioUsageAccess(filters, viewer);
  const generationWhere = buildGenerationWhere(filters, access);
  const outputWhere = buildOutputWhere(filters, access);
  const breakdownBy: StudioUsageBreakdownBy =
    access.isAdmin && !access.effectiveUserId ? 'user' : filters.model ? 'provider' : 'model';

  const [generationTotals, outputTotals, timeline, breakdown] = await Promise.all([
    loadGenerationTotals(generationWhere),
    loadOutputTotals(outputWhere),
    loadTimeline(outputWhere),
    loadBreakdown(outputWhere, breakdownBy),
  ]);

  return {
    filters: serializeFilters(filters, access),
    totals: { ...generationTotals, ...outputTotals },
    timeline,
    breakdownBy,
    breakdown,
  };
}
