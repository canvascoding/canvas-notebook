import 'server-only';

import { randomUUID } from 'crypto';
import { eq, desc } from 'drizzle-orm';
import { getComposio, getComposioMode, isManagedComposioConfigured, verifyApiKey, type ComposioMode } from './composio-client';
import { disconnectTool, getActiveConnectedAccounts, getConnectedAccounts, initiateConnection } from './composio-auth';
import { resetSessionCache } from './composio-session';
import { clearToolkitCache, getAvailableToolkits } from './composio-toolkit-registry';
import { composioContextCacheKey, type ResolvedComposioContext } from './composio-context';
import {
  inferConnectedComposioToolkits,
  normalizeComposioToolkits,
  selectComposioToolSearchResults,
  type ComposioToolSummary,
} from './composio-tool-discovery';
import { createComposioOAuthFlowState } from './composio-oauth-state';
import { requestManagedComposio, type ManagedRequestOptions } from './managed-composio-client';
import { classifyComposioFailure, ComposioProviderError } from './composio-provider-error';
import { executeManagedComposioTool } from './managed-composio-execution';
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

const TRIGGER_APP_CACHE_TTL_MS = 30 * 60 * 1000;

type TriggerAppCacheEntry = {
  expiresAt: number;
  apps: Array<{
    slug: string;
    name: string;
    logo?: string;
    description?: string;
    triggerCount: number;
  }>;
};

const triggerAppCache = new Map<string, TriggerAppCacheEntry>();
const TOOL_VERSION_CACHE_TTL_MS = 30 * 60 * 1000;
const toolVersionCache = new Map<string, { version: string; expiresAt: number }>();

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
  apiKeyState: 'missing' | 'valid' | 'invalid_or_insufficient_scope' | 'unknown';
  providerHealthy: boolean;
  mode: ComposioMode;
  localConfigured: boolean;
  managedAvailable: boolean;
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
  retryable?: boolean;
  errorCode?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
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
    errorType: error instanceof Error ? error.name : typeof error,
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
  options: ManagedRequestOptions = {},
  context: ResolvedComposioContext,
): Promise<T> {
  return requestManagedComposio<T>(path, options, context);
}

function cacheToolVersion(tool: Record<string, unknown>): void {
  const slug = stringValue(tool.slug) || stringValue(tool.name);
  const version = stringValue(tool.version) || stringValue(asRecord(tool.meta).version);
  if (slug && version && version !== 'latest') toolVersionCache.set(slug, { version, expiresAt: Date.now() + TOOL_VERSION_CACHE_TTL_MS });
}

function cachedToolVersion(action: string): string | undefined {
  const cached = toolVersionCache.get(action);
  if (!cached || cached.expiresAt <= Date.now()) {
    toolVersionCache.delete(action);
    return undefined;
  }
  return cached.version;
}

async function withComposioSignal<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>, mutation = false): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await operation(controller.signal); }
  catch (error) { throw classifyComposioFailure({ error, mutation, timeout: controller.signal.aborted }); }
  finally { clearTimeout(timer); }
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

export async function getComposioGatewayMode(context: ResolvedComposioContext): Promise<ComposioMode> {
  return getComposioMode(context.storageScope);
}

export async function getGatewayStatus(context: ResolvedComposioContext): Promise<ComposioStatusResult> {
  const mode = await getComposioMode(context.storageScope);
  const localConfigured = mode === 'local';
  const managedAvailable = isManagedComposioConfigured();
  if (mode === 'disabled') {
    return { configured: false, apiKeyValid: false, apiKeyState: 'missing', providerHealthy: true, mode, localConfigured, managedAvailable, webhookSubscription: null, connectedAccounts: [] };
  }

  if (mode === 'managed') {
    try {
      const result = await managedRequest<ComposioStatusResult>('/status', {}, context);
      return {
        ...result,
        configured: result.configured !== false,
        apiKeyValid: result.apiKeyValid !== false,
        apiKeyState: result.apiKeyState || (result.apiKeyValid === false ? 'invalid_or_insufficient_scope' : 'valid'),
        providerHealthy: result.providerHealthy !== false,
        mode,
        localConfigured,
        managedAvailable,
        webhookSubscription: { configured: true, mode: 'managed' },
        connectedAccounts: (result.connectedAccounts || []).filter((account) => account.status === 'ACTIVE'),
      };
    } catch (error) {
      const normalized = error instanceof Error && 'code' in error
        ? error as { code?: string; retryable?: boolean; providerRequestId?: string; retryAfterMs?: number }
        : classifyComposioFailure({ error });
      return {
        configured: true,
        apiKeyValid: true,
        apiKeyState: 'unknown',
        providerHealthy: false,
        mode,
        localConfigured,
        managedAvailable,
        webhookSubscription: { configured: true, mode: 'managed' },
        connectedAccounts: [],
        retryable: normalized.retryable,
        errorCode: normalized.code,
        providerRequestId: normalized.providerRequestId,
        retryAfterMs: normalized.retryAfterMs,
      };
    }
  }

  const probe = await verifyApiKey(context);
  if (!probe.valid || !probe.healthy) {
    return {
      configured: true,
      apiKeyValid: probe.valid,
      apiKeyState: probe.valid ? 'unknown' : 'invalid_or_insufficient_scope',
      providerHealthy: probe.healthy,
      mode,
      localConfigured,
      managedAvailable,
      webhookSubscription: null,
      connectedAccounts: [],
      ...(probe.error ? { retryable: probe.error.retryable, errorCode: probe.error.code, providerRequestId: probe.error.providerRequestId, retryAfterMs: probe.error.retryAfterMs } : {}),
    };
  }
  const accounts = await getActiveConnectedAccounts(context);
  let webhookSubscription: ComposioStatusResult['webhookSubscription'] = null;
  try {
    const sub = await getLocalWebhookSubscription(context);
    if (sub) {
      webhookSubscription = { configured: true, webhookUrl: sub.webhookUrl, status: sub.status, mode: sub.mode };
    } else {
      webhookSubscription = { configured: false };
    }
  } catch { /* subscription check is non-critical */ }
  return { configured: true, apiKeyValid: true, apiKeyState: 'valid', providerHealthy: true, mode, localConfigured, managedAvailable, webhookSubscription, connectedAccounts: connectedAccountResponse(accounts) };
}

export async function getGatewayToolkits(context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') return { toolkits: [] };
  if (mode === 'managed') return managedRequest<{ toolkits: unknown[] }>('/toolkits', {}, context);
  return { toolkits: await getAvailableToolkits(context) };
}

export async function getGatewayTriggerApps(context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') {
    return {
      apps: [],
      totalCount: 0,
      status: { configured: false, apiKeyValid: false, apiKeyState: 'missing' as const, providerHealthy: true, mode, webhookSubscription: null, connectedAccounts: [] },
    };
  }

  // Check the configuration before asking Composio for trigger metadata. This
  // keeps provider errors (which can include API-key details) out of the
  // automation composer and lets it show its normal setup-required state.
  const status = await getGatewayStatus(context);
  if (!status.configured || status.apiKeyValid === false || !status.providerHealthy) {
    return { apps: [], totalCount: 0, status };
  }

  const now = Date.now();
  const cacheKey = composioContextCacheKey(context);
  const cached = triggerAppCache.get(cacheKey);
  let baseApps = cached && cached.expiresAt > now ? cached.apps : null;
  if (!baseApps) {
    const result = await getGatewayTriggerTypes('', context);
    const bySlug = new Map<string, {
      slug: string;
      name: string;
      logo?: string;
      description?: string;
      triggerCount: number;
    }>();

    for (const item of result.triggerTypes || []) {
      const record = asRecord(item);
      const toolkit = asRecord(record.toolkit);
      const slug = stringValue(toolkit.slug)
        || stringValue(record.toolkitSlug)
        || stringValue(record.toolkit_slug);
      if (!slug || HIDDEN_TOOLKIT_SLUGS.has(slug)) continue;

      const existing = bySlug.get(slug);
      bySlug.set(slug, {
        slug,
        name: existing?.name || stringValue(toolkit.name) || slug,
        logo: existing?.logo || stringValue(toolkit.logo),
        description: existing?.description || stringValue(toolkit.description) || stringValue(record.description),
        triggerCount: (existing?.triggerCount || 0) + 1,
      });
    }

    baseApps = Array.from(bySlug.values()).sort((a, b) => a.name.localeCompare(b.name));
    triggerAppCache.set(cacheKey, {
      apps: baseApps,
      expiresAt: now + TRIGGER_APP_CACHE_TTL_MS,
    });
  }

  const connectedBySlug = new Map(status.connectedAccounts.map((account) => [account.toolkit.slug, account]));
  const apps = baseApps
    .map((app) => {
      const connected = connectedBySlug.get(app.slug);
      return {
        ...app,
        connected: Boolean(connected),
        connectedAccountId: connected?.id || '',
        connectedAccountStatus: connected?.status || '',
      };
    })
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));

  return { apps, totalCount: apps.length, status };
}

export async function getGatewayToolkitTools(toolkit: string, search: string, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') return { tools: [], totalCount: 0 };
  if (mode === 'managed') {
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    return managedRequest<{ tools: unknown[]; totalCount: number; hasMore?: boolean }>(`/toolkits/${encodeURIComponent(toolkit)}/tools`, { query }, context);
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) return { tools: [], totalCount: 0 };
  const queryParams: Parameters<typeof composio.tools.getRawComposioTools>[0] = {
    toolkits: [toolkit],
    limit: 500,
    important: false,
  };
  if (search) queryParams.search = search;
  const results = await withComposioSignal(15_000, (signal) => composio.tools.getRawComposioTools(queryParams, undefined, { signal }));
  const toolList = Array.isArray(results) ? results : [];
  toolList.forEach((tool) => cacheToolVersion(tool as Record<string, unknown>));
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

export async function connectGatewayToolkit(
  toolkit: string,
  context: ResolvedComposioContext,
  options: { mobileReturnUrl?: string | null } = {},
) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio not configured');
  if (mode === 'managed') {
    const flow = await createComposioOAuthFlowState({
      context,
      toolkitSlug: toolkit,
      mobileReturnUrl: options.mobileReturnUrl,
    });
    const result = await managedRequest<{ redirectUrl: string | null; noAuth?: boolean }>(`/connect/${encodeURIComponent(toolkit)}`, {
      method: 'POST',
      body: { returnUrl: flow.callbackUrl },
    }, context);
    return result.noAuth ? result : {
      ...result,
      flowId: flow.state,
      expiresAt: flow.expiresAt.toISOString(),
    };
  }
  return initiateConnection(toolkit, context, options);
}

export async function disconnectGatewayToolkit(toolkit: string, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio not configured');
  if (mode === 'managed') {
    return managedRequest<{ success: boolean }>(`/disconnect/${encodeURIComponent(toolkit)}`, { method: 'DELETE' }, context);
  }
  await disconnectTool(toolkit, context);
  return { success: true };
}

export async function refreshGatewayToolkit(toolkit: string, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio not configured');
  if (mode === 'managed') {
    return managedRequest<{ toolkit: string; status: string; connectedAt: string | null }>(`/refresh/${encodeURIComponent(toolkit)}`, { method: 'POST' }, context);
  }

  const accounts = await getConnectedAccounts({}, context);
  const account = accounts.find((a) => a.toolkit?.slug === toolkit);
  if (account) {
    return { toolkit, status: account.status || 'UNKNOWN', connectedAt: account.createdAt || null };
  }
  return { toolkit, status: 'NOT_CONNECTED', connectedAt: null };
}

export async function searchGatewayTools(query: string, toolkits: string[] | undefined, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  const normalizedQuery = query.trim();
  let resolvedToolkits = normalizeComposioToolkits(toolkits)
    .filter((toolkit) => !HIDDEN_TOOLKIT_SLUGS.has(toolkit));
  if (resolvedToolkits.length === 0 && normalizedQuery) {
    const status = await getGatewayStatus(context);
    resolvedToolkits = inferConnectedComposioToolkits(normalizedQuery, status.connectedAccounts)
      .filter((toolkit) => !HIDDEN_TOOLKIT_SLUGS.has(toolkit));
  }

  if (resolvedToolkits.length > 0) {
    const toolkitResults = await Promise.all(
      resolvedToolkits.map((toolkit) => getGatewayToolkitTools(toolkit, '', context)),
    );
    const allTools = toolkitResults.flatMap((result) => Array.isArray(result.tools)
      ? result.tools as ComposioToolSummary[]
      : []);
    const selected = selectComposioToolSearchResults(allTools, normalizedQuery, resolvedToolkits);
    return {
      tools: selected.tools,
      count: selected.tools.length,
      totalCount: selected.totalCount,
      toolkits: resolvedToolkits,
      discovery: 'toolkit_catalog' as const,
      fallback: selected.fallback,
    };
  }

  if (!normalizedQuery) {
    throw new Error('Provide a search query or at least one toolkit slug. To list an app catalog, pass toolkits and omit query.');
  }
  if (mode === 'managed') {
    return managedRequest<{ tools: unknown[]; count: number }>('/tools/search', {
      method: 'POST',
      body: { query: normalizedQuery },
    }, context);
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const results = await withComposioSignal(15_000, (signal) => composio.tools.getRawComposioTools({
    search: normalizedQuery,
  } as Parameters<typeof composio.tools.getRawComposioTools>[0], undefined, { signal }));
  const resultArr = Array.isArray(results) ? results : [];
  resultArr.forEach((tool) => cacheToolVersion(tool as Record<string, unknown>));
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

export async function getGatewayToolSchemas(tools: string[], context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return managedRequest<Record<string, unknown>>('/tools/schemas', {
      method: 'POST',
      body: { tools },
    }, context);
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const schemas: Record<string, unknown> = {};
  for (const slug of tools.slice(0, 10)) {
    try {
      const tool = await withComposioSignal(15_000, (signal) => composio.tools.getRawComposioToolBySlug(String(slug), undefined, { signal }));
      const toolRecord = tool as Record<string, unknown>;
      cacheToolVersion(toolRecord);
      schemas[String(slug)] = (toolRecord?.inputParameters ?? null) as Record<string, unknown> | null;
    } catch {
      schemas[String(slug)] = { error: `Tool '${slug}' not found` };
    }
  }
  return schemas;
}

export async function executeGatewayTool(action: string, params: Record<string, unknown>, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    const toolkit = action.split('_')[0]?.trim().toLowerCase() || 'unknown';
    return executeManagedComposioTool({
      execute: () => managedRequest<Record<string, unknown>>('/execute', { method: 'POST', body: { action, params } }, context),
      createOAuthFlow: () => createComposioOAuthFlowState({ context, toolkitSlug: toolkit }),
      connect: (returnUrl) => managedRequest<Record<string, unknown>>(`/connect/${encodeURIComponent(toolkit)}`, {
        method: 'POST', body: { returnUrl },
      }, context),
    });
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  let version = cachedToolVersion(action);
  if (!version) {
    const tool = await withComposioSignal(15_000, (signal) => composio.tools.getRawComposioToolBySlug(action, undefined, { signal }));
    const toolRecord = tool as Record<string, unknown>;
    cacheToolVersion(toolRecord);
    version = cachedToolVersion(action);
  }
  if (!version) {
    throw new ComposioProviderError('Tool schema did not include a concrete version.', {
      code: 'COMPOSIO_BAD_RESPONSE',
      retryable: false,
    });
  }
  try {
    return await withComposioSignal(120_000, (signal) => composio.tools.execute(action, {
      userId: context.composioUserId,
      arguments: params,
      version,
    }, { signal }), true);
  } catch (error) {
    if (error instanceof ComposioProviderError) throw error;
    throw classifyComposioFailure({ error, mutation: true, timeout: error instanceof Error && error.name === 'AbortError' });
  }
}

export async function getGatewayAuthRedirect(toolkit: string, context: ResolvedComposioContext) {
  const result = await connectGatewayToolkit(toolkit, context);
  return result.redirectUrl || '';
}

export async function getGatewayTriggerTypes(toolkit: string, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    const query = new URLSearchParams();
    if (toolkit) query.set('toolkit', toolkit);
    return managedRequest<{ triggerTypes: unknown[]; totalCount: number; hasMore?: boolean; nextCursor?: string | null }>('/triggers/types', { query }, context);
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  logComposioTrigger('Listing local trigger types', { toolkit });
  const result = await withComposioSignal(15_000, (signal) => composio.triggers.listTypes({
    ...(toolkit ? { toolkits: [toolkit] } : {}),
    limit: 1000,
  } as Parameters<typeof composio.triggers.listTypes>[0], { signal }));
  logComposioTrigger('Listed local trigger types', { toolkit, count: result.items.length, hasMore: Boolean(result.nextCursor) });
  return {
    triggerTypes: result.items,
    totalCount: result.items.length,
    hasMore: Boolean(result.nextCursor),
    nextCursor: result.nextCursor ?? null,
  };
}

export async function listGatewayTriggers(context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') return managedRequest<{ triggers: unknown[] }>('/triggers', {}, context);

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  const accounts = await getConnectedAccounts({}, context);
  const accountById = new Map(accounts.map((account) => [account.id, account as ComposioConnectedAccount]));
  const connectedAccountIds = Array.from(accountById.keys());
  if (connectedAccountIds.length === 0) {
    logComposioTrigger('Skipped local active trigger listing because no connected accounts exist');
    return { triggers: [] };
  }
  logComposioTrigger('Listing local active triggers', { connectedAccountCount: connectedAccountIds.length });
  const result = await withComposioSignal(15_000, (signal) => composio.triggers.listActive({
    connectedAccountIds,
    showDisabled: true,
    limit: 1000,
  } as Parameters<typeof composio.triggers.listActive>[0], { signal }));
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

export async function getLocalWebhookSubscription(context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode !== 'local') return null;
  const [row] = await db
    .select()
    .from(composioWebhookSubscriptions)
    .where(eq(composioWebhookSubscriptions.status, 'active'))
    .orderBy(desc(composioWebhookSubscriptions.updatedAt))
    .limit(1);
  return row ?? null;
}

async function fetchComposioWebhook(url: string, init: RequestInit, timeoutMs: number, mutation: boolean): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw classifyComposioFailure({ error, mutation, timeout: controller.signal.aborted });
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureLocalWebhookSubscription(options: { forceRefresh?: boolean; context: ResolvedComposioContext }) {
  const mode = await getComposioMode(options.context.storageScope);
  if (mode !== 'local') throw new Error('Webhook subscriptions are only supported in local Composio mode.');
  const apiKey = await import('./composio-client').then((m) => m.getLocalComposioApiKey(options.context.storageScope));
  if (!apiKey) throw new Error('Composio API key is required to create a webhook subscription.');
  const existing = await getLocalWebhookSubscription(options.context);
  const currentUrl = `${appBaseUrl()}/api/composio/webhook`;
  if (existing && !options?.forceRefresh) {
    if (existing.webhookUrl !== currentUrl) {
      logComposioTrigger('Webhook URL changed, re-registering subscription');
      return ensureLocalWebhookSubscription({ forceRefresh: true, context: options.context });
    }
    return existing;
  }
  const webhookUrl = `${appBaseUrl()}/api/composio/webhook`;
  logComposioTrigger('Creating local webhook subscription');
  const headers = {
    'X-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
  const subscriptionBody = {
    webhook_url: webhookUrl,
    enabled_events: COMPOSIO_WEBHOOK_EVENT_TYPES,
    version: 'V3',
  };
  const response = await fetchComposioWebhook('https://backend.composio.dev/api/v3.1/webhook_subscriptions', {
    method: 'POST',
    headers,
    body: JSON.stringify(subscriptionBody),
  }, 30_000, true);
  let data: unknown;
  if (response.status === 409) {
    logComposioTrigger('Local webhook subscription already exists, reusing remote subscription');
    data = await reuseExistingLocalWebhookSubscription(apiKey, headers, subscriptionBody);
  } else if (!response.ok) {
    logComposioTriggerError('Failed to create Composio webhook subscription', new Error(`HTTP ${response.status}`), { status: response.status });
    throw classifyComposioFailure({ status: response.status, headers: response.headers, mutation: true });
  } else {
    data = await response.json();
  }

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
      encryptedSecret: await encryptWebhookSecret(secret),
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
        encryptedSecret: await encryptWebhookSecret(secret),
        secretPreview: previewWebhookSecret(secret),
        eventTypes: JSON.stringify(eventTypes),
        status: 'active',
        updatedAt: now,
        rotatedAt: options?.forceRefresh ? now : null,
      },
    })
    .returning();
  logComposioTrigger('Local webhook subscription ensured');
  return row;
}

async function reuseExistingLocalWebhookSubscription(
  apiKey: string,
  headers: Record<string, string>,
  subscriptionBody: { webhook_url: string; enabled_events: string[]; version: string },
): Promise<unknown> {
  const listResponse = await fetchComposioWebhook('https://backend.composio.dev/api/v3.1/webhook_subscriptions?limit=10', {
    method: 'GET',
    headers: { 'X-API-KEY': apiKey },
  }, 15_000, false);
  if (!listResponse.ok) {
    throw classifyComposioFailure({ status: listResponse.status, headers: listResponse.headers });
  }

  const listData = await listResponse.json();
  const listRecord = asRecord(listData);
  const items = Array.isArray(listRecord.items)
    ? listRecord.items
    : Array.isArray(listRecord.data)
      ? listRecord.data
      : [];
  const existingRemote = asRecord(items[0]);
  const subscriptionId = stringValue(existingRemote.id) || stringValue(existingRemote.subscription_id);
  if (!subscriptionId) {
    throw new Error('Composio reported an existing webhook subscription but did not return it from the list endpoint.');
  }

  const updateResponse = await fetchComposioWebhook(`https://backend.composio.dev/api/v3.1/webhook_subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(subscriptionBody),
  }, 30_000, true);
  if (!updateResponse.ok) {
    throw classifyComposioFailure({ status: updateResponse.status, headers: updateResponse.headers, mutation: true });
  }

  const updateData = await updateResponse.json();
  const updateRecord = asRecord((updateData as Record<string, unknown>).subscription ?? updateData);
  const existingSecret = stringValue(existingRemote.secret);
  if (existingSecret && !stringValue(updateRecord.secret)) {
    return { ...updateRecord, secret: existingSecret };
  }
  return updateData;
}

export async function createGatewayTrigger(input: {
  triggerSlug: string;
  toolkitSlug?: string;
  connectedAccountId?: string;
  triggerConfig?: Record<string, unknown>;
  notebookWebhookUrl?: string | null;
}, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    await managedRequest('/webhook/subscription', { method: 'POST', body: {} }, context);
    return managedRequest<{ trigger: Record<string, unknown> }>('/triggers', {
      method: 'POST',
      body: input,
    }, context);
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  await ensureLocalWebhookSubscription({ context });
  logComposioTrigger('Creating local trigger', {
    triggerSlug: input.triggerSlug,
    toolkitSlug: input.toolkitSlug,
    hasConnectedAccountId: Boolean(input.connectedAccountId),
    hasTriggerConfig: Boolean(input.triggerConfig && Object.keys(input.triggerConfig).length > 0),
  });
  const triggerType = await withComposioSignal(15_000, (signal) => composio.triggers.getType(input.triggerSlug, { signal }));
  const composioUserId = context.composioUserId;
  const result = await withComposioSignal(30_000, (signal) => composio.triggers.create(composioUserId, input.triggerSlug, {
    connectedAccountId: input.connectedAccountId,
    triggerConfig: input.triggerConfig || {},
  }, { signal }), true);
  const triggerId = result.triggerId;
  let connectedAccountId = input.connectedAccountId || '';
  try {
    const activeResult = await withComposioSignal(15_000, (signal) => composio.triggers.listActive({
      triggerIds: [triggerId],
      showDisabled: true,
      limit: 1,
    } as Parameters<typeof composio.triggers.listActive>[0], { signal }));
    const activeTrigger = asRecord(activeResult.items[0]);
    connectedAccountId = stringValue(activeTrigger.connectedAccountId) || stringValue(activeTrigger.connected_account_id) || connectedAccountId;
  } catch (error) {
    logComposioTriggerError('Failed to fetch created trigger details', error, { triggerSlug: input.triggerSlug });
  }
  if (!connectedAccountId) {
    throw new Error('Composio created the trigger but did not return the connected account ID.');
  }
  logComposioTrigger('Created local trigger', { triggerSlug: input.triggerSlug });
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

export async function updateGatewayTrigger(
  triggerId: string,
  input: { status?: 'active' | 'paused'; triggerConfig?: Record<string, unknown>; notebookWebhookUrl?: string | null },
  context: ResolvedComposioContext,
) {
  const update = await prepareGatewayTriggerUpdate(context);
  return update(triggerId, input);
}

/** Resolve credentials before a caller holds a database transaction open. */
export async function prepareGatewayTriggerUpdate(context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return (triggerId: string, input: { status?: 'active' | 'paused'; triggerConfig?: Record<string, unknown>; notebookWebhookUrl?: string | null }) => managedRequest<{ trigger: Record<string, unknown> }>(`/triggers/${encodeURIComponent(triggerId)}`, {
      method: 'PATCH',
      body: input,
    }, context);
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  return async (triggerId: string, input: { status?: 'active' | 'paused'; triggerConfig?: Record<string, unknown>; notebookWebhookUrl?: string | null }) => {
    if (input.status === 'paused') await withComposioSignal(30_000, (signal) => composio.triggers.disable(triggerId, { signal }), true);
    if (input.status === 'active') await withComposioSignal(30_000, (signal) => composio.triggers.enable(triggerId, { signal }), true);
    return { trigger: { triggerId, status: input.status } };
  };
}

export async function deleteGatewayTrigger(triggerId: string, context: ResolvedComposioContext) {
  const mode = await getComposioMode(context.storageScope);
  if (mode === 'disabled') throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations or enable managed Composio.');
  if (mode === 'managed') {
    return managedRequest<{ success: boolean }>(`/triggers/${encodeURIComponent(triggerId)}`, { method: 'DELETE' }, context);
  }

  const composio = await getComposio(context.storageScope);
  if (!composio) throw new Error('Composio is not configured. Add COMPOSIO_API_KEY in Settings → Integrations.');
  await withComposioSignal(30_000, (signal) => composio.triggers.delete(triggerId, { signal }), true);
  return { success: true };
}

export function clearComposioGatewayCaches(context?: ResolvedComposioContext | null): void {
  clearToolkitCache();
  triggerAppCache.clear();
  toolVersionCache.clear();
  resetSessionCache(context);
}
