import crypto from 'node:crypto';

import type { McpConfig, McpServerConfig } from '@/app/lib/mcp/config';
import { normalizeMcpScope, type McpScope } from '@/app/lib/mcp/scope';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const NON_AUTH_FIELDS = new Set([
  'schemaVersion', 'connectionId', 'ownerUserId', 'organizationId', 'displayName',
  'enabled', 'icon', 'iconUrl', 'timeoutMs', 'directTools', 'authVersion',
  'legacyOAuthName', 'legacyOAuthAmbiguous', 'legacyConfigHash',
]);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashMcpLegacyConfig(config: McpServerConfig): string {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex');
}

export function hashMcpAuthConfig(config: McpServerConfig): string {
  return hashMcpLegacyConfig(Object.fromEntries(Object.entries(config).filter(([key]) => !NON_AUTH_FIELDS.has(key))));
}

export function validateMcpConnectionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid MCP connection ID.');
}

/** Only the authenticated storage scope can assign ownership or new identities. */
export function hydrateMcpConnectionIdentities(config: McpConfig, scope: McpScope | null | undefined, previous?: McpConfig): McpConfig {
  const normalized = normalizeMcpScope(scope);
  if (!normalized?.userId) return config; // Explicit system configuration is migrated separately.
  const seen = new Set<string>();
  const priorById = new Map(Object.values(previous?.mcpServers || {}).map((server) => [server.connectionId, server]));
  const legacyNames = Object.keys(config.mcpServers).map((name) => name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server');
  const result: McpConfig = { ...config, mcpServers: {} };
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.ownerUserId !== undefined && server.ownerUserId !== normalized.userId) throw new Error('MCP connection owner belongs to another user.');
    if (server.schemaVersion !== undefined && server.schemaVersion !== 1) throw new Error('Unsupported MCP connection schema version.');
    const prior = previous ? (server.connectionId ? priorById.get(server.connectionId) : previous.mcpServers[name]) : undefined;
    if (server.connectionId !== undefined) {
      validateMcpConnectionId(server.connectionId);
      if (previous && !prior) throw new Error('Unknown MCP connection ID; new connections must omit the ID.');
    }
    const connectionId = prior?.connectionId || server.connectionId || crypto.randomUUID();
    if (seen.has(connectionId)) throw new Error('Duplicate MCP connection ID.');
    seen.add(connectionId);
    const ownerUserId: string = prior?.ownerUserId || normalized.userId;
    // An existing unassociated connection stays unassociated. `??` would treat
    // its persisted null as missing and let an edit bind it to an organization.
    let organizationId = prior
      ? prior.organizationId || null
      : (server.organizationId === undefined ? normalized.organizationId || null : server.organizationId);
    if (ownerUserId !== normalized.userId) throw new Error('MCP connection owner belongs to another user.');
    if (prior && server.ownerUserId !== undefined && server.ownerUserId !== ownerUserId) {
      throw new Error('MCP connection owner is immutable.');
    }
    if (prior && server.organizationId !== undefined && server.organizationId !== organizationId) {
      throw new Error('MCP connection organization association is immutable.');
    }
    if (organizationId !== null && (typeof organizationId !== 'string' || !organizationId.trim())) {
      throw new Error('MCP connection organization association is invalid.');
    }
    if (organizationId !== null) {
      const validatedAssociation = normalizeMcpScope({ userId: normalized.userId, organizationId });
      if (!validatedAssociation?.organizationId) throw new Error('MCP connection organization association is invalid.');
      organizationId = validatedAssociation.organizationId;
    }
    const authVersion = prior
      ? (prior.authVersion || 1) + (hashMcpAuthConfig(prior) === hashMcpAuthConfig(server) ? 0 : 1)
      : previous ? 1 : server.authVersion || 1;
    const legacy = previous ? prior : server;
    const migrating = !previous && server.schemaVersion === undefined;
    const legacyName = name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server';
    const { legacyOAuthName: _name, legacyOAuthAmbiguous: _ambiguous, legacyConfigHash: _hash, ...clean } = server;
    // Migration provenance never comes from an incoming config edit.
    const provenance = migrating ? {
      legacyOAuthName: name,
      legacyOAuthAmbiguous: legacyNames.filter((value) => value === legacyName).length > 1,
      legacyConfigHash: hashMcpLegacyConfig(server),
    } : legacy?.legacyOAuthName ? {
      legacyOAuthName: legacy.legacyOAuthName,
      legacyOAuthAmbiguous: legacy.legacyOAuthAmbiguous,
      legacyConfigHash: legacy.legacyConfigHash,
    } : {};
    result.mcpServers[name] = {
      ...clean, ...provenance, schemaVersion: 1, connectionId,
      ownerUserId, organizationId,
      displayName: typeof server.displayName === 'string' && server.displayName.trim() ? server.displayName.trim() : name,
      authVersion,
    };
  }
  return result;
}
