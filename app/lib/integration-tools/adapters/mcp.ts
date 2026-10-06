import 'server-only';

import { createHash } from 'node:crypto';

import { assertMcpConnectionAccess, McpAccessError, requireMcpUserAccess } from '@/app/lib/mcp/access';
import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { expandMcpEnvValue } from '@/app/lib/mcp/env-references';
import { readMcpAvailableEnv } from '@/app/lib/mcp/env-runtime';
import { readMcpConnectionStatus } from '@/app/lib/mcp/connection-status';
import type { McpConnectionHealth } from '@/app/lib/mcp/connection-health-types';
import { getMcpOAuthStatus } from '@/app/lib/mcp/oauth';
import { listMcpServerDefinitions } from '@/app/lib/mcp/server-definitions';
import type { McpScope } from '@/app/lib/mcp/scope';
import {
  type IntegrationExecutionContext,
  type IntegrationProviderDescriptor,
  type IntegrationProviderError,
  type IntegrationProviderScope,
  type IntegrationSourceSnapshot,
} from '../contracts';
import { createIntegrationProviderRef } from '../references';

// The existing MCP health monitor checks active connections every five minutes.
// Discovery consumes those observations; it never performs a new network check.
const MCP_HEALTH_FRESHNESS_MS = 5 * 60_000;
const CREDENTIAL_NAME = /(authorization|token|secret|password|api[_-]?key|credential)/iu;

function requiresOAuth(connection: McpServerConfig): boolean {
  return connection.auth === 'oauth' || Boolean(connection.oauth);
}

function supportedTransport(connection: McpServerConfig): boolean {
  if (typeof connection.command === 'string' && connection.command.trim()) return process.env.MCP_ALLOW_STDIO === 'true';
  return Boolean(typeof connection.url === 'string' && connection.url.trim());
}

function hasConfiguredCredentials(connection: McpServerConfig): boolean {
  if (connection.command?.trim()) {
    return Object.entries(connection.env || {}).some(([key, value]) => CREDENTIAL_NAME.test(key) || CREDENTIAL_NAME.test(value))
      || (connection.envPassthrough || []).some(key => CREDENTIAL_NAME.test(key));
  }
  return Boolean(connection.bearerTokenEnv) || Object.keys(connection.headersFromEnv || {}).length > 0
    || Object.entries(connection.headers || {}).some(([key, value]) => CREDENTIAL_NAME.test(key) || CREDENTIAL_NAME.test(value));
}

/** Check the same scoped ENV expressions used by the existing MCP runtime. */
async function readEnvironmentReadiness(connection: McpServerConfig, scope: McpScope) {
  const stdio = Boolean(connection.command?.trim());
  const expressions = stdio
    ? [...(connection.args || []), ...Object.values(connection.env || {})]
    : [...(connection.url ? [connection.url] : []), ...Object.values(connection.headers || {})];
  const directKeys = stdio
    ? connection.envPassthrough || []
    : [...Object.values(connection.headersFromEnv || {}), ...(connection.bearerTokenEnv ? [connection.bearerTokenEnv] : [])];
  const credentialExpressions = Object.entries(stdio ? connection.env || {} : connection.headers || {})
    .filter(([key, value]) => CREDENTIAL_NAME.test(key) || CREDENTIAL_NAME.test(value)).map(([, value]) => value);
  const credentialKeys = stdio
    ? (connection.envPassthrough || []).filter(key => CREDENTIAL_NAME.test(key))
    : [...Object.values(connection.headersFromEnv || {}),
      ...(connection.bearerTokenEnv ? [connection.bearerTokenEnv] : [])];
  const requiresCredential = hasConfiguredCredentials(connection);
  const hasEnvironmentReferences = directKeys.length > 0 || expressions.some(value => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.test(value));
  if (!hasEnvironmentReferences) return { requiresCredential, ready: true, credentialsPresent: true };
  const available = await readMcpAvailableEnv(scope);
  const missing = new Set<string>();
  for (const value of expressions) expandMcpEnvValue(value, available, missing);
  for (const key of directKeys) if (available[key.trim()] === undefined) missing.add(key.trim());
  const credentialMissing = new Set<string>();
  const credentialsPresent = credentialExpressions.every(value => expandMcpEnvValue(value, available, credentialMissing).trim().length > 0)
    && credentialKeys.every(key => Boolean(available[key.trim()]?.trim())) && credentialMissing.size === 0;
  return { requiresCredential, ready: missing.size === 0 && credentialsPresent, credentialsPresent };
}

function observedHealth(health: McpConnectionHealth | null, now: number): IntegrationProviderDescriptor['health'] {
  const checkedAt = health?.lastCheckedAt ? Date.parse(health.lastCheckedAt) : NaN;
  if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > MCP_HEALTH_FRESHNESS_MS) return 'unknown';
  if (health?.reachability === 'reachable') return 'healthy';
  if (health?.reachability === 'unreachable') return 'unhealthy';
  return 'unknown';
}

function settingsHref(connectionId?: string): string {
  return `/settings?tab=mcp&section=mcpConfig${connectionId ? `&connection=${encodeURIComponent(connectionId)}` : ''}`;
}

function statusError(providerRef: string): IntegrationProviderError {
  // Provider messages, configuration paths and credentials stay out of discovery.
  return { source: 'mcp', code: 'MCP_STATUS_UNAVAILABLE', message: 'MCP connection status is unavailable.', providerRef, retryable: true };
}

/**
 * Lists actual personal MCP connections and approved setup candidates without
 * starting a server, loading its tools, probing its endpoint or fetching icons.
 * The shared gateway validates workspace access before calling this adapter.
 */
export async function listMcpIntegrationProviders(
  context: IntegrationExecutionContext,
): Promise<IntegrationSourceSnapshot> {
  const requestedScope: McpScope = { userId: context.actorUserId, organizationId: context.organizationId || null };
  const actor = await requireMcpUserAccess(requestedScope);
  if (!actor || (context.organizationId && context.organizationId !== actor.organizationId)) {
    throw new McpAccessError('The requested organization is no longer active.');
  }
  const config = await readMcpConfig(requestedScope);
  const providers: IntegrationProviderDescriptor[] = [];
  const providerErrors: IntegrationProviderError[] = [];
  const definitionIdsInUse = new Set<string>();
  const revisions: unknown[] = [actor.organizationId, actor.canManageDefinitions];
  const now = Date.now();

  for (const serverName of Object.keys(config.mcpServers)) {
    let connection: McpServerConfig;
    try {
      // Reuse real ownership, active-membership and current definition approval.
      // Disabled owned resources remain discoverable, but never executable.
      ({ connection } = await assertMcpConnectionAccess(serverName, requestedScope, { allowDisabled: true, actor }));
    } catch (error) {
      if (error instanceof McpAccessError && [403, 404].includes(error.status)) continue;
      providerErrors.push({ source: 'mcp', code: 'MCP_ACCESS_STATUS_UNAVAILABLE', message: 'Some MCP connection access checks are unavailable.', retryable: true });
      continue;
    }
    // readMcpConfig persists stable UUIDs for legacy personal configuration. An
    // incomplete identity cannot be replaced by an unscoped display-name hash.
    const connectionId = connection.connectionId;
    if (!connectionId || connection.ownerUserId !== actor.userId) continue;
    const scope: IntegrationProviderScope = { type: 'user', resourceId: connectionId, ownerUserId: actor.userId };
    const providerRef = createIntegrationProviderRef({ source: 'mcp', scope, connectionId });
    const credentialScope: McpScope = { userId: actor.userId, organizationId: connection.organizationId || null };
    const oauthRequired = requiresOAuth(connection);
    let requiresAuth = oauthRequired || hasConfiguredCredentials(connection);
    let authorized: boolean | 'unknown' = oauthRequired ? 'unknown' : true;
    let health: McpConnectionHealth | null = null;
    let statusAvailable = true;
    let environmentReady: boolean | 'unknown' = 'unknown';

    try {
      health = await readMcpConnectionStatus(serverName, connection as McpServerConfig & { connectionId: string }, credentialScope, now);
      const environment = await readEnvironmentReadiness(connection, credentialScope);
      environmentReady = environment.ready;
      requiresAuth = oauthRequired || environment.requiresCredential;
      authorized = environment.credentialsPresent && (!environment.requiresCredential || health.authStatus !== 'reauth_required');
      if (oauthRequired) {
        const oauth = await getMcpOAuthStatus(serverName, undefined, credentialScope);
        if (!oauth.configured || (oauth.code && oauth.code !== 'reauth_required')) {
          statusAvailable = false;
          authorized = 'unknown';
        } else {
          authorized = authorized && oauth.authorized && health.authStatus !== 'reauth_required';
        }
      }
    } catch {
      statusAvailable = false;
      authorized = 'unknown';
    }
    if (!statusAvailable) providerErrors.push(statusError(providerRef));

    const enabled = connection.enabled !== false;
    const transportSupported = supportedTransport(connection);
    const healthState = observedHealth(health, now);
    const canExecute = enabled && transportSupported && environmentReady === true && authorized === true;
    const state: IntegrationProviderDescriptor['state'] = !enabled ? 'disabled'
      : !transportSupported ? 'degraded'
        : authorized === false ? 'auth_required'
          : environmentReady === false ? 'degraded'
          : !statusAvailable || healthState === 'unknown' ? 'unknown'
            : healthState === 'unhealthy' ? 'degraded' : 'ready';
    const nextActions: IntegrationProviderDescriptor['nextActions'] = canExecute
      ? [{ kind: 'gateway', request: { action: 'list', target: 'tools', providerRef }, label: 'List available tools' }]
      : [{ kind: 'setup', href: environmentReady === false ? '/settings?tab=secrets' : settingsHref(connectionId), label: !enabled ? 'Enable connection' : environmentReady === false ? 'Configure required credentials' : authorized === false ? 'Connect account' : 'Review connection settings' }];
    providers.push({
      providerRef, source: 'mcp', displayName: connection.displayName || serverName, scope,
      description: 'Personal MCP connection.', configured: true, state, requiresAuth, authorized,
      health: healthState, canExecute, checkedAt: health?.lastCheckedAt || null,
      statusSource: health?.lastCheckedAt ? 'cache' : 'configuration',
      pluginRefs: [], skillRefs: [], matchReasons: [], nextActions,
    });
    if (connection.serverDefinitionId) definitionIdsInUse.add(connection.serverDefinitionId);
    revisions.push([connectionId, serverName, hashMcpAuthConfig(connection), connection.enabled, connection.authVersion, health?.authGeneration, authorized, environmentReady, healthState]);
  }

  if (actor.organizationId) {
    const definitions = await listMcpServerDefinitions(actor.organizationId).catch(() => {
      providerErrors.push({ source: 'mcp', code: 'MCP_SETUP_CATALOG_UNAVAILABLE', message: 'Approved MCP setup options are unavailable.', retryable: true });
      return [];
    });
    for (const definition of definitions) {
      revisions.push([definition.id, definition.revision, definition.enabled]);
      if (!definition.enabled || definitionIdsInUse.has(definition.id)) continue;
      const resourceId = `definition:${definition.id}`;
      const scope: IntegrationProviderScope = { type: 'organization', resourceId, organizationId: actor.organizationId };
      const providerRef = createIntegrationProviderRef({ source: 'mcp', scope, connectionId: resourceId });
      providers.push({
        providerRef, source: 'mcp', displayName: definition.name, scope,
        description: 'Organization-approved MCP setup. Create your personal connection to use it.',
        state: 'setup_required', configured: false, requiresAuth: requiresOAuth(definition.config), authorized: false,
        health: 'unknown', canExecute: false, checkedAt: null, statusSource: 'configuration',
        pluginRefs: [], skillRefs: [], matchReasons: [],
        nextActions: [{ kind: 'setup', href: settingsHref(), label: 'Set up a personal connection' }],
      });
    }
  }
  providers.sort((a, b) => a.providerRef.localeCompare(b.providerRef));
  return {
    source: 'mcp', providers, complete: providerErrors.length === 0, providerErrors,
    revision: createHash('sha256').update(JSON.stringify([
      context.policyRevision, revisions,
      providers.map(({ checkedAt: _checkedAt, ...provider }) => provider), providerErrors,
    ])).digest('hex'),
  };
}
