import 'server-only';

import { randomUUID } from 'crypto';
import { eq, desc } from 'drizzle-orm';
import { getComposio, getComposioMode, verifyApiKey, type ComposioMode } from './composio-client';
import { disconnectTool, getConnectedAccounts, initiateConnection } from './composio-auth';
import { getComposioSession } from './composio-session';
import { getComposioUserId } from './composio-identity';
import { clearToolkitCache, getAvailableToolkits } from './composio-toolkit-registry';
import { getManagedControlPlaneBaseUrl } from '../managed/control-plane-url';
import { encryptWebhookSecret, previewWebhookSecret } from './composio-webhook-secret';
import { db } from '../db';
import { composioWebhookSubscriptions } from '../db/schema';

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
  webhookSubscription?: {
    configured: boolean;
    webhookUrl?: string;
    status?: string;
    mode?: string;
  } | null;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function logComposioTrigger(message: string, details?: Record<string, unknown>): void {
  if (details) {
    console.log(`[Composio Triggers] ${message}`, details);
  } else {
    console.log(`[Composio Triggers] ${message}`);
  }
}

function logComposioTriggerError(message: string, error: unknown, details?: Record<string, unknown>): void {
  console.error(`[Composio Triggers] ${message}`, {
    ...details,
    error: error instanceof Error ? error.message : String(error),
  });
}

function normalizeLocalTriggerInstance(
  value: unknown,
  accountById: Map<string, ComposioConnectedAccount>,
): Record<string, unknown> {
  const record = asRecord(value);
  const connectedAccountId = stringValue(record.connectedAccountId) || stringValue(record.connected_account_id);
  const account = connectedAccountId ? accountById.get(connectedAccountId) : undefined;
  const disabledAt = record.disabledAt ?? record.disabled_at;
  const triggerSlug = stringValue(record.triggerSlug)
    || stringValue(record.trigger_slug)
    || stringValue(record.triggerName)
    || stringValue(record.trigger_name)
    || stringValue(record.slug);

  return {
    ...record,
    triggerId: stringValue(record.triggerId) || stringValue(record.trigger_id) || stringValue(record.id),
    triggerSlug,
    toolkitSlug: stringValue(record.toolkitSlug) || stringValue(record.toolkit_slug) || account?.toolkit?.slug || '',
    connectedAccountId,
    status: disabledAt ? 'paused' : 'active',
  };
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
  const method = options.method || 'GET';
  logComposioTrigger('Managed fetch started', { method, path, query: url.searchParams.toString() });
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${instanceToken()}`,
        'Content-Type': 'application/json',
        'X-Canvas-Composio-User-Id': userId,
      },
      body: options.body ? JSON.stringify({ ...options.body, composioUserId: userId }) : undefined,
    });
  } catch (error) {
    logComposioTriggerError('Managed fetch failed', error, { method, path });
    throw error;
  }

  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch (error) {
    logComposioTriggerError('Managed fetch returned non-JSON response', error, {
      method,
      path,
      status: response.status,
      bodyPreview: text.slice(0, 500),
    });
    throw new Error(`Managed Composio request returned invalid JSON (${response.status})`);
  }
  logComposioTrigger('Managed fetch completed', { method, path, status: response.status, ok: response.ok });
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
    return { configured: false, apiKeyValid: false, mode, webhookSubscription: null, connectedAccounts: [] };
  }

  if (mode === 'managed') {
    const result = await managedRequest<ComposioStatusResult>('/status');
    result.webhookSubscription = { configured: true, mode: 'managed' };
    return result;
  }

  const apiKeyValid = await verifyApiKey();
  if (!apiKeyValid) {
    return { configured: true, apiKeyValid: false, mode, webhookSubscription: null, connectedAccounts: [] };
  }
  const accounts = await getConnectedAccounts();
  let webhookSubscription: ComposioStatusResult['webhookSubscription'] = null;
  try {
    const sub = await getLocalWebhookSubscription();
    if (sub) {
      webhookSubscription = { configured: true, webhookUrl: sub.webhookUrl, status: sub.status, mode: sub.mode };
    } else {
      webhookSubscription = { configured: false };
    }
  } catch { /* subscription check is non-critical */ }
  return { configured: true, apiKeyValid: true, mode, webhookSubscription, connectedAccounts: connectedAccountResponse(accounts) };
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
  logComposioTrigger('Listing local trigger types', { toolkit });
  const result = await composio.triggers.listTypes({
    ...(toolkit ? { toolkits: [toolkit] } : {}),
    limit: 1000,
  });
  logComposioTrigger('Listed local trigger types', { toolkit, count: result.items.length, hasMore: Boolean(result.nextCursor) });
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
  const accounts = await getConnectedAccounts();
  const accountById = new Map(accounts.map((account) => [account.id, account as ComposioConnectedAccount]));
  const connectedAccountIds = Array.from(accountById.keys());
  if (connectedAccountIds.length === 0) {
    logComposioTrigger('Skipped local active trigger listing because no connected accounts exist');
    return { triggers: [] };
  }
  logComposioTrigger('Listing local active triggers', { connectedAccountCount: connectedAccountIds.length });
  const result = await composio.triggers.listActive({
    connectedAccountIds,
    showDisabled: true,
    limit: 1000,
  });
  const triggers = result.items.map((item) => normalizeLocalTriggerInstance(item, accountById));
  logComposioTrigger('Listed local active triggers', { count: triggers.length });
  return {
    triggers,
  };
}

const COMPOSIO_WEBHOOK_EVENT_TYPES = [
  'composio.trigger.message',
  'composio.connected_account.expired',
  'composio.trigger.disabled',
];

export async function getLocalWebhookSubscription() {
  const mode = await getComposioMode();
  if (mode !== 'local') return null;
  const [row] = await db
    .select()
    .from(composioWebhookSubscriptions)
    .where(eq(composioWebhookSubscriptions.status, 'active'))
    .orderBy(desc(composioWebhookSubscriptions.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function ensureLocalWebhookSubscription(options?: { forceRefresh?: boolean }) {
  const mode = await getComposioMode();
  if (mode !== 'local') throw new Error('Webhook subscriptions are only supported in local Composio mode.');
  const apiKey = await import('./composio-client').then((m) => m.getLocalComposioApiKey());
  if (!apiKey) throw new Error('Composio API key is required to create a webhook subscription.');
  const existing = await getLocalWebhookSubscription();
  const currentUrl = `${appBaseUrl()}/api/composio/webhook`;
  if (existing && !options?.forceRefresh) {
    if (existing.webhookUrl !== currentUrl) {
      logComposioTrigger('Webhook URL changed, re-registering subscription', { old: existing.webhookUrl, new: currentUrl });
      return ensureLocalWebhookSubscription({ forceRefresh: true });
    }
    return existing;
  }
  const webhookUrl = `${appBaseUrl()}/api/composio/webhook`;
  logComposioTrigger('Creating local webhook subscription', { webhookUrl });
  const response = await fetch('https://backend.composio.dev/api/v3.1/webhook_subscriptions', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook_url: webhookUrl,
      enabled_events: COMPOSIO_WEBHOOK_EVENT_TYPES,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    logComposioTriggerError('Failed to create Composio webhook subscription', new Error(`HTTP ${response.status}`), { status: response.status, body: text.slice(0, 500) });
    throw new Error(`Failed to create Composio webhook subscription (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const subscription = (data as Record<string, unknown>).subscription ?? data;
  const subRecord = subscription as Record<string, unknown>;
  const subscriptionId = String(subRecord.id ?? subRecord.subscription_id ?? '');
  const secret = String(subRecord.secret ?? '');
  const returnedUrl = String(subRecord.webhook_url ?? subRecord.url ?? webhookUrl);
  const eventTypes = Array.isArray(subRecord.enabled_events) ? subRecord.enabled_events.map(String) : COMPOSIO_WEBHOOK_EVENT_TYPES;
  if (!subscriptionId || !secret) {
    throw new Error('Composio webhook subscription response missing subscription ID or secret.');
  }
  const now = new Date();
  if (existing) {
    await db
      .update(composioWebhookSubscriptions)
      .set({ status: 'rotated', updatedAt: now, rotatedAt: now })
      .where(eq(composioWebhookSubscriptions.id, existing.id));
  }
  const [row] = await db
    .insert(composioWebhookSubscriptions)
    .values({
      id: `comp-sub-${randomUUID()}`,
      subscriptionId,
      webhookUrl: returnedUrl || webhookUrl,
      encryptedSecret: encryptWebhookSecret(secret),
      secretPreview: previewWebhookSecret(secret),
      eventTypes: JSON.stringify(eventTypes),
      status: 'active',
      mode: 'local',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: composioWebhookSubscriptions.subscriptionId,
      set: {
        webhookUrl: returnedUrl || webhookUrl,
        encryptedSecret: encryptWebhookSecret(secret),
        secretPreview: previewWebhookSecret(secret),
        eventTypes: JSON.stringify(eventTypes),
        status: 'active',
        updatedAt: now,
        rotatedAt: options?.forceRefresh ? now : null,
      },
    })
    .returning();
  logComposioTrigger('Local webhook subscription ensured', { subscriptionId, webhookUrl: returnedUrl || webhookUrl });
  return row;
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
  await ensureLocalWebhookSubscription();
  logComposioTrigger('Creating local trigger', {
    triggerSlug: input.triggerSlug,
    toolkitSlug: input.toolkitSlug,
    hasConnectedAccountId: Boolean(input.connectedAccountId),
    hasTriggerConfig: Boolean(input.triggerConfig && Object.keys(input.triggerConfig).length > 0),
  });
  const triggerType = await composio.triggers.getType(input.triggerSlug);
  const composioUserId = await getComposioUserId();
  const result = await composio.triggers.create(composioUserId, input.triggerSlug, {
    connectedAccountId: input.connectedAccountId,
    triggerConfig: input.triggerConfig || {},
  });
  const triggerId = result.triggerId;
  let connectedAccountId = input.connectedAccountId || '';
  try {
    const activeResult = await composio.triggers.listActive({
      triggerIds: [triggerId],
      showDisabled: true,
      limit: 1,
    });
    const activeTrigger = asRecord(activeResult.items[0]);
    connectedAccountId = stringValue(activeTrigger.connectedAccountId) || stringValue(activeTrigger.connected_account_id) || connectedAccountId;
  } catch (error) {
    logComposioTriggerError('Failed to fetch created trigger details', error, { triggerId, triggerSlug: input.triggerSlug });
  }
  if (!connectedAccountId) {
    throw new Error('Composio created the trigger but did not return the connected account ID.');
  }
  logComposioTrigger('Created local trigger', { triggerId, triggerSlug: input.triggerSlug, connectedAccountId });
  return {
    trigger: {
      triggerId,
      triggerSlug: input.triggerSlug,
      toolkitSlug: input.toolkitSlug || triggerType.toolkit.slug,
      connectedAccountId,
      composioUserId,
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
