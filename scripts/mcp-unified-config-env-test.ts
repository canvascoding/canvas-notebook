import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { McpScope } from '../app/lib/mcp/scope';
import type { McpServerConfig } from '../app/lib/mcp/config';
import { expandMcpEnvValue, mcpConfigUsesChangedEnv, mcpLiteralEnvKey } from '../app/lib/mcp/env-references';

async function child() {
  const { readMcpConfig } = await import('../app/lib/mcp/config');
  await readMcpConfig({ userId: 'parallel' });
}
async function runChild(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const worker = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', path.resolve('scripts/mcp-unified-config-env-test.ts'), '--child'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    worker.stdout.on('data', chunk => { output += chunk; }); worker.stderr.on('data', chunk => { output += chunk; });
    worker.once('error', reject); worker.once('close', code => code === 0 ? resolve() : reject(new Error(`MCP config child failed (${code}): ${output}`)));
  });
}
async function fixture(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-config-env-'));
  const saved = { ...process.env };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network access is disabled in MCP config fixtures.'); };
  try {
    process.env.CANVAS_DATA_ROOT = root;
    process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
    process.env.BASE_URL = 'https://notebook.example.test';
    process.env.BETTER_AUTH_URL = 'https://notebook.example.test';
    for (const key of ['DATA', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY']) delete process.env[key];
    process.env.INTEGRATIONS_ENV_MASTER_KEY = 'fixture-master-key-with-at-least-32-bytes';
    const config = await import('../app/lib/mcp/config');
    const env = await import('../app/lib/secrets/unified-env-store');
    const identity = await import('../app/lib/mcp/connection-identity');
    const credentials = await import('../app/lib/mcp/credential-storage');
    const oauth = await import('../app/lib/mcp/oauth');
    const manager = await import('../app/lib/mcp/manager');
    await manager.closeAllMcpServers();
    const userA = { userId: 'alice' }; const userB = { userId: 'bob' };
    const connectionId = crypto.randomUUID();
    const source: McpServerConfig = {
      schemaVersion: 1, connectionId, ownerUserId: userA.userId, organizationId: null, displayName: 'Fixture', authVersion: 3,
      auth: 'oauth', url: 'https://mcp.example.test/api', oauth: { issuer: 'https://issuer.example.test', clientId: 'fixture-client' },
      env: { TOKEN: 'fixture-sensitive', CUSTOM: 'opaque-credential-fixture', REGION: 'eu', TEMPLATE: 'prefix-${SOURCE}', DIRECT: '${SOURCE}', EMPTY: '' },
      headers: { Authorization: 'Bearer ${SOURCE}', 'X-Custom': 'opaque-header-fixture', 'X-Region': 'eu', 'X-Direct': '${SOURCE}' },
    };
    const oldHash = identity.hashMcpAuthConfig(source);
    await env.patchUnifiedEnvEntries([{ key: 'SOURCE', value: 'fixture-source' }], userA);
    const tokenPath = `connections/${connectionId}/tokens.json`;
    await credentials.writeMcpCredentialJson(tokenPath, {
      connectionId, ownerUserId: userA.userId, organizationId: null, authVersion: 3, lifecycleGeneration: 0,
      configHash: oldHash, serverUrl: source.url, issuer: 'https://issuer.example.test', resource: source.url,
      clientId: 'fixture-client', tokenType: 'Bearer', accessToken: 'fixture-oauth-access', expiresAt: '2035-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }, userA);
    await fixture(config.resolveMcpConfigPath(userA), { mcpServers: { remote: source } });
    const state = await config.readMcpConfigState(userA);
    const migrated = config.parseAndValidateMcpConfig(state.rawContent).mcpServers.remote;
    assert.equal(migrated.connectionId, connectionId); assert.equal(migrated.authVersion, 3);
    assert.equal(identity.hashMcpAuthConfig(migrated), oldHash, 'storage-only migration preserves existing OAuth config binding');
    for (const field of ['env', 'headers'] as const) for (const [name, value] of Object.entries(source[field]!)) {
      if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) { assert.equal(migrated[field]![name], value); continue; }
      const key = mcpLiteralEnvKey(connectionId, field, name);
      assert.equal(migrated[field]![name], `\${${key}}`);
      assert.equal(env.readUnifiedSecretValue(key, userA), value, 'all literals, even innocuous names and mixed templates, are centralized');
      if (value && !value.includes('${')) assert.equal(state.rawContent.includes(value), false);
    }
    assert.equal((await oauth.getMcpOAuthStatus('remote', 'https://notebook.example.test', userA)).authorized, true);
    assert.equal(await oauth.getValidMcpAccessToken('remote', migrated, oldHash, userA), 'fixture-oauth-access');
    const environment = Object.fromEntries((await env.readUnifiedEnvState(userA)).entries.map(entry => [entry.key, entry.value]));
    const missing = new Set<string>();
    assert.equal(expandMcpEnvValue(migrated.env!.TEMPLATE, environment, missing), 'prefix-fixture-source');
    assert.equal(expandMcpEnvValue(migrated.headers!.Authorization, environment, missing), 'Bearer fixture-source');
    assert.equal(expandMcpEnvValue(migrated.env!.DIRECT, environment, missing), 'fixture-source');
    assert.equal(missing.size, 0);
    assert.equal(expandMcpEnvValue('${ORDINARY}', { ORDINARY: '${SOURCE}', SOURCE: 'never-expanded' }, missing), '${SOURCE}', 'ordinary ENV values retain their previous single-layer behavior');
    assert.equal(expandMcpEnvValue('${CANVAS_MCP_DIRECT_TOKEN}', { CANVAS_MCP_DIRECT_TOKEN: '${SOURCE}', SOURCE: 'never-expanded' }, missing), '${SOURCE}', 'existing MCP-prefixed values remain literal');
    assert.equal(mcpConfigUsesChangedEnv({ env: { CUSTOM: '${CANVAS_MCP_DIRECT_TOKEN}' } }, new Set(['SOURCE']), { CANVAS_MCP_DIRECT_TOKEN: '${SOURCE}' }), false);
    const generated = mcpLiteralEnvKey(connectionId, 'env', 'TEMPLATE');
    const missingSource = new Set<string>();
    assert.equal(expandMcpEnvValue(`\${${generated}}`, { [generated]: 'prefix-${ABSENT}' }, missingSource), 'prefix-');
    assert.deepEqual([...missingSource], ['ABSENT']);
    assert.equal(mcpConfigUsesChangedEnv(migrated, new Set(['SOURCE']), environment), true);
    assert.equal(mcpConfigUsesChangedEnv({ env: { TEMPLATE: `\${${generated}}` } }, new Set(['SOURCE']), environment), true, 'dependencies inside generated templates remain visible');
    assert.equal(mcpConfigUsesChangedEnv({ env: { ORDINARY: '${ORDINARY}' } }, new Set(['SOURCE']), { ORDINARY: '${SOURCE}' }), false, 'ordinary values do not gain new dependency semantics');
    const firstRevision = (await env.readUnifiedEnvState(userA)).revision;
    assert.equal((await config.readMcpConfigState(userA)).rawContent, state.rawContent);
    assert.equal((await env.readUnifiedEnvState(userA)).revision, firstRevision, 'repeated config reads do not rewrite ENV');
    const regionKey = mcpLiteralEnvKey(connectionId, 'env', 'REGION');
    await env.patchUnifiedEnvEntries([{ key: regionKey, value: 'authoritative-edit' }], userA);
    await fixture(config.resolveMcpConfigPath(userA), { mcpServers: { remote: source } });
    const recovered = (await config.readMcpConfig(userA)).mcpServers.remote;
    assert.equal(env.readUnifiedSecretValue(regionKey, userA), 'authoritative-edit', 'replayed legacy config cannot overwrite the unified store');
    assert.equal(identity.hashMcpAuthConfig(recovered), oldHash);
    const managerGlobal = globalThis as unknown as { __canvasMcpManagerStore: { entries: Map<string, unknown> } };
    const observeClose = (scope: McpScope, server: McpServerConfig, name = 'remote') => {
      let closed = 0;
      const entry = { scope, config: server, serverName: name, transport: 'http', abortController: new AbortController(), client: { close: async () => { closed++; } }, closed: false };
      managerGlobal.__canvasMcpManagerStore.entries.set(`fixture-${crypto.randomUUID()}`, entry);
      return () => closed;
    };
    const identicalScope = { userId: 'identical' };
    const identicalSource: McpServerConfig = { schemaVersion: 1, connectionId: crypto.randomUUID(), ownerUserId: 'identical', organizationId: null, displayName: 'Stable', authVersion: 1, auth: 'none', command: 'node', env: { REGION: 'eu' } };
    await fixture(config.resolveMcpConfigPath(identicalScope), { mcpServers: { stable: identicalSource } });
    const identicalState = await config.readMcpConfigState(identicalScope);
    const identical = config.parseAndValidateMcpConfig(identicalState.rawContent).mcpServers.stable;
    const identicalKey = identical.env!.REGION.slice(2, -1);
    await env.patchUnifiedEnvEntries([{ key: identicalKey, value: 'manually-updated' }], identicalScope);
    const identicalClosed = observeClose(identicalScope, identical, 'stable');
    const resubmitted = await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { stable: identicalSource } }), identicalScope);
    assert.equal(env.readUnifiedSecretValue(identicalKey, identicalScope), 'eu', 'explicit incoming literals update their authoritative ENV value');
    assert.equal(resubmitted.rawContent, identicalState.rawContent, 'resubmitted literals can retain identical canonical JSON');
    assert.equal(identicalClosed(), 1, 'changed ENV values close a client even when canonical JSON stays identical');
    assert.equal(identity.hashMcpAuthConfig((await config.readMcpConfig(identicalScope)).mcpServers.stable), identity.hashMcpAuthConfig(identical));
    const recoveryScope = { userId: 'config-write-recovery' };
    const recoveryId = crypto.randomUUID();
    const recoverySource: McpServerConfig = { schemaVersion: 1, connectionId: recoveryId, ownerUserId: recoveryScope.userId, organizationId: null, displayName: 'Recovery', authVersion: 1, auth: 'none', command: 'node', env: { REGION: 'old-region' } };
    const recoveryPath = config.resolveMcpConfigPath(recoveryScope);
    const recoveryKey = mcpLiteralEnvKey(recoveryId, 'env', 'REGION');
    const recoveryRaw = JSON.stringify({ mcpServers: { recovery: recoverySource } });
    await fixture(recoveryPath, { mcpServers: { recovery: recoverySource } });
    const originalRename = fs.rename;
    const rejectConfigRename: typeof fs.rename = async (from, to) => {
      if (to === recoveryPath) throw Object.assign(new Error('Injected MCP config publish failure.'), { code: 'EIO' });
      return originalRename(from, to);
    };
    fs.rename = rejectConfigRename;
    try {
      await assert.rejects(() => config.readMcpConfigState(recoveryScope), /Injected MCP config publish failure/);
    } finally {
      fs.rename = originalRename;
    }
    assert.equal(await fs.readFile(recoveryPath, 'utf8'), recoveryRaw, 'failed migration leaves its original config source intact');
    assert.equal(env.readUnifiedSecretValue(recoveryKey, recoveryScope), 'old-region', 'ENV commits before config publication fails');
    await env.patchUnifiedEnvEntries([{ key: recoveryKey, value: 'authoritative-after-failure' }], recoveryScope);
    const migrationRecovered = (await config.readMcpConfig(recoveryScope)).mcpServers.recovery;
    assert.equal(migrationRecovered.env!.REGION, `\${${recoveryKey}}`, 'a later read finishes publishing canonical references');
    assert.equal(env.readUnifiedSecretValue(recoveryKey, recoveryScope), 'authoritative-after-failure', 'recovery never replays the stale literal over authoritative ENV');
    const beforeFailedApi = await fs.readFile(recoveryPath, 'utf8');
    fs.rename = rejectConfigRename;
    try {
      await assert.rejects(() => config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { recovery: { ...migrationRecovered, env: { REGION: 'new-region-after-failed-api' } } } }), recoveryScope), /Injected MCP config publish failure/);
    } finally {
      fs.rename = originalRename;
    }
    assert.equal(await fs.readFile(recoveryPath, 'utf8'), beforeFailedApi, 'failed API publication retains the previous config file');
    assert.equal(env.readUnifiedSecretValue(recoveryKey, recoveryScope), 'new-region-after-failed-api');
    const apiRecovered = (await config.readMcpConfig(recoveryScope)).mcpServers.recovery;
    assert.equal(apiRecovered.env!.REGION, `\${${recoveryKey}}`);
    assert.equal(env.readUnifiedSecretValue(apiRecovered.env!.REGION.slice(2, -1), recoveryScope), 'new-region-after-failed-api', 'a failed API call can complete its ENV change when the existing reference is reloaded');
    const changed = { ...recovered, env: { ...recovered.env, REGION: 'new-region' } };
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { remote: changed } }), userA);
    const updated = (await config.readMcpConfig(userA)).mcpServers.remote;
    assert.notEqual(identity.hashMcpAuthConfig(updated), oldHash); assert.equal(updated.authVersion, 4);
    assert.equal(await credentials.readMcpCredentialJson(tokenPath, userA), null, 'genuine auth config edits invalidate existing credentials');
    const forged = { ...updated, url: 'https://different.example.test/mcp' };
    forged.envMigrationBinding = { version: 1, priorAuthHash: identity.hashMcpAuthConfig(updated), referencedConfigHash: identity.hashMcpReferencedAuthConfig(forged) };
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { remote: forged } }), userA);
    assert.notEqual(identity.hashMcpAuthConfig((await config.readMcpConfig(userA)).mcpServers.remote), identity.hashMcpAuthConfig(updated), 'caller-created migration metadata cannot bypass OAuth invalidation');
    const beforeConflict = (await env.readUnifiedEnvState(userA)).revision;
    await assert.rejects(() => config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { remote: { ...forged, env: { REGION: 'conflict-write' } } } }), userA, { expectedRaw: 'stale' }), /changed/);
    assert.equal((await env.readUnifiedEnvState(userA)).revision, beforeConflict, 'rejected snapshots do not update ENV');
    assert.throws(() => config.parseAndValidateMcpConfig(JSON.stringify({ mcpServers: { unsafe: { env: { TOKEN: 'literal-secret' } } } })), /reference secret/);
    await fixture(config.resolveMcpConfigPath(userB), { mcpServers: { remote: { ...source, ownerUserId: userB.userId, env: { REGION: 'bob' }, headers: {} } } });
    const bob = (await config.readMcpConfig(userB)).mcpServers.remote;
    assert.equal(env.readUnifiedSecretValue(regionKey, userB), 'bob'); assert.equal(env.readUnifiedSecretValue(regionKey, userA), 'new-region');
    const sourceClosed = observeClose(userB, { ...bob, env: { NESTED: `\${${generated}}` } });
    const aliceClosed = observeClose(userA, { ...updated, env: { NESTED: `\${${generated}}` } });
    await env.patchUnifiedEnvEntries([{ key: generated, value: 'prefix-${SOURCE}' }, { key: 'SOURCE', value: 'bob-source' }], userB);
    await manager.closeMcpServersForScope(userB, ['SOURCE']);
    assert.equal(sourceClosed(), 1, 'runtime invalidation follows one generated template layer'); assert.equal(aliceClosed(), 0, 'runtime invalidation stays in its owner scope');
    await manager.closeAllMcpServers();
    await fixture(config.resolveMcpConfigPath(), { mcpServers: { shared: { command: 'node', env: { CUSTOM: 'system-value' }, headers: { 'X-Custom': 'system-header' } } } });
    const system = (await config.readMcpConfig()).mcpServers.shared;
    const systemEnvKey = system.env!.CUSTOM.slice(2, -1);
    assert.equal(env.readUnifiedSecretValue(systemEnvKey, { secretScope: 'system' }), 'system-value');
    assert.equal(env.readUnifiedSecretValue(systemEnvKey, userA), null);
    await assert.rejects(() => config.readMcpConfig({ organizationId: 'invalid-no-owner' }), /user scope/);
    const invalidOwner = { userId: 'wrong-owner' };
    await fixture(config.resolveMcpConfigPath(invalidOwner), { mcpServers: { foreign: source } });
    await assert.rejects(() => config.readMcpConfig(invalidOwner), /another user/);
    assert.equal(await fs.stat(env.getUnifiedEnvFilePath(invalidOwner)).catch(() => null), null, 'ownership is checked before writing central values');
    const parallel = { userId: 'parallel' };
    await fixture(config.resolveMcpConfigPath(parallel), { mcpServers: { concurrent: { command: 'node', env: { TOKEN: 'parallel-secret', TEMPLATE: 'hello-${SOURCE}' } } } });
    await Promise.all([runChild(), runChild(), runChild()]);
    const concurrent = (await config.readMcpConfig(parallel)).mcpServers.concurrent;
    const concurrentEntries = (await env.readUnifiedEnvState(parallel)).entries.filter(entry => entry.key.startsWith('CANVAS_MCP_'));
    assert.equal(concurrentEntries.length, 2, 'concurrent read migration creates one deterministic set');
    assert.equal(env.readUnifiedSecretValue(concurrent.env!.TOKEN.slice(2, -1), parallel), 'parallel-secret');
    console.log('MCP config ENV migration: every literal/template, owner isolation, authoritative replay protection, failed config publication recovery, stable OAuth identity, forged metadata rejection and runtime invalidation passed.');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    globalThis.fetch = oldFetch; await fs.rm(root, { recursive: true, force: true });
  }
}
(process.argv.includes('--child') ? child() : main()).catch(error => { console.error(error); process.exitCode = 1; });
