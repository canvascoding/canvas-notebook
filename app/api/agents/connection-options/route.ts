import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getGatewayStatus, getGatewayToolkits } from '@/app/lib/composio/composio-gateway';
import { getMcpRuntimeStatus } from '@/app/lib/mcp/manager';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type AgentConnectionOption = {
  id: string;
  label: string;
  kind: 'mcp' | 'composio';
  toolCount: number;
  logoUrl?: string | null;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

function parsePositiveInteger(value: string | null, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const integer = Math.floor(parsed);
  return max ? Math.min(integer, max) : integer;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toToolkitSummary(value: unknown) {
  const record = asRecord(value);
  const slug = stringValue(record.slug);
  const name = stringValue(record.name) || slug;
  const toolsCount = numberValue(record.toolsCount) ?? numberValue(record.toolCount);
  return {
    slug,
    name,
    logo: stringValue(record.logo),
    toolsCount: toolsCount ?? (Array.isArray(record.tools) ? record.tools.length : 0),
  };
}

function matchesQuery(option: AgentConnectionOption, query: string): boolean {
  if (!query) return true;
  const haystack = [option.id, option.label, option.kind].join('\n').toLowerCase();
  return haystack.includes(query);
}

function paginate<T>(items: T[], page: number, limit: number): { items: T[]; pagination: Pagination } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * limit;

  return {
    items: items.slice(start, start + limit),
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    },
  };
}

async function loadMcpOptions(): Promise<AgentConnectionOption[]> {
  const runtime = await getMcpRuntimeStatus();
  return runtime.servers
    .filter((server) => server.enabled)
    .map((server) => ({
      id: `mcp:${server.name}`,
      kind: 'mcp' as const,
      label: server.name,
      toolCount: server.cachedToolCount || 0,
      logoUrl: `/api/integrations/mcp-icon/${encodeURIComponent(server.name)}`,
    }));
}

async function loadComposioOptions(): Promise<AgentConnectionOption[]> {
  const status = await getGatewayStatus();
  if (!status.configured || !status.apiKeyValid || status.connectedAccounts.length === 0) {
    return [];
  }

  let toolkitSummaryBySlug = new Map<string, ReturnType<typeof toToolkitSummary>>();
  try {
    const result = await getGatewayToolkits();
    if (Array.isArray(result.toolkits)) {
      toolkitSummaryBySlug = new Map(
        result.toolkits
          .map(toToolkitSummary)
          .filter((toolkit) => toolkit.slug)
          .map((toolkit) => [toolkit.slug, toolkit]),
      );
    }
  } catch {
    toolkitSummaryBySlug = new Map();
  }

  return status.connectedAccounts
    .filter((account) => account.toolkit.slug)
    .map((account) => {
      const toolkit = toolkitSummaryBySlug.get(account.toolkit.slug);
      return {
        id: `composio:${account.toolkit.slug}`,
        kind: 'composio' as const,
        label: account.toolkit.name || toolkit?.name || account.toolkit.slug,
        toolCount: toolkit?.toolsCount || 0,
        logoUrl: toolkit?.logo || null,
      };
    });
}

export async function GET(request: NextRequest) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-connection-options',
  });
  if (!limited.ok) return limited.response;

  try {
    const query = request.nextUrl.searchParams.get('query')?.trim().toLowerCase() || '';
    const page = parsePositiveInteger(request.nextUrl.searchParams.get('page'), 1);
    const limit = parsePositiveInteger(request.nextUrl.searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT);
    const [mcpResult, composioResult] = await Promise.allSettled([
      loadMcpOptions(),
      loadComposioOptions(),
    ]);
    const options = [
      ...(mcpResult.status === 'fulfilled' ? mcpResult.value : []),
      ...(composioResult.status === 'fulfilled' ? composioResult.value : []),
    ]
      .filter((option) => matchesQuery(option, query))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
    const { items, pagination } = paginate(options, page, limit);

    return NextResponse.json({
      success: true,
      data: {
        connections: items,
        pagination,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load agent connection options.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
