import 'server-only';

import { getGatewayStatus, getGatewayToolkits } from '@/app/lib/composio/composio-gateway';
import { getMcpRuntimeStatus } from '@/app/lib/mcp/manager';

export type AgentConnectionOption = {
  id: string;
  label: string;
  kind: 'mcp' | 'composio';
  toolCount: number;
  logoUrl?: string | null;
};

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

function matchesConnectionQuery(option: AgentConnectionOption, query: string): boolean {
  if (!query) return true;
  const haystack = [option.id, option.label, option.kind].join('\n').toLowerCase();
  return haystack.includes(query);
}

async function loadMcpConnectionOptions(): Promise<AgentConnectionOption[]> {
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

async function loadComposioConnectionOptions(userId?: string | null): Promise<AgentConnectionOption[]> {
  const storageScope = userId ? { userId } : undefined;
  const status = await getGatewayStatus(storageScope);
  if (!status.configured || !status.apiKeyValid || status.connectedAccounts.length === 0) {
    return [];
  }

  let toolkitSummaryBySlug = new Map<string, ReturnType<typeof toToolkitSummary>>();
  try {
    const result = await getGatewayToolkits(storageScope);
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

export async function loadAgentConnectionOptions(params: { query?: string; userId?: string | null } = {}): Promise<AgentConnectionOption[]> {
  const query = params.query?.trim().toLowerCase() || '';
  const [mcpResult, composioResult] = await Promise.allSettled([
    loadMcpConnectionOptions(),
    loadComposioConnectionOptions(params.userId),
  ]);

  return [
    ...(mcpResult.status === 'fulfilled' ? mcpResult.value : []),
    ...(composioResult.status === 'fulfilled' ? composioResult.value : []),
  ]
    .filter((option) => matchesConnectionQuery(option, query))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}
