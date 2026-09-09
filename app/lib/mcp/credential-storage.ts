import crypto from 'node:crypto';
import path from 'node:path';

import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { openMcpSecret, sealMcpSecret, type McpSecretBinding } from '@/app/lib/mcp/secret-store';
import { requireMcpCredentialScope, type McpScope } from '@/app/lib/mcp/scope';
import { readMcpTextFileIfExists, removeMcpStoragePath, writeMcpTextFileAtomic } from '@/app/lib/mcp/storage';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';

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
  return { ...server, connectionId };
}

function bindingFor(relativePath: string, scope: McpScope, connectionId?: string): McpSecretBinding {
  const parts = relativePath.split('/');
  const id = parts[0] === 'connections' ? parts[1] : connectionId;
  if (!id) throw new Error('MCP credential connection binding is missing.');
  return { ownerUserId: scope.userId || 'system', organizationId: scope.organizationId || null, connectionId: id, purpose: relativePath };
}

export async function writeMcpCredentialJson(relativePath: string, payload: unknown, scope?: McpScope | null): Promise<void> {
  const ownedScope = requireMcpCredentialScope(scope);
  const connectionId = (payload as { connectionId?: string })?.connectionId;
  const binding = bindingFor(relativePath, ownedScope, connectionId);
  const sealed = await sealMcpSecret(payload, binding);
  // The clear ID only routes state lookup. Authentication binds it to the secret.
  await writeMcpTextFileAtomic(relativePath, JSON.stringify({ connectionId: binding.connectionId, sealed }), ownedScope);
}

export async function readMcpCredentialJson<T>(relativePath: string, scope?: McpScope | null): Promise<T | null> {
  const ownedScope = requireMcpCredentialScope(scope);
  const { content } = await readMcpTextFileIfExists(relativePath, ownedScope);
  if (content === null) return null;
  let envelope: { connectionId?: string; sealed?: string };
  try { envelope = JSON.parse(content); } catch { throw new Error('Invalid MCP credential storage envelope.'); }
  if (typeof envelope.connectionId !== 'string' || typeof envelope.sealed !== 'string') throw new Error('Invalid MCP credential storage envelope.');
  const binding = bindingFor(relativePath, ownedScope, envelope.connectionId);
  if (binding.connectionId !== envelope.connectionId) throw new Error('MCP credential connection binding does not match.');
  return openMcpSecret<T>(envelope.sealed, binding);
}

/** Copy only unambiguous, config-bound legacy credentials; resume safely after interruption. */
export async function migrateMcpConnectionCredentials(serverName: string, scope?: McpScope | null): Promise<string> {
  const ownedScope = requireMcpCredentialScope(scope);
  const connection = await resolveMcpCredentialConnection(serverName, ownedScope);
  const directory = `connections/${connection.connectionId}`;
  const legacyName = connection.legacyOAuthName || (ownedScope.legacy ? serverName : null);
  if (!legacyName) return directory;
  return withMcpStorageLock(`migration-${connection.connectionId}`, ownedScope, async () => {
    const marker = `${directory}/migration.json`;
    const oldDirectory = path.posix.join('mcp-oauth', legacyName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server');
    if ((await readMcpTextFileIfExists(marker, ownedScope)).content === null) {
      const legacyToken = await readMcpTextFileIfExists(`${oldDirectory}/tokens.json`, ownedScope);
      let token: Record<string, unknown> | null = null;
      try { token = legacyToken.content ? JSON.parse(legacyToken.content) : null; } catch { /* Reauthorize invalid legacy data. */ }
      const valid = !connection.legacyOAuthAmbiguous && token?.serverName === legacyName
        && token?.configHash === connection.legacyConfigHash && token?.serverUrl === connection.url
        && typeof token?.issuer === 'string' && typeof token?.resource === 'string';
      if (valid) {
        for (const filename of ['tokens.json', 'client.json', 'scope-challenge.json']) {
          const target = `${directory}/${filename}`;
          if ((await readMcpTextFileIfExists(target, ownedScope)).content !== null) continue;
          const source = await readMcpTextFileIfExists(`${oldDirectory}/${filename}`, ownedScope);
          if (!source.content) continue;
          const payload = JSON.parse(source.content) as Record<string, unknown>;
          await writeMcpCredentialJson(target, {
            ...payload, configHash: hashMcpAuthConfig(connection), connectionId: connection.connectionId,
            ownerUserId: ownedScope.userId, organizationId: ownedScope.organizationId || null, authVersion: connection.authVersion || 1,
          }, ownedScope);
        }
      }
      // Publish the marker only after every encrypted write succeeds. Missing keys
      // never discard legacy data; a subsequent attempt can finish the migration.
      await writeMcpTextFileAtomic(marker, JSON.stringify({ version: 1, reauthRequired: Boolean(token && !valid) }), ownedScope);
    }
    await removeMcpStoragePath(oldDirectory, ownedScope, { recursive: true });
    // In-flight pre-upgrade flows cannot be safely rebound; remove their PKCE secrets.
    await removeMcpStoragePath('mcp-oauth/.state', ownedScope, { recursive: true });
    return directory;
  });
}
