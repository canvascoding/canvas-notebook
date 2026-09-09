import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function serverConfig(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://mcp.example.test/api',
    displayName: 'Example MCP',
    iconUrl: '/icons/example.svg',
    auth: 'oauth',
    oauth: {
      issuer: 'https://issuer.example.test',
      clientId: 'canvas-client',
      scopes: ['tools', 'profile'],
    },
    ...overrides,
  };
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-identity-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;

  const {
    parseAndValidateMcpConfig,
    readMcpConfig,
    readMcpConfigState,
    resolveMcpConfigPath,
    writeMcpConfigRaw,
  } = await import('../app/lib/mcp/config');
  const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');

  const userA = { userId: 'identity-user-a', organizationId: 'org-a' };
  const userB = { userId: 'identity-user-b', organizationId: 'org-a' };
  const userOtherOrg = { userId: 'identity-user-b', organizationId: 'org-b' };
  const config = (name: string, value: Record<string, unknown> = {}) => JSON.stringify({
    settings: { toolPrefix: 'server', idleTimeout: 10 },
    mcpServers: { [name]: serverConfig(value) },
  });
  const getServer = (value: Awaited<ReturnType<typeof readMcpConfig>>, name: string) => value.mcpServers[name] as Record<string, unknown>;

  await writeMcpConfigRaw(config('remote'), userA);
  await writeMcpConfigRaw(config('remote'), userB);
  const aRemote = getServer(await readMcpConfig(userA), 'remote');
  const bRemote = getServer(await readMcpConfig(userB), 'remote');
  assert.match(String(aRemote.connectionId), UUID);
  assert.match(String(bRemote.connectionId), UUID);
  assert.notEqual(aRemote.connectionId, bRemote.connectionId, 'same server name must be user-scoped');
  assert.equal(aRemote.ownerUserId, userA.userId);
  assert.equal(aRemote.organizationId, userA.organizationId);
  assert.equal(aRemote.schemaVersion, 1);
  assert.equal(aRemote.authVersion, 1);

  await writeMcpConfigRaw(JSON.stringify({
    settings: { toolPrefix: 'server', idleTimeout: 10 },
    mcpServers: {
      remote: serverConfig(),
      'other-name': serverConfig(),
    },
  }), userA);
  const otherName = getServer(await readMcpConfig(userA), 'other-name');
  assert.notEqual(aRemote.connectionId, otherName.connectionId, 'same endpoint must not share identity across entries');

  const renamed = serverConfig({
    connectionId: aRemote.connectionId,
    displayName: 'Renamed MCP',
    iconUrl: '/icons/renamed.svg',
    enabled: false,
  });
  await writeMcpConfigRaw(config('renamed', renamed), userA);
  const renamedRemote = getServer(await readMcpConfig(userA), 'renamed');
  assert.equal(renamedRemote.connectionId, aRemote.connectionId);
  assert.equal(hashMcpAuthConfig(renamedRemote), hashMcpAuthConfig(aRemote));
  assert.equal(renamedRemote.authVersion, aRemote.authVersion);
  assert.equal(renamedRemote.displayName, 'Renamed MCP');
  assert.equal(renamedRemote.iconUrl, '/icons/renamed.svg');
  assert.equal(renamedRemote.enabled, false);

  const changedAuth = serverConfig({
    connectionId: aRemote.connectionId,
    oauth: { issuer: 'https://new-issuer.example.test', clientId: 'canvas-client', scopes: ['tools'] },
  });
  await writeMcpConfigRaw(config('renamed', changedAuth), userA);
  const changedRemote = getServer(await readMcpConfig(userA), 'renamed');
  assert.equal(changedRemote.connectionId, aRemote.connectionId);
  assert.notEqual(hashMcpAuthConfig(changedRemote), hashMcpAuthConfig(aRemote));
  assert.equal(changedRemote.authVersion, Number(aRemote.authVersion) + 1);

  await assert.rejects(
    () => writeMcpConfigRaw(config('foreign', { connectionId: aRemote.connectionId, ownerUserId: userA.userId }), userB),
    /owner|foreign|user|scope/i,
  );
  await assert.rejects(
    () => writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      one: serverConfig({ connectionId: aRemote.connectionId }),
      two: serverConfig({ connectionId: aRemote.connectionId }),
    } }), userA),
    /duplicate|connection.?id/i,
  );
  await assert.rejects(
    () => writeMcpConfigRaw(config('bound', { ownerUserId: userA.userId, organizationId: userA.organizationId }), userOtherOrg),
    /organization|scope|owner/i,
  );

  await writeMcpConfigRaw(JSON.stringify({ mcpServers: {} }), userB);
  await assert.rejects(
    () => writeMcpConfigRaw(config('resurrected', { connectionId: bRemote.connectionId }), userB),
    /unknown|connection.?id/i,
  );

  const oldRaw = JSON.stringify({ mcpServers: {
    'foo/bar': { url: 'https://legacy.example.test/mcp', auth: 'oauth', oauth: { issuer: 'https://legacy.example.test' } },
    foo_bar: { url: 'https://legacy.example.test/mcp', auth: 'oauth', oauth: { issuer: 'https://legacy.example.test' } },
  } });
  const oldPath = resolveMcpConfigPath({ userId: 'legacy-user' });
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, oldRaw, 'utf8');
  const firstLegacy = await readMcpConfig({ userId: 'legacy-user' });
  const secondLegacy = await readMcpConfig({ userId: 'legacy-user' });
  assert.deepEqual(secondLegacy, firstLegacy, 'legacy identity migration must be idempotent');
  const legacyFoo = getServer(firstLegacy, 'foo/bar');
  const legacyFooBar = getServer(firstLegacy, 'foo_bar');
  assert.match(String(legacyFoo.connectionId), UUID);
  assert.match(String(legacyFooBar.connectionId), UUID);
  assert.equal(legacyFoo.legacyOAuthAmbiguous, true);
  assert.equal(legacyFooBar.legacyOAuthAmbiguous, true);

  const legacyState = await readMcpConfigState({ userId: 'legacy-user' });
  assert.equal(parseAndValidateMcpConfig(legacyState.rawContent).mcpServers['foo/bar'] !== undefined, true);
  assert.equal(hashMcpAuthConfig(legacyFoo), hashMcpAuthConfig(legacyFoo));
  console.log('mcp-connection-identity-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
