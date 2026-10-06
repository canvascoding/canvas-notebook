import 'server-only';

import { randomUUID } from 'node:crypto';
import type { AuthorizedIntegrationConnection, IntegrationConnectionActor, IntegrationConnectionOperation, IntegrationConnectionRecord, IntegrationConnectionRevisions, SharedIntegrationConnectionCreation } from '@/app/lib/integration-tools/connections/contracts';
import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { assertSharedIntegrationOwnershipManagement } from '@/app/lib/integration-tools/connections/ownership';
import { parseAndValidateMcpConfig, readMcpConfig, writeMcpConfigRaw, type McpServerConfig } from './config';
import { assertMcpConnectionAccess } from './access';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { hasMcpCredentialUrl, mcpCredentialArgIndices } from './credential-fields';
import { readMcpAvailableEnvSnapshot } from './env-runtime';
import { readMcpOAuthLifecycle } from './oauth-lifecycle';
import { listMcpServerDefinitions } from './server-definitions';
import { sharedMcpScope, withSharedMcpAuthority } from './shared-access';
import { sharedMcpSecretSlot, sharedMcpSecretSlots, writeSharedMcpSecretSlot } from './shared-secrets';
import type { McpScope } from './scope';
import { stageSharedMcpBindingPublication } from './shared-publication';

export { sharedMcpScope } from './shared-access';

export type SharedMcpConnectionInput = Omit<SharedIntegrationConnectionCreation, 'backend' | 'connectionRef'> & {
  definitionId?: string;
  config?: McpServerConfig;
  secrets?: Array<{ name: string; value: string }>;
};
export type SharedMcpBackend = {
  authorization: AuthorizedIntegrationConnection;
  scope: McpScope;
  serverName: string;
  connection: McpServerConfig & { connectionId: string };
  environmentRevision: string;
  authGeneration: number;
  authorizationState: string | null;
};

function revisions(authorization: AuthorizedIntegrationConnection): IntegrationConnectionRevisions {
  const resource = authorization.resource;
  return { metadataRevision: resource.metadataRevision, grantsRevision: resource.grantsRevision, bindingRevision: resource.bindingRevision };
}

/** Metadata-only: never starts a provider, reads tools or makes a network call. */
export async function resolveSharedMcpBackend(actor: IntegrationConnectionActor, connectionRef: string,
  operation: IntegrationConnectionOperation = 'inspect', toolName?: string): Promise<SharedMcpBackend> {
  const { authorizeIntegrationConnection } = await import('@/app/lib/integration-tools/connections/store');
  const authorization = await authorizeIntegrationConnection(actor, connectionRef, operation, toolName);
  const scope = sharedMcpScope(authorization, toolName);
  const { serverName, connection } = await assertMcpConnectionAccess(authorization.backend.source === 'mcp' ? authorization.backend.connectionId : '', scope, { allowDisabled: true });
  if (!connection.connectionId) throw new IntegrationConnectionError('CONNECTION_BACKEND_UNAVAILABLE', 'The shared MCP configuration is unavailable.', 409);
  const [environment, lifecycle] = await Promise.all([
    readMcpAvailableEnvSnapshot(scope), readMcpOAuthLifecycle(connection.connectionId, scope),
  ]);
  return { authorization, scope, serverName, connection: connection as McpServerConfig & { connectionId: string },
    environmentRevision: environment.revision, authGeneration: lifecycle.generation, authorizationState: lifecycle.lastCompletedState ?? null };
}

export async function readSharedMcpConnectionConfig(authorization: AuthorizedIntegrationConnection): Promise<McpServerConfig & { connectionId: string }> {
  const scope = sharedMcpScope(authorization);
  const { connection } = await assertMcpConnectionAccess(scope.shared!.connectionId, scope, { allowDisabled: true });
  return connection as McpServerConfig & { connectionId: string };
}

function prepareConfiguration(scope: McpScope, input: McpServerConfig, secretNames: readonly string[]): McpServerConfig {
  const config = structuredClone(input);
  const allowed = new Set(['url', 'auth', 'oauth', 'transport', 'timeoutMs', 'directTools', 'enabled', 'headers', 'headersFromEnv', 'bearerTokenEnv', 'command', 'args', 'env', 'envPassthrough', 'cwd']);
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', `Unsupported shared MCP configuration field: ${key}.`);
  const stdio = typeof config.command === 'string' && config.command.trim().length > 0;
  if (stdio ? Boolean(config.url) || Boolean(config.oauth) || config.auth === 'oauth' || config.transport && config.transport !== 'stdio'
    : typeof config.url !== 'string' || !config.url.trim() || config.transport && config.transport !== 'http') {
    throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Choose one shared HTTP endpoint or one explicitly authorized STDIO command.');
  }
  if (!stdio) {
    const endpoint = new URL(config.url!);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || hasMcpCredentialUrl(config.url!) || /\$\{/u.test(config.url!)) {
      throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'The shared MCP endpoint must be a public HTTP URL without embedded credentials.');
    }
  } else if (mcpCredentialArgIndices(config.args ?? []).size) {
    throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'STDIO credential arguments must use generated resource slots.');
  }
  const slots = secretNames.map(name => sharedMcpSecretSlot(scope, name));
  if (new Set(secretNames).size !== secretNames.length) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Duplicate shared MCP secret slot.');
  const byAlias = new Map(slots.map(slot => [`MCP_SLOT_${slot.name}`, slot.envKey]));
  const envKey = (alias: string) => {
    const key = byAlias.get(alias);
    if (!key) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Shared MCP credentials must use slots generated for this resource.');
    return key;
  };
  const replaceSlots = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, alias: string) => `\${${envKey(alias)}}`);
  if (config.args) config.args = config.args.map(replaceSlots);
  if (config.env) config.env = Object.fromEntries(Object.entries(config.env).map(([key, value]) => {
    if (!/\$\{/u.test(value)) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Shared MCP environment values must use generated resource slots.');
    return [key, replaceSlots(value)];
  }));
  if (config.envPassthrough) {
    const projected = { ...config.env };
    for (const name of config.envPassthrough) projected[name] = `\${${envKey(`MCP_SLOT_${name}`)}}`;
    config.env = projected; delete config.envPassthrough;
  }
  if (config.headers) config.headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => {
    if (!/\$\{/u.test(value) && !['accept', 'content-type'].includes(key.toLowerCase())) {
      throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Shared MCP header values must use generated resource slots.');
    }
    return [key, replaceSlots(value)];
  }));
  if (config.headersFromEnv) config.headersFromEnv = Object.fromEntries(Object.entries(config.headersFromEnv).map(([key, alias]) => [key, envKey(alias)]));
  if (config.bearerTokenEnv) config.bearerTokenEnv = envKey(config.bearerTokenEnv);
  if (config.oauth && (typeof config.oauth !== 'object' || Array.isArray(config.oauth))) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Invalid shared OAuth configuration.');
  if (config.oauth) {
    const oauth = config.oauth as Record<string, unknown>;
    const allowedOAuth = new Set(['issuer', 'resourceMetadataUrl', 'authorizationUrl', 'tokenUrl', 'registrationUrl', 'revocationUrl', 'clientId', 'scopes']);
    if (Object.keys(oauth).some(key => !allowedOAuth.has(key))) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Shared OAuth configuration contains unsupported fields. Client secrets and redirect routes are managed by Canvas.');
    for (const [key, value] of Object.entries(oauth)) if (key.endsWith('Url') || key === 'issuer') {
      if (typeof value !== 'string' || hasMcpCredentialUrl(value) || /\$\{/u.test(value)) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Shared OAuth endpoints cannot contain embedded credentials.');
      const endpoint = new URL(value);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Invalid shared OAuth endpoint.');
    }
    if (oauth.clientId !== undefined && (typeof oauth.clientId !== 'string' || oauth.clientId.length > 2048)
      || oauth.scopes !== undefined && (!Array.isArray(oauth.scopes) || oauth.scopes.length > 100 || oauth.scopes.some(scope => typeof scope !== 'string' || scope.length > 256))) {
      throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Invalid shared OAuth client or scopes.');
    }
  }
  const prepared = { ...config, schemaVersion: 1 as const, connectionId: scope.shared!.connectionId,
    organizationId: scope.shared!.ownership.organizationId, ...(slots.length ? { sharedSecretSlots: slots } : {}) };
  return parseAndValidateMcpConfig(JSON.stringify({ mcpServers: { connection: prepared } })).mcpServers.connection;
}

/** A new shared account is always provisioned independently of any personal account. */
export async function createSharedMcpConnection(actorInput: IntegrationConnectionActor, input: SharedMcpConnectionInput): Promise<IntegrationConnectionRecord> {
  const actor = structuredClone(actorInput);
  const creation = structuredClone(input);
  await assertSharedIntegrationOwnershipManagement(actor, creation.ownership);
  if (Boolean(creation.definitionId) === Boolean(creation.config)) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Choose an approved server or one manual shared MCP configuration.');
  let config = creation.config;
  if (creation.definitionId) {
    const definition = (await listMcpServerDefinitions(creation.ownership.organizationId)).find(item => item.id === creation.definitionId && item.enabled);
    if (!definition) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'The approved MCP server is unavailable.', 404);
    config = structuredClone(definition.config);
  }
  if (config?.command) {
    const current = await readOrganizationPermissionForUser(actor.userId);
    if (process.env.MCP_ALLOW_STDIO !== 'true' || current.organizationId !== creation.ownership.organizationId
      || current.permission?.status !== 'active' || !['owner', 'admin'].includes(current.permission.role)) {
      throw new IntegrationConnectionError('CONNECTION_MANAGEMENT_REQUIRED', 'Shared STDIO requires the instance STDIO policy and explicit organization administration.', 403);
    }
  }
  const { createSharedIntegrationConnection, authorizeIntegrationConnection, publishIntegrationConnectionBinding } = await import('@/app/lib/integration-tools/connections/store');
  const backend = { source: 'mcp' as const, connectionId: randomUUID() };
  const { definitionId: _definition, config: _configuration, secrets = [], ...metadata } = creation;
  const connectionRef = `canvas-connection:${randomUUID()}`;
  const preparationScope: McpScope = { shared: { connectionRef, connectionId: backend.connectionId, ownership: creation.ownership,
    actor, operation: 'manage', revisions: { metadataRevision: 1, grantsRevision: 1, bindingRevision: 1 }, authorizationRevision: 'preparation' } };
  const prepared = prepareConfiguration(preparationScope, config!, secrets.map(slot => slot.name));
  for (const slot of secrets) if (typeof slot.value !== 'string' || Buffer.byteLength(slot.value, 'utf8') > 64 * 1024 || slot.value.includes('\0')) {
    throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Invalid shared MCP secret value.');
  }
  if (creation.definitionId) prepared.serverDefinitionId = creation.definitionId;
  const record = await createSharedIntegrationConnection(actor, { ...metadata, backend, connectionRef });
  const authorization = await authorizeIntegrationConnection(actor, record.resource.connectionRef, 'manage');
  const scope = sharedMcpScope(authorization);
  return withSharedMcpAuthority(scope, 'manage', async () => {
    await stageSharedMcpBindingPublication(authorization);
    for (const slot of sharedMcpSecretSlots(prepared, scope)) await writeSharedMcpSecretSlot(scope, slot, secrets.find(value => value.name === slot.name)!.value);
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { connection: prepared } }), scope);
    return publishIntegrationConnectionBinding(actor, record.resource.connectionRef, revisions(authorization), backend);
  });
}

/** Secret-only reconnect changes remain resource bound and fence old schemas. */
export async function updateSharedMcpSecretSlots(actor: IntegrationConnectionActor, connectionRef: string,
  expected: IntegrationConnectionRevisions, patches: Array<{ name: string; value: string | null }>): Promise<IntegrationConnectionRecord> {
  const captured = structuredClone(patches);
  const { withAuthorizedIntegrationConnection, publishIntegrationConnectionBinding } = await import('@/app/lib/integration-tools/connections/store');
  return withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', structuredClone(expected), async authorization => {
    const scope = sharedMcpScope(authorization);
    const config = await readMcpConfig(scope);
    const connection = config.mcpServers.connection;
    if (!connection) throw new IntegrationConnectionError('CONNECTION_BACKEND_UNAVAILABLE', 'Shared MCP configuration is unavailable.', 409);
    const slots = sharedMcpSecretSlots(connection, scope);
    if (captured.length > 50 || new Set(captured.map(patch => patch.name)).size !== captured.length) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Invalid shared secret changes.');
    const updates = captured.map(patch => {
      const slot = slots.find(value => value.name === patch.name);
      if (!slot || patch.value !== null && (typeof patch.value !== 'string' || Buffer.byteLength(patch.value, 'utf8') > 64 * 1024 || patch.value.includes('\0'))) {
        throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Invalid resource-bound secret change.');
      }
      return { slot, value: patch.value };
    });
    await stageSharedMcpBindingPublication(authorization);
    for (const update of updates) await writeSharedMcpSecretSlot(scope, update.slot, update.value);
    const { closeMcpServer } = await import('./manager');
    await closeMcpServer(scope.shared!.connectionId, scope);
    return publishIntegrationConnectionBinding(actor, connectionRef, expected, authorization.backend);
  });
}

/** Explicit reconnect also repairs a setup whose filesystem publication failed. */
export async function updateSharedMcpConfiguration(actor: IntegrationConnectionActor, connectionRef: string,
  expected: IntegrationConnectionRevisions, input: Pick<SharedMcpConnectionInput, 'definitionId' | 'config' | 'secrets'>): Promise<IntegrationConnectionRecord> {
  const captured = structuredClone(input);
  const { withAuthorizedIntegrationConnection, publishIntegrationConnectionBinding } = await import('@/app/lib/integration-tools/connections/store');
  return withAuthorizedIntegrationConnection(actor, connectionRef, 'manage', structuredClone(expected), async authorization => {
    if (authorization.backend.source !== 'mcp' || Boolean(captured.definitionId) === Boolean(captured.config)) {
      throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Choose one approved server or one shared MCP configuration.');
    }
    let configuration = captured.config;
    if (captured.definitionId) {
      const definition = (await listMcpServerDefinitions(authorization.resource.ownership.organizationId)).find(item => item.id === captured.definitionId && item.enabled);
      if (!definition) throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'The approved MCP server is unavailable.', 404);
      configuration = definition.config;
    }
    if (configuration?.command) {
      const current = await readOrganizationPermissionForUser(actor.userId);
      if (process.env.MCP_ALLOW_STDIO !== 'true' || current.organizationId !== authorization.resource.ownership.organizationId
        || current.permission?.status !== 'active' || !['owner', 'admin'].includes(current.permission.role)) {
        throw new IntegrationConnectionError('CONNECTION_MANAGEMENT_REQUIRED', 'Shared STDIO requires the instance STDIO policy and explicit organization administration.', 403);
      }
    }
    const scope = sharedMcpScope(authorization), secrets = captured.secrets ?? [];
    const prepared = prepareConfiguration(scope, configuration!, secrets.map(secret => secret.name));
    for (const secret of secrets) if (typeof secret.value !== 'string' || Buffer.byteLength(secret.value, 'utf8') > 64 * 1024 || secret.value.includes('\0')) {
      throw new IntegrationConnectionError('CONNECTION_CONFIG_INVALID', 'Invalid shared MCP secret value.');
    }
    if (captured.definitionId) prepared.serverDefinitionId = captured.definitionId;
    const previous = await readMcpConfig(scope);
    const oldSlots = Object.values(previous.mcpServers).flatMap(config => sharedMcpSecretSlots(config, scope));
    await stageSharedMcpBindingPublication(authorization);
    const nextSlots = sharedMcpSecretSlots(prepared, scope);
    for (const slot of nextSlots) await writeSharedMcpSecretSlot(scope, slot, secrets.find(secret => secret.name === slot.name)!.value);
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { connection: prepared } }), scope);
    for (const slot of oldSlots.filter(old => !nextSlots.some(next => next.name === old.name))) await writeSharedMcpSecretSlot(scope, slot, null);
    const { closeMcpServer } = await import('./manager');
    await closeMcpServer(scope.shared!.connectionId, scope);
    return publishIntegrationConnectionBinding(actor, connectionRef, expected, authorization.backend);
  });
}
