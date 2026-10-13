import 'server-only';

import { createHash } from 'node:crypto';

import type { CapabilityResourceActor, CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import type { IntegrationConnectionDescriptor } from '@/app/lib/integration-tools/connections/contracts';
import type { PluginExtensionConnection, PluginExtensionCoverage, PluginExtensionItem } from './plugin-extension-contracts';

export type PluginExtensionSourceResult = { items: PluginExtensionItem[]; coverage: PluginExtensionCoverage; continuation?: string };
const text = (value: unknown, limit = 200) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit) : '';
const opaqueIdentity = (value: unknown, limit = 256): string => typeof value === 'string' && value.length > 0 && value.length <= limit
  && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : '';
const canonicalToolkit = (value: unknown): string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value) ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const own = (actor: CapabilityResourceActor): CapabilityResourceOwnerScope => ({ type: 'user', ownerUserId: actor.userId, organizationId: null });
const access = { canRead: true, canUse: true, canManage: true };
const personalComposioObservations = new WeakMap<PluginExtensionConnection, { profileRevision: string; userId: string; mode: 'local' | 'managed' }>();

/** Private provenance stays outside serializable DTOs and is refreshed after catalogue IO. */
export async function revalidatePersonalComposioExtensionConnection(actor: CapabilityResourceActor, connection: PluginExtensionConnection): Promise<boolean> {
  const observed = personalComposioObservations.get(connection);
  if (!observed || !connection.profileId) return false;
  try {
    const [{ resolveBoundComposioContext }, { getComposioMode }] = await Promise.all([
      import('@/app/lib/composio/composio-context'), import('@/app/lib/composio/composio-client')]);
    const current = await resolveBoundComposioContext({ userId: actor.userId, workspaceId: actor.workspaceId, profileId: connection.profileId });
    return current.cacheRevision === observed.profileRevision && current.composioUserId === observed.userId
      && await getComposioMode(current.storageScope) === observed.mode;
  } catch { return false; }
}

export function publicSharedExtensionConnection(value: IntegrationConnectionDescriptor): PluginExtensionConnection {
  return { connectionRef: value.resource.connectionRef, displayName: text(value.resource.displayName),
    ownership: value.resource.ownership, ownershipLabel: value.ownershipLabel,
    access: { canRead: value.access.canRead === true, canUse: value.access.canUse === true, canManage: value.access.canManage === true },
    authorization: 'unknown', health: 'unknown', enabled: value.resource.status === 'active' };
}

/** Shared credential/profile/account identifiers never enter a management DTO. */
export async function readComposioExtensions(actor: CapabilityResourceActor, signal: AbortSignal,
  options: { search?: string; continuation?: string; maxPages?: number; selectedSlug?: string } = {}): Promise<PluginExtensionSourceResult> {
  const [{ resolveComposioContext, resolveBoundComposioContext }, { listComposioProfiles }, { getComposioMode, getComposio },
    { loadLocalComposioMetadata, loadManagedComposioMetadata, isComposioIntegrationApplicationVisible },
    { listSharedIntegrationConnections }] = await Promise.all([
    import('@/app/lib/composio/composio-context'), import('@/app/lib/composio/composio-profiles'),
    import('@/app/lib/composio/composio-client'), import('@/app/lib/integration-tools/adapters/composio'),
    import('@/app/lib/integration-tools/connections/store'),
  ]);
  const apps = new Map<string, Extract<PluginExtensionItem, { kind: 'integration' }>>();
  let partial = false, configured = false, continuation: string | undefined;
  const app = (slug: string, metadata: Record<string, unknown> = {}) => {
    const existing = apps.get(slug);
    if (existing) return existing;
    const meta = record(metadata.meta), noAuth = (metadata.noAuth ?? metadata.isNoAuth ?? metadata.no_auth) === true;
    const value: Extract<PluginExtensionItem, { kind: 'integration' }> = { id: `composio:${slug}`, kind: 'integration',
      name: slug, displayName: text(metadata.name) || slug, description: text(meta.description ?? metadata.description, 4096),
      source: 'composio', stock: 'available', access: { canRead: true, canUse: false, canManage: false },
      toolkit: { slug, noAuth }, connections: [] };
    apps.set(slug, value); return value;
  };
  try {
    const effective = await resolveComposioContext({ userId: actor.userId, workspaceId: actor.workspaceId });
    const mode = await getComposioMode(effective.storageScope);
    configured = mode !== 'disabled';
    if (configured) {
      const contexts = [];
      for (const profile of await listComposioProfiles(actor.userId)) {
        if (profile.status !== 'active') continue;
        try {
          signal.throwIfAborted();
          contexts.push(profile.id === effective.profileId ? effective : await resolveBoundComposioContext({
            userId: actor.userId, workspaceId: actor.workspaceId, profileId: profile.id }));
        } catch { partial = true; }
      }
      if (!contexts.length) partial = true;
      else {
        const binding = createHash('sha256').update(JSON.stringify([mode, contexts.map(context => [context.profileId, context.cacheRevision, context.composioUserId]).sort()])).digest('base64url');
        let cursor: string | undefined;
        if (options.continuation) {
          const previous = JSON.parse(Buffer.from(options.continuation, 'base64url').toString('utf8')) as { v: unknown; binding: unknown; cursor: unknown };
          if (previous.v !== 1 || previous.binding !== binding || typeof previous.cursor !== 'string' || !previous.cursor || previous.cursor.length > 2048) throw new Error('COMPOSIO_CATALOG_BINDING_CHANGED');
          cursor = previous.cursor;
        }
        const catalogueQuery = { search: options.search, cursor, maxPages: options.maxPages };
        const collections = mode === 'local' ? await loadLocalComposioMetadata(contexts, signal, catalogueQuery) : await loadManagedComposioMetadata(contexts, signal, catalogueQuery);
        continuation = collections.catalogue.nextCursor ? Buffer.from(JSON.stringify({ v: 1, binding, cursor: collections.catalogue.nextCursor })).toString('base64url') : undefined;
        partial ||= !collections.catalogue.complete || collections.accounts.some(profile => !profile.complete);
        if (options.selectedSlug && canonicalToolkit(options.selectedSlug) && isComposioIntegrationApplicationVisible(options.selectedSlug)
          && !collections.catalogue.items.some(item => item.slug === options.selectedSlug)) {
          try {
            // The provider decides membership in the current project catalogue;
            // a canonical slug in a URL never fabricates an offering.
            if (mode === 'local') {
              const client = await getComposio(contexts[0].storageScope);
              if (!client) throw new Error('COMPOSIO_NOT_CONFIGURED');
              const exact = record(await client.getClient().toolkits.retrieve(options.selectedSlug, {}, { signal, maxRetries: 0 }));
              if (exact.slug === options.selectedSlug) collections.catalogue.items.push(exact);
            } else {
              const exact = await loadManagedComposioMetadata(contexts, signal, { search: options.selectedSlug });
              collections.catalogue.items.push(...exact.catalogue.items.filter(item => item.slug === options.selectedSlug));
              partial ||= !exact.catalogue.complete;
            }
          } catch { partial = true; }
        }
        for (const metadata of collections.catalogue.items) {
          const slug = canonicalToolkit(metadata.slug);
          if (!slug) { partial = true; continue; }
          if (slug && isComposioIntegrationApplicationVisible(slug)) app(slug, metadata);
        }
        for (const profile of collections.accounts) for (const account of profile.items) {
          const toolkit = record(account.toolkit), slug = canonicalToolkit(toolkit.slug), id = opaqueIdentity(account.id);
          if (!slug || !id || !opaqueIdentity(profile.context.profileId)) { partial = true; continue; }
          if (!isComposioIntegrationApplicationVisible(slug)) continue;
          const item = app(slug, { name: toolkit.name });
          const active = account.status === 'ACTIVE' && account.isDisabled !== true && account.is_disabled !== true;
          const summary: PluginExtensionConnection = { connectionRef: `composio-personal:${profile.context.profileId}:${id}`,
            displayName: profile.context.profileName, ownership: own(actor), access: { ...access },
            authorization: !profile.complete ? 'unknown' : active ? 'authorized' : 'required',
            // Account status proves authorization, never the business API's reachability.
            health: 'unknown', enabled: profile.configured, profileId: profile.context.profileId, accountId: id };
          personalComposioObservations.set(summary, { profileRevision: profile.context.cacheRevision, userId: profile.context.composioUserId, mode: mode === 'local' ? 'local' : 'managed' });
          item.connections.push(summary);
        }
      }
    }
  } catch { partial = true; }
  try {
    const shared = await listSharedIntegrationConnections(actor, 'composio');
    for (const value of shared) {
      if (value.resource.status !== 'active' || !value.access.canRead || !value.resource.application
        || !isComposioIntegrationApplicationVisible(value.resource.application)) continue;
      const item = app(value.resource.application);
      item.connections.push(publicSharedExtensionConnection(value));
    }
  } catch { partial = true; }
  for (const item of apps.values()) {
    item.connections.sort((a, b) => a.connectionRef.localeCompare(b.connectionRef));
    item.stock = item.connections.length ? 'installed' : 'available';
    item.access.canUse = item.connections.some(connection => connection.access.canUse);
    item.access.canManage = item.connections.some(connection => connection.access.canManage);
  }
  return { items: [...apps.values()], ...(continuation ? { continuation } : {}), coverage: { source: 'composio',
    status: partial ? apps.size ? 'partial' : 'unavailable' : configured ? 'complete' : apps.size ? 'partial' : 'not_configured',
    ...(partial ? { error: { code: 'COMPOSIO_CATALOG_PARTIAL', message: 'The Composio catalogue or some connection profiles could not be fully checked.', retryable: true } }
      : !configured && apps.size ? { error: { code: 'COMPOSIO_CATALOG_NOT_CONFIGURED', message: 'Only known shared connections are shown; the personal Composio catalogue is not configured.', retryable: false } } : {}) } };
}

export async function readMcpExtensions(actor: CapabilityResourceActor): Promise<PluginExtensionSourceResult> {
  const [{ requireMcpUserAccess, assertMcpConnectionAccess, McpAccessError }, { readMcpConfig }, { readMcpConnectionStatus },
    { getMcpOAuthStatus }, { listMcpServerDefinitions }, { listSharedIntegrationConnections }] = await Promise.all([
    import('@/app/lib/mcp/access'), import('@/app/lib/mcp/config'), import('@/app/lib/mcp/connection-status'),
    import('@/app/lib/mcp/oauth'), import('@/app/lib/mcp/server-definitions'), import('@/app/lib/integration-tools/connections/store'),
  ]);
  const items: PluginExtensionItem[] = [], usedDefinitions = new Set<string>();
  let partial = false;
  try {
    const mcpActor = await requireMcpUserAccess({ userId: actor.userId });
    if (mcpActor) {
      const scope = { userId: actor.userId, organizationId: mcpActor.organizationId };
      const config = await readMcpConfig(scope);
      for (const name of Object.keys(config.mcpServers)) {
        try {
          const { connection } = await assertMcpConnectionAccess(name, scope, { allowDisabled: true, actor: mcpActor });
          if (!connection.connectionId || connection.ownerUserId !== actor.userId) continue;
          const requiresOAuth = connection.auth === 'oauth' || Boolean(connection.oauth);
          const summary: PluginExtensionConnection = { connectionRef: `mcp-personal:${connection.connectionId}`, displayName: text(connection.displayName) || name,
            ownership: { type: 'user', ownerUserId: actor.userId, organizationId: connection.organizationId || null }, access: { ...access },
            authorization: 'unknown', health: 'unknown', enabled: connection.enabled !== false };
          try {
            const current = connection as typeof connection & { connectionId: string };
            const health = await readMcpConnectionStatus(name, current, scope), oauth = await getMcpOAuthStatus(name, undefined, scope);
            summary.authorization = requiresOAuth ? oauth.authorized ? 'authorized' : oauth.configured ? 'required' : 'unknown'
              : connection.bearerTokenEnv || Object.keys(connection.headersFromEnv || {}).length || Object.keys(connection.env || {}).length ? 'unknown' : 'not_required';
            summary.checkedAt = health.lastCheckedAt;
            const checked = Date.parse(health.lastCheckedAt || '');
            if (Number.isFinite(checked) && checked <= Date.now() && Date.now() - checked <= 15 * 60_000) {
              summary.health = health.reachability === 'reachable' ? 'healthy' : health.reachability === 'unreachable' ? 'unavailable' : 'unknown';
            }
          } catch { partial = true; }
          items.push({ id: summary.connectionRef, kind: 'mcp', name, displayName: summary.displayName, description: '', source: 'mcp', stock: 'installed',
            access: summary.access, ownership: summary.ownership,
            mcp: { serverId: connection.connectionId, transport: connection.command ? 'stdio' : connection.url ? 'http' : 'unknown', template: false }, connections: [summary] });
          if (connection.serverDefinitionId) usedDefinitions.add(connection.serverDefinitionId);
        } catch (error) { if (!(error instanceof McpAccessError && [403, 404].includes(error.status))) partial = true; }
      }
      if (mcpActor.organizationId) for (const definition of await listMcpServerDefinitions(mcpActor.organizationId)) {
        if (!definition.enabled || usedDefinitions.has(definition.id)) continue;
        items.push({ id: `mcp-definition:${definition.id}`, kind: 'mcp', name: definition.name, displayName: text(definition.name), description: '',
          source: 'mcp', stock: 'available', access: { canRead: true, canUse: false, canManage: mcpActor.canManageDefinitions },
          ownership: { type: 'organization', organizationId: definition.organizationId },
          mcp: { definitionId: definition.id, transport: 'http', template: true }, connections: [] });
      }
    }
  } catch (error) { if (!(error instanceof McpAccessError && error.status === 403)) partial = true; }
  try {
    for (const value of await listSharedIntegrationConnections(actor, 'mcp')) {
      if (!value.access.canRead || value.resource.status !== 'active') continue;
      const summary = publicSharedExtensionConnection(value);
      items.push({ id: value.resource.connectionRef, kind: 'mcp', name: value.resource.displayName, displayName: text(value.resource.displayName),
        description: text(value.resource.description, 4096), source: 'mcp', stock: 'installed', access: summary.access, ownership: value.resource.ownership,
        ownershipLabel: value.ownershipLabel, mcp: { connectionRef: value.resource.connectionRef, transport: 'unknown', template: false }, connections: [summary] });
    }
  } catch { partial = true; }
  return { items, coverage: { source: 'mcp', status: partial ? items.length ? 'partial' : 'unavailable' : 'complete',
    ...(partial ? { error: { code: 'MCP_CATALOG_PARTIAL', message: 'Some MCP connection metadata could not be checked.', retryable: true } } : {}) } };
}
