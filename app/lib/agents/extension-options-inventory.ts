import 'server-only';

import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { getComposioMode, getLocalComposioApiKey } from '@/app/lib/composio/composio-client';
import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { resolveBoundComposioContext } from '@/app/lib/composio/composio-context';
import { loadLocalComposioToolkitCatalogue, loadManagedComposioToolkitCatalogue,
  isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { authorizeIntegrationConnection, type IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';
import { requireMcpUserAccess, assertPersonalMcpConnectionMetadataAccess, McpAccessError } from '@/app/lib/mcp/access';
import { resolveMcpConfigPath, type McpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { readExistingConfig } from '@/app/lib/mcp/read-only-config';
import { validateMcpConnectionId } from '@/app/lib/mcp/connection-identity';
import { listMcpServerDefinitions } from '@/app/lib/mcp/server-definitions';
import { resolveOrganizationDataRoot } from '@/app/lib/runtime-data-paths';
import { mcpIconSourceBinding } from '@/app/lib/mcp/icon-source';
import { mcpPluginExtensionIcon, publicPluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { PluginExtensionConnection, PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';
import type { PluginExtensionSourceResult } from '@/app/lib/plugins/plugin-extension-integrations';
import { AgentWorkflowError } from './workflow-contracts';
import { listExtensionSharedOptions as listAgentExtensionSharedOptions, revalidateExtensionOptionsSourceContext as revalidateAgentExtensionOptionsContext,
  authorizeExtensionSharedOption as authorizeAgentExtensionSharedOption,
  type ExtensionOptionsSourceContext as AgentExtensionOptionsContext } from './extension-options-source-context';

const text = (value: unknown, limit = 256) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit) : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const slug = (value: unknown): string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)
  && isComposioIntegrationApplicationVisible(value) ? value : '';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

function configurationTarget(context: AgentExtensionOptionsContext): void {
  if (context.target.kind === 'user_choice') throw new AgentWorkflowError('AGENT_WORKFLOW_CHOICE_DENIED', 'Use the exact permitted slot connection chooser.', 403);
}
function sharedSummary(value: IntegrationConnectionBindingAuthorization): PluginExtensionConnection {
  return { connectionRef: value.resource.connectionRef, displayName: text(value.resource.displayName), ownership: value.resource.ownership,
    access: { canRead: true, canUse: value.canUse, canManage: value.canManage }, enabled: value.resource.status === 'active',
    authorization: value.backend.source === 'composio' && value.backend.accountBinding === 'no_auth' ? 'not_required' : 'unknown', health: 'unknown' };
}

/** No profile creation, account enumeration, status, tools or business probes. Existing central ENV migration semantics remain in its reader. */
export async function readAgentComposioOptionsCatalogue(context: AgentExtensionOptionsContext, signal: AbortSignal,
  options: { search?: string; continuation?: string; selectedSlug?: string; profileId?: string } = {}): Promise<PluginExtensionSourceResult> {
  configurationTarget(context);
  await revalidateAgentExtensionOptionsContext(context);
  const scope = { secretScope: 'user' as const, userId: context.actor.userId };
  const mode = await getComposioMode(scope);
  const profiles = await listExistingComposioProfiles(context.actor.userId);
  if (profiles.length > 32) throw new AgentWorkflowError('AGENT_WORKFLOW_OPTIONS_UNAVAILABLE', 'Too many profiles are available for this catalogue.', 503);
  const selectedProfile = options.profileId === undefined ? undefined : profiles.find(profile => profile.id === options.profileId
    && profile.ownerUserId === context.actor.userId && profile.status === 'active');
  if (options.profileId !== undefined && !selectedProfile) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose one active profile owned by the current actor.', 403);
  }
  const profile = selectedProfile ?? profiles[0];
  const existing = mode === 'managed' && profile
    ? await resolveBoundComposioContext({ userId: context.actor.userId, workspaceId: context.actor.workspaceId, profileId: profile.id }) : undefined;
  const binding = digest([context.contextKey, mode, options.search ?? '', options.profileId ?? null, mode === 'local' ? digest(await getLocalComposioApiKey(scope))
    : existing ? [existing.profileId, existing.cacheRevision] : null]);
  let cursor: string | undefined;
  if (options.continuation) {
    try {
      const previous = record(JSON.parse(Buffer.from(options.continuation, 'base64url').toString('utf8')));
      if (Object.keys(previous).some(key => !['v', 'binding', 'cursor'].includes(key)) || previous.v !== 1 || previous.binding !== binding
        || typeof previous.cursor !== 'string' || !previous.cursor || previous.cursor.length > 2048) throw new Error('Changed catalogue');
      cursor = previous.cursor;
    } catch { throw new AgentWorkflowError('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED', 'The catalogue context changed. Restart the search.', 409); }
  }
  let partial = false, continuation: string | undefined;
  const apps = new Map<string, Extract<PluginExtensionItem, { kind: 'integration' }>>();
  const app = (toolkit: string, metadata: Record<string, unknown> = {}) => {
    const previous = apps.get(toolkit);
    if (previous) return previous;
    const meta = record(metadata.meta), icon = publicPluginExtensionIcon(meta.logo ?? metadata.logo, `composio:${toolkit}`);
    const item: Extract<PluginExtensionItem, { kind: 'integration' }> = { id: `composio:${toolkit}`, kind: 'integration', name: toolkit,
      displayName: text(metadata.name) || toolkit, description: text(meta.description ?? metadata.description, 4096), source: 'composio', stock: 'available',
      access: { canRead: true, canUse: false, canManage: false }, toolkit: { slug: toolkit,
        noAuth: (metadata.noAuth ?? metadata.isNoAuth ?? metadata.no_auth) === true }, connections: [], ...(icon ? { icon } : {}) };
    apps.set(toolkit, item);
    return item;
  };
  const configured = mode === 'local' || mode === 'managed' && Boolean(existing);
  if (configured) {
    const load = (query: { search?: string; cursor?: string; maxPages?: number }) => mode === 'local'
      ? loadLocalComposioToolkitCatalogue(scope, signal, query) : loadManagedComposioToolkitCatalogue(existing!, signal, query);
    const catalogue = await load({ search: options.search, cursor, maxPages: 1 });
    partial = !catalogue.complete;
    continuation = catalogue.nextCursor ? Buffer.from(JSON.stringify({ v: 1, binding, cursor: catalogue.nextCursor })).toString('base64url') : undefined;
    if (options.selectedSlug && slug(options.selectedSlug) && !catalogue.items.some(item => item.slug === options.selectedSlug)) {
      const selected = await load({ search: options.selectedSlug });
      catalogue.items.push(...selected.items.filter(item => item.slug === options.selectedSlug));
      partial ||= !selected.complete;
    }
    for (const metadata of catalogue.items) {
      const toolkit = slug(metadata.slug);
      if (toolkit) app(toolkit, metadata);
      else {
        // Hidden native providers are deliberately omitted; malformed identities are incomplete metadata.
        if (typeof metadata.slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(metadata.slug)) partial = true;
      }
    }
  }
  const shared = await listAgentExtensionSharedOptions(context, 'composio');
  for (const value of shared) {
    const toolkit = slug(value.resource.application);
    if (toolkit) app(toolkit).connections.push(sharedSummary(value));
  }
  if (existing) {
    const current = await resolveBoundComposioContext({ userId: context.actor.userId, workspaceId: context.actor.workspaceId, profileId: existing.profileId });
    if (current.cacheRevision !== existing.cacheRevision || current.composioUserId !== existing.composioUserId) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED', 'The catalogue profile changed. Restart the search.', 409);
    }
  }
  if (selectedProfile) {
    const fresh = (await listExistingComposioProfiles(context.actor.userId)).find(value => value.id === selectedProfile.id);
    if (!fresh || digest(fresh) !== digest(selectedProfile)) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED', 'The selected catalogue profile changed. Restart its selection.', 409);
    }
  }
  if (await getComposioMode(scope) !== mode || mode === 'local' && digest([context.contextKey, mode, options.search ?? '', options.profileId ?? null,
    digest(await getLocalComposioApiKey(scope))]) !== binding) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_OPTIONS_CURSOR_CHANGED', 'The catalogue source changed. Restart the search.', 409);
  }
  await revalidateAgentExtensionOptionsContext(context);
  for (const item of apps.values()) {
    item.stock = item.connections.length ? 'installed' : 'available';
    item.access.canUse = item.connections.some(connection => connection.access.canUse);
    item.access.canManage = item.connections.some(connection => connection.access.canManage);
  }
  return { items: [...apps.values()], ...(continuation ? { continuation } : {}), coverage: { source: 'composio',
    status: partial ? apps.size ? 'partial' : 'unavailable' : configured ? 'complete' : apps.size ? 'partial' : 'not_configured',
    ...(!configured ? { error: { code: mode === 'managed' ? 'COMPOSIO_PROFILE_REQUIRED' : 'COMPOSIO_NOT_CONFIGURED',
      message: mode === 'managed' ? 'Choose or create a Composio profile to browse this managed catalogue.'
        : 'The Composio catalogue is not configured; only permitted known connections can be shown.', retryable: false } }
      : partial ? { error: { code: 'COMPOSIO_CATALOG_PARTIAL', message: 'The Composio catalogue could not be fully loaded.', retryable: true } } : {}) } };
}

/** Server-only exact metadata for package/definition matching. Never serialize the returned configuration. */
export async function readAgentOwnMcpOptionMetadata(context: AgentExtensionOptionsContext, connectionRef: string,
  options: { database?: SqlConnection } = {}):
  Promise<{ serverName: string; connection: McpServerConfig } | null> {
  if (!context.allowPersonal || !/^mcp-personal:[a-f0-9-]{36}$/u.test(connectionRef)) return null;
  await revalidateAgentExtensionOptionsContext(context, options);
  const actor = await requireMcpUserAccess({ userId: context.actor.userId }, options);
  const config = await readExistingConfig(resolveMcpConfigPath({ userId: context.actor.userId }));
  const exact = Object.entries(config.mcpServers).filter(([, value]) => `mcp-personal:${value.connectionId}` === connectionRef);
  if (exact.length !== 1 || !actor) return null;
  const [serverName, connection] = exact[0];
  validateMcpConnectionId(connection.connectionId);
  await assertPersonalMcpConnectionMetadataAccess(connection, { userId: context.actor.userId }, actor);
  await revalidateAgentExtensionOptionsContext(context, options);
  const current = await readExistingConfig(resolveMcpConfigPath({ userId: context.actor.userId }));
  const currentExact = Object.entries(current.mcpServers).filter(([, value]) => `mcp-personal:${value.connectionId}` === connectionRef);
  if (currentExact.length !== 1 || digest(currentExact[0]) !== digest(exact[0])) return null;
  return { serverName, connection };
}

const noAuth = (connection: McpServerConfig): boolean => !connection.oauth && (!connection.auth || connection.auth === 'none')
  && !connection.bearerTokenEnv && !Object.keys(connection.headers ?? {}).length && !Object.keys(connection.headersFromEnv ?? {}).length
  && !Object.keys(connection.env ?? {}).length && !(connection.envPassthrough as unknown[] | undefined)?.length;

/** Private current source metadata only. Mapping Manage and execution authority remain separate caller checks. */
export async function readAgentSharedMcpOptionMetadata(context: AgentExtensionOptionsContext, connectionRef: string):
  Promise<{ serverName: string; connection: McpServerConfig; authorization: IntegrationConnectionBindingAuthorization } | null> {
  await revalidateAgentExtensionOptionsContext(context);
  const authorization = await authorizeAgentExtensionSharedOption(context, connectionRef);
  if (authorization.backend.source !== 'mcp') return null;
  const connectionId = authorization.backend.connectionId;
  validateMcpConnectionId(connectionId);
  const file = path.join(resolveOrganizationDataRoot(authorization.resource.ownership.organizationId), 'mcp', 'shared', connectionId, 'config.json');
  const config = await readExistingConfig(file);
  const entries = Object.entries(config.mcpServers);
  if (entries.length !== 1) return null;
  const [serverName, connection] = entries[0];
  if (connection.connectionId !== connectionId || connection.ownerUserId
    || connection.organizationId !== authorization.resource.ownership.organizationId || connection.enabled === false) return null;
  const currentConfig = await readExistingConfig(file);
  if (digest(currentConfig) !== digest(config)) return null;
  const current = await authorizeAgentExtensionSharedOption(context, connectionRef);
  if (digest(current) !== digest(authorization)) return null;
  await revalidateAgentExtensionOptionsContext(context);
  return { serverName, connection, authorization: current };
}

/** Current metadata only: no MCP initialize, cached health, OAuth status, account read or credential/config writes. */
export async function readAgentMcpOptionsInventory(context: AgentExtensionOptionsContext): Promise<PluginExtensionSourceResult> {
  return readMcpOptionsInventory(context, true);
}

/** Own metadata for an actual per-user slot. This path never enumerates global shared candidates. */
export async function readAgentOwnMcpOptionsInventory(context: AgentExtensionOptionsContext,
  options: { database?: SqlConnection } = {}): Promise<PluginExtensionSourceResult> {
  return readMcpOptionsInventory(context, false, options);
}

async function readMcpOptionsInventory(context: AgentExtensionOptionsContext, includeShared: boolean,
  options: { database?: SqlConnection } = {}): Promise<PluginExtensionSourceResult> {
  await revalidateAgentExtensionOptionsContext(context, options);
  if (includeShared) configurationTarget(context);
  const items: PluginExtensionItem[] = [];
  const personalStamps = new Map<string, string>();
  let partial = false;
  try {
    const actor = await requireMcpUserAccess({ userId: context.actor.userId }, options);
    if (actor) {
      if (context.allowPersonal) {
        let config: McpConfig = { mcpServers: {} };
        try { config = await readExistingConfig(resolveMcpConfigPath({ userId: context.actor.userId })); }
        catch { partial = true; }
        const counts = new Map<string | undefined, number>();
        for (const value of Object.values(config.mcpServers)) counts.set(value.connectionId, (counts.get(value.connectionId) ?? 0) + 1);
        for (const [serverName, connection] of Object.entries(config.mcpServers)) {
          try {
            validateMcpConnectionId(connection.connectionId);
            if (counts.get(connection.connectionId) !== 1) throw new Error('Duplicate MCP identity.');
            await assertPersonalMcpConnectionMetadataAccess(connection, { userId: context.actor.userId }, actor, { allowDisabled: true });
            const id = `mcp-personal:${connection.connectionId}`;
            personalStamps.set(id, digest(connection));
            const ownership = { type: 'user' as const, ownerUserId: context.actor.userId, organizationId: connection.organizationId ?? null };
            const access = { canRead: true, canUse: connection.enabled !== false, canManage: true };
            items.push({ id, kind: 'mcp', name: serverName, displayName: text(connection.displayName) || text(serverName), description: '',
              source: 'mcp', stock: 'installed', ownership, access,
              ...(connection.url || connection.iconUrl ? { icon: mcpPluginExtensionIcon(id, mcpIconSourceBinding(id, connection), context.actor.workspaceId) } : {}),
              mcp: { serverId: connection.connectionId, transport: connection.command ? 'stdio' : connection.url ? 'http' : 'unknown', template: false },
              connections: [{ connectionRef: id, displayName: text(connection.displayName) || text(serverName), ownership, access,
                authorization: noAuth(connection) ? 'not_required' : 'unknown', health: 'unknown', enabled: connection.enabled !== false }] });
          } catch (error) { if (!(error instanceof McpAccessError && [403, 404].includes(error.status))) partial = true; }
        }
      }
      if (actor.organizationId) for (const definition of await listMcpServerDefinitions(actor.organizationId)) {
        if (!definition.enabled) continue;
        const id = `mcp-definition:${definition.id}`;
        items.push({ id, kind: 'mcp', name: definition.name, displayName: text(definition.name), description: '', source: 'mcp', stock: 'available',
          access: { canRead: true, canUse: false, canManage: actor.canManageDefinitions }, ownership: { type: 'organization', organizationId: actor.organizationId },
          icon: mcpPluginExtensionIcon(id, mcpIconSourceBinding(id, { ...definition.config,
            organizationId: definition.organizationId, serverDefinitionId: definition.id }, definition.revision), context.actor.workspaceId),
          mcp: { definitionId: definition.id, transport: 'http', template: true }, connections: [] });
      }
    }
  } catch (error) { if (!(error instanceof McpAccessError && [403, 404].includes(error.status))) partial = true; }
  const shared = includeShared ? await listAgentExtensionSharedOptions(context, 'mcp') : [];
  for (const value of shared) {
    const summary = sharedSummary(value);
    let connection: McpServerConfig | undefined, icon;
    try {
      if (value.backend.source !== 'mcp') throw new Error('Changed source.');
      validateMcpConnectionId(value.backend.connectionId);
      const file = path.join(resolveOrganizationDataRoot(value.resource.ownership.organizationId), 'mcp', 'shared', value.backend.connectionId, 'config.json');
      const config = await readExistingConfig(file);
      const values = Object.values(config.mcpServers);
      if (values.length !== 1 || values[0].connectionId !== value.backend.connectionId || values[0].ownerUserId
        || values[0].organizationId !== value.resource.ownership.organizationId) throw new Error('Changed shared config.');
      connection = values[0];
      // The existing image endpoint admits human Read. A target-only grant
      // never manufactures that different authority merely to display a logo.
      const readable = await authorizeIntegrationConnection({ userId: context.actor.userId, organizationId: context.organizationId,
        workspaceId: context.actor.workspaceId }, value.resource.connectionRef, 'inspect');
      if (readable.access.canRead && (connection.url || connection.iconUrl)) icon = mcpPluginExtensionIcon(value.resource.connectionRef,
        mcpIconSourceBinding(value.resource.connectionRef, connection,
          `${value.resource.metadataRevision}:${value.resource.grantsRevision}:${value.resource.bindingRevision}`), context.actor.workspaceId);
    } catch { /* Optional image/config detail cannot hide an actually authorized shared selection. */ }
    summary.authorization = connection && noAuth(connection) ? 'not_required' : 'unknown';
    summary.enabled = connection?.enabled !== false;
    items.push({ id: value.resource.connectionRef, kind: 'mcp', name: value.resource.displayName, displayName: text(value.resource.displayName),
      description: text(value.resource.description, 4096), source: 'mcp', stock: 'installed', ownership: value.resource.ownership,
      access: summary.access, ...(icon ? { icon } : {}), mcp: { connectionRef: value.resource.connectionRef,
        transport: connection?.command ? 'stdio' : connection?.url ? 'http' : 'unknown', template: false }, connections: [summary] });
  }
  const freshShared = new Map((includeShared ? await listAgentExtensionSharedOptions(context, 'mcp') : []).map(value => [value.resource.connectionRef, value]));
  if (personalStamps.size) {
    const currentActor = await requireMcpUserAccess({ userId: context.actor.userId }, options);
    const current = await readExistingConfig(resolveMcpConfigPath({ userId: context.actor.userId }));
    for (const [id, stamp] of personalStamps) {
      const matches = Object.values(current.mcpServers).filter(value => `mcp-personal:${value.connectionId}` === id);
      try {
        if (matches.length !== 1 || digest(matches[0]) !== stamp) throw new Error('Changed personal MCP source.');
        await assertPersonalMcpConnectionMetadataAccess(matches[0], { userId: context.actor.userId }, currentActor, { allowDisabled: true });
      } catch { personalStamps.delete(id); partial = true; }
    }
  }
  await revalidateAgentExtensionOptionsContext(context, options);
  return { items: items.filter(item => item.id.startsWith('mcp-personal:') ? personalStamps.has(item.id)
      : !item.id.startsWith('canvas-connection:') || freshShared.has(item.id)
        && digest(freshShared.get(item.id)) === digest(shared.find(value => value.resource.connectionRef === item.id))),
    coverage: { source: 'mcp', status: partial ? items.length ? 'partial' : 'unavailable' : 'complete',
      ...(partial ? { error: { code: 'MCP_CATALOG_PARTIAL', message: 'Some exact MCP metadata requires setup or could not be read.', retryable: true } } : {}) } };
}
