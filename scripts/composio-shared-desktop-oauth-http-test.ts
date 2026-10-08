import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import type { SqlConnection } from '../app/lib/db';
import type { IntegrationConnectionRecord } from '../app/lib/integration-tools/connections/contracts';
import type { SharedComposioDesktopOAuthSummary } from '../app/lib/composio/composio-shared-desktop-oauth-contract';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

const BASE_URL = 'http://127.0.0.1:3001';
const ORG = 'composio-desktop-http-org';
const IDS = ['http-owner', 'http-manager', 'http-user'] as const;

async function seedAuthority(sql: SqlConnection) {
  for (const id of IDS) {
    await sql.run('INSERT INTO "user" (id,name,email,role,banned,email_verified,created_at,updated_at) VALUES ($1,$1,$2,$3,0,1,1000,1000)',
      [id, `${id}@own-desktop-http.example.test`, id === 'http-owner' ? 'admin' : 'user']);
  }
  await sql.run('INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ($1,$2,\'team\',1,1000,1000)', [ORG, IDS[0]]);
  for (const id of IDS) {
    await sql.run('INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ($1,$2,$3,\'active\',0,1000,1000)', [ORG, id, id === 'http-owner' ? 'owner' : 'member']);
    await sql.run('INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,$2,\'personal\',$3,$4,$3,\'active\',1000,1000)', [`ws-${id}`, ORG, id, `workspaces/${id}/files`]);
  }
  await sql.run('INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES (\'http-team\',$1,\'team\',\'workspaces/own-http-team/files\',\'Own HTTP team\',\'active\',1000,1000)', [ORG]);
  for (const id of ['http-owner', 'http-manager']) {
    await sql.run('INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ($1,\'http-team\',$2,\'member\',\'active\',1,0,1000,1000)', [ORG, id]);
  }
  const tokens = new Map<string, string>();
  for (const [sessionId, userId] of [['http-session-owner', 'http-owner'], ['http-session-manager', 'http-manager'],
    ['http-session-manager-new', 'http-manager'], ['http-session-user', 'http-user'], ['http-session-expired', 'http-manager']] as const) {
    const token = randomUUID(); tokens.set(sessionId, token);
    await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,1000,1000)',
      [sessionId, userId, token, sessionId === 'http-session-expired' ? Date.now() - 1000 : Date.now() + 2 * 60 * 60_000]);
  }
  return tokens;
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-desktop-http-'));
  await fs.chmod(root, 0o700); const identity = await fs.lstat(root), marker = randomUUID();
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600, flag: 'wx' });
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/unused_isolated_http_fixture',
    CANVAS_INSTANCE_ID: `own-http-${marker}`, CANVAS_ORGANIZATION_ID: ORG, CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '',
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    COMPOSIO_API_KEY: '', COMPOSIO_BASE_URL: '', BASE_URL, BETTER_AUTH_BASE_URL: BASE_URL, AUTH_COOKIE_SECURE: 'false', NODE_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  let database: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
  let provider: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  let queries = 0, sessionReads = 0, forbiddenRequests = 0, blockedMetadataRequests = 0, leases = 0;
  const blockedRequests: Array<{ hostname: string; pathname: string }> = [];
  const close = async () => {
    loader._load = originalLoad; globalThis.fetch = originalFetch;
    await provider?.close(); assert.equal(leases, 0); await database?.close();
    const actual = await fs.lstat(root);
    assert(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
    assert.equal(actual.mode & 0o777, 0o700); assert.equal(await fs.realpath(root), await fs.realpath(path.dirname(root)).then(parent => path.join(parent, path.basename(root))));
    assert.equal(await fs.readFile(path.join(root, '.fixture-owner'), 'utf8'), marker);
    await fs.rm(root, { recursive: true, force: false });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
  try {
    database = await createPiTestDatabase(); provider = await createComposioProviderFixture(); process.env.COMPOSIO_BASE_URL = provider.baseUrl;
    const actualDatabase = database, ownProvider = provider;
    const engine = actualDatabase.getPostgresRuntimeQueryable(), originalQuery = engine.query.bind(engine);
    engine.query = ((...args: Parameters<typeof engine.query>) => { queries += 1; return originalQuery(...args); }) as typeof engine.query;
    let tail = Promise.resolve();
    const transport = { ...actualDatabase, openDb: async (): Promise<SqlConnection> => {
      const before = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await before;
      const actual = await actualDatabase.openDb(); let closed = false; leases += 1;
      return { get: actual.get, all: actual.all, run: actual.run, close: async () => {
        if (!closed) { closed = true; await actual.close(); leases -= 1; release(); }
      } };
    } };
    globalThis.fetch = (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== ownProvider.baseUrl) {
        // The installed SDK's utils/version.ts performs this unauthenticated GET.
        // Count it separately while rejecting it before any external network access.
        blockedRequests.push({ hostname: target.hostname, pathname: target.pathname });
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (target.protocol === 'https:' && target.hostname === 'registry.npmjs.org' && target.port === ''
          && target.pathname === '/@composio/core/latest' && target.search === '' && target.hash === ''
          && target.username === '' && target.password === '' && method === 'GET' && [...headers].length === 0
          && init?.body == null && (!(input instanceof Request) || input.body === null)) blockedMetadataRequests += 1;
        else forbiddenRequests += 1;
        return Promise.reject(new Error('The own HTTP fixture forbids external network.'));
      }
      return originalFetch(input, init);
    };
    const authWrappers = new WeakMap<object, object>();
    loader._load = (name, parent, isMain) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return transport;
      if (name === '@/app/lib/license/seat-limit' || /\/app\/lib\/license\/seat-limit(?:\.ts)?$/u.test(name)) {
        // Only external seat/license issuance is isolated, as in the existing MCP HTTP gate.
        // This gate claims actual BetterAuth/Session SQL and CommonStore rights, not license acceptance.
        const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/license/seat-limit');
        return { ...actual, assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: ORG }) };
      }
      if (name === '@/app/lib/auth' || /\/app\/lib\/auth(?:\.ts)?$/u.test(name)) {
        const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/auth');
        let observed = authWrappers.get(actual);
        if (!observed) {
          const api = new Proxy(actual.auth.api, { get: (target, key, receiver) => key === 'getSession'
            ? (input: Parameters<typeof actual.auth.api.getSession>[0]) => { sessionReads += 1; return actual.auth.api.getSession(input); }
            : Reflect.get(target, key, receiver) });
          observed = { ...actual, auth: new Proxy(actual.auth, { get: (target, key, receiver) => key === 'api' ? api : Reflect.get(target, key, receiver) }) };
          authWrappers.set(actual, observed);
        }
        return observed;
      }
      return originalLoad(name, parent, isMain);
    };
    const sql = await transport.openDb(); let tokens: Map<string, string>;
    try { tokens = await seedAuthority(sql); } finally { await sql.close(); }
    const auth = await import('../app/lib/auth'); await auth.ensureAuthReady();
    for (const sessionId of ['http-session-owner', 'http-session-manager', 'http-session-manager-new', 'http-session-user']) {
      const token = tokens.get(sessionId); assert(token);
      const current = await auth.auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${token}` }) });
      assert(current); assert.equal(current.session.id, sessionId);
    }
    return { provider, transport, tokens, close, queries: () => queries, sessionReads: () => sessionReads,
      forbiddenRequests: () => forbiddenRequests, blockedMetadataRequests: () => blockedMetadataRequests, blockedRequests: () => [...blockedRequests] };
  } catch (error) { await close(); throw error; }
}

function request(token: string | null, pathname: string, init: RequestInit = {}) {
  const { signal: _signal, ...options } = init, headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.method === 'POST' && !headers.has('Origin')) headers.set('Origin', BASE_URL);
  return new NextRequest(`${BASE_URL}${pathname}`, { ...options, headers });
}

async function assertSummary(response: Response, ref: string, state?: string): Promise<SharedComposioDesktopOAuthSummary> {
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const value = await response.json() as { success?: unknown; data?: SharedComposioDesktopOAuthSummary };
  assert.equal(value.success, true); const summary = value.data; assert(summary && typeof summary === 'object');
  assert.equal(summary.connectionRef, ref); assert.match(summary.state, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
  if (state) assert.equal(summary.state, state);
  assert(Number.isFinite(Date.parse(summary.expiresAt)));
  assert.deepEqual(Object.keys(summary).sort(), ['connectionRef', 'expiresAt', 'state', 'status',
    ...(summary.status === 'waiting' ? ['authorizationUrl'] : []), ...('code' in summary ? ['code', 'error'] : [])].sort());
  if (summary.status === 'waiting') assert.equal(new URL(summary.authorizationUrl).protocol, 'https:');
  else assert.equal(Object.hasOwn(summary, 'authorizationUrl'), false);
  assert.doesNotMatch(JSON.stringify(value), /authSessionId|credentialRevision|pendingAccountId|composioUserId|profileId|backend|intent|http-session-/u);
  return summary;
}

async function main() {
  const fixture = await createFixture();
  try {
    const { provider, tokens, transport } = fixture;
    const profiles = await import('../app/lib/composio/composio-shared-profiles');
    const backend = await import('../app/lib/composio/composio-shared-backend');
    const store = await import('../app/lib/integration-tools/connections/store');
    const env = await import('../app/lib/integrations/env-config');
    const startRoute = await import('../app/api/composio/shared-connections/[connectionRef]/connect/route');
    const desktopRoute = await import('../app/api/composio/shared-connections/[connectionRef]/connect/desktop/route');
    const callbackRoute = await import('../app/api/composio/shared/desktop/callback/route');
    const http = await import('../app/api/composio/shared/http');
    const mcpHttp = await import('../app/api/mcp/shared-connections/http');
    const { SecretReadinessError } = await import('../app/lib/secrets/readiness');
    const owner = { userId: 'http-owner', workspaceId: 'ws-http-owner' }, manager = { userId: 'http-manager', workspaceId: 'ws-http-manager' };
    const token = tokens.get('http-session-manager'), ownerToken = tokens.get('http-session-owner');
    const otherSession = tokens.get('http-session-manager-new'), userToken = tokens.get('http-session-user'), expiredToken = tokens.get('http-session-expired');
    assert(token && ownerToken && otherSession && userToken && expiredToken);
    const orgOwnership = { type: 'organization' as const, organizationId: ORG }, teamOwnership = { type: 'team' as const, organizationId: ORG, workspaceId: 'http-team' };
    await env.replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-org-http-composio-key' }], { secretScope: 'organization', organizationId: ORG });
    const orgProfile = await profiles.createSharedComposioProfile({ actor: owner, ownership: orgOwnership, name: 'Own HTTP designs', providerMode: 'local' });
    const teamProfile = await profiles.createSharedComposioProfile({ actor: owner, ownership: teamOwnership, name: 'Own HTTP team designs', providerMode: 'local' });
    const grants = [{ targetType: 'user' as const, targetId: manager.userId, canUse: false, canManage: true, allowedToolNames: [] },
      { targetType: 'user' as const, targetId: 'http-user', canUse: true, canManage: false, allowedToolNames: null }];
    const create = async (team = false, toolkit = 'canva') => store.createSharedIntegrationConnection(owner, {
      ownership: team ? teamOwnership : orgOwnership, displayName: `Own HTTP ${randomUUID()}`, accessMode: 'restricted', allowedToolNames: [], grants,
      backend: await backend.prepareSharedComposioConnectionBackend(owner, { ownership: team ? teamOwnership : orgOwnership,
        profileId: team ? teamProfile.id : orgProfile.id, toolkit }),
    });
    const expected = (record: IntegrationConnectionRecord) => ({ expectedMetadataRevision: record.resource.metadataRevision,
      expectedGrantsRevision: record.resource.grantsRevision, expectedBindingRevision: record.resource.bindingRevision });
    const current = async (ref: string) => { const value = await store.getIntegrationConnectionRecord(ref); assert(value); return value; };
    const params = (ref: string) => ({ params: Promise.resolve({ connectionRef: ref }) });
    const startPath = (ref: string, workspaceId = manager.workspaceId) => `/api/composio/shared-connections/${encodeURIComponent(ref)}/connect?workspaceId=${workspaceId}`;
    const desktopPath = (ref: string) => `/api/composio/shared-connections/${encodeURIComponent(ref)}/connect/desktop`;
    const start = async (record: IntegrationConnectionRecord, intent = randomBytes(32).toString('base64url')) => {
      const before = fixture.sessionReads();
      const response = await startRoute.POST(request(token, startPath(record.resource.connectionRef), { method: 'POST', body: JSON.stringify({ desktop: true, intent, ...expected(record) }) }), params(record.resource.connectionRef));
      assert.equal(fixture.sessionReads() - before, 1, 'Desktop start captures exactly one actual BetterAuth identity.');
      return { summary: await assertSummary(response, record.resource.connectionRef), intent };
    };
    const first = await create(), ref = first.resource.connectionRef, intent = randomBytes(32).toString('base64url');
    const payload = { desktop: true, intent, ...expected(first) }, beforeInvalid = provider.calls.length;
    for (const [credential, body, suffix, headers, status] of [
      [null, payload, '', {}, 401], [expiredToken, payload, '', {}, 401], [userToken, payload, '', {}, 403],
      [token, { ...payload, returnLocale: 'en' }, '', {}, 400], [token, { ...payload, returnPath: '/en/plugins' }, '', {}, 400],
      [token, { ...payload, authSessionId: 'http-session-owner' }, '', {}, 400], [token, { ...payload, actor: owner }, '', {}, 400],
      [token, { ...payload, expectedBindingRevision: Number.MAX_SAFE_INTEGER + 1 }, '', {}, 400],
      [token, { ...payload, intent: intent.slice(0, 42) + 'B' }, '', {}, 400],
      [token, payload, '&workspaceId=ws-http-manager', {}, 400], [token, payload, '&ownerUserId=http-owner', {}, 400],
      [token, payload, '', { 'x-canvas-workspace-id': 'ws-http-owner' }, 400],
      [token, payload, '', { Origin: 'https://outside.example.test' }, 403], [token, payload, '', { 'sec-fetch-site': 'cross-site' }, 403],
    ] as const) {
      const response = await startRoute.POST(request(credential, startPath(ref) + suffix, { method: 'POST', headers, body: JSON.stringify(body) }), params(ref));
      assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(provider.calls.length, beforeInvalid); assert.deepEqual(await current(ref), first);
    const { summary: flow } = await start(first, intent); assert.equal(flow.status, 'waiting');
    const callsAfterStart = provider.calls.length;
    const recovered = await assertSummary(await desktopRoute.GET(request(token, `${desktopPath(ref)}?intent=${intent}&workspaceId=${manager.workspaceId}`), params(ref)), ref, flow.state);
    assert.equal(recovered.status, 'waiting'); assert.equal(provider.calls.length, callsAfterStart);
    const replay = await start(first, intent); assert.equal(replay.summary.state, flow.state); assert.equal(provider.calls.length, callsAfterStart);
    for (const [credential, query, headers, status] of [
      [null, `state=${flow.state}`, {}, 401], [otherSession, `state=${flow.state}`, {}, 403], [userToken, `state=${flow.state}`, {}, 403],
      [token, `state=${flow.state}&intent=${intent}`, {}, 400], [token, `state=${flow.state}&state=${flow.state}`, {}, 400],
      [token, `state=${flow.state}&actor=http-owner`, {}, 400], [token, `intent=${intent}&action=cancel`, {}, 400],
      [token, `state=${flow.state}`, { 'x-canvas-workspace-id': 'ws-http-owner' }, 400],
    ] as const) {
      const response = await desktopRoute.GET(request(credential, `${desktopPath(ref)}?${query}&workspaceId=${manager.workspaceId}`, { headers }), params(ref));
      assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    for (const body of [{ state: flow.state, intent, action: 'cancel' }, { intent, action: 'finalize', ...expected(first) },
      { state: flow.state, action: 'finalize', ...expected(first) }, { intent, action: 'cancel' }, { state: flow.state, action: 'cancel', authSessionId: 'http-session-owner' }]) {
      const response = await desktopRoute.POST(request(token, `${desktopPath(ref)}?workspaceId=${manager.workspaceId}`, { method: 'POST', body: JSON.stringify(body) }), params(ref));
      assert.equal(response.status, 400); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(provider.calls.length, callsAfterStart); assert.deepEqual(await current(ref), first);
    for (const query of [`flow=${flow.state}&flow=${flow.state}`, `flow=${flow.state}&error=SECRET_UNSAFE_ERROR`,
      `flow=${flow.state}&actor=http-owner`, `flow=${flow.state}&state=${flow.state}`, `flow=${flow.state.slice(0, 42)}B`]) {
      const response = await callbackRoute.GET(request(null, `/api/composio/shared/desktop/callback?${query}`));
      assert.equal(response.status, 400); assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const html = await response.text(); assert.equal(html.includes(flow.state), false); assert.equal(html.includes('SECRET_UNSAFE_ERROR'), false);
    }
    const pending = provider.accounts.get(orgProfile.composioUserId)?.find(account => account.status === 'INITIATED'); assert(pending);
    const callbackHref = provider.completeOAuth(pending.id); assert(callbackHref);
    const callbackUrl = new URL(callbackHref); assert.equal(callbackUrl.pathname, '/api/composio/shared/desktop/callback'); assert.equal(callbackUrl.searchParams.get('flow'), flow.state);
    const beforeCollect = { calls: provider.calls.length, sessions: fixture.sessionReads(), queries: fixture.queries() };
    const callback = await callbackRoute.GET(request(null, callbackUrl.pathname + callbackUrl.search, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }));
    assert.equal(callback.status, 200); assert.equal(provider.calls.length, beforeCollect.calls); assert.equal(fixture.sessionReads(), beforeCollect.sessions);
    assert(fixture.queries() > beforeCollect.queries && fixture.queries() - beforeCollect.queries <= 20, 'Public collection uses bounded SQL without authentication or SDK.');
    const html = await callback.text(); assert.equal(html.includes(flow.state), false); assert.equal(html.includes(ref), false);
    assert.equal(callback.headers.get('Cache-Control'), 'no-store'); assert.equal(callback.headers.get('Referrer-Policy'), 'no-referrer'); assert(callback.headers.get('Content-Security-Policy')?.includes("default-src 'none'"));
    assert.deepEqual(await current(ref), first, 'Collection cannot publish an account binding.');
    const complete = await assertSummary(await desktopRoute.POST(request(token, `${desktopPath(ref)}?workspaceId=${manager.workspaceId}`,
      { method: 'POST', body: JSON.stringify({ state: flow.state, action: 'finalize' }) }), params(ref)), ref, flow.state);
    assert.equal(complete.status, 'completed'); const published = await current(ref); assert.equal(published.resource.bindingRevision, first.resource.bindingRevision + 1);
    const commitReader = await transport.openDb(); let completedReceipt: unknown;
    try {
      assert.equal((await commitReader.get('SELECT COUNT(*)::integer AS count FROM composio_shared_desktop_oauth_commits WHERE connection_ref=$1', [ref]) as { count: number }).count, 1);
      completedReceipt = await commitReader.all('SELECT to_jsonb(row) AS value FROM composio_shared_desktop_oauth_commits row WHERE connection_ref=$1', [ref]);
    }
    finally { await commitReader.close(); }
    const completedCalls = provider.calls.length;
    assert.equal((await assertSummary(await desktopRoute.POST(request(token, `${desktopPath(ref)}?workspaceId=${manager.workspaceId}`,
      { method: 'POST', body: JSON.stringify({ intent, action: 'cancel', ...expected(first) }) }), params(ref)), ref, flow.state)).status, 'completed');
    const verificationCalls = provider.calls.slice(completedCalls);
    assert(verificationCalls.length > 0, 'Completed recovery must freshly verify the original ACTIVE account.');
    for (const call of verificationCalls) {
      assert.equal(call.path, '/api/v3.1/connected_accounts'); assert.equal(call.userId, orgProfile.composioUserId);
      assert.equal(call.toolkitSlugs, 'canva'); assert.deepEqual(call.body, {});
    }
    assert(published.backend.source === 'composio'); assert.equal(published.backend.connectedAccountId, pending.id);
    assert.deepEqual(await current(ref), published, 'Completed recovery must not republish the binding.');
    const recoveryReader = await transport.openDb();
    try { assert.deepEqual(await recoveryReader.all('SELECT to_jsonb(row) AS value FROM composio_shared_desktop_oauth_commits row WHERE connection_ref=$1', [ref]), completedReceipt); }
    finally { await recoveryReader.close(); }
    console.log('PASS actual BetterAuth original session + strict desktop requests, safe DTO/HTML, collect-only SDK0 and exactly one account publication.');

    const cancelledRecord = await create(true), cancelledRef = cancelledRecord.resource.connectionRef, cancelledIntent = randomBytes(32).toString('base64url');
    const beforeCancel = provider.calls.length;
    const cancelled = await assertSummary(await desktopRoute.POST(request(token, `${desktopPath(cancelledRef)}?workspaceId=${manager.workspaceId}`,
      { method: 'POST', body: JSON.stringify({ intent: cancelledIntent, action: 'cancel', ...expected(cancelledRecord) }) }), params(cancelledRef)), cancelledRef);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(provider.calls.length, beforeCancel);
    assert.equal((await start(cancelledRecord, cancelledIntent)).summary.status, 'cancelled'); assert.equal(provider.calls.length, beforeCancel);
    assert.equal((await assertSummary(await desktopRoute.GET(request(token, `${desktopPath(cancelledRef)}?intent=${cancelledIntent}&workspaceId=${manager.workspaceId}`), params(cancelledRef)), cancelledRef, cancelled.state)).status, 'cancelled');
    assert.deepEqual(await current(cancelledRef), cancelledRecord);
    const unknown = await desktopRoute.GET(request(token, `${desktopPath(cancelledRef)}?intent=${randomBytes(32).toString('base64url')}&workspaceId=${manager.workspaceId}`), params(cancelledRef));
    assert.equal(unknown.status, 404); assert.equal(unknown.headers.get('Cache-Control'), 'no-store');
    const noAuth = await create(false, 'duckduckgo'), noAuthRef = noAuth.resource.connectionRef;
    const noAuthResponse = await startRoute.POST(request(token, startPath(noAuthRef), { method: 'POST', body: JSON.stringify({ desktop: true, intent: randomBytes(32).toString('base64url'), ...expected(noAuth) }) }), params(noAuthRef));
    assert.equal(noAuthResponse.status, 200); assert.equal(noAuthResponse.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await noAuthResponse.json(), { success: true, data: { connectionRef: noAuthRef, noAuth: true } });
    assert.equal((await current(noAuthRef)).resource.bindingRevision, noAuth.resource.bindingRevision + 1);
    const sql = await transport.openDb();
    try { assert.equal((await sql.get('SELECT COUNT(*)::integer AS count FROM composio_shared_desktop_oauth_transactions WHERE connection_ref=$1', [noAuthRef]) as { count: number }).count, 0); }
    finally { await sql.close(); }
    const unconfirmed = await create(); provider.loseNextLinkAcknowledgement();
    const lostIntent = randomBytes(32).toString('base64url'), beforeLost = provider.calls.length;
    const lost = await startRoute.POST(request(token, startPath(unconfirmed.resource.connectionRef), { method: 'POST', body: JSON.stringify({ desktop: true, intent: lostIntent, ...expected(unconfirmed) }) }), params(unconfirmed.resource.connectionRef));
    assert.equal(lost.status, 503); assert.equal(lost.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await lost.json(), { success: false, code: 'outcome_unknown',
      error: 'The operation outcome is unknown. Check Composio before repeating it.' });
    const recoveredStart = await assertSummary(await desktopRoute.GET(request(token, `${desktopPath(unconfirmed.resource.connectionRef)}?intent=${lostIntent}&workspaceId=${manager.workspaceId}`), params(unconfirmed.resource.connectionRef)), unconfirmed.resource.connectionRef);
    assert.equal(recoveredStart.status, 'starting'); assert.equal(recoveredStart.code, 'CONNECTION_DESKTOP_OAUTH_START_UNCONFIRMED'); assert(provider.calls.length > beforeLost);
    const callsAfterLoss = provider.calls.length; await start(unconfirmed, lostIntent); assert.equal(provider.calls.length, callsAfterLoss, 'Intent recovery never repeats the uncertain account-link request.');
    console.log('PASS durable early intent cancellation, no-auth separate ACK and lost-link ACK recovery without relinking.');

    const denied = await create(), deniedFlow = (await start(denied)).summary;
    const beforeDenied = provider.calls.length, deniedDescriptor = await store.inspectSharedIntegrationConnection(owner, denied.resource.connectionRef);
    assert(deniedDescriptor.grants);
    await store.mutateSharedIntegrationConnection(owner, denied.resource.connectionRef, { ...expected(denied),
      grants: deniedDescriptor.grants.map(grant => ({ targetType: grant.targetType, targetId: grant.targetId, canUse: grant.canUse,
        canManage: grant.targetId === manager.userId ? false : grant.canManage, allowedToolNames: grant.allowedToolNames })) });
    for (const action of ['finalize', 'cancel'] as const) {
      const response = await desktopRoute.POST(request(token, `${desktopPath(denied.resource.connectionRef)}?workspaceId=${manager.workspaceId}`,
        { method: 'POST', body: JSON.stringify({ state: deniedFlow.state, action }) }), params(denied.resource.connectionRef));
      assert.equal(response.status, 403); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(provider.calls.length, beforeDenied);
    for (const code of ['master_key_missing', 'decryption_failed', 'invalid_secret_format', 'mcp_credential_key_missing'] as const) {
      const readiness = http.sharedComposioResponseError(new SecretReadinessError(code, 'SECRET_PRIVATE_PATH_AND_KEY'));
      assert.equal(readiness.status, 503); assert.equal(readiness.headers.get('Cache-Control'), 'no-store');
      const body = await readiness.json(); assert.equal(body.code, code); assert.equal(body.setupHref, '/settings?tab=secrets'); assert.equal(JSON.stringify(body).includes('SECRET_PRIVATE_PATH_AND_KEY'), false);
    }
    const mcpReads = fixture.sessionReads();
    const legacyMcp = await mcpHttp.sharedMcpRequestDesktopInitiator(request(token, '/api/mcp/shared-connections/test/oauth?workspaceId='));
    assert.equal(fixture.sessionReads() - mcpReads, 1); assert(!(legacyMcp instanceof Response)); assert.equal(legacyMcp.actor.workspaceId, null);
    const legacyAnonymous = await startRoute.POST(request(null, startPath(ref), { method: 'POST', body: 'invalid-json' }), params(ref));
    assert.equal(legacyAnonymous.status, 401, 'Browser branch still authenticates before validating JSON.');
    const browserRecord = await create(), beforeBrowserRows = await transport.openDb();
    try { assert.equal((await beforeBrowserRows.get('SELECT COUNT(*)::integer AS count FROM composio_shared_desktop_oauth_transactions WHERE connection_ref=$1', [browserRecord.resource.connectionRef]) as { count: number }).count, 0); }
    finally { await beforeBrowserRows.close(); }
    const browser = await startRoute.POST(request(token, startPath(browserRecord.resource.connectionRef), { method: 'POST', headers: { Origin: 'https://outside.example.test' },
      body: JSON.stringify({ ...expected(browserRecord), returnLocale: 'en' }) }), params(browserRecord.resource.connectionRef));
    assert.equal(browser.status, 200); const browserBody = await browser.json(); assert.equal(browserBody.success, true);
    assert.deepEqual(Object.keys(browserBody.data).sort(), ['expiresAt', 'flowId', 'redirectUrl']);
    const finalReader = await transport.openDb();
    try { assert.equal((await finalReader.get('SELECT COUNT(*)::integer AS count FROM pi_sessions') as { count: number }).count, 0); }
    finally { await finalReader.close(); }
    assert.equal(provider.calls.filter(call => /\/tools\/execute\//u.test(call.path)).length, 0); assert.equal(fixture.forbiddenRequests(), 0);
    assert.equal(fixture.blockedRequests().length, fixture.blockedMetadataRequests(), 'Every blocked non-own request must be the exact credential-free SDK version probe.');
    console.log('PASS all external network blocked; known SDK npm version-check attempts counted separately.', { blockedMetadataRequests: fixture.blockedMetadataRequests() });
    console.log('PASS current grant revocation, static Secrets readiness, MCP identity extraction compatibility and unchanged browser contract; no business/network/runtime-session calls.');
  } finally { await fixture.close(); }
}

main().catch(error => {
  const name = error instanceof Error && ['AssertionError', 'Error', 'TypeError'].includes(error.name) ? error.name : 'FixtureError';
  const site = error instanceof Error ? error.stack?.match(/composio-shared-desktop-oauth-http-test\.ts:(\d+):(\d+)/u)?.slice(1).join(':') : undefined;
  console.error('composio-shared-desktop-oauth-http-test: FAIL', { name, ...(site ? { site } : {}) }); process.exitCode = 1;
});
