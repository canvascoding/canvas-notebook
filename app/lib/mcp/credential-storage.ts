import crypto from 'node:crypto';
import path from 'node:path';

import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { openMcpSecret, sealMcpSecret, type McpSecretBinding } from '@/app/lib/mcp/secret-store';
import { requireMcpCredentialScope, type McpScope } from '@/app/lib/mcp/scope';
import { readMcpTextFileIfExists, removeMcpStoragePath, writeMcpTextFileAtomic } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';

export function resolveMcpCredentialScope(
  connection: Pick<McpServerConfig, 'ownerUserId' | 'organizationId'> & { connectionId: string },
  scope?: McpScope | null,
): McpScope {
  const requested = requireMcpCredentialScope(scope);
  if (!requested.userId) return requested;
  if (connection.ownerUserId !== requested.userId) throw new Error('MCP connection belongs to another user.');
  const organizationId = connection.organizationId || null;
  if (requested.organizationId && requested.organizationId !== organizationId) {
    throw new Error('MCP connection belongs to another organization.');
  }
  return { userId: requested.userId, organizationId };
}

export async function resolveMcpCredentialConnection(serverName: string, scope?: McpScope | null): Promise<McpServerConfig & { connectionId: string }> {
  const ownedScope = requireMcpCredentialScope(scope);
  const config = await readMcpConfig(ownedScope);
  const systemId = (name: string) => `system-${crypto.createHash('sha256').update(name).digest('hex')}`;
  const entries = Object.entries(config.mcpServers);
  const selected = entries.find(([name, item]) => item.connectionId === serverName || (ownedScope.legacy && systemId(name) === serverName))
    || entries.find(([name]) => name === serverName);
  if (!selected) throw new Error(`Unknown MCP connection "${serverName}".`);
  const [name, server] = selected;
  const connectionId = server.connectionId || systemId(name);
  const connection = { ...server, connectionId };
  resolveMcpCredentialScope(connection, ownedScope);
  return connection;
}

function bindingFor(relativePath: string, scope: McpScope, connectionId?: string): McpSecretBinding {
  const parts = relativePath.split('/');
  const id = parts[0] === 'connections' ? parts[1] : connectionId;
  if (!id) throw new Error('MCP credential connection binding is missing.');
  return { ownerUserId: scope.userId || 'system', organizationId: scope.organizationId || null, connectionId: id, purpose: relativePath };
}

function envelopeOrganizationId(payload: unknown, scope: McpScope): string | null {
  const value = (payload as { organizationId?: unknown })?.organizationId;
  if (value === undefined) return scope.organizationId || null;
  if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error('Invalid MCP credential organization binding.');
  if (scope.organizationId && value !== scope.organizationId) throw new Error('MCP credential organization binding does not match the requested scope.');
  return value || null;
}

export async function writeMcpCredentialJson(relativePath: string, payload: unknown, scope?: McpScope | null): Promise<void> {
  const ownedScope = requireMcpCredentialScope(scope);
  const connectionId = (payload as { connectionId?: string })?.connectionId;
  const organizationId = envelopeOrganizationId(payload, ownedScope);
  const binding = bindingFor(relativePath, { ...ownedScope, organizationId }, connectionId);
  const sealed = await sealMcpSecret(payload, binding);
  // Clear routing fields are bound into the secret's AAD and cannot change its authority.
  await writeMcpTextFileAtomic(relativePath, JSON.stringify({ connectionId: binding.connectionId, organizationId, sealed }), ownedScope);
}

export async function readMcpCredentialJson<T>(relativePath: string, scope?: McpScope | null): Promise<T | null> {
  const ownedScope = requireMcpCredentialScope(scope);
  const { content } = await readMcpTextFileIfExists(relativePath, ownedScope);
  if (content === null) return null;
  let envelope: { connectionId?: string; organizationId?: string | null; sealed?: string };
  try { envelope = JSON.parse(content); } catch { throw new Error('Invalid MCP credential storage envelope.'); }
  if (typeof envelope.connectionId !== 'string' || typeof envelope.sealed !== 'string') throw new Error('Invalid MCP credential storage envelope.');
  if (envelope.organizationId !== undefined && envelope.organizationId !== null && (typeof envelope.organizationId !== 'string' || !envelope.organizationId.trim())) {
    throw new Error('Invalid MCP credential storage envelope.');
  }
  if (ownedScope.organizationId && envelope.organizationId !== undefined && envelope.organizationId !== ownedScope.organizationId) {
    throw new Error('MCP credential organization binding does not match the requested scope.');
  }
  // Pre-association envelopes bind the caller's requested scope exactly as before.
  const binding = bindingFor(relativePath, { ...ownedScope, organizationId: envelope.organizationId === undefined ? ownedScope.organizationId || null : envelope.organizationId }, envelope.connectionId);
  if (binding.connectionId !== envelope.connectionId) throw new Error('MCP credential connection binding does not match.');
  return openMcpSecret<T>(envelope.sealed, binding);
}

/** Copy only unambiguous, config-bound legacy credentials; resume safely after interruption. */
export async function migrateMcpConnectionCredentials(serverName: string, scope?: McpScope | null): Promise<string> {
  const ownedScope = requireMcpCredentialScope(scope);
  const connection = await resolveMcpCredentialConnection(serverName, ownedScope);
  const credentialScope = resolveMcpCredentialScope(connection, ownedScope);
  const directory = `connections/${connection.connectionId}`;
  const legacyName = connection.legacyOAuthName || (ownedScope.legacy ? serverName : null);
  if (!legacyName) return directory;
  return withMcpStorageLock(`migration-${connection.connectionId}`, credentialScope, async () => {
    const marker = `${directory}/migration.json`;
    const oldDirectory = path.posix.join('mcp-oauth', legacyName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server');
    if ((await readMcpTextFileIfExists(marker, credentialScope)).content === null) {
      const legacyToken = await readMcpTextFileIfExists(`${oldDirectory}/tokens.json`, credentialScope);
      let token: Record<string, unknown> | null = null;
      try { token = legacyToken.content ? JSON.parse(legacyToken.content) : null; } catch { /* Reauthorize invalid legacy data. */ }
      const valid = !connection.legacyOAuthAmbiguous && token?.serverName === legacyName
        && token?.configHash === connection.legacyConfigHash && token?.serverUrl === connection.url
        && typeof token?.issuer === 'string' && typeof token?.resource === 'string';
      if (valid) {
        for (const filename of ['tokens.json', 'client.json', 'scope-challenge.json']) {
          const target = `${directory}/${filename}`;
          if ((await readMcpTextFileIfExists(target, credentialScope)).content !== null) continue;
          const source = await readMcpTextFileIfExists(`${oldDirectory}/${filename}`, credentialScope);
          if (!source.content) continue;
          const payload = JSON.parse(source.content) as Record<string, unknown>;
          await writeMcpCredentialJson(target, {
            ...payload, configHash: hashMcpAuthConfig(connection), connectionId: connection.connectionId,
            ownerUserId: credentialScope.userId, organizationId: credentialScope.organizationId || null, authVersion: connection.authVersion || 1,
          }, credentialScope);
        }
      }
      // Publish the marker only after every encrypted write succeeds. Missing keys
      // never discard legacy data; a subsequent attempt can finish the migration.
      await writeMcpTextFileAtomic(marker, JSON.stringify({ version: 1, reauthRequired: Boolean(token && !valid) }), credentialScope);
    }
    await removeMcpStoragePath(oldDirectory, credentialScope, { recursive: true });
    // In-flight pre-upgrade flows cannot be safely rebound; remove their PKCE secrets.
    await removeMcpStoragePath('mcp-oauth/.state', credentialScope, { recursive: true });
    return directory;
  });
}
