import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';
import type { McpServerConfig } from '../app/lib/mcp/config';
import { mcpLiteralEnvKey, mcpConfigUsesChangedEnv } from '../app/lib/mcp/env-references';
import { hasMcpCredentialUrl, mcpCredentialArgIndices } from '../app/lib/mcp/credential-fields';

function fixtureMcpServer(): Server {
  const server = new Server({ name: 'url-args-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'args', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: JSON.stringify(process.argv.slice(process.argv.indexOf('--credential-child') + 1)) }] }));
  return server;
}

async function child(): Promise<void> {
  await fixtureMcpServer().connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-url-args-'));
  const saved = { ...process.env };
  const mocks = installMcpAccessMocks();
  const logMessages: string[] = [];
  const logger = { log: console.log, warn: console.warn, error: console.error };
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const capture = (write: typeof process.stdout.write): typeof process.stdout.write => ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    logMessages.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return typeof encoding === 'function' ? write(chunk, encoding) : write(chunk, encoding, callback);
  }) as typeof process.stdout.write;
  process.stdout.write = capture(stdout); process.stderr.write = capture(stderr);
  const requests: string[] = [];
  const discovery: string[] = [];
  let exchanges = 0;
  let metadataGate: Promise<void> | null = null;
  let metadataEntered: (() => void) | undefined;
  let releaseMetadata: (() => void) | undefined;
  const handler = createMcpHandler(fixtureMcpServer, { legacy: 'reject' });
  let base = '';
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', base);
    discovery.push(url.pathname);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] })); return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      metadataEntered?.(); await metadataGate;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] })); return;
    }
    if (url.pathname === '/token') {
      exchanges++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'fixture-oauth-new', token_type: 'Bearer', expires_in: 3600 })); return;
    }
    requests.push(req.url || '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const response = await handler.fetch(new Request(`${base}${req.url}`, {
      method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter((item): item is [string, string] => typeof item[1] === 'string')),
      ...(body ? { body } : {}),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  let rotatedRequests = 0;
  const rotatedServer = http.createServer((_req, res) => { rotatedRequests++; res.writeHead(500).end(); });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => rotatedServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address(); const rotatedAddr = rotatedServer.address(); assert(addr && typeof addr === 'object' && rotatedAddr && typeof rotatedAddr === 'object');
  base = `http://127.0.0.1:${addr.port}`;
  const rotatedBase = `http://127.0.0.1:${rotatedAddr.port}`;
  let manager: typeof import('../app/lib/mcp/manager') | undefined;
  try {
    process.env.CANVAS_DATA_ROOT = root;
    for (const key of ['DATA', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY']) delete process.env[key];
    process.env.CANVAS_SECRETS_MASTER_KEY = 'fixture-unified-url-args-master-key';
    process.env.MCP_ALLOW_STDIO = 'true'; process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true'; process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
    process.env.BASE_URL = 'http://localhost:3000'; process.env.BETTER_AUTH_URL = 'http://localhost:3000';
    for (const user of ['alice', 'bob', 'absent', 'recovery']) mocks.memberships.set(user, { organizationId: 'fixture-org', role: 'admin', status: 'active' });
    const config = await import('../app/lib/mcp/config');
    const env = await import('../app/lib/secrets/unified-env-store');
    const scopedEnv = await import('../app/lib/integrations/env-config');
    const identity = await import('../app/lib/mcp/connection-identity');
    const runtime = await import('../app/lib/mcp/env-runtime');
    const credentials = await import('../app/lib/mcp/credential-storage');
    const oauth = await import('../app/lib/mcp/oauth');
    const { MCP_SYSTEM_SCOPE } = await import('../app/lib/mcp/scope');
    const mcpManager = await import('../app/lib/mcp/manager');
    manager = mcpManager;
    const alice = { userId: 'alice' }; const bob = { userId: 'bob' };
    const urlId = crypto.randomUUID(); const argsId = crypto.randomUUID(); const oauthId = crypto.randomUUID();
    const httpUrl = `${base}/mcp?access_token=fixture-http-literal&region=eu`;
    const rawArgs = ['--import', 'tsx', path.resolve('scripts/mcp-unified-url-args-test.ts'), '--credential-child', '--region', 'eu', '--api-key', 'fixture-cli-literal', '--token=fixture-equals-literal', 'PASSWORD=fixture-assignment-literal', '-H', 'Authorization: Bearer fixture-header-literal', `${base}/mcp?api_key=fixture-url-arg`, `--url=${base}/mcp?token=fixture-url-equals`, '--password', 'prefix-${SOURCE}', '--key', 'fixture-cli-key', '--key=fixture-cli-key-equals'];
    const source: Record<string, McpServerConfig> = {
      remote: { schemaVersion: 1, connectionId: urlId, ownerUserId: 'alice', organizationId: null, authVersion: 1, url: httpUrl, auth: 'none' },
      cli: { schemaVersion: 1, connectionId: argsId, ownerUserId: 'alice', organizationId: null, authVersion: 1, command: process.execPath, args: rawArgs, auth: 'none' },
      oauth: { schemaVersion: 1, connectionId: oauthId, ownerUserId: 'alice', organizationId: null, authVersion: 1, url: httpUrl, auth: 'oauth', oauth: { clientId: 'fixture-client' } },
      safe: { url: `${base}/ordinary?region=eu`, args: ['--region', 'eu', '--tokenizer', 'ordinary'] },
      keyQuery: { url: `${base}/mcp?key=fixture-query-key-literal` },
      embedded: { url: `https://fixture-user:fixture-password@127.0.0.1:${addr.port}/mcp` },
    };
    const fixture = async (file: string, value: unknown) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 }); };
    await scopedEnv.replaceScopedEnvEntries('integrations', [{ key: 'SOURCE', value: 'integration-value' }], alice);
    await scopedEnv.replaceScopedEnvEntries('agents', [{ key: 'SOURCE', value: 'agent-value' }], alice);
    await env.patchUnifiedEnvEntries([{ key: 'MCP_CREDENTIAL_KEY', value: 'fixture-inner-mcp-encryption-key-32bytes' }], { secretScope: 'system' });
    const urlKey = mcpLiteralEnvKey(urlId, 'url', 'url');
    await env.patchUnifiedEnvEntries([{ key: urlKey, value: `${rotatedBase}/mcp?access_token=fixture-bob-decoy` }], bob);
    await env.patchUnifiedEnvEntries([{ key: urlKey, value: `${rotatedBase}/mcp?access_token=fixture-system-decoy` }], { secretScope: 'system' });
    await credentials.writeMcpCredentialJson(`connections/${oauthId}/tokens.json`, {
      connectionId: oauthId, ownerUserId: 'alice', organizationId: null, authVersion: 1, lifecycleGeneration: 0, configHash: identity.hashMcpAuthConfig(source.oauth),
      serverUrl: httpUrl, issuer: base, resource: `${base}/mcp`, clientId: 'fixture-client', tokenType: 'Bearer', accessToken: 'fixture-old-oauth', expiresAt: '2035-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }, alice);
    await fixture(config.resolveMcpConfigPath(alice), { mcpServers: source });
    const migrated = await config.readMcpConfig(alice);
    const raw = await fs.readFile(config.resolveMcpConfigPath(alice), 'utf8');
    assert.equal((await runtime.resolveMcpTransportValues(migrated.mcpServers.keyQuery, alice)).url, source.keyQuery.url);
    assert.match(migrated.mcpServers.keyQuery.url!, /^\$\{CANVAS_MCP_/);
    assert.equal(raw.includes('fixture-query-key-literal'), false);
    assert.equal(migrated.mcpServers.remote.url, `\${${urlKey}}`);
    assert.deepEqual(migrated.mcpServers.safe.args, source.safe.args); assert.equal(migrated.mcpServers.safe.url, source.safe.url);
    for (const value of ['fixture-http-literal', 'fixture-cli-literal', 'fixture-equals-literal', 'fixture-assignment-literal', 'fixture-header-literal', 'fixture-url-arg', 'fixture-url-equals', 'fixture-user', 'fixture-password', 'fixture-cli-key', 'fixture-cli-key-equals']) assert.equal(raw.includes(value), false);
    assert.equal((await fs.readFile(env.getUnifiedEnvFilePath(alice), 'utf8')).includes('fixture-cli-literal'), false, 'durable values use unified encryption');
    assert.equal(identity.hashMcpAuthConfig(migrated.mcpServers.oauth), identity.hashMcpAuthConfig(source.oauth));
    assert.equal((await oauth.getMcpOAuthStatus('oauth', 'http://localhost:3000', alice)).authorized, true, 'legacy literal URL token remains bound to same resolved target');
    assert.equal(await oauth.getValidMcpAccessToken('oauth', migrated.mcpServers.oauth, '', alice), 'fixture-old-oauth');
    assert.equal((await runtime.resolveMcpTransportValues(migrated.mcpServers.remote, alice)).url, httpUrl);
    const expandedArgs = (await runtime.resolveMcpTransportValues(migrated.mcpServers.cli, alice)).args;
    assert.deepEqual(expandedArgs, rawArgs.map(arg => arg === 'prefix-${SOURCE}' ? 'prefix-agent-value' : arg));
    assert.equal(mcpConfigUsesChangedEnv(migrated.mcpServers.cli, new Set(['SOURCE']), await runtime.readMcpAvailableEnv(alice)), true);
    await mcpManager.listMcpTools('remote', { scope: alice });
    assert(requests.some(request => request.includes('access_token=fixture-http-literal')));
    const result = await mcpManager.callMcpTool('cli', 'args', {}, undefined, alice);
    const actualArgs = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.deepEqual(actualArgs, expandedArgs.slice(expandedArgs.indexOf('--credential-child') + 1), 'real stdio child receives resolved credentials');
    assert.equal(rotatedRequests, 0, 'other owner/system decoys are not used');
    await assert.rejects(() => mcpManager.listMcpTools('embedded', { scope: alice }), /embedded credentials/);
    const revision = (await env.readUnifiedEnvState(alice)).revision;
    await config.readMcpConfig(alice); assert.equal((await env.readUnifiedEnvState(alice)).revision, revision);
    await env.patchUnifiedEnvEntries([{ key: urlKey, value: `${base}/mcp?access_token=fixture-http-rotated` }], alice);
    await mcpManager.closeMcpServersForScope(alice, [urlKey]);
    const status = await mcpManager.getMcpRuntimeStatus(undefined, alice);
    assert.equal(status.servers.find(server => server.name === 'remote')?.connected, false);
    assert.equal(status.servers.find(server => server.name === 'cli')?.connected, true, 'unrelated clients remain connected');
    await mcpManager.listMcpTools('remote', { scope: alice }); assert(requests.some(request => request.includes('fixture-http-rotated')));
    const pending = await oauth.startMcpOAuth('oauth', 'http://localhost:3000', alice);
    const pendingUrlKey = migrated.mcpServers.oauth.url!.slice(2, -1);
    await env.patchUnifiedEnvEntries([{ key: pendingUrlKey, value: `${rotatedBase}/mcp?key=fixture-pending-rotation` }], alice);
    const beforeExchange = exchanges;
    await assert.rejects(() => oauth.completeMcpOAuthCallback('pending-code', pending.state, undefined, alice), /authorization target changed/);
    assert.equal(exchanges, beforeExchange, 'pending target rotation is rejected before token exchange');
    await env.patchUnifiedEnvEntries([{ key: pendingUrlKey, value: httpUrl }], alice);
    const started = await oauth.startMcpOAuth('oauth', 'http://localhost:3000', alice);
    assert(discovery.includes('/.well-known/oauth-protected-resource/mcp'), 'OAuth discovery resolves canonical URL refs');
    const completed = await oauth.completeMcpOAuthCallback('fixture-code', started.state, undefined, alice);
    assert.equal(completed.serverUrl, httpUrl, 'new token binds actual resolved target rather than mutable reference');
    const oauthUrlKey = migrated.mcpServers.oauth.url!.slice(2, -1);
    await env.patchUnifiedEnvEntries([{ key: oauthUrlKey, value: `  ${httpUrl}  ` }], alice);
    assert.equal((await oauth.getMcpOAuthStatus('oauth', 'http://localhost:3000', alice)).authorized, true, 'binding uses the same URL trimming as the transport');
    const expired = { ...completed, accessToken: 'fixture-expired-before-refresh', refreshToken: 'fixture-refresh-token', expiresAt: '2020-01-01T00:00:00.000Z' };
    await credentials.writeMcpCredentialJson(`connections/${oauthId}/tokens.json`, expired, alice);
    const entered = new Promise<void>(resolve => { metadataEntered = resolve; });
    metadataGate = new Promise<void>(resolve => { releaseMetadata = resolve; });
    const refresh = oauth.getValidMcpAccessToken('oauth', migrated.mcpServers.oauth, '', alice);
    const rejectedRefresh = assert.rejects(refresh, /authorization target changed/);
    await entered;
    const exchangesBeforeDrift = exchanges;
    await env.patchUnifiedEnvEntries([{ key: oauthUrlKey, value: `${rotatedBase}/mcp?key=fixture-refresh-rotation` }], alice);
    releaseMetadata!(); await rejectedRefresh; metadataGate = null; metadataEntered = undefined;
    assert.equal(exchanges, exchangesBeforeDrift, 'refresh detects target drift after metadata before sending token request');
    assert.deepEqual(await credentials.readMcpCredentialJson(`connections/${oauthId}/tokens.json`, alice), JSON.parse(JSON.stringify(expired)), 'drift does not publish refreshed credentials');
    await env.patchUnifiedEnvEntries([{ key: oauthUrlKey, value: `${rotatedBase}/mcp?access_token=fixture-other-host` }], alice);
    assert.equal((await oauth.getMcpOAuthStatus('oauth', 'http://localhost:3000', alice)).authorized, false);
    await assert.rejects(() => oauth.getValidMcpAccessToken('oauth', migrated.mcpServers.oauth, '', alice), /requires OAuth authorization/);
    assert.equal(rotatedRequests, 0, 'old authorization never reaches a rotated URL host');
    const absent = { userId: 'absent' }; process.env.ONLY_OTHER_OWNER = `${base}/mcp`;
    await env.patchUnifiedEnvEntries([{ key: 'ONLY_OTHER_OWNER', value: `${base}/mcp` }], bob);
    await env.patchUnifiedEnvEntries([{ key: 'ONLY_OTHER_OWNER', value: `${base}/mcp` }], { secretScope: 'system' });
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { absent: { url: '${ONLY_OTHER_OWNER}' } } }), absent);
    await assert.rejects(() => mcpManager.listMcpTools('absent', { scope: absent }), /Missing MCP environment variable.*ONLY_OTHER_OWNER.*tab=secrets/);
    const systemUrl = `${base}/mcp?api_key=fixture-system-literal`;
    await fixture(config.resolveMcpConfigPath(MCP_SYSTEM_SCOPE), { mcpServers: { system: { url: systemUrl, command: process.execPath, args: rawArgs.slice(0, 8) } } });
    const system = (await config.readMcpConfig(MCP_SYSTEM_SCOPE)).mcpServers.system;
    assert.equal((await runtime.resolveMcpTransportValues(system, MCP_SYSTEM_SCOPE)).url, systemUrl);
    assert.equal((await fs.readFile(config.resolveMcpConfigPath(MCP_SYSTEM_SCOPE), 'utf8')).includes('fixture-system-literal'), false);
    await mcpManager.callMcpTool('system', 'args', {}, undefined, MCP_SYSTEM_SCOPE);
    const recovery = { userId: 'recovery' }; const recoveryId = crypto.randomUUID(); const recoveryKey = mcpLiteralEnvKey(recoveryId, 'url', 'url');
    const recoverySource = { schemaVersion: 1, connectionId: recoveryId, ownerUserId: 'recovery', url: `${base}/mcp?token=fixture-recovery-old` };
    const recoveryFile = config.resolveMcpConfigPath(recovery); await fixture(recoveryFile, { mcpServers: { recovery: recoverySource } });
    const rename = fs.rename; fs.rename = async (from, to) => { if (to === recoveryFile) throw new Error('Injected URL config publish failure'); return rename(from, to); };
    try { await assert.rejects(() => config.readMcpConfig(recovery), /Injected URL config publish failure/); } finally { fs.rename = rename; }
    await env.patchUnifiedEnvEntries([{ key: recoveryKey, value: `${base}/mcp?token=fixture-recovery-authoritative` }], recovery);
    const recovered = (await config.readMcpConfig(recovery)).mcpServers.recovery;
    assert.equal(recovered.url, `\${${recoveryKey}}`); assert.equal((await runtime.resolveMcpTransportValues(recovered, recovery)).url, `${base}/mcp?token=fixture-recovery-authoritative`);
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { recovery: { ...recovered, url: `${base}/mcp?token=fixture-explicit-update` } } }), recovery);
    assert.equal(env.readUnifiedSecretValue(recoveryKey, recovery), `${base}/mcp?token=fixture-explicit-update`);
    assert(hasMcpCredentialUrl('https://example.test/mcp?api_key=literal'));
    assert(hasMcpCredentialUrl('https://example.test/mcp?key=literal'));
    assert.deepEqual([...mcpCredentialArgIndices(['--header', 'x-api-key: fixture-header-key-literal'])], [1]);
    assert.equal(hasMcpCredentialUrl('https://example.test/mcp?token=${TOKEN}'), false);
    assert.deepEqual([...mcpCredentialArgIndices(['--tokenizer', 'safe', '--api-key', '${KEY}', '--header=Authorization: Bearer literal'])], [4]);
    assert(logMessages.some(message => message.includes('Connecting HTTP server')), 'the real transport logger is captured');
    for (const message of logMessages) assert.equal(/fixture-(?:http|cli|equals|assignment|header|url|password|user|other-host)/.test(message), false, 'transport logs retain canonical metadata without resolved credential values');
    logger.log('MCP URL/args credentials: encrypted owner migration, real stdio/HTTP resolution, safe metadata, decoy isolation, selective rotation, OAuth actual-target binding and publication recovery passed.');
  } finally {
    releaseMetadata?.();
    await manager?.closeAllMcpServers(); await handler.close();
    httpServer.closeAllConnections(); rotatedServer.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => httpServer.close(() => resolve())), new Promise<void>(resolve => rotatedServer.close(() => resolve()))]);
    process.stdout.write = stdout; process.stderr.write = stderr;
    mocks.restore(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true });
  }
}
(process.argv.includes('--credential-child') ? child() : main()).catch(error => { console.error(error); process.exitCode = 1; });
