import 'server-only';

import { randomUUID } from 'node:crypto';
import { getComposio, getComposioMode, getLocalComposioApiKey, type ComposioMode } from '@/app/lib/composio/composio-client';
import { resolveBoundComposioContext, type ResolvedComposioContext } from '@/app/lib/composio/composio-context';
import { requestManagedComposio, ManagedComposioProtocolError } from '@/app/lib/composio/managed-composio-client';
import { classifyComposioFailure, ComposioProviderError } from '@/app/lib/composio/composio-provider-error';
import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { prepareToolOutput } from '@/app/lib/pi/tool-output-preparation';
import { IntegrationContractError, type IntegrationExecutionContext, type IntegrationProviderError } from '../contracts';
import { IntegrationReferenceCache } from '../reference-cache';
import { createIntegrationMetadataCacheKey, integrationMetadataCache } from '../metadata-cache';
import type { IntegrationAdapterToolPage, IntegrationAdapterToolSchema, IntegrationResolvedProvider, IntegrationToolAdapter } from '../runtime-contracts';
import { schemaFingerprint } from '../schema';
import { listComposioIntegrationProviders } from './composio';

type RecordValue = Record<string, unknown>;
type ManagedCapabilities = { credentialRevision: string };
type Binding = {
  kind: 'composio_binding';
  context: ResolvedComposioContext;
  toolkit: string;
  mode: Exclude<ComposioMode, 'disabled'>;
  accountId: string | null;
  noAuth: boolean;
  managed: ManagedCapabilities | null;
  client: Awaited<ReturnType<typeof getComposio>>;
  credentialRevision: string;
};
type ToolSchema = IntegrationAdapterToolSchema & { providerSchemaRevision?: string };
type PagePosition = { fingerprint: string; chunk: number; upstreamCursor?: string };
const cursors = new IntegrationReferenceCache<PagePosition>(2048, 15 * 60_000);
const READ_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
const ALLOWED_TOOL_CHUNK_SIZE = 32;

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function concreteVersion(value: unknown): string {
  const version = string(value);
  if (!version || ['latest', 'stable', 'current', 'default'].includes(version.toLowerCase())) {
    throw new IntegrationContractError('schema_changed', 'The Composio tool must provide a concrete version.');
  }
  return version;
}

function bindingFor(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider): Binding {
  const binding = provider.binding as Binding | null;
  if (!binding || binding.kind !== 'composio_binding' || binding.context.userId !== context.actorUserId
    || provider.provider.scope.type !== 'user' || provider.provider.scope.ownerUserId !== context.actorUserId) {
    throw new IntegrationContractError('provider_denied', 'Choose a Composio app from the current integration catalogue.');
  }
  return binding;
}

async function withSignal<T>(signal: AbortSignal | undefined, mutation: boolean, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = AbortSignal.timeout(mutation ? 120_000 : READ_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  try { return await operation(combined); }
  catch (error) {
    if (error instanceof IntegrationContractError) throw error;
    throw publicFailure(error, mutation, timeout.aborted);
  }
}

function publicFailure(error: unknown, mutation = false, timeout = false): IntegrationContractError {
  if (error instanceof IntegrationContractError) return error;
  if (error instanceof ManagedComposioProtocolError) return new IntegrationContractError(error.code, error.message);
  const failure = error instanceof ComposioProviderError ? error : classifyComposioFailure({ error, mutation, timeout });
  if (failure.code === 'COMPOSIO_OUTCOME_UNKNOWN' || failure.outcomeUnknown) {
    return new IntegrationContractError('outcome_unknown', 'The Composio operation outcome is unknown. Check the app before repeating this action.');
  }
  if (failure.code === 'COMPOSIO_AUTH_REQUIRED' || failure.code === 'COMPOSIO_CREDENTIALS_OR_SCOPE') {
    return new IntegrationContractError('provider_denied', 'The selected Composio connection is not authorized. Review its connection settings.');
  }
  return new IntegrationContractError('provider_unavailable', 'Composio is temporarily unavailable. Try this operation again later.');
}

async function managedCapabilities(context: ResolvedComposioContext): Promise<ManagedCapabilities> {
  try {
    const result = record(await requestManagedComposio('/capabilities', { bindingProtocolErrors: true }, context));
    if (result.bindingProtocolVersion !== 1 || result.exactAccountBinding !== true || result.concreteToolVersions !== true
      || result.paginatedToolCatalog !== true || result.supportsToolNameFilter !== true || !string(result.credentialRevision)) {
      throw new IntegrationContractError('provider_unavailable', 'Managed Composio requires the current connection binding protocol. Update the Control Plane.');
    }
    return { credentialRevision: string(result.credentialRevision) };
  } catch (error) {
    if (error instanceof ComposioProviderError && error.upstreamStatus === 404) {
      throw new IntegrationContractError('provider_unavailable', 'Managed Composio requires the current connection binding protocol. Update the Control Plane.');
    }
    throw publicFailure(error);
  }
}

async function liveToolkit(context: ResolvedComposioContext, mode: Binding['mode'], toolkit: string, client: Binding['client']): Promise<RecordValue> {
  return withSignal(undefined, false, async (signal) => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      signal.throwIfAborted();
      const result = record(mode === 'local'
        ? await client!.getClient().toolkits.list({ search: toolkit, limit: 1000, cursor }, { signal, maxRetries: 0 })
        : await requestManagedComposio('/toolkits', { signal, bindingProtocolErrors: true,
          query: new URLSearchParams({ search: toolkit, limit: '1000', ...(cursor ? { cursor } : {}) }) }, context));
      const items = result[mode === 'local' ? 'items' : 'toolkits'];
      if (!Array.isArray(items)) break;
      const app = items.map(record).find((item) => item.slug === toolkit);
      if (app) return app;
      const next = string(result.nextCursor ?? result.next_cursor);
      if (!next || seen.has(next)) break;
      seen.add(next); cursor = next;
    }
    throw new IntegrationContractError('provider_unavailable', 'The selected Composio app could not be verified.');
  });
}

async function liveAccounts(context: ResolvedComposioContext, mode: Binding['mode'], client: Binding['client']): Promise<RecordValue[]> {
  return withSignal(undefined, false, async (signal) => {
    if (mode === 'managed') {
      const result = record(await requestManagedComposio('/status', { signal, bindingProtocolErrors: true }, context));
      if (result.configured === false || result.providerHealthy === false || result.apiKeyValid === false || !Array.isArray(result.connectedAccounts)) {
        throw new IntegrationContractError('provider_unavailable', 'The selected Composio connection could not be verified.');
      }
      return result.connectedAccounts.map(record);
    }
    if (!client) throw new IntegrationContractError('provider_unavailable', 'Composio is not configured.');
    const accounts: RecordValue[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      signal.throwIfAborted();
      const result = await client.connectedAccounts.list({ userIds: [context.composioUserId], limit: 100, cursor }, { signal });
      accounts.push(...result.items.map((item) => item as unknown as RecordValue));
      if (!result.nextCursor) {
        if (result.totalPages > page + 1) break;
        return accounts;
      }
      if (seen.has(result.nextCursor)) break;
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new IntegrationContractError('provider_unavailable', 'The selected Composio account list was incomplete.');
  });
}

async function credentialRevision(context: ResolvedComposioContext, mode: Binding['mode'], managed: ManagedCapabilities | null, client: Binding['client']) {
  const [system, scoped, key] = await Promise.all([
    readScopedEnvState('integrations', { secretScope: 'legacy' }),
    readScopedEnvState('integrations', context.storageScope),
    getLocalComposioApiKey(context.storageScope),
  ]);
  if (mode === 'local' && (!client || client.getConfig().apiKey !== key)) {
    throw new IntegrationContractError('binding_changed', 'The Composio provider configuration changed. Reload the selected connection.');
  }
  return schemaFingerprint([mode, system.revision, scoped.revision, key,
    mode === 'managed' ? [getManagedControlPlaneBaseUrl(), process.env.CANVAS_INSTANCE_TOKEN || null, managed?.credentialRevision] : null]);
}

async function resolveProvider(context: IntegrationExecutionContext, providerRef: string): Promise<IntegrationResolvedProvider> {
  const catalogue = await listComposioIntegrationProviders(context);
  const provider = catalogue.providers.find((item) => item.providerRef === providerRef);
  if (!provider || provider.scope.type !== 'user' || provider.scope.ownerUserId !== context.actorUserId || !provider.application) {
    throw new IntegrationContractError('provider_denied', 'The selected Composio app is unavailable to this user.');
  }
  const prefix = 'profile:';
  const suffix = `:${provider.application}`;
  if (!provider.scope.resourceId.startsWith(prefix) || !provider.scope.resourceId.endsWith(suffix)) {
    throw new IntegrationContractError('provider_denied', 'The selected Composio profile could not be verified.');
  }
  const profileId = provider.scope.resourceId.slice(prefix.length, -suffix.length);
  // Always resolve the explicit owned binding. A changed workspace default cannot
  // silently reroute a previously selected provider or invalidate an unrelated one.
  const resolved = await resolveBoundComposioContext({ userId: context.actorUserId, workspaceId: context.workspaceId, profileId });
  const mode = await getComposioMode(resolved.storageScope);
  if (mode === 'disabled') throw new IntegrationContractError('provider_unavailable', 'Composio is not configured.');
  const managed = mode === 'managed' ? await managedCapabilities(resolved) : null;
  const client = mode === 'local' ? await getComposio(resolved.storageScope) : null;
  const app = await liveToolkit(resolved, mode, provider.application, client);
  const noAuth = (app.noAuth ?? app.isNoAuth ?? app.no_auth) === true;
  const accounts = noAuth ? [] : (await liveAccounts(resolved, mode, client)).filter((item) => record(item.toolkit).slug === provider.application);
  const active = new Map(accounts.filter((item) => item.status === 'ACTIVE' && item.isDisabled !== true && item.is_disabled !== true
    && string(item.id)).map((item) => [string(item.id), item]));
  const canExecute = noAuth || active.size === 1;
  const accountId = !noAuth && active.size === 1 ? active.keys().next().value! : null;
  const revision = await credentialRevision(resolved, mode, managed, client);
  const binding: Binding = { kind: 'composio_binding', context: resolved, toolkit: provider.application, mode, accountId, noAuth, managed,
    client, credentialRevision: revision };
  return { provider: { ...provider, configured: true, requiresAuth: !noAuth, authorized: noAuth || active.size > 0,
    health: 'healthy', canExecute, state: canExecute ? 'ready' : active.size > 1 ? 'unknown' : 'auth_required',
    checkedAt: new Date().toISOString(), statusSource: 'provider' }, binding,
    bindingRevision: schemaFingerprint([context.actorUserId, context.organizationId ?? null, resolved.workspaceId,
      resolved.profileId, resolved.cacheRevision, resolved.composioUserId, mode, revision, noAuth,
      accounts.map((item) => [string(item.id), string(item.status), item.isDisabled === true || item.is_disabled === true]).sort()]) };
}

function pageError(providerRef: string, error: unknown): IntegrationProviderError {
  if (error instanceof IntegrationContractError) return { source: 'composio', providerRef, code: error.code, retryable: false,
    message: 'The selected Composio tool catalogue could not be fully loaded.' };
  const failure = error instanceof ComposioProviderError ? error : classifyComposioFailure({ error });
  return { source: 'composio', providerRef, code: failure.code, retryable: failure.retryable,
    message: 'The selected Composio tool catalogue could not be fully loaded.' };
}

async function listTools(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider,
  input: Parameters<IntegrationToolAdapter['listTools']>[2]): Promise<IntegrationAdapterToolPage> {
  const binding = bindingFor(context, provider);
  const allowed = input.allowedToolNames === null || input.allowedToolNames === undefined ? null : [...new Set(input.allowedToolNames)].sort();
  if (allowed?.length === 0) return { tools: [], complete: true, providerErrors: [], nextCursor: null };
  const query = input.query?.trim() || '';
  const fingerprint = schemaFingerprint([context, provider.bindingRevision, query, input.limit, allowed]);
  let position: PagePosition = { fingerprint, chunk: 0 };
  if (input.cursor) {
    const stored = cursors.get(input.cursor);
    if (!stored || stored.fingerprint !== fingerprint) throw new IntegrationContractError('invalid_cursor', 'Reload the selected Composio tool catalogue.');
    position = { ...stored };
  }
  const chunks: Array<string[] | null> = allowed
    ? Array.from({ length: Math.ceil(allowed.length / ALLOWED_TOOL_CHUNK_SIZE) }, (_, i) => allowed.slice(i * ALLOWED_TOOL_CHUNK_SIZE, (i + 1) * ALLOWED_TOOL_CHUNK_SIZE))
    : [null];
  const tools: IntegrationAdapterToolPage['tools'][number][] = [];
  const errors: IntegrationProviderError[] = [];
  let complete = true;
  try {
    await withSignal(input.signal, false, async (signal) => {
      const client = binding.client;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES && position.chunk < chunks.length && tools.length < input.limit; page += 1) {
        signal.throwIfAborted();
        const chunk = chunks[position.chunk];
        const cacheKey = createIntegrationMetadataCacheKey({ context, source: 'composio', providerRef: provider.provider.providerRef,
          revision: provider.bindingRevision, kind: 'tool_catalog', selector: { query, limit: input.limit - tools.length,
            chunk, cursor: position.upstreamCursor ?? null } });
        const cached = integrationMetadataCache.get<RecordValue>(cacheKey);
        const fetched = cached || record(binding.mode === 'local'
          ? await client!.getClient().tools.list({ toolkit_slug: binding.toolkit, limit: input.limit - tools.length, search: query || undefined,
            tool_slugs: chunk?.join(','), cursor: position.upstreamCursor, important: 'false' }, { signal, maxRetries: 0 })
          : await requestManagedComposio(`/toolkits/${encodeURIComponent(binding.toolkit)}/tools`, { signal, bindingProtocolErrors: true,
            query: new URLSearchParams({
            limit: String(input.limit - tools.length), ...(query ? { search: query } : {}),
            ...(chunk ? { toolNames: JSON.stringify(chunk) } : {}), ...(position.upstreamCursor ? { cursor: position.upstreamCursor } : {}),
          }) }, binding.context));
        const rawItems = fetched[binding.mode === 'local' ? 'items' : 'tools'];
        const result: RecordValue = { nextCursor: fetched.nextCursor ?? fetched.next_cursor,
          complete: fetched.complete, hasMore: fetched.hasMore, [binding.mode === 'local' ? 'items' : 'tools']: Array.isArray(rawItems)
          ? rawItems.map(record).map((item) => ({ slug: string(item.slug), name: string(item.name), description: string(item.description),
            toolkit: typeof item.toolkit === 'string' ? item.toolkit : { slug: string(record(item.toolkit).slug), name: string(record(item.toolkit).name) } })) : null };
        const items = result[binding.mode === 'local' ? 'items' : 'tools'];
        if (!Array.isArray(items)) throw new Error('Invalid tool catalogue');
        for (const item of items.map(record)) {
          const toolkit = typeof item.toolkit === 'string' ? item.toolkit : string(record(item.toolkit).slug);
          const name = string(item.slug);
          if (toolkit !== binding.toolkit || !name || allowed && !allowed.includes(name)) { complete = false; continue; }
          const description = string(item.description).slice(0, 600);
          if (query && !`${name} ${string(item.name)} ${description}`.toLowerCase().includes(query.toLowerCase())) continue;
          tools.push({ name, description, effect: 'unknown' });
        }
        const next = string(result.nextCursor ?? result.next_cursor);
        if (next && (seen.has(next) || next === position.upstreamCursor)) throw new Error('Repeated tool catalogue page');
        if (next) { seen.add(next); position.upstreamCursor = next; }
        else { position.chunk += 1; delete position.upstreamCursor; }
        if (result.complete === false || result.hasMore === true && !next || items.length > input.limit) complete = false;
        if (!cached) integrationMetadataCache.set(cacheKey, result, { complete: complete && result.complete !== false, signal });
        if (page === MAX_PAGES - 1 && position.chunk < chunks.length) complete = false;
      }
    });
  } catch (error) { complete = false; errors.push(pageError(provider.provider.providerRef, error)); }
  input.signal?.throwIfAborted();
  if (!complete && errors.length === 0) errors.push(pageError(provider.provider.providerRef, new ComposioProviderError('Invalid catalogue page.', {
    code: 'COMPOSIO_BAD_RESPONSE', retryable: false,
  })));
  let nextCursor: string | null = null;
  if (position.chunk < chunks.length) {
    nextCursor = `composio-page:v1:${randomUUID()}`;
    cursors.set(nextCursor, position);
  }
  return { tools: tools.slice(0, input.limit), complete, providerErrors: errors, nextCursor };
}

async function describeTool(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider, toolName: string,
  signal?: AbortSignal): Promise<ToolSchema> {
  const binding = bindingFor(context, provider);
  return withSignal(signal, false, async (readSignal) => {
    let tool: RecordValue;
    if (binding.mode === 'managed') {
      const response = record(await requestManagedComposio(`/tools/${encodeURIComponent(toolName)}`, {
        signal: readSignal, bindingProtocolErrors: true,
        query: new URLSearchParams({ toolkit: binding.toolkit }),
      }, binding.context));
      tool = record(response.tool);
    } else {
      const client = binding.client;
      tool = record(await client!.tools.getRawComposioToolBySlug(toolName, undefined, { signal: readSignal }));
    }
    const toolkit = typeof tool.toolkit === 'string' ? tool.toolkit : string(record(tool.toolkit).slug);
    if (tool.slug !== toolName || toolkit !== binding.toolkit) throw new IntegrationContractError('tool_not_found', 'This tool does not belong to the selected Composio app.');
    if (!tool.inputParameters || typeof tool.inputParameters !== 'object' || Array.isArray(tool.inputParameters)) {
      throw new IntegrationContractError('schema_unsupported', 'The Composio tool did not return its input schema.');
    }
    if (binding.noAuth && (binding.mode === 'managed' ? tool.noAuth !== true : tool.isNoAuth === false)) {
      throw new IntegrationContractError('binding_changed', 'This Composio tool requires a current account binding.');
    }
    const version = concreteVersion(tool.version);
    const outputSchema = tool.outputParameters && typeof tool.outputParameters === 'object' && !Array.isArray(tool.outputParameters)
      ? tool.outputParameters as RecordValue : undefined;
    if (binding.mode === 'managed' && !string(tool.schemaRevision)) throw new IntegrationContractError('schema_changed', 'Managed Composio did not return a verified schema revision.');
    return { name: toolName, description: string(tool.description), effect: 'unknown', inputSchema: tool.inputParameters as RecordValue,
      ...(outputSchema === undefined ? {} : { outputSchema }), toolVersion: version,
      ...(binding.mode === 'managed' ? { providerSchemaRevision: string(tool.schemaRevision) } : {}) };
  });
}

async function callTool(context: IntegrationExecutionContext, provider: IntegrationResolvedProvider, tool: IntegrationAdapterToolSchema,
  args: RecordValue, input: Parameters<IntegrationToolAdapter['callTool']>[4]) {
  const current = await resolveProvider(context, provider.provider.providerRef);
  if (current.bindingRevision !== provider.bindingRevision) throw new IntegrationContractError('binding_changed', 'The selected Composio account changed. Load the schema again.');
  if (!current.provider.canExecute) throw new IntegrationContractError('provider_unavailable', 'Select a single active Composio account before executing this tool.');
  const schema = await describeTool(context, current, tool.name, input.signal);
  if (schemaFingerprint(schema) !== schemaFingerprint(tool)) throw new IntegrationContractError('schema_changed', 'The Composio tool schema changed. Load it again.');
  const binding = bindingFor(context, current);
  const version = concreteVersion(schema.toolVersion);
  const checkedCredentials = await credentialRevision(binding.context, binding.mode,
    binding.mode === 'managed' ? await managedCapabilities(binding.context) : null, binding.client);
  if (checkedCredentials !== binding.credentialRevision) throw new IntegrationContractError('binding_changed', 'The Composio provider configuration changed. Load the schema again.');
  await input.beforeDispatch?.();
  input.signal?.throwIfAborted();
  const result = await withSignal(input.signal, true, async (signal) => {
    if (binding.mode === 'managed') return requestManagedComposio('/execute', { method: 'POST', signal, bindingProtocolErrors: true, body: {
      bindingProtocolVersion: 1, action: tool.name, params: args, toolkit: binding.toolkit, version,
      connectedAccountId: binding.accountId, credentialRevision: binding.managed!.credentialRevision,
      schemaRevision: schema.providerSchemaRevision,
    } }, binding.context);
    const client = binding.client;
    return client!.getClient().tools.execute(tool.name, { user_id: binding.context.composioUserId,
      connected_account_id: binding.accountId ?? undefined, version, arguments: args }, { signal, maxRetries: 0 });
  });
  return prepareToolOutput({ result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} },
    raw: result, identity: getAgentExecutionContext(), toolCallId: input.toolCallId, toolName: 'integrations' });
}

export const composioIntegrationToolAdapter: IntegrationToolAdapter = {
  source: 'composio', resolveProvider, listTools, describeTool, callTool,
};
