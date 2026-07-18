import 'server-only';

import type {
  CanvasPluginComposioConnector,
  CanvasPluginConnectorManifest,
  CanvasPluginEmailConnector,
  CanvasPluginMcpConnector,
} from '@/app/lib/plugins/canvas-plugin-manifest';

export type PluginConnectionReadinessItem = {
  type: 'composio' | 'email' | 'mcp';
  key: string;
  label: string;
  required: boolean;
  ready: boolean;
  available?: boolean;
  connected?: boolean;
  configured?: boolean;
  logo?: string;
  reason?: string;
  details?: string[];
  action: 'none' | 'configure-composio' | 'connect-composio' | 'configure-email' | 'configure-mcp';
};

export type PluginConnectionReadiness = {
  ready: boolean;
  items: PluginConnectionReadinessItem[];
  summary: {
    total: number;
    ready: number;
    requiredMissing: number;
    recommendedMissing: number;
  };
};

const READINESS_CACHE_TTL_MS = 10_000;
const readinessCache = new Map<string, {
  expiresAt: number;
  promise: Promise<PluginConnectionReadiness>;
}>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map(stringValue).filter((entry): entry is string => Boolean(entry));
  return strings.length > 0 ? strings : undefined;
}

export function normalizeComposioConnectors(
  connectors: CanvasPluginConnectorManifest | undefined,
): CanvasPluginComposioConnector[] {
  const modern = Array.isArray(connectors?.composio) ? connectors.composio as unknown[] : [];
  const legacy = (connectors?.composioToolkits || []).map((toolkit) => ({ toolkit, recommended: true }));
  return [...modern, ...legacy]
    .map((connector): CanvasPluginComposioConnector | null => {
      const legacyToolkit = stringValue(connector);
      if (legacyToolkit) return { toolkit: legacyToolkit, recommended: true };
      if (!isRecord(connector)) return null;
      const toolkit = stringValue(connector.toolkit ?? connector.slug ?? connector.toolkitSlug);
      if (!toolkit) return null;
      return {
        toolkit,
        label: stringValue(connector.label ?? connector.name),
        reason: stringValue(connector.reason),
        recommended: connector.recommended === true,
        required: connector.required === true,
        tools: stringArrayValue(connector.tools),
      };
    })
    .filter((connector): connector is CanvasPluginComposioConnector => Boolean(connector?.toolkit));
}

export function normalizeEmailConnectors(
  connectors: CanvasPluginConnectorManifest | undefined,
): CanvasPluginEmailConnector[] {
  const modern = Array.isArray(connectors?.email) ? connectors.email as unknown[] : [];
  return modern
    .map((connector): CanvasPluginEmailConnector | null => {
      if (!isRecord(connector)) return null;
      const providers = stringArrayValue(connector.providers)
        ?.filter((provider): provider is 'gmail' | 'imap-smtp' => provider === 'gmail' || provider === 'imap-smtp');
      return {
        kind: stringValue(connector.kind) === 'mailbox' ? 'mailbox' : undefined,
        label: stringValue(connector.label ?? connector.name),
        reason: stringValue(connector.reason),
        recommended: connector.recommended === true,
        required: connector.required === true,
        providers,
      };
    })
    .filter((connector): connector is CanvasPluginEmailConnector => Boolean(connector));
}

export function normalizeMcpConnectors(
  connectors: CanvasPluginConnectorManifest | undefined,
): CanvasPluginMcpConnector[] {
  const modern = Array.isArray(connectors?.mcp) ? connectors.mcp as unknown[] : [];
  return [
    ...modern,
    ...(connectors?.mcpServers
      ? [{ name: 'mcp', label: 'MCP', configPath: connectors.mcpServers, recommended: true }]
      : []),
  ]
    .map((connector): CanvasPluginMcpConnector | null => {
      const legacyName = stringValue(connector);
      if (legacyName) return { name: legacyName, label: legacyName, recommended: true };
      if (!isRecord(connector)) return null;
      const name = stringValue(connector.name ?? connector.id);
      if (!name) return null;
      return {
        name,
        label: stringValue(connector.label),
        reason: stringValue(connector.reason),
        recommended: connector.recommended === true,
        required: connector.required === true,
        configPath: stringValue(connector.configPath ?? connector.config_path),
        env: stringArrayValue(connector.env),
        oauth: connector.oauth === true,
      };
    })
    .filter((connector): connector is CanvasPluginMcpConnector => Boolean(connector?.name));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function resolvePluginConnectionReadinessUncached(input: {
  connectors?: CanvasPluginConnectorManifest;
  userId: string;
  workspaceId?: string | null;
}): Promise<PluginConnectionReadiness> {
  const items: PluginConnectionReadinessItem[] = [];
  const composio = normalizeComposioConnectors(input.connectors);
  if (composio.length > 0) {
    const { resolveComposioContext } = await import('@/app/lib/composio/composio-context');
    const { getGatewayStatus, getGatewayToolkits } = await import('@/app/lib/composio/composio-gateway');
    const { resolveComposioToolkitAccess } = await import('@/app/lib/composio/composio-toolkit-access');
    const composioContext = await resolveComposioContext({
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    const status = await getGatewayStatus(composioContext).catch(() => ({
      configured: false,
      apiKeyValid: false,
      connectedAccounts: [],
    }));
    const connectedBySlug = new Set(
      (status.connectedAccounts || [])
        .map((account) => account.toolkit?.slug)
        .filter((slug): slug is string => Boolean(slug)),
    );
    let toolkitBySlug = new Map<string, { name?: string; logo?: string; ready: boolean }>();
    if (status.configured && status.apiKeyValid) {
      const toolkitResult = await getGatewayToolkits(composioContext).catch(() => ({ toolkits: [] }));
      if (Array.isArray(toolkitResult.toolkits)) {
        toolkitBySlug = new Map(toolkitResult.toolkits
          .map((toolkit) => toolkit && typeof toolkit === 'object' ? toolkit as Record<string, unknown> : {})
          .map((toolkit) => {
            const slug = stringValue(toolkit.slug) || '';
            const access = resolveComposioToolkitAccess(
              toolkit,
              Boolean(toolkit.connected) || connectedBySlug.has(slug),
            );
            return [slug, {
              name: stringValue(toolkit.name),
              logo: stringValue(toolkit.logo),
              ready: access.ready,
            }] as const;
          })
          .filter(([slug]) => Boolean(slug)));
      }
    }
    for (const connector of composio) {
      const toolkit = toolkitBySlug.get(connector.toolkit);
      const configured = Boolean(status.configured && status.apiKeyValid);
      const available = configured && Boolean(toolkit);
      const connected = Boolean(toolkit?.ready);
      items.push({
        type: 'composio',
        key: connector.toolkit,
        label: connector.label || toolkit?.name || connector.toolkit,
        required: connector.required === true,
        ready: available && connected,
        available,
        connected,
        configured,
        logo: toolkit?.logo,
        reason: connector.reason,
        details: connector.tools?.length ? [`Tools: ${connector.tools.join(', ')}`] : undefined,
        action: !configured ? 'configure-composio' : connected ? 'none' : 'connect-composio',
      });
    }
  }

  const email = normalizeEmailConnectors(input.connectors);
  if (email.length > 0) {
    const { listEmailAccounts } = await import('@/app/lib/email/service');
    const accountsResult = await listEmailAccounts(input.userId).catch(() => ({ accounts: [] }));
    const accountCount = Array.isArray(accountsResult.accounts) ? accountsResult.accounts.length : 0;
    for (const [index, connector] of email.entries()) {
      const providers = connector.providers?.length ? connector.providers.join(', ') : 'gmail, imap-smtp';
      items.push({
        type: 'email',
        key: connector.label || `email-${index}`,
        label: connector.label || 'Email account',
        required: connector.required === true,
        ready: accountCount > 0,
        configured: accountCount > 0,
        connected: accountCount > 0,
        reason: connector.reason,
        details: [`Providers: ${providers}`, `Connected accounts: ${accountCount}`],
        action: accountCount > 0 ? 'none' : 'configure-email',
      });
    }
  }

  const mcp = normalizeMcpConnectors(input.connectors);
  if (mcp.length > 0) {
    const [{ readMcpConfig }, { getMcpOAuthStatus }] = await Promise.all([
      import('@/app/lib/mcp/config'),
      import('@/app/lib/mcp/oauth'),
    ]);
    const config = await readMcpConfig({ userId: input.userId }).catch(() => ({ mcpServers: {} }));
    const mcpServers = config.mcpServers as Record<string, { enabled?: boolean } | undefined>;
    for (const connector of mcp) {
      const server = mcpServers[connector.name];
      const configured = Boolean(server);
      const enabled = configured && server?.enabled !== false;
      const oauth = connector.oauth
        ? await getMcpOAuthStatus(connector.name, undefined, { userId: input.userId }).catch(() => null)
        : null;
      const authorized = connector.oauth ? Boolean(oauth?.authorized) : true;
      const ready = configured && enabled && authorized;
      const details = [
        connector.configPath ? `Example config: ${connector.configPath}` : null,
        connector.env?.length ? `Env: ${connector.env.join(', ')}` : null,
        connector.oauth ? (authorized ? 'OAuth authorized' : 'OAuth authorization required') : null,
      ].filter((detail): detail is string => Boolean(detail));
      items.push({
        type: 'mcp',
        key: connector.name,
        label: connector.label || connector.name,
        required: connector.required === true,
        ready,
        configured,
        connected: ready,
        reason: connector.reason,
        details,
        action: ready ? 'none' : 'configure-mcp',
      });
    }
  }

  const requiredMissing = items.filter((item) => item.required && !item.ready).length;
  const recommendedMissing = items.filter((item) => !item.required && !item.ready).length;
  return {
    ready: requiredMissing === 0,
    items,
    summary: {
      total: items.length,
      ready: items.filter((item) => item.ready).length,
      requiredMissing,
      recommendedMissing,
    },
  };
}

export async function resolvePluginConnectionReadiness(input: {
  connectors?: CanvasPluginConnectorManifest;
  userId: string;
  workspaceId?: string | null;
  fresh?: boolean;
}): Promise<PluginConnectionReadiness> {
  const cacheKey = `${input.userId}\0${input.workspaceId || ''}\0${JSON.stringify(input.connectors || {})}`;
  const now = Date.now();
  const cached = readinessCache.get(cacheKey);
  if (!input.fresh && cached && cached.expiresAt > now) {
    return cached.promise;
  }
  if (readinessCache.size > 200) {
    for (const [key, entry] of readinessCache) {
      if (entry.expiresAt <= now) readinessCache.delete(key);
    }
    while (readinessCache.size > 200) {
      const oldestKey = readinessCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      readinessCache.delete(oldestKey);
    }
  }
  const promise = resolvePluginConnectionReadinessUncached(input);
  readinessCache.set(cacheKey, { expiresAt: now + READINESS_CACHE_TTL_MS, promise });
  try {
    return await promise;
  } catch (error) {
    if (readinessCache.get(cacheKey)?.promise === promise) readinessCache.delete(cacheKey);
    throw error;
  }
}
