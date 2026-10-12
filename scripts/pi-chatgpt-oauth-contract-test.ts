import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { NextRequest } from 'next/server';

// Real Pi OAuth, credential storage and HTTP handlers; only session and token transport are fixtures.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-chatgpt-contract-'));
  const previousRoot = process.env.CANVAS_DATA_ROOT;
  const originalFetch = globalThis.fetch;
  process.env.CANVAS_DATA_ROOT = root;
  let subject = 'oauth-owner-a';
  let tokenRequests = 0;
  let refreshGate: Promise<void> | null = null;
  const refreshStarted = Promise.withResolvers<void>();
  const children: ChildProcess[] = [];
  const internals = Module as unknown as { _load: (name: string, parent?: unknown, isMain?: boolean) => unknown };
  const originalLoad = internals._load;
  const fixturePath = path.join(root, 'token-transport.mjs');
  const transportSource = `
import assert from 'node:assert/strict';
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/token');
  const body = new URLSearchParams(options.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'fixture-issued-client');
  assert.equal(body.get('code'), 'fixture-code');
  assert.ok(body.get('code_verifier'));
  assert.equal(body.get('resource'), 'https://api.openai.com/v1');
  return Response.json({access_token:'fixture-child-access',refresh_token:'fixture-child-refresh',expires_in:3600,scope:'openid chatgpt.tokens.use.direct',id_token:'fixture-id'});
};
`;
  await fs.writeFile(fixturePath, transportSource);
  internals._load = function (name, parent, isMain) {
    if (name === 'server-only') return {};
    if (name.endsWith('/app/lib/auth') || name === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: subject } }) } } };
    if (name === 'child_process') return { spawn: (command: string, args: string[], options: object) => {
      const child = spawn(command, ['--import', fixturePath, ...args], options);
      children.push(child); return child;
    } };
    return originalLoad.call(this, name, parent, isMain);
  };
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), 'https://auth.openai.com/api/accounts/oauth/token', 'no live provider requests');
    const body = new URLSearchParams(options?.body as string);
    assert.equal(body.get('client_id'), 'fixture-issued-client');
    assert.equal(body.get('resource'), 'https://api.openai.com/v1');
    tokenRequests++;
    if (body.get('grant_type') === 'refresh_token') {
      refreshStarted.resolve();
      if (refreshGate) await refreshGate;
    } else {
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'fixture-code');
      assert.ok(body.get('code_verifier'));
    }
    return Response.json({ access_token: `fixture-access-${tokenRequests}`, refresh_token: `fixture-refresh-${tokenRequests}`,
      expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', id_token: 'fixture-id' });
  };
  try {
    const oauth = await import('../app/lib/pi/oauth');
    const secrets = await import('../app/lib/integrations/env-config');
    const policy = await import('../app/lib/agent-runtime-policy/provider-auth-policy');
    const help = await import('../app/lib/pi/provider-help');
    assert.equal(help.getAuthMethodForProvider('openai'), 'both');
    assert.deepEqual(policy.getAllowedCredentialScopesForProvider('openai', 'oauth'), ['user']);
    assert.deepEqual(policy.getAllowedCredentialScopesForProvider('openai', 'api-key'), ['system', 'organization', 'user']);
    assert.equal(policy.validateProviderCatalogAuth({ providerId: 'openai', credentialScope: 'organization', config: { authMethod: 'oauth' } }), 'OAUTH_REQUIRES_USER_SCOPE');
    assert.equal(oauth.isOAuthProvider('openai'), true);
    assert.ok(help.getVisibleOAuthProviders().includes('openai-codex'));
    const deviceIds = await Promise.all(Array.from({ length: 5 }, () => oauth.getOrCreatePiOAuthDeviceId()));
    assert.equal(new Set(deviceIds).size, 1, 'concurrent login retains one installation UUID');
    const deviceId = deviceIds[0];
    assert.match(deviceId, /^[0-9a-f-]{36}$/);
    const systemRevision = (await secrets.readUnifiedEnvState({ secretScope: 'system' })).revision;
    assert.equal(await oauth.getOrCreatePiOAuthDeviceId(), deviceId);
    assert.equal((await secrets.readUnifiedEnvState({ secretScope: 'system' })).revision, systemRevision);
    const owner = { userId: subject };
    await oauth.saveProviderCredentials('openai-codex', { access: 'fixture-legacy-access', refresh: 'fixture-legacy-refresh', expires: Date.now() + 3_600_000 }, owner);
    let redirect = '';
    const login = (invalidState = false) => oauth.initiateOAuthLogin('openai', value => {
      const url = new URL(value);
      assert.equal(url.searchParams.get('ext_agent_host_id'), `urn:uuid:${deviceId}`);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ code: 'fixture-code', state: invalidState ? 'wrong-state' : url.searchParams.get('state')!, client_id: 'fixture-issued-client' }).toString();
      redirect = callback.toString();
    }, async () => redirect, undefined, owner);
    await login();
    const initial = oauth.getProviderCredentials('openai', owner)!;
    assert.equal(initial.clientId, 'fixture-issued-client');
    assert.deepEqual(initial.scopes, ['openid', 'chatgpt.tokens.use.direct']);
    assert.equal((await oauth.getProviderRequestAuth('openai', owner))?.apiKey, initial.access);
    assert.equal(oauth.getProviderCredentials('openai', { userId: 'oauth-owner-b' }), null);
    assert.equal(oauth.getProviderCredentials('openai-codex', owner)?.access, 'fixture-legacy-access');
    const requestsBefore = tokenRequests;
    await assert.rejects(() => login(true), /state mismatch/);
    assert.equal(tokenRequests, requestsBefore, 'invalid state cannot exchange a token');
    assert.equal(oauth.getProviderCredentials('openai', owner)?.access, initial.access);
    await oauth.saveProviderCredentials('openai', { ...initial, expires: 1 }, owner);
    const connectionId = oauth.getProviderConnectionId('openai', owner);
    const releaseRefresh = Promise.withResolvers<void>();
    refreshGate = releaseRefresh.promise;
    const controller = new AbortController();
    const refreshing = oauth.getProviderRequestAuth('openai', owner, { signal: controller.signal }).catch(() => null);
    await refreshStarted.promise;
    controller.abort(); releaseRefresh.resolve(); await refreshing;
    for (let i = 0; i < 50 && oauth.getProviderCredentials('openai', owner)?.refresh === initial.refresh; i++) await delay(20);
    assert.notEqual(oauth.getProviderCredentials('openai', owner)?.refresh, initial.refresh, 'started refresh persists rotated token despite cancellation');
    assert.equal(oauth.getProviderConnectionId('openai', owner), connectionId);
    assert.equal(oauth.getProviderCredentials('openai', owner)?.clientId, initial.clientId);

    const initiate = await import('../app/api/oauth/pi/initiate/route');
    const exchange = await import('../app/api/oauth/pi/exchange/route');
    const status = await import('../app/api/oauth/pi/status/route');
    const request = (url: string, body: object) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const started = await initiate.POST(request('/api/oauth/pi/initiate', { provider: 'openai' }));
    assert.equal(started.status, 200);
    const flow = await started.json();
    assert.equal(flow.success, true);
    const flowDir = path.join(root, 'users', subject, 'settings/pi-oauth-states');
    let state: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      state = JSON.parse(await fs.readFile(path.join(flowDir, `${flow.flowId}.json`), 'utf8'));
      if (state.authUrl) break;
      if (state.status === 'failed') assert.fail(state.error);
      await delay(100);
    }
    const url = new URL(state.authUrl);
    assert.equal(url.searchParams.get('ext_agent_host_id'), `urn:uuid:${deviceId}`, 'background login uses the same durable installation ID');
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ code: 'fixture-code', state: url.searchParams.get('state')!, client_id: 'fixture-issued-client' }).toString();
    subject = 'oauth-owner-b';
    assert.equal((await exchange.POST(request('/api/oauth/pi/exchange', { flowId: flow.flowId, provider: 'openai', code: callback.toString() }))).status, 404, 'another user cannot complete the flow');
    subject = owner.userId;
    const completed = await exchange.POST(request('/api/oauth/pi/exchange', { flowId: flow.flowId, provider: 'openai', code: callback.toString() }));
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).success, true, 'generated script preserves full manual callback URL');
    const childCredential = oauth.getProviderCredentials('openai', owner)!;
    assert.equal(childCredential.access, 'fixture-child-access');
    assert.equal(childCredential.clientId, 'fixture-issued-client');
    assert.equal(oauth.getProviderCredentials('openai-codex', owner)?.access, 'fixture-legacy-access');
    const statuses = await (await status.GET(new NextRequest('http://localhost/api/oauth/pi/status'))).json();
    assert.ok(statuses.providers.some((entry: { provider: string; connected: boolean }) => entry.provider === 'openai' && entry.connected));
    assert.ok(statuses.providers.some((entry: { provider: string; connected: boolean }) => entry.provider === 'openai-codex' && entry.connected));
    await oauth.removeProviderCredentials('openai', owner);
    assert.equal(await oauth.getOrCreatePiOAuthDeviceId(), deviceId, 'disconnect does not rotate installation identity');
    console.log('ChatGPT OAuth real SDK, background callback, refresh and owner isolation contracts passed');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    internals._load = originalLoad; globalThis.fetch = originalFetch;
    if (previousRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
