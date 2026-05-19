import 'server-only';

import { getComposio, getComposioMode, verifyApiKey, type ComposioMode } from './composio-client';
import { disconnectTool, getConnectedAccounts, initiateConnection } from './composio-auth';
import { getComposioSession } from './composio-session';
import { getComposioUserId } from './composio-identity';
import { clearToolkitCache, getAvailableToolkits } from './composio-toolkit-registry';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';

const HIDDEN_TOOLKIT_SLUGS = new Set([
  'gemini',
  'google_veo',
  'nano_banana',
  'openai',
  'anthropic',
  'google',
]);

export interface ComposioConnectedAccount {
  id: string;
  toolkit?: {
    slug?: string;
    name?: string;
  };
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface ComposioStatusResult {
  configured: boolean;
  apiKeyValid: boolean;
  mode: ComposioMode;
  connectedAccounts: Array<{
    id: string;
    toolkit: {
      slug: string;
      name: string;
    };
    connectedAt?: string;
    status?: string;
  }>;
}

function controlPlaneBaseUrl(): string {
  const baseUrl = getManagedControlPlaneBaseUrl();
  if (!baseUrl) throw new Error('CANVAS_CONTROL_PLANE_URL is required for managed Composio.');
  return baseUrl;
}

function instanceToken(): string {
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!token) throw new Error('CANVAS_INSTANCE_TOKEN is required for managed Composio.');
  return token;
}

function appBaseUrl(): string {
  const baseUrl = process.env.BASE_URL || process.env.APP_BASE_URL;
  if (baseUrl) return baseUrl.replace(/\/+$/, '');
  const port = process.env.PORT || '3000';
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return `http://localhost:${port}`;
}

async function managedRequest<T>(
  path: string,
  options: { method?: string; body?: Record<string, unknown>; query?: URLSearchParams } = {},
): Promise<T> {
  const userId = await getComposioUserId();
  const url = new URL(`${controlPlaneBaseUrl()}/v1/managed/composio${path}`);
  if (options.query) {
    options.query.forEach((value, key) => url.searchParams.set(key, value));
  }
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${instanceToken()}`,
      'Content-Type': 'application/json',
      'X-Canvas-Composio-User-Id': userId,
    },
    body: options.body ? JSON.stringify({ ...options.body, composioUserId: userId }) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (data && typeof data === 'object' && 'auth_required' in data) {
      return data as T;
    }
    throw new Error(typeof data.error === 'string' ? data.error : `Managed Composio request failed (${response.status})`);
  }
  return data as T;
}

function connectedAccountResponse(accounts: ComposioConnectedAccount[]) {
  return accounts.map((a) => ({
    id: a.id,
    toolkit: {
      slug: a.toolkit?.slug ?? '',
      name: a.toolkit?.name ?? a.toolkit?.slug ?? '',
    },
    connectedAt: a.createdAt,
    status: a.status,
  }));
}

export async function getComposioGatewayMode(): Promise<ComposioMode> {
  return getComposioMode();
}

export async function getGatewayStatus(): Promise<ComposioStatusResult> {
  const mode = await getComposioMode();
  if (mode === 'disabled') {
    return { configured: false, apiKeyValid: false, mode, connectedAccounts: [] };
  }

  if (mode === 'managed') {
    return managedRequest<ComposioStatusResult>('/status');
  }

  const apiKeyValid = await verifyApiKey();
  if (!apiKeyValid) {
    return { configured: true, apiKeyValid: false, mode, connectedAccounts: [] };
  }
  const accounts = await getConnectedAccounts();
  return { configured: true, apiKeyValid: true, mode, connectedAccounts: connectedAccountResponse(accounts) };
}

export async function getGatewayToolkits() {
  const mode = await getComposioMode();
  if (mode === 'disabled') return { toolkits: [] };
  if (mode === 'managed') return managedRequest<{ toolkits: unknown[] }>('/toolkits');
  return { toolkits: await getAvailableToolkits() };
}

export async function getGatewayToolkitTools(toolkit: string, search: string) {
  const mode = await getComposioMode();
  if (mode === 'disabled') return { tools: [], totalCount: 0 };
  if (mode === 'managed') {
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    return managedRequest<{ tools: unknown[]; totalCount: number; hasMore?: boolean }>(`/toolkits/${encodeURIComponent(toolkit)}/tools`, { query });
  }

  const composio = await getComposio();
  if (!composio) return { tools: [], totalCount: 0 };
  const queryParams: Parameters<typeof composio.tools.getRawComposioTools>[0] = {
    toolkits: [toolkit],
    limit: 500,
    important: false,
  };
  if (search) queryParams.search = search;
  const results = await composio.tools.getRawComposioTools(queryParams);
  const toolList = Array.isArray(results) ? results : [];
  const tools = toolList.map((tool: Record<string, unknown>) => {
    const tk = (tool.toolkit ?? {}) as Record<string, unknown>;
    return {
      slug: String(tool.slug ?? tool.name ?? ''),
      name: String(tool.name ?? tool.slug ?? ''),
      description: typeof tool.description === 'string' ? tool.description : '',
      toolkit: String(tk.slug ?? tool.toolkitSlug ?? ''),
    };
  });
  return { tools, totalCount: tools.length, hasMore: toolList.length >= 500 };
}

export async function connectGatewayToolkit(toolkit: string) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio not configured');
  if (mode === 'managed') {
    return managedRequest<{ redirectUrl: string | null; noAuth?: boolean }>(`/connect/${encodeURIComponent(toolkit)}`, {
      method: 'POST',
      body: { returnUrl: `${appBaseUrl()}/settings?tab=integrations&connected=${encodeURIComponent(toolkit)}` },
    });
  }
  return initiateConnection(toolkit);
}

export async function disconnectGatewayToolkit(toolkit: string) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio not configured');
  if (mode === 'managed') {
    return managedRequest<{ success: boolean }>(`/disconnect/${encodeURIComponent(toolkit)}`, { method: 'DELETE' });
  }
  await disconnectTool(toolkit);
  return { success: true };
}

export async function refreshGatewayToolkit(toolkit: string) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio not configured');
  if (mode === 'managed') {
    return managedRequest<{ toolkit: string; status: string; connectedAt: string | null }>(`/refresh/${encodeURIComponent(toolkit)}`, { method: 'POST' });
  }

  const accounts = await getConnectedAccounts();
  const account = accounts.find((a) => a.toolkit?.slug === toolkit);
  if (account) {
    return { toolkit, status: account.status || 'UNKNOWN', connectedAt: account.createdAt || null };
  }
  return { toolkit, status: 'NOT_CONNECTED', connectedAt: null };
}

export async function searchGatewayTools(query: string, toolkits?: string[]) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return managedRequest<{ tools: unknown[]; count: number }>('/tools/search', {
      method: 'POST',
      body: { query, toolkits },
    });
  }

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const results = await composio.tools.getRawComposioTools({
    search: query,
    ...(toolkits ? { toolkits } : {}),
  } as Parameters<typeof composio.tools.getRawComposioTools>[0]);
  const resultArr = Array.isArray(results) ? results : [];
  const filtered = resultArr.filter((tool: Record<string, unknown>) => {
    const toolkit = (tool.toolkit ?? {}) as Record<string, unknown>;
    const toolkitSlug = String(toolkit.slug ?? tool.toolkitSlug ?? '');
    return !HIDDEN_TOOLKIT_SLUGS.has(toolkitSlug);
  });
  const formatted = filtered.slice(0, 20).map((tool: Record<string, unknown>) => {
    const toolkit = (tool.toolkit ?? {}) as Record<string, unknown>;
    return {
      slug: String(tool.slug ?? tool.name ?? ''),
      name: String(tool.name ?? tool.slug ?? ''),
      description: typeof tool.description === 'string' ? tool.description.slice(0, 200) : '',
      toolkit: String(toolkit.slug ?? tool.toolkitSlug ?? ''),
    };
  });
  return { tools: formatted, count: formatted.length };
}

export async function getGatewayToolSchemas(tools: string[]) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return managedRequest<Record<string, unknown>>('/tools/schemas', {
      method: 'POST',
      body: { tools },
    });
  }

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const schemas: Record<string, unknown> = {};
  for (const slug of tools.slice(0, 10)) {
    try {
      const tool = await composio.tools.getRawComposioToolBySlug(String(slug));
      const toolRecord = tool as Record<string, unknown>;
      schemas[String(slug)] = (toolRecord?.inputParameters ?? null) as Record<string, unknown> | null;
    } catch {
      schemas[String(slug)] = { error: `Tool '${slug}' not found` };
    }
  }
  return schemas;
}

export async function executeGatewayTool(action: string, params: Record<string, unknown>) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return managedRequest<unknown>('/execute', {
      method: 'POST',
      body: { action, params, returnUrl: `${appBaseUrl()}/settings?tab=integrations&connected=${encodeURIComponent(action.split('_')[0]?.toLowerCase() ?? '')}` },
    });
  }

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  return composio.tools.execute(action, {
    userId: await getComposioUserId(),
    arguments: params,
    dangerouslySkipVersionCheck: true,
  });
}

export async function getGatewayAuthRedirect(toolkit: string) {
  const mode = await getComposioMode();
  if (mode === 'managed') {
    const result = await managedRequest<{ redirectUrl: string | null; noAuth?: boolean }>(`/connect/${encodeURIComponent(toolkit)}`, {
      method: 'POST',
      body: { returnUrl: `${appBaseUrl()}/settings?tab=integrations&connected=${encodeURIComponent(toolkit)}` },
    });
    return result.redirectUrl || '';
  }
  const session = await getComposioSession();
  if (!session) return '';
  const connectionRequest = await session.authorize(toolkit, { callbackUrl: `${appBaseUrl()}/api/composio/callback` });
  return connectionRequest.redirectUrl;
}

export async function getGatewayTriggerTypes(toolkit: string) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    const query = new URLSearchParams();
    if (toolkit) query.set('toolkit', toolkit);
    return managedRequest<{ triggerTypes: unknown[]; totalCount: number; hasMore?: boolean; nextCursor?: string | null }>('/triggers/types', { query });
  }

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const result = await composio.triggers.listTypes({
    ...(toolkit ? { toolkits: [toolkit] } : {}),
    limit: 1000,
  });
  return {
    triggerTypes: result.items,
    totalCount: result.items.length,
    hasMore: Boolean(result.nextCursor),
    nextCursor: result.nextCursor ?? null,
  };
}

export async function listGatewayTriggers() {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') return managedRequest<{ triggers: unknown[] }>('/triggers');

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const composioUserId = await getComposioUserId();
  const result = await composio.triggers.listActive({
    showDisabled: true,
    limit: 1000,
  });
  return {
    triggers: result.items.filter((item) => {
      const trigger = item as { userId?: string; user_id?: string };
      return trigger.userId === composioUserId || trigger.user_id === composioUserId;
    }),
  };
}

export async function createGatewayTrigger(input: {
  triggerSlug: string;
  toolkitSlug?: string;
  connectedAccountId?: string;
  triggerConfig?: Record<string, unknown>;
  notebookWebhookUrl?: string | null;
}) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    await managedRequest('/webhook/subscription', { method: 'POST', body: {} });
    return managedRequest<{ trigger: Record<string, unknown> }>('/triggers', {
      method: 'POST',
      body: input,
    });
  }

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const triggerType = await composio.triggers.getType(input.triggerSlug);
  const result = await composio.triggers.create(await getComposioUserId(), input.triggerSlug, {
    connectedAccountId: input.connectedAccountId,
    triggerConfig: input.triggerConfig || {},
  });
  return {
    trigger: {
      triggerId: result.triggerId,
      triggerSlug: input.triggerSlug,
      toolkitSlug: input.toolkitSlug || triggerType.toolkit.slug,
      connectedAccountId: input.connectedAccountId || '',
      composioUserId: await getComposioUserId(),
      triggerConfig: input.triggerConfig || {},
    },
  };
}

export async function updateGatewayTrigger(triggerId: string, input: { status?: 'active' | 'paused'; triggerConfig?: Record<string, unknown>; notebookWebhookUrl?: string | null }) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return managedRequest<{ trigger: Record<string, unknown> }>(`/triggers/${encodeURIComponent(triggerId)}`, {
      method: 'PATCH',
      body: input,
    });
  }

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  if (input.status === 'paused') await composio.triggers.disable(triggerId);
  if (input.status === 'active') await composio.triggers.enable(triggerId);
  return { trigger: { triggerId, status: input.status } };
}

export async function deleteGatewayTrigger(triggerId: string) {
  const mode = await getComposioMode();
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return managedRequest<{ success: boolean }>(`/triggers/${encodeURIComponent(triggerId)}`, { method: 'DELETE' });
  }

  const composio = await getComposio();
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  await composio.triggers.delete(triggerId);
  return { success: true };
}

export function clearComposioGatewayCaches(): void {
  clearToolkitCache();
}
