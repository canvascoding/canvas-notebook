import 'server-only';
import { createHash } from 'node:crypto';
import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { resolveBoundComposioContext, type ResolvedComposioContext } from '@/app/lib/composio/composio-context';
import { getComposioForContext, getComposioModeForContext, getLocalComposioApiKeyForContext } from '@/app/lib/composio/composio-client';
import { requestManagedComposio } from '@/app/lib/composio/managed-composio-client';
import { resolveAuthorizedComposioConnectionContext } from '@/app/lib/composio/composio-shared-context';
import { getComposioConnectionObservationRevision } from '@/app/lib/composio/composio-connection-observation-revision';
import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';
import { authorizeIntegrationConnection } from '@/app/lib/integration-tools/connections/store';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { readAgentComposioOptionsCatalogue, readAgentMcpOptionsInventory,
  readAgentOwnMcpOptionMetadata } from '@/app/lib/agents/extension-options-inventory';
import type { PluginExtensionItem, PluginExtensionConnection } from '@/app/lib/plugins/plugin-extension-contracts';
import type { PluginExtensionSourceResult } from '@/app/lib/plugins/plugin-extension-integrations';
import { publicPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import { resolveMcpCredentialScope } from '@/app/lib/mcp/credential-storage';
import { resolveSharedMcpBackend } from '@/app/lib/mcp/shared-connections';
import { readMcpConnectionHealth } from '@/app/lib/mcp/connection-health';
import { getMcpOAuthStatus } from '@/app/lib/mcp/oauth';
import { readMcpAvailableEnvSnapshot } from '@/app/lib/mcp/env-runtime';
import { expandMcpEnvValue } from '@/app/lib/mcp/env-references';
import type { McpScope } from '@/app/lib/mcp/scope';
import type { McpServerConfig } from '@/app/lib/mcp/config';
import type { StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import { authorizeChatExtensionSharedOption, listChatExtensionSharedOptions,
  revalidateChatExtensionOptionsContext, type ChatExtensionOptionsContext } from './extension-options-context';
import { ExtensionConnectionObservations } from './extension-connection-observations';

type Account = { id: string; toolkit: string; name: string; active: boolean; logo?: string };
type Observation = { accounts: Account[]; configured: boolean; complete: boolean; checkedAt: string };
const host = globalThis as typeof globalThis & { __canvasChatConnectionObservationsV1?: ExtensionConnectionObservations<Observation> };
const observations = host.__canvasChatConnectionObservationsV1 ??= new ExtensionConnectionObservations<Observation>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 256) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit) : '';
const identity = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : '';
const visibleToolkit = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)
  && isComposioIntegrationApplicationVisible(value) ? value : '';
const unavailable = (): Observation => ({ accounts: [], configured: false, complete: false, checkedAt: new Date().toISOString() });

async function observationKey(context: ChatExtensionOptionsContext, profile: ResolvedComposioContext) {
  const mode = await getComposioModeForContext(profile);
  const scoped = await readScopedEnvState('integrations', profile.storageScope);
  // Only a private change stamp is retained; no key, provider entity or shared
  // backend identity enters the public connection DTO.
  const credential = mode === 'local' ? digest(await getLocalComposioApiKeyForContext(profile))
    : digest([getManagedControlPlaneBaseUrl(), process.env.CANVAS_INSTANCE_TOKEN ?? null]);
  return { mode, key: digest([context.actor.userId, context.organizationId, context.actor.workspaceId,
    profile.profileId, profile.cacheRevision, profile.composioUserId, mode, scoped.revision, credential, getComposioConnectionObservationRevision(),
    profile.sharedBinding ? [profile.sharedBinding.authorization.resource.connectionRef, profile.sharedBinding.authorization.backend,
      profile.sharedBinding.authorization.authorizationRevision] : null]) };
}

function accounts(values: unknown[]): Account[] {
  const result: Account[] = [];
  for (const value of values) {
    const item = record(value), toolkit = record(item.toolkit), slug = visibleToolkit(toolkit.slug), id = identity(item.id);
    if (!slug || !id) continue;
    const meta = record(toolkit.meta), logo = text(meta.logo ?? toolkit.logo, 2048);
    result.push({ id, toolkit: slug, name: text(toolkit.name) || slug,
      active: item.status === 'ACTIVE' && item.isDisabled !== true && item.is_disabled !== true,
      ...(logo ? { logo } : {}) });
  }
  return result;
}

/** Account observations only. This operation never retrieves toolkit/tool
 * catalogues, initializes a business API, creates a profile, or selects an account. */
async function observeAccounts(profile: ResolvedComposioContext, mode: 'local' | 'managed' | 'disabled', signal: AbortSignal): Promise<Observation> {
  if (mode === 'disabled') return unavailable();
  if (mode === 'managed') {
    const result = record(await requestManagedComposio('/status', { signal }, profile));
    if (!Array.isArray(result.connectedAccounts) || result.connectedAccounts.length > 1024) throw new Error('Incomplete account observation.');
    return { accounts: accounts(result.connectedAccounts), configured: result.configured !== false,
      complete: result.providerHealthy !== false && result.apiKeyValid !== false, checkedAt: new Date().toISOString() };
  }
  const client = await getComposioForContext(profile);
  if (!client) return unavailable();
  const values: unknown[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    signal.throwIfAborted();
    const result = await client.connectedAccounts.list({ userIds: [profile.composioUserId], limit: 100,
      ...(cursor ? { cursor } : {}) }, { signal });
    if (!Array.isArray(result.items) || values.length + result.items.length > 1024) throw new Error('Incomplete account observation.');
    values.push(...result.items);
    const next = result.nextCursor ?? (result as unknown as Record<string, unknown>).next_cursor;
    if (!next) {
      if (Number(result.totalPages ?? 1) > page + 1) throw new Error('Incomplete account observation.');
      return { accounts: accounts(values), configured: true, complete: true, checkedAt: new Date().toISOString() };
    }
    if (typeof next !== 'string' || next.length > 2048 || seen.has(next)) throw new Error('Incomplete account observation.');
    seen.add(next); cursor = next;
  }
  throw new Error('Incomplete account observation.');
}

/** Current rights and source revisions always gate private cached observations.
 * A cold local search performs zero provider I/O; the connected phase warms it. */
export async function readChatComposioConnectionInventory(context: ChatExtensionOptionsContext, signal: AbortSignal,
  refresh = false): Promise<PluginExtensionSourceResult> {
  await revalidateChatExtensionOptionsContext(context);
  const base = await readAgentComposioOptionsCatalogue(context, signal, { localOnly: true });
  const apps = new Map(base.items.filter((item): item is Extract<PluginExtensionItem, { kind: 'integration' }> => item.kind === 'integration')
    .map(item => [item.toolkit.slug, item]));
  let partial = false;
  const app = (toolkit: string, name: string, logo?: string) => {
    let item = apps.get(toolkit);
    if (!item) {
      const icon = publicPluginExtensionIcon(logo, `composio:${toolkit}`);
      item = { id: `composio:${toolkit}`, kind: 'integration', name: toolkit, displayName: name || toolkit,
        description: '', source: 'composio', stock: 'installed', access: { canRead: true, canUse: false, canManage: false },
        toolkit: { slug: toolkit, noAuth: false }, connections: [], ...(icon ? { icon } : {}) }; apps.set(toolkit, item);
    }
    return item;
  };
  const profiles = await listExistingComposioProfiles(context.actor.userId);
  if (profiles.length > 32) throw new Error('Too many connection profiles.');
  const profileStamps = new Map<string, string>();
  for (const profile of profiles) {
    if (profile.ownerUserId !== context.actor.userId || profile.status !== 'active') continue;
    signal.throwIfAborted();
    try {
      const resolved = await resolveBoundComposioContext({ userId: context.actor.userId, workspaceId: context.actor.workspaceId, profileId: profile.id });
      const current = await observationKey(context, resolved);
      profileStamps.set(profile.id, current.key);
      const observed = refresh ? await observations.refresh(current.key, abort => observeAccounts(resolved, current.mode, abort), unavailable())
        : observations.get(current.key);
      if (!observed) continue;
      partial ||= !observed.complete;
      for (const account of observed.accounts) {
        const item = app(account.toolkit, account.name, account.logo);
        item.connections.push({ connectionRef: `composio-personal:${profile.id}:${account.id}`, displayName: text(profile.name),
          ownership: { type: 'user', ownerUserId: context.actor.userId, organizationId: context.organizationId },
          access: { canRead: true, canUse: true, canManage: true }, enabled: observed.configured,
          authorization: observed.complete ? account.active ? 'authorized' : 'required' : 'unknown',
          health: observed.complete ? 'unknown' : 'unavailable', checkedAt: observed.checkedAt,
          profileId: profile.id, accountId: account.id });
      }
    } catch { partial = true; }
  }
  const shared = await listChatExtensionSharedOptions(context, 'composio');
  const sharedStamps = new Map<string, string>();
  for (const binding of shared) {
    signal.throwIfAborted();
    if (binding.backend.source !== 'composio') continue;
    const backend = binding.backend;
    const item = apps.get(backend.toolkit), summary = item?.connections.find(value => value.connectionRef === binding.resource.connectionRef);
    if (!summary) continue;
    try {
      // A target grant is not human Inspect. Unknown status remains lower in
      // the catalogue when the actor has only that narrower grant.
      const authorized = await authorizeIntegrationConnection({ userId: context.actor.userId, organizationId: context.organizationId,
        workspaceId: context.actor.workspaceId }, binding.resource.connectionRef, 'inspect');
      const resolved = await resolveAuthorizedComposioConnectionContext(authorized), current = await observationKey(context, resolved);
      sharedStamps.set(binding.resource.connectionRef, current.key);
      const observed = refresh ? await observations.refresh(current.key, abort => observeAccounts(resolved, current.mode, abort), unavailable())
        : observations.get(current.key);
      if (!observed) { summary.authorization = 'unknown'; continue; }
      const account = observed.accounts.find(value => value.id === backend.connectedAccountId && value.toolkit === backend.toolkit);
      summary.authorization = !observed.complete ? 'unknown' : backend.accountBinding === 'no_auth' ? 'not_required'
        : backend.accountBinding === 'account' && account?.active ? 'authorized' : 'required';
      summary.enabled = summary.enabled && observed.configured;
      summary.health = observed.complete ? 'unknown' : 'unavailable'; summary.checkedAt = observed.checkedAt;
    } catch { summary.authorization = 'unknown'; }
  }
  // Account metadata may have taken seconds: reject changed profile ownership,
  // credentials, current target grants and workspace/agent policy afterwards.
  const freshProfiles = new Map((await listExistingComposioProfiles(context.actor.userId)).filter(profile => profile.status === 'active'
    && profile.ownerUserId === context.actor.userId).map(profile => [profile.id, profile]));
  for (const [id, stamp] of profileStamps) {
    let valid = false;
    try {
      if (freshProfiles.has(id)) valid = (await observationKey(context, await resolveBoundComposioContext({ userId: context.actor.userId,
        workspaceId: context.actor.workspaceId, profileId: id }))).key === stamp;
    } catch { /* A changed source is omitted. */ }
    if (!valid) for (const item of apps.values()) item.connections = item.connections.filter(value => value.profileId !== id);
  }
  const freshShared = new Map((await listChatExtensionSharedOptions(context, 'composio')).map(binding => [binding.resource.connectionRef, binding]));
  for (const [reference, stamp] of sharedStamps) try {
    const current = await authorizeIntegrationConnection({ userId: context.actor.userId, organizationId: context.organizationId,
      workspaceId: context.actor.workspaceId }, reference, 'inspect');
    if ((await observationKey(context, await resolveAuthorizedComposioConnectionContext(current))).key !== stamp) throw new Error('Changed source.');
  } catch {
    for (const item of apps.values()) for (const connection of item.connections) if (connection.connectionRef === reference) connection.authorization = 'unknown';
  }
  for (const item of apps.values()) {
    item.connections = item.connections.filter(connection => connection.profileId || (() => {
      const before = shared.find(value => value.resource.connectionRef === connection.connectionRef), after = freshShared.get(connection.connectionRef);
      return before && after && digest(before) === digest(after);
    })());
    item.access.canUse = item.connections.some(connection => connection.access.canUse);
    item.access.canManage = item.connections.some(connection => connection.access.canManage);
  }
  await revalidateChatExtensionOptionsContext(context); signal.throwIfAborted();
  return { items: [...apps.values()].filter(item => item.connections.length), coverage: { source: 'composio', status: partial ? 'partial' : 'complete',
    ...(partial ? { error: { code: 'CHAT_CONNECTION_STATUS_PARTIAL', message: 'Some connection observations are unavailable.', retryable: true } } : {}) } };
}

async function mcpObservation(serverName: string, connection: McpServerConfig & { connectionId: string }, scope: McpScope,
  summary: PluginExtensionConnection, authority?: unknown): Promise<{ summary: PluginExtensionConnection; stamp: string }> {
  const health = await readMcpConnectionHealth(connection, scope), environment = await readMcpAvailableEnvSnapshot(scope);
  const missing = new Set<string>();
  const expressions = [connection.url ?? '', ...(connection.args ?? []), ...Object.values(connection.env ?? {}), ...Object.values(connection.headers ?? {})];
  for (const expression of expressions) expandMcpEnvValue(expression, environment.values, missing);
  for (const key of [...Object.values(connection.headersFromEnv ?? {}), ...(connection.envPassthrough ?? []), ...(connection.bearerTokenEnv ? [connection.bearerTokenEnv] : [])])
    if (!environment.values[key]?.trim()) missing.add(key);
  const oauth = connection.auth === 'oauth' || Boolean(connection.oauth) ? await getMcpOAuthStatus(serverName, undefined, scope) : null;
  const knownAuthFailure = health.authStatus === 'reauth_required' || health.lastErrorCode === 'insufficient_scope';
  const authorization: PluginExtensionConnection['authorization'] = missing.size || knownAuthFailure ? 'required'
    : oauth ? !oauth.configured || oauth.code && oauth.code !== 'reauth_required' ? 'unknown' : oauth.authorized ? 'authorized' : 'required'
      : connection.bearerTokenEnv || Object.keys(connection.headers ?? {}).length || Object.keys(connection.headersFromEnv ?? {}).length
        || Object.keys(connection.env ?? {}).length ? 'authorized' : 'not_required';
  const transport = connection.command?.trim() ? process.env.MCP_ALLOW_STDIO === 'true' : Boolean(connection.url?.trim());
  return { summary: { ...summary, authorization, enabled: summary.enabled && connection.enabled !== false && transport && missing.size === 0,
    health: health.reachability === 'unreachable' ? 'unavailable' : health.reachability === 'reachable' ? 'healthy' : 'unknown',
    checkedAt: health.lastCheckedAt }, stamp: digest([connection, environment.revision, health.authGeneration, health.authStatus,
      health.reachability, health.lastErrorCode, oauth?.authVersion, oauth?.lastCompletedState, oauth?.configured, oauth?.code,
      oauth?.authorized, transport, authority]) };
}

/** Status is exclusively local credential/health metadata. No MCP initialize,
 * OAuth refresh, provider probe or external favicon request occurs here. */
export async function readChatMcpConnectionInventory(context: ChatExtensionOptionsContext): Promise<PluginExtensionSourceResult> {
  const inventory = await readAgentMcpOptionsInventory(context);
  const observed: Array<{ item: Extract<PluginExtensionItem, { kind: 'mcp' }>; index: number; stamp: string;
    read: () => Promise<{ summary: PluginExtensionConnection; stamp: string }> }> = [];
  for (const item of inventory.items) if (item.kind === 'mcp' && !item.mcp.template) {
    for (let index = 0; index < item.connections.length; index++) {
      const summary = item.connections[index]!;
      try {
        const read = async () => {
          if (summary.ownership.type === 'user') {
            const metadata = await readAgentOwnMcpOptionMetadata(context, summary.connectionRef);
            if (!metadata?.connection.connectionId) throw new Error('Changed connection.');
            const connection = metadata.connection as McpServerConfig & { connectionId: string };
            return mcpObservation(metadata.serverName, connection, resolveMcpCredentialScope(connection, { userId: context.actor.userId }), summary);
          }
          const resolved = await resolveSharedMcpBackend({ userId: context.actor.userId, organizationId: context.organizationId,
            workspaceId: context.actor.workspaceId }, summary.connectionRef, 'inspect');
          const binding = await authorizeChatExtensionSharedOption(context, summary.connectionRef);
          if (binding.backend.source !== 'mcp' || binding.backend.connectionId !== resolved.connection.connectionId) throw new Error('Changed shared source.');
          const freshSummary = { ...summary, access: { ...summary.access, canUse: binding.canUse && binding.allowedToolNames?.length !== 0,
            canManage: binding.canManage }, enabled: summary.enabled && binding.resource.status === 'active' && resolved.authorization.resource.status === 'active' };
          return mcpObservation(resolved.serverName, resolved.connection, resolved.scope, freshSummary,
            [binding, resolved.authorization.authorizationRevision]);
        };
        const current = await read(); item.connections[index] = current.summary;
        observed.push({ item, index, stamp: current.stamp, read });
      } catch { item.connections[index] = { ...summary, authorization: 'unknown', health: 'unknown' }; }
    }
  }
  // An earlier source may change while later local credentials are read. Re-read
  // each exact source/config/env/OAuth generation after the complete first pass.
  // These private stamps never confer authority and never enter the response.
  for (const entry of observed) try {
    const current = await entry.read();
    if (current.stamp !== entry.stamp) throw new Error('Changed MCP status source.');
    entry.item.connections[entry.index] = current.summary;
  } catch { entry.item.connections[entry.index] = { ...entry.item.connections[entry.index]!, authorization: 'unknown', health: 'unknown' }; }
  await revalidateChatExtensionOptionsContext(context);
  return inventory;
}

export const isChatConnectionReady = (connection: PluginExtensionConnection): boolean => connection.access.canUse && connection.enabled
  && (connection.authorization === 'authorized' || connection.authorization === 'not_required') && connection.health !== 'unavailable';

/** Exact MRU selections are ranked only against the same freshly authorized
 * metadata inventory. Account ambiguity remains an explicit chooser concern. */
export function isChatStandaloneSelectionReady(selection: StandaloneExtensionSelection, items: readonly PluginExtensionItem[]): boolean {
  const reference = selection.target.kind === 'shared' ? selection.target.connectionRef : selection.kind === 'mcp' ? selection.target.connectionRef
    : selection.target.accountBinding === 'account' ? `composio-personal:${selection.target.profileId}:${selection.target.accountId}` : null;
  return reference !== null && items.some(item => (item.kind === 'mcp' || item.kind === 'integration')
    && (selection.kind !== 'composio' || item.kind === 'integration' && item.toolkit.slug === selection.toolkit)
    && item.connections.some(connection => connection.connectionRef === reference && isChatConnectionReady(connection)));
}
