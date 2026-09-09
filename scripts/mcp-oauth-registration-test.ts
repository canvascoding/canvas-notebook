import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: 'fixture-org' }) };
  if (request.includes('organization/permissions')) return {
    readOrganizationPermissionForUser: async () => ({ configured: true, organizationId: 'fixture-org', permission: { role: 'admin', status: 'active' } }),
    assertUserOrganizationAdmin: async () => undefined,
  };
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-registration-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  let url = '';
  let releaseRegistration: (() => void) | undefined;
  let waitRegistration: Promise<void> | undefined;
  let registrations = 0;
  let exchanges = 0;
  let tokenResponse: Record<string, unknown> = { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 };
  const revocations: string[] = [];
  const fixture = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/.well-known/oauth-protected-resource/mcp') {
      response.end(JSON.stringify({ resource: `${url}/mcp`, authorization_servers: [url] }));
    } else if (request.url === '/.well-known/oauth-authorization-server') {
      response.end(JSON.stringify({ issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, registration_endpoint: `${url}/register`, revocation_endpoint: `${url}/revoke`, code_challenge_methods_supported: ['S256'] }));
    } else if (request.url === '/register') {
      registrations += 1;
      await waitRegistration;
      response.end(JSON.stringify({ client_id: `client-${registrations}`, client_secret: 'test-secret' }));
    } else if (request.url === '/token') {
      exchanges += 1;
      response.end(JSON.stringify(tokenResponse));
    } else if (request.url === '/revoke') {
      revocations.push(new URLSearchParams(body).get('token') || '');
      response.statusCode = 503; // Local disconnect still succeeds when revocation fails.
      response.end('{}');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert(address && typeof address === 'object');
  url = `http://127.0.0.1:${address.port}`;
  const scope = { userId: 'registration-user' };
  const { writeMcpConfigRaw, readMcpConfig, setMcpServerEnabled } = await import('../app/lib/mcp/config');
  const { startMcpOAuth, completeMcpOAuthCallback, clearMcpOAuth, getMcpOAuthStatus, getValidMcpAccessToken } = await import('../app/lib/mcp/oauth');
  const { readMcpOAuthLifecycle, invalidateMcpOAuthGeneration } = await import('../app/lib/mcp/oauth-lifecycle');
  const { readMcpCredentialJson, writeMcpCredentialJson } = await import('../app/lib/mcp/credential-storage');
  const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');
  const { closeAllMcpServers } = await import('../app/lib/mcp/manager');
  async function until(check: () => Promise<boolean> | boolean) {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await delay(20);
    }
    throw new Error('OAuth fixture did not reach the expected barrier.');
  }
  try {
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { remote: { url: `${url}/mcp`, auth: 'oauth', oauth: { issuer: url } } } }), scope);
    const connection = (await readMcpConfig(scope)).mcpServers.remote as import('../app/lib/mcp/config').McpServerConfig & { connectionId: string };
    const tokenPath = `connections/${connection.connectionId}/tokens.json`;
    const clientPath = `connections/${connection.connectionId}/client.json`;
    waitRegistration = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const started = startMcpOAuth('remote', 'http://localhost:3000', scope);
    const rejectedStart = assert.rejects(started, /invalidated|changed/i);
    await until(() => registrations === 1);
    const clearing = clearMcpOAuth('remote', scope);
    await until(async () => (await readMcpOAuthLifecycle(connection.connectionId, scope)).generation === 1);
    releaseRegistration!();
    await Promise.all([clearing, rejectedStart]);
    assert.equal(await readMcpCredentialJson(clientPath, scope), null, 'DCR completed after disconnect cannot persist a client');
    waitRegistration = undefined;

    const cutoff = (await invalidateMcpOAuthGeneration(connection.connectionId, scope)).generation;
    const fresh = await startMcpOAuth('remote', 'http://localhost:3000', scope);
    const token = await completeMcpOAuthCallback('new-code', fresh.state, undefined, scope);
    await clearMcpOAuth(connection.connectionId, scope, { connectionSnapshot: connection, alreadyInvalidated: true, invalidatedGeneration: cutoff });
    assert.deepEqual(await readMcpCredentialJson(tokenPath, scope), JSON.parse(JSON.stringify(token)), 'delayed cleanup must preserve a newer authorization');
    assert.deepEqual(revocations, [], 'delayed cleanup must not revoke a newer token');
    await clearMcpOAuth('remote', scope);
    assert.equal(await readMcpCredentialJson(tokenPath, scope), null);
    assert.deepEqual(revocations.sort(), ['access', 'refresh']);

    const pending = await startMcpOAuth('remote', 'http://localhost:3000', scope);
    await setMcpServerEnabled('remote', false, scope);
    const priorExchanges = exchanges;
    await assert.rejects(completeMcpOAuthCallback('disabled-code', pending.state, undefined, scope), /changed|disabled|no longer matches/i);
    assert.equal(exchanges, priorExchanges, 'disabled callback must be rejected before token exchange');
    await setMcpServerEnabled('remote', true, scope);

    for (const invalid of [{ token_type: 'DPoP' }, { expires_in: -1 }, { expires_in: '3600' }, { access_token: '' }]) {
      tokenResponse = { access_token: 'access', token_type: 'Bearer', expires_in: 3600, ...invalid };
      const flow = await startMcpOAuth('remote', 'http://localhost:3000', scope);
      await assert.rejects(completeMcpOAuthCallback('invalid-code', flow.state, undefined, scope), /invalid token response/i);
      assert.equal(await readMcpCredentialJson(tokenPath, scope), null);
    }
    tokenResponse = { access_token: 'expired', token_type: 'Bearer', expires_in: 0 };
    const zeroFlow = await startMcpOAuth('remote', 'http://localhost:3000', scope);
    const zero = await completeMcpOAuthCallback('zero-code', zeroFlow.state, undefined, scope);
    assert(Date.parse(zero.expiresAt!) <= Date.now());
    assert.equal((await getMcpOAuthStatus('remote', undefined, scope)).authorized, false);
    await writeMcpCredentialJson(tokenPath, { ...zero, refreshToken: 'still-refreshable', expiresAt: 'invalid-date' }, scope);
    assert.equal((await getMcpOAuthStatus('remote', undefined, scope)).authStatus, 'authorized', 'refreshable expiry must not require login');
    tokenResponse = { access_token: 'no-expiry', token_type: 'Bearer' };
    const config = (await readMcpConfig(scope)).mcpServers.remote;
    assert.equal(await getValidMcpAccessToken('remote', config, hashMcpAuthConfig(config), scope), 'no-expiry');
    assert.equal((await readMcpCredentialJson<{ expiresAt?: string }>(tokenPath, scope))?.expiresAt, undefined, 'a refreshed token must not inherit the old expiry');
    const latest = await readMcpConfig(scope);
    latest.mcpServers.wrongIssuer = { url: `${url}/mcp`, auth: 'oauth', oauth: { issuer: `${url}/invalid-issuer`, clientId: 'fixture' } };
    await writeMcpConfigRaw(JSON.stringify(latest), scope);
    await assert.rejects(startMcpOAuth('wrongIssuer', 'http://localhost:3000', scope), /discovery|issuer/i, 'an explicit issuer must never silently fall back to another issuer');
    console.log('mcp-oauth-registration-test: ok');
  } finally {
    releaseRegistration?.();
    await closeAllMcpServers();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
