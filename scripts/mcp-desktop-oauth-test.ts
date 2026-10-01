import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import { installMcpAccessMocks } from './fixtures/mcp-test-access';

function request(url: string, userId?: string, init: RequestInit = {}): NextRequest {
  const { signal: _signal, ...options } = init;
  const headers = new Headers(init.headers);
  if (userId) headers.set('x-test-user', userId);
  if (init.body) headers.set('Content-Type', 'application/json');
  return new NextRequest(url, { ...options, headers });
}

async function main(): Promise<void> {
  const originalEnv = { ...process.env };
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-desktop-oauth-'));
  const access = installMcpAccessMocks();
  const mutableMembership = { organizationId: 'fixture-org', role: 'admin' as const, status: 'active' as const };
  for (const userId of ['alice', 'bob']) access.memberships.set(userId, { ...mutableMembership });
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === '@/app/lib/auth' || /(?:^|\/)app\/lib\/auth$/u.test(name)) return {
      auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
        const userId = headers.get('x-test-user');
        return userId && ['alice', 'bob'].includes(userId) ? { user: { id: userId } } : null;
      } } },
    };
    return originalLoad(name, parent, isMain);
  };
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.BASE_URL = 'http://canvas.test';
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
  delete process.env.CANVAS_SECRETS_MASTER_KEY;
  delete process.env.MCP_OAUTH_BASE_URL;
  let providerOrigin = '';
  let exchanges = 0;
  let releaseExchange: () => void = () => undefined;
  let exchangeEntered: (() => void) | null = null;
  let delayExchange = false;
  const fixture = http.createServer(async (req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ issuer: providerOrigin, authorization_endpoint: `${providerOrigin}/authorize`, token_endpoint: `${providerOrigin}/token`, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true }));
      return;
    }
    if (req.url === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), 'http://canvas.test/api/mcp/oauth/callback');
      assert.ok(form.get('code_verifier'));
      exchanges++;
      if (delayExchange) {
        exchangeEntered?.();
        await new Promise<void>(resolve => { releaseExchange = resolve; });
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ access_token: `desktop-token-${exchanges}`, refresh_token: 'desktop-refresh-fixture', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    res.statusCode = 404;
    res.end('fixture not found');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== 'string');
  providerOrigin = `http://127.0.0.1:${address.port}`;
  const originalNow = Date.now;
  try {
    const oauth = await import('../app/lib/mcp/oauth');
    const desktop = await import('../app/lib/mcp/desktop-oauth');
    const config = await import('../app/lib/mcp/config');
    const credentials = await import('../app/lib/mcp/credential-storage');
    const storage = await import('../app/lib/mcp/storage');
    const lifecycle = await import('../app/lib/mcp/oauth-lifecycle');
    const callbackRoute = await import('../app/api/mcp/oauth/callback/route');
    const desktopRoute = await import('../app/api/mcp/oauth/desktop/route');
    const statusRoute = await import('../app/api/integrations/mcp-status/route');
    const writeConfig = async (extra = {}, serverName = 'remote') => config.writeMcpConfigRaw(JSON.stringify({ mcpServers: {
      [serverName]: { url: `${providerOrigin}/mcp`, auth: 'oauth', oauth: { issuer: providerOrigin, clientId: 'desktop-client' }, ...extra },
    } }), { userId: 'alice' });
    await writeConfig();
    const connectionId = (await config.readMcpConfig({ userId: 'alice' })).mcpServers.remote.connectionId!;
    const start = () => oauth.startMcpOAuth('remote', 'http://canvas.test', { userId: 'alice' }, { desktop: true });
    const callback = (state: string, actor?: string, error?: string, issuer: string | null = providerOrigin) => {
      const url = new URL('http://canvas.test/api/mcp/oauth/callback');
      url.searchParams.set('state', state);
      if (error) url.searchParams.set('error', error); else url.searchParams.set('code', 'desktop-code-fixture');
      if (issuer) url.searchParams.set('iss', issuer);
      return callbackRoute.GET(request(url.toString(), actor));
    };
    const post = (state: string, actor?: string, action = 'finalize') => desktopRoute.POST(request('http://canvas.test/api/mcp/oauth/desktop', actor, { method: 'POST', body: JSON.stringify({ state, action }) }));
    const get = (state: string, actor?: string) => desktopRoute.GET(request(`http://canvas.test/api/mcp/oauth/desktop?state=${encodeURIComponent(state)}`, actor));
    const startedResponse = await statusRoute.POST(request('http://canvas.test/api/integrations/mcp-status', 'alice', { method: 'POST', body: JSON.stringify({ action: 'authorize', server: 'remote', desktop: true }) }));
    assert.equal(startedResponse.status, 200);
    const started = (await startedResponse.json()).data as Awaited<ReturnType<typeof start>>;
    assert.equal(started.desktop, true);
    assert.match(started.state, /^desktop_[A-Za-z0-9_-]{32}$/u);
    assert.equal(Date.parse(started.expiresAt) > Date.now() + 9 * 60_000, true);
    assert.equal((await get(started.state)).status, 401);
    assert.equal((await get(started.state, 'bob')).status, 403);
    const waiting = await (await get(started.state, 'alice')).json();
    assert.equal(waiting.data.status, 'waiting');
    assert.equal(waiting.data.authorizationUrl, started.authorizationUrl, 'IPC can verify the exact server-resolved OAuth URL');
    assert.equal((await callback(started.state)).status, 200, 'desktop callback works without any Canvas session cookie');
    assert.equal(exchanges, 0, 'public callback only collects the encrypted code');
    const received = await (await get(started.state, 'alice')).json();
    assert.equal(received.data.status, 'callback_received');
    assert.equal('authorizationUrl' in received.data, false);
    assert.doesNotMatch(JSON.stringify(received), /desktop-code-fixture|codeVerifier|desktop-refresh-fixture/u);
    assert.equal((await post(started.state)).status, 401);
    assert.equal((await post(started.state, 'bob')).status, 403);
    assert.equal(exchanges, 0);
    for (const action of [['cancel'], ['finalize'], { action: 'finalize' }, null, 0]) {
      const invalidAction = await desktopRoute.POST(request('http://canvas.test/api/mcp/oauth/desktop', 'alice', { method: 'POST', body: JSON.stringify({ state: started.state, action }) }));
      assert.equal(invalidAction.status, 400, 'desktop actions require an exact string action');
    }
    assert.equal(exchanges, 0, 'invalid cancel/finalize payloads never exchange tokens');
    const locatorPath = storage.resolveMcpStoragePath(`desktop-oauth-transactions/${crypto.createHash('sha256').update(started.state).digest('hex')}.json`, { legacy: true });
    const receivedDisk = await fs.readFile(locatorPath, 'utf8');
    const receivedRecord = await credentials.readMcpCredentialJson<Record<string, unknown>>(`desktop-oauth-transactions/${crypto.createHash('sha256').update(started.state).digest('hex')}.json`, { legacy: true });
    assert.doesNotMatch(receivedDisk, /desktop-code-fixture|codeVerifier|alice/u, 'temporary provider result stays sealed on disk');
    const finalized = await (await post(started.state, 'alice')).json();
    assert.equal(finalized.data.status, 'completed');
    assert.equal(exchanges, 1);
    assert.equal((await lifecycle.readMcpOAuthLifecycle(connectionId, { userId: 'alice' })).lastCompletedState, started.state);
    assert.equal((await post(started.state, 'alice')).status, 200, 'finalize retry is idempotent');
    assert.equal(exchanges, 1);
    await credentials.writeMcpCredentialJson(`desktop-oauth-transactions/${crypto.createHash('sha256').update(started.state).digest('hex')}.json`, receivedRecord!, { legacy: true });
    assert.equal((await post(started.state, 'alice')).status, 200, 'finalize recovers a token commit completed before its locator write');
    assert.equal(exchanges, 1, 'recovery never reuses the one-time provider code');
    assert.equal((await callback(started.state)).status, 409, 'callback cannot be replayed');
    const originalToken = await credentials.readMcpCredentialJson(`connections/${connectionId}/tokens.json`, { userId: 'alice' });
    assert.equal(await credentials.readMcpCredentialJson(`connections/${connectionId}/tokens.json`, { userId: 'bob' }), null);
    const terminalRecord = await credentials.readMcpCredentialJson<Record<string, unknown>>(`desktop-oauth-transactions/${crypto.createHash('sha256').update(started.state).digest('hex')}.json`, { legacy: true });
    assert.equal('response' in terminalRecord!, false, 'terminal state clears code, PKCE and client secrets');

    const differentBrowserAccount = await start();
    assert.equal((await callback(differentBrowserAccount.state, 'bob')).status, 200, 'an unrelated browser session never becomes the desktop owner');
    assert.equal((await post(differentBrowserAccount.state, 'bob')).status, 403);
    assert.equal((await post(differentBrowserAccount.state, 'alice')).status, 200);
    assert.equal(exchanges, 2);
    const browserFlow = await oauth.startMcpOAuth('remote', 'http://canvas.test', { userId: 'alice' });
    assert.equal((await callback(browserFlow.state)).status, 401, 'ordinary browser callbacks retain their session requirement');
    assert.ok([400, 403, 404, 503].includes((await callback(browserFlow.state, 'bob')).status), 'other-account browser callback cannot consume the owner state');
    assert.equal((await callback(browserFlow.state, 'alice')).status, 200);
    assert.equal(exchanges, 3);
    const baseline = await credentials.readMcpCredentialJson(`connections/${connectionId}/tokens.json`, { userId: 'alice' });
    assert.notDeepEqual(baseline, originalToken);

    const cancelled = await start();
    assert.equal((await callback(cancelled.state, undefined, 'access_denied')).status, 200);
    assert.equal((await desktop.getMcpDesktopOAuthStatus(cancelled.state, 'alice')).status, 'cancelled');
    assert.equal((await desktop.finalizeMcpDesktopOAuth(cancelled.state, 'alice')).status, 'cancelled');
    assert.equal(exchanges, 3);
    const explicitCancel = await start();
    const laterFlow = await start();
    await desktop.cancelMcpDesktopOAuth(explicitCancel.state, 'alice');
    assert.equal((await callback(explicitCancel.state)).status, 409);
    assert.equal((await callback(laterFlow.state)).status, 200, 'cancelling an older flow does not invalidate a newer flow');
    assert.equal((await post(laterFlow.state, 'alice')).status, 200);
    assert.equal(exchanges, 4);

    const badIssuer = await start();
    assert.equal((await callback(badIssuer.state, undefined, undefined, 'https://wrong-issuer.example')).status, 400);
    assert.equal((await desktop.getMcpDesktopOAuthStatus(badIssuer.state, 'alice')).status, 'failed');
    const missingIssuer = await start();
    assert.equal((await callback(missingIssuer.state, undefined, undefined, null)).status, 400);
    assert.equal((await desktop.getMcpDesktopOAuthStatus(missingIssuer.state, 'alice')).status, 'failed');
    const delayed = await start();
    const beganAt = originalNow();
    Date.now = () => beganAt + 120_000;
    assert.equal((await callback(delayed.state)).status, 200, 'sign-in can take more than 90 seconds');
    assert.equal((await post(delayed.state, 'alice')).status, 200);
    Date.now = originalNow;
    assert.equal(exchanges, 5);
    const expired = await start();
    Date.now = () => Date.parse(expired.expiresAt) + 1;
    assert.equal((await desktop.getMcpDesktopOAuthStatus(expired.state, 'alice')).status, 'expired');
    assert.equal((await callback(expired.state)).status, 409);
    Date.now = originalNow;
    assert.equal(exchanges, 5);

    const revoked = await start();
    assert.equal((await callback(revoked.state)).status, 200);
    access.memberships.set('alice', { ...mutableMembership, status: 'suspended' });
    assert.equal((await post(revoked.state, 'alice')).status, 403, 'finalize repeats active membership validation');
    await assert.rejects(() => desktop.finalizeMcpDesktopOAuth(revoked.state, 'alice'), { status: 403 });
    access.memberships.set('alice', { ...mutableMembership });
    assert.equal((await desktop.getMcpDesktopOAuthStatus(revoked.state, 'alice')).status, 'failed');
    assert.equal(exchanges, 5);
    const disabled = await start();
    await config.setMcpServerEnabled('remote', false, { userId: 'alice' });
    assert.equal((await callback(disabled.state)).status, 409);
    await config.setMcpServerEnabled('remote', true, { userId: 'alice' });
    const changed = await start();
    const current = (await config.readMcpConfig({ userId: 'alice' })).mcpServers.remote;
    await writeConfig({ ...current, oauth: { ...(typeof current.oauth === 'object' && current.oauth ? current.oauth : {}), scopes: ['changed'] } });
    assert.equal((await callback(changed.state)).status, 400);
    assert.equal((await desktop.getMcpDesktopOAuthStatus(changed.state, 'alice')).status, 'failed');
    const removed = await start();
    await config.writeMcpConfigRaw('{"mcpServers":{}}', { userId: 'alice' });
    assert.equal((await callback(removed.state)).status, 404);
    assert.equal(exchanges, 5);

    // Revocation while exchanging still fences the final credential write.
    await writeConfig();
    const race = await start();
    assert.equal((await callback(race.state)).status, 200);
    delayExchange = true;
    const entered = new Promise<void>(resolve => { exchangeEntered = resolve; });
    const finalizing = desktop.finalizeMcpDesktopOAuth(race.state, 'alice');
    await entered;
    access.memberships.set('alice', { ...mutableMembership, status: 'suspended' });
    releaseExchange?.();
    await assert.rejects(() => finalizing, { status: 403 });
    access.memberships.set('alice', { ...mutableMembership });
    const replacementId = (await config.readMcpConfig({ userId: 'alice' })).mcpServers.remote.connectionId!;
    assert.equal(await credentials.readMcpCredentialJson(`connections/${replacementId}/tokens.json`, { userId: 'alice' }), null, 'revoked access cannot persist exchanged tokens');
    assert.equal((await desktop.getMcpDesktopOAuthStatus(race.state, 'alice')).status, 'failed');
    assert.equal((await get('desktop_' + 'a'.repeat(32), 'alice')).status, 409, 'unknown locators have no user-scope enumeration fallback');
    assert.equal((await get('../../another-owner', 'alice')).status, 400);
    console.log('mcp-desktop-oauth-test: PASS (no browser cookie, different browser user, authenticated owner finalize, encrypted temporary code, single use, lifecycle binding, denial, expiry, >90s login, cancellation race and revoked-access exchange)');
  } finally {
    Date.now = originalNow;
    releaseExchange?.();
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    internals._load = originalLoad;
    access.restore();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
