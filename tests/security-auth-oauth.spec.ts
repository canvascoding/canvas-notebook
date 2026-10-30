import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

import { createAuthenticatedContext } from './helpers/managed-test-context';

test('OAuth PKCE consent, refresh and grant revocation work with the upgraded provider', async ({ browser }, info) => {
  test.skip(process.env.E2E_EXTERNAL_SERVER !== '1', 'Requires the managed production runtime.');
  test.setTimeout(120_000);
  const origin = process.env.BASE_URL!;
  const issuer = `${origin}/api/auth`;
  const context = await createAuthenticatedContext(browser);
  const anonymous = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(30_000);
  const callbackServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('OAuth callback received');
  });
  await new Promise<void>(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const settingsResponse = await context.request.get('/api/integrations/mcp-server');
  expect(settingsResponse.status()).toBe(200);
  const original = (await settingsResponse.json()).data;
  const originalTools = original.capabilities.filter((tool: { enabled: boolean; available: boolean }) => tool.enabled && tool.available)
    .map((tool: { id: string }) => tool.id);
  const call = (token?: string) => anonymous.request.post(`${origin}/mcp`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'auth_probe' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'auth_probe', arguments: {},
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'dependency-security-acceptance', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {} } } },
  });
  try {
    expect((await context.request.patch('/api/integrations/mcp-server', {
      data: { enabled: true, tools: ['auth_probe', 'list_workspaces'] },
    })).status()).toBe(200);
    expect((await call()).status()).toBe(401);
    const redirectUri = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
    const registration = await anonymous.request.post(`${issuer}/oauth2/register`, {
      data: { client_name: 'Dependency security acceptance', application_type: 'native', redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], scope: 'openid offline_access workspace:list' },
    });
    expect(registration.status()).toBe(201);
    const clientId = (await registration.json()).client_id;
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const authorization = new URL(`${issuer}/oauth2/authorize`);
    authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
      response_type: 'code', scope: 'openid offline_access workspace:list', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', resource: `${origin}/mcp` }).toString();
    await page.goto(authorization.toString());
    await expect(page.locator('button[name="accept"][value="true"]')).toBeVisible();
    await page.screenshot({ path: info.outputPath('oauth-consent.png'), fullPage: true });
    await page.locator('button[name="accept"][value="true"]').click();
    await page.waitForURL(url => url.origin === new URL(redirectUri).origin && url.pathname === '/callback', { timeout: 15_000 });
    const callback = new URL(page.url());
    expect(callback.searchParams.get('state')).toBe(state);
    expect(callback.searchParams.get('code')).toBeTruthy();
    const exchanged = await anonymous.request.post(`${issuer}/oauth2/token`, { form: {
      grant_type: 'authorization_code', code: callback.searchParams.get('code')!, client_id: clientId,
      redirect_uri: redirectUri, code_verifier: verifier, resource: `${origin}/mcp`,
    } });
    expect(exchanged.status()).toBe(200);
    const first = await exchanged.json();
    expect(first.access_token).toBeTruthy();
    expect(first.refresh_token).toBeTruthy();
    expect((await call(first.access_token)).status()).toBe(200);
    const refreshed = await anonymous.request.post(`${issuer}/oauth2/token`, { form: {
      grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId, resource: `${origin}/mcp`,
    } });
    expect(refreshed.status()).toBe(200);
    const second = await refreshed.json();
    expect((await call(second.access_token)).status()).toBe(200);
    const revoked = await anonymous.request.post(`${issuer}/oauth2/revoke`, { form: {
      token: second.refresh_token || first.refresh_token, token_type_hint: 'refresh_token', client_id: clientId,
    } });
    expect(revoked.status()).toBe(200);
    expect((await call(second.access_token)).status()).toBe(401);
    for (const token of new Set([first.refresh_token, second.refresh_token].filter(Boolean))) {
      const replay = await anonymous.request.post(`${issuer}/oauth2/token`, { form: {
        grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: `${origin}/mcp`,
      } });
      expect(replay.status()).toBe(400);
    }
    expect(errors).toEqual([]);
  } finally {
    try {
      const restored = await context.request.patch('/api/integrations/mcp-server', {
        data: { enabled: original.desiredEnabled, tools: originalTools },
      });
      expect(restored.status()).toBe(200);
    } finally {
      await new Promise<void>(resolve => callbackServer.close(() => resolve()));
      await anonymous.close();
      await context.close();
    }
  }
});
