import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type LegacyServer = {
  url: string;
  auth: 'oauth';
  oauth: { issuer: string; clientId: string };
};

function key(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function legacyServer(url = 'https://mcp.example.test/api'): LegacyServer {
  return {
    url,
    auth: 'oauth',
    oauth: { issuer: 'https://issuer.example.test', clientId: 'canvas-client' },
  };
}

function legacyDirectory(name: string): string {
  return `mcp-oauth/${name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server'}`;
}

async function exists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(() => true).catch(() => false);
}

async function writeLegacyConfig(
  resolveMcpConfigPath: (scope: { userId: string; organizationId: string }) => string,
  scope: { userId: string; organizationId: string },
  servers: Record<string, LegacyServer>,
): Promise<void> {
  const filePath = resolveMcpConfigPath(scope);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ mcpServers: servers }, null, 2));
}

async function writeLegacyOAuthFiles(
  resolveMcpStoragePath: (relativePath: string, scope: { userId: string; organizationId: string }) => string,
  scope: { userId: string; organizationId: string },
  name: string,
  server: LegacyServer,
  configHash: string,
): Promise<void> {
  const directory = legacyDirectory(name);
  const tokenPath = resolveMcpStoragePath(`${directory}/tokens.json`, scope);
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify({
    serverName: name,
    serverUrl: server.url,
    issuer: server.oauth.issuer,
    resource: 'https://resource.example.test',
    configHash,
    clientId: server.oauth.clientId,
    tokenType: 'Bearer',
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    updatedAt: new Date().toISOString(),
  }));
  await fs.writeFile(resolveMcpStoragePath(`${directory}/client.json`, scope), JSON.stringify({
    clientId: server.oauth.clientId,
    clientSecret: `client-secret-${name}`,
    issuer: server.oauth.issuer,
    registeredAt: new Date().toISOString(),
  }));
  const statePath = resolveMcpStoragePath('mcp-oauth/.state/pending.json', scope);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({ codeVerifier: 'legacy-pkce-secret' }));
}

async function main() {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalDataRoot = process.env.CANVAS_DATA_ROOT;
  const originalMasterKey = process.env.INTEGRATIONS_ENV_MASTER_KEY;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-credential-migration-'));
  mutableEnv.CANVAS_DATA_ROOT = root;
  mutableEnv.INTEGRATIONS_ENV_MASTER_KEY = key();

  try {
    const { hashMcpAuthConfig, hashMcpLegacyConfig } = await import('../app/lib/mcp/connection-identity');
    const { readMcpConfig, resolveMcpConfigPath, writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const { migrateMcpConnectionCredentials, readMcpCredentialJson } = await import('../app/lib/mcp/credential-storage');
    const { getMcpOAuthStatus } = await import('../app/lib/mcp/oauth');
    const { resolveMcpStoragePath } = await import('../app/lib/mcp/storage');

    const scope = { userId: 'migration-user', organizationId: 'migration-org' };
    const rawServer = legacyServer();
    const oldHash = hashMcpLegacyConfig(rawServer);
    await writeLegacyConfig(resolveMcpConfigPath, scope, { legacy: rawServer });
    await writeLegacyOAuthFiles(resolveMcpStoragePath, scope, 'legacy', rawServer, oldHash);

    const hydrated = await readMcpConfig(scope);
    const migratedServer = hydrated.mcpServers.legacy!;
    assert.ok(migratedServer.connectionId, 'legacy config must receive a stable connection ID');
    assert.equal(migratedServer.ownerUserId, scope.userId);
    assert.equal(migratedServer.organizationId, scope.organizationId);
    assert.equal(migratedServer.legacyConfigHash, oldHash);

    const status = await getMcpOAuthStatus('legacy', undefined, scope);
    assert.equal(status.configured, true);
    assert.equal(status.authorized, true);
    const directory = `connections/${migratedServer.connectionId}`;
    const migratedToken = await readMcpCredentialJson<{ accessToken: string; connectionId: string; configHash: string }>(`${directory}/tokens.json`, scope);
    const migratedClient = await readMcpCredentialJson<{ clientSecret: string; connectionId: string }>(`${directory}/client.json`, scope);
    assert.equal(migratedToken?.accessToken, 'access-legacy');
    assert.equal(migratedToken?.connectionId, migratedServer.connectionId);
    assert.equal(migratedToken?.configHash, hashMcpAuthConfig(migratedServer));
    assert.equal(migratedClient?.clientSecret, 'client-secret-legacy');

    const storedTokenPath = resolveMcpStoragePath(`${directory}/tokens.json`, scope);
    assert.equal((await fs.readFile(storedTokenPath, 'utf8')).includes('access-legacy'), false, 'new credential file must be sealed');
    assert.equal(await exists(resolveMcpStoragePath(legacyDirectory('legacy'), scope)), false);
    assert.equal(await exists(resolveMcpStoragePath('mcp-oauth/.state', scope)), false);
    assert.equal(await migrateMcpConnectionCredentials('legacy', scope), directory, 'migration must be idempotent');
    assert.equal((await readMcpCredentialJson<{ accessToken: string }>(`${directory}/tokens.json`, scope))?.accessToken, 'access-legacy');

    const renamedConfig = JSON.stringify({ mcpServers: {
      renamed: { ...migratedServer, displayName: 'Renamed connection' },
    } });
    await writeMcpConfigRaw(renamedConfig, scope);
    const renamed = (await readMcpConfig(scope)).mcpServers.renamed!;
    assert.equal(renamed.connectionId, migratedServer.connectionId);
    assert.equal(hashMcpAuthConfig(renamed), hashMcpAuthConfig(migratedServer));
    assert.equal((await getMcpOAuthStatus('renamed', undefined, scope)).authorized, true);

    await writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      renamed: { ...renamed, url: 'https://changed.example.test/mcp' },
    } }), scope);
    const endpointChanged = await getMcpOAuthStatus('renamed', undefined, scope);
    assert.equal(endpointChanged.authorized, false);
    assert.match(endpointChanged.reason || '', /does not match/i);

    const noKeyScope = { userId: 'missing-key-user', organizationId: 'migration-org' };
    const noKeyServer = legacyServer('https://missing-key.example.test/mcp');
    await writeLegacyConfig(resolveMcpConfigPath, noKeyScope, { legacy: noKeyServer });
    await writeLegacyOAuthFiles(resolveMcpStoragePath, noKeyScope, 'legacy', noKeyServer, hashMcpLegacyConfig(noKeyServer));
    delete mutableEnv.INTEGRATIONS_ENV_MASTER_KEY;
    await assert.rejects(() => migrateMcpConnectionCredentials('legacy', noKeyScope), /settings\?tab=integrations/i);
    assert.equal(await exists(resolveMcpStoragePath(legacyDirectory('legacy'), noKeyScope)), true, 'missing key must retain plaintext migration source');
    mutableEnv.INTEGRATIONS_ENV_MASTER_KEY = key();
    const noKeyConnection = (await readMcpConfig(noKeyScope)).mcpServers.legacy!.connectionId!;
    await migrateMcpConnectionCredentials('legacy', noKeyScope);
    assert.equal((await readMcpCredentialJson<{ accessToken: string }>(`connections/${noKeyConnection}/tokens.json`, noKeyScope))?.accessToken, 'access-legacy');

    const collisionScope = { userId: 'collision-user', organizationId: 'migration-org' };
    const collisionServer = legacyServer('https://collision.example.test/mcp');
    await writeLegacyConfig(resolveMcpConfigPath, collisionScope, { 'foo/bar': collisionServer, foo_bar: collisionServer });
    await writeLegacyOAuthFiles(resolveMcpStoragePath, collisionScope, 'foo/bar', collisionServer, hashMcpLegacyConfig(collisionServer));
    const collided = await readMcpConfig(collisionScope);
    assert.equal(collided.mcpServers['foo/bar']?.legacyOAuthAmbiguous, true);
    assert.equal(collided.mcpServers.foo_bar?.legacyOAuthAmbiguous, true);
    await migrateMcpConnectionCredentials('foo/bar', collisionScope);
    for (const server of Object.values(collided.mcpServers)) {
      assert.equal(await exists(resolveMcpStoragePath(`connections/${server.connectionId}/tokens.json`, collisionScope)), false);
    }
    const collisionStatus = await getMcpOAuthStatus('foo/bar', undefined, collisionScope);
    assert.equal(collisionStatus.requiresAuth, true);
    assert.equal(collisionStatus.authorized, false);

    console.log('mcp-credential-migration-test: ok');
  } finally {
    if (originalDataRoot === undefined) delete mutableEnv.CANVAS_DATA_ROOT;
    else mutableEnv.CANVAS_DATA_ROOT = originalDataRoot;
    if (originalMasterKey === undefined) delete mutableEnv.INTEGRATIONS_ENV_MASTER_KEY;
    else mutableEnv.INTEGRATIONS_ENV_MASTER_KEY = originalMasterKey;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
