import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import type { SqlConnection } from '../app/lib/db';
import type { IntegrationConnectionRecord } from '../app/lib/integration-tools/connections/contracts';
import type { SharedMcpDesktopOAuthSummary } from '../app/lib/mcp/shared-desktop-oauth';
import { createPiTestDatabase } from './helpers/pi-test-database';

const BASE_URL = 'http://127.0.0.1:3001';

async function createHttpProvider() {
  let origin = '', requests = 0;
  const forms: URLSearchParams[] = [], errors: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    requests += 1;
    try {
      if (request.url === '/.well-known/oauth-authorization-server') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true })); return;
      }
      if (request.url === '/.well-known/oauth-protected-resource/mcp') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] })); return;
      }
      if (request.url === '/token' && request.method === 'POST') {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8')); forms.push(form);
        assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('client_id'), 'own-http-client');
        assert.equal(form.get('redirect_uri'), `${BASE_URL}/api/mcp/oauth/callback`); assert(form.get('code_verifier'));
        assert.equal(form.get('resource'), `${origin}/mcp`);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ access_token: `own-http-token-${forms.length}`, token_type: 'Bearer', expires_in: 3600 })); return;
      }
      response.statusCode = 404; response.end('own fixture not found');
    } catch (error) { errors.push(error); response.statusCode = 500; response.end('own fixture failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  return { origin, url: `${origin}/mcp`, forms, errors, requests: () => requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function createHttpDatabase() {
  const database = await createPiTestDatabase();
  let tail = Promise.resolve(), queries = 0;
  const engine = database.getPostgresRuntimeQueryable(), originalQuery = engine.query.bind(engine);
  engine.query = ((...args: Parameters<typeof engine.query>) => { queries += 1; return originalQuery(...args); }) as typeof engine.query;
  return { ...database, queries: () => queries, openDb: async (): Promise<SqlConnection> => {
    const before = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await before;
    const actual = await database.openDb(); let closed = false;
    return { get: actual.get, all: actual.all, run: actual.run,
      close: async () => { if (!closed) { closed = true; await actual.close(); release(); } } };
  } };
}

async function seedHttpAuthority(sql: SqlConnection) {
  for (const id of ['http-owner', 'http-manager', 'http-user']) {
    await sql.run('INSERT INTO "user" (id,name,email,role,banned,email_verified,created_at,updated_at) VALUES ($1,$1,$2,$3,0,1,1000,1000)',
      [id, `${id}@own-desktop.example.test`, id === 'http-owner' ? 'admin' : 'user']);
  }
  await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('http-org','http-owner','team',1,1000,1000)");
  for (const id of ['http-owner', 'http-manager', 'http-user']) {
    await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('http-org',$1,$2,'active',0,1000,1000)", [id, id === 'http-owner' ? 'owner' : 'member']);
    await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'http-org','personal',$2,$3,$2,'active',1000,1000)", [`ws-${id}`, id, `workspaces/${id}/files`]);
  }
  await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('http-team','http-org','team','workspaces/own-team/files','Own HTTP team','active',1000,1000)");
  const tokens = new Map<string, string>();
  for (const [sessionId, userId] of [['http-session-owner', 'http-owner'], ['http-session-manager', 'http-manager'],
    ['http-session-manager-new', 'http-manager'], ['http-session-user', 'http-user']] as const) {
    const token = randomUUID(); tokens.set(sessionId, token);
    await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,1000,1000)',
      [sessionId, userId, token, Date.now() + 2 * 60 * 60_000]);
  }
  return tokens;
}

function authenticatedRequest(token: string | null, pathname: string, init: RequestInit = {}) {
  const { signal: _signal, ...options } = init;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return new NextRequest(`${BASE_URL}${pathname}`, { ...options, headers });
}

async function assertPublicDesktopReply(response: Response, connectionRef: string, state: string) {
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json() as { success: boolean; data: SharedMcpDesktopOAuthSummary };
  assert.equal(result.success, true); assert.equal(result.data.connectionRef, connectionRef); assert.equal(result.data.state, state);
  assert(Number.isFinite(Date.parse(result.data.expiresAt)));
  assert.deepEqual(Object.keys(result.data).sort(), ['connectionRef', 'expiresAt', 'state', 'status',
    ...(result.data.authorizationUrl ? ['authorizationUrl'] : []), ...(result.data.code ? ['code', 'error'] : [])].sort());
  assert.doesNotMatch(JSON.stringify(result), /codeVerifier|authSessionId|initiatingUserId|connectionId|configHash|backend|http-session-|own-http-token/u);
  if (result.data.status !== 'waiting') assert.equal('authorizationUrl' in result.data, false);
  return result.data;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-shared-desktop-http-')), identity = await fs.lstat(root);
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/unused_isolated_http_fixture',
    CANVAS_INSTANCE_ID: `own-http-${randomUUID()}`, CANVAS_ORGANIZATION_ID: 'http-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: 'false', MCP_ALLOW_PRIVATE_NETWORK: 'true',
    MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_STDIO: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', MCP_OAUTH_BASE_URL: BASE_URL,
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    BASE_URL, BETTER_AUTH_BASE_URL: BASE_URL, AUTH_COOKIE_SECURE: 'false', NODE_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown }, originalLoad = loader._load;
  const originalFetch = globalThis.fetch; let forbiddenRequests = 0;
  let database: Awaited<ReturnType<typeof createHttpDatabase>> | undefined, provider: Awaited<ReturnType<typeof createHttpProvider>> | undefined;
  try {
    database = await createHttpDatabase(); provider = await createHttpProvider();
    const activeDatabase = database;
    const ownProvider = provider;
    globalThis.fetch = (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== ownProvider.origin) {
        forbiddenRequests += 1; return Promise.reject(new Error('The isolated HTTP fixture forbids other network destinations.'));
      }
      return originalFetch(input, init);
    };
    loader._load = (name, parent, isMain) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return activeDatabase;
      if (name === '@/app/lib/license/seat-limit' || /\/app\/lib\/license\/seat-limit(?:\.ts)?$/u.test(name)) {
        // External license issuance is outside this HTTP contract gate. The initial
        // unseamed attempt was blocked by the real inactive-license auth hook.
        // Keep actual BetterAuth/Bearer, Session SQL and all resource authority.
        const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/license/seat-limit');
        return { ...actual, assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: 'http-org' }) };
      }
      return originalLoad(name, parent, isMain);
    };
    const sql = await database.openDb(), tokens = await seedHttpAuthority(sql); await sql.close();
    const authModule = await import('../app/lib/auth'); await authModule.ensureAuthReady();
    for (const sessionId of ['http-session-owner', 'http-session-manager', 'http-session-manager-new', 'http-session-user']) {
      const token = tokens.get(sessionId)!;
      const current = await authModule.auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${token}` }) });
      assert(current, 'Actual BetterAuth must resolve each isolated stored authentication session.');
      assert.equal(current.session.id, sessionId);
    }
    console.log('PASS actual BetterAuth bearer transport and exact PostgreSQL sessions; only external seat/license issuance is isolated.');
    const shared = await import('../app/lib/mcp/shared-connections'), store = await import('../app/lib/integration-tools/connections/store');
    const startRoute = await import('../app/api/mcp/shared-connections/[connectionRef]/oauth/route');
    const desktopRoute = await import('../app/api/mcp/shared-connections/[connectionRef]/oauth/desktop/route');
    const callbackRoute = await import('../app/api/mcp/oauth/callback/route');
    const owner = { userId: 'http-owner', workspaceId: 'ws-http-owner' };
    const token = tokens.get('http-session-manager')!, otherSession = tokens.get('http-session-manager-new')!, userToken = tokens.get('http-session-user')!;
    const create = async (team = false) => shared.createSharedMcpConnection(owner, { ownership: team
      ? { type: 'team', organizationId: 'http-org', workspaceId: 'http-team' } : { type: 'organization', organizationId: 'http-org' },
      displayName: `Own HTTP ${randomUUID()}`, accessMode: 'restricted', allowedToolNames: [], secrets: [],
      grants: [{ targetType: 'user', targetId: 'http-manager', canUse: false, canManage: true, allowedToolNames: null },
        { targetType: 'user', targetId: 'http-user', canUse: true, canManage: false, allowedToolNames: null }],
      config: { url: provider!.url, auth: 'oauth', oauth: { issuer: provider!.origin, clientId: 'own-http-client' } } });
    const expected = (record: IntegrationConnectionRecord) => ({ expectedMetadataRevision: record.resource.metadataRevision,
      expectedGrantsRevision: record.resource.grantsRevision, expectedBindingRevision: record.resource.bindingRevision });
    const params = (ref: string) => ({ params: Promise.resolve({ connectionRef: ref }) });
    const current = async (ref: string) => { const value = await store.getIntegrationConnectionRecord(ref); assert(value); return value; };
    const first = await create(), ref = first.resource.connectionRef;
    const startPath = `/api/mcp/shared-connections/${encodeURIComponent(ref)}/oauth?workspaceId=ws-http-manager`;
    const desktopPath = `/api/mcp/shared-connections/${encodeURIComponent(ref)}/oauth/desktop`;
    const initialProviderReads = provider.requests(), initialBinding = first.resource.bindingRevision;
    for (const [credential, payload, suffix, headers, status] of [
      [null, { ...expected(first), desktop: true }, '', {}, 401],
      [token, { ...expected(first), desktop: 'true' }, '', {}, 400],
      [token, { ...expected(first), desktop: true, actor: owner }, '', {}, 400],
      [token, { ...expected(first), desktop: true, authSessionId: 'http-session-owner' }, '', {}, 400],
      [token, { ...expected(first), desktop: true, sharedDesktopInitiator: { authSessionId: 'http-session-owner' } }, '', {}, 400],
      [token, { ...expected(first), desktop: true }, '&workspaceId=ws-http-manager', {}, 400],
      [token, { ...expected(first), desktop: true }, '', { 'x-canvas-workspace-id': 'ws-http-owner' }, 400],
      [userToken, { ...expected(first), desktop: true }, '', {}, 403],
    ] as const) {
      const response = await startRoute.POST(authenticatedRequest(credential, startPath + suffix, { method: 'POST', headers, body: JSON.stringify(payload) }), params(ref));
      assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(provider.requests(), initialProviderReads); assert.equal((await current(ref)).resource.bindingRevision, initialBinding);
    const startedResponse = await startRoute.POST(authenticatedRequest(token, startPath, { method: 'POST', body: JSON.stringify({ ...expected(first), desktop: true }) }), params(ref));
    assert.equal(startedResponse.status, 200); assert.equal(startedResponse.headers.get('Cache-Control'), 'no-store');
    const startedBody = await startedResponse.json() as { success: boolean; data: { connectionRef: string; desktop: boolean; state: string; redirectUri: string; authorizationUrl: string; expiresAt: string } };
    assert.equal(startedBody.success, true); const started = startedBody.data;
    assert.equal(started.connectionRef, ref); assert.equal(started.desktop, true); assert.match(started.state, /^desktop_[A-Za-z0-9_-]{32}$/u);
    assert.equal(started.redirectUri, `${BASE_URL}/api/mcp/oauth/callback`); assert(Number.isFinite(Date.parse(started.expiresAt)));
    assert.deepEqual(Object.keys(started).sort(), ['authorizationUrl', 'connectionRef', 'desktop', 'expiresAt', 'redirectUri', 'state']);
    assert.doesNotMatch(JSON.stringify(started), /authSessionId|codeVerifier|connectionId|http-session-|own-http-token/u);
    const statusQuery = `?state=${started.state}&workspaceId=ws-http-manager`;
    const waiting = await assertPublicDesktopReply(await desktopRoute.GET(authenticatedRequest(token, desktopPath + statusQuery), params(ref)), ref, started.state);
    assert.equal(waiting.status, 'waiting'); assert.equal(waiting.expiresAt, started.expiresAt); assert.equal(waiting.authorizationUrl, started.authorizationUrl);
    const noExchange = provider.forms.length;
    for (const [credential, query, headers, requestedRef, status] of [
      [null, statusQuery, {}, ref, 401], [otherSession, statusQuery, {}, ref, 403], [userToken, statusQuery, {}, ref, 403],
      [token, `${statusQuery}&state=${started.state}`, {}, ref, 400],
      [token, `${statusQuery}&workspaceId=ws-http-manager`, {}, ref, 400],
      [token, `${statusQuery}&actor=http-owner`, {}, ref, 400],
      [token, `${statusQuery}&authSessionId=http-session-owner`, {}, ref, 400],
      [token, statusQuery, { 'x-canvas-workspace-id': 'ws-http-owner' }, ref, 400],
      [token, `?state=${started.state}&workspaceId=ws-http-owner`, {}, ref, 403],
      [token, statusQuery, {}, `canvas-connection:${randomUUID()}`, 403],
    ] as const) {
      const response = await desktopRoute.GET(authenticatedRequest(credential, desktopPath + query, { headers }), params(requestedRef));
      assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    for (const payload of [{ state: started.state, action: 'invalid' }, { state: '../../state', action: 'finalize' },
      { state: started.state, action: 'finalize', actor: owner }, { state: started.state, action: 'finalize', authSessionId: 'http-session-owner' },
      { state: started.state, action: 'finalize', expectedBindingRevision: initialBinding }, ['finalize']]) {
      const response = await desktopRoute.POST(authenticatedRequest(token, desktopPath + '?workspaceId=ws-http-manager', { method: 'POST', body: JSON.stringify(payload) }), params(ref));
      assert.equal(response.status, 400); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(provider.forms.length, noExchange); assert.equal((await current(ref)).resource.bindingRevision, initialBinding);
    const sqlBeforeCallback = database.queries(), providerBeforeCallback = provider.requests();
    const callback = await callbackRoute.GET(authenticatedRequest(null, `/api/mcp/oauth/callback?${new URLSearchParams({ state: started.state, code: 'own-fixture-code', iss: provider.origin })}`));
    assert.equal(callback.status, 200); assert.equal(database.queries(), sqlBeforeCallback); assert.equal(provider.requests(), providerBeforeCallback);
    const received = await assertPublicDesktopReply(await desktopRoute.GET(authenticatedRequest(token, desktopPath + statusQuery), params(ref)), ref, started.state);
    assert.equal(received.status, 'callback_received');
    const finalized = await assertPublicDesktopReply(await desktopRoute.POST(authenticatedRequest(token, desktopPath + '?workspaceId=ws-http-manager',
      { method: 'POST', body: JSON.stringify({ state: started.state, action: 'finalize' }) }), params(ref)), ref, started.state);
    assert.equal(finalized.status, 'completed'); assert.equal(provider.forms.length, noExchange + 1);
    assert.equal((await current(ref)).resource.bindingRevision, initialBinding + 1);
    assert.equal((await assertPublicDesktopReply(await desktopRoute.POST(authenticatedRequest(token, desktopPath + '?workspaceId=ws-http-manager',
      { method: 'POST', body: JSON.stringify({ state: started.state, action: 'finalize' }) }), params(ref)), ref, started.state)).status, 'completed');
    assert.equal(provider.forms.length, noExchange + 1, 'HTTP finalize replay does not repeat the one-time provider code POST.');
    const team = await create(true), teamRef = team.resource.connectionRef;
    const teamPath = `/api/mcp/shared-connections/${encodeURIComponent(teamRef)}/oauth?workspaceId=ws-http-manager`;
    const teamResponse = await startRoute.POST(authenticatedRequest(token, teamPath, { method: 'POST', body: JSON.stringify({ ...expected(team), desktop: true }) }), params(teamRef));
    assert.equal(teamResponse.status, 200); const teamState = (await teamResponse.json()).data.state as string;
    const cancelled = await assertPublicDesktopReply(await desktopRoute.POST(authenticatedRequest(token,
      `/api/mcp/shared-connections/${encodeURIComponent(teamRef)}/oauth/desktop?workspaceId=ws-http-manager`,
      { method: 'POST', body: JSON.stringify({ state: teamState, action: 'cancel' }) }), params(teamRef)), teamRef, teamState);
    assert.equal(cancelled.status, 'cancelled'); assert.equal((await current(teamRef)).resource.bindingRevision, team.resource.bindingRevision);
    assert.equal(provider.forms.length, noExchange + 1);
    for (const desktop of [undefined, false]) {
      const record = await current(ref);
      const response = await startRoute.POST(authenticatedRequest(token, startPath, { method: 'POST', body: JSON.stringify({ ...expected(record), ...(desktop === undefined ? {} : { desktop }) }) }), params(ref));
      assert.equal(response.status, 200); const data = (await response.json()).data;
      assert.match(data.state, /^[A-Za-z0-9_-]{32}$/u); assert.equal('desktop' in data, false); assert.equal('connectionRef' in data, false);
      assert.equal(data.redirectUri, `${BASE_URL}/api/mcp/shared-connections/oauth/callback`);
    }
    const revoked = await create(), revokedRef = revoked.resource.connectionRef;
    const revokedStart = await startRoute.POST(authenticatedRequest(token,
      `/api/mcp/shared-connections/${encodeURIComponent(revokedRef)}/oauth?workspaceId=ws-http-manager`,
      { method: 'POST', body: JSON.stringify({ ...expected(revoked), desktop: true }) }), params(revokedRef));
    assert.equal(revokedStart.status, 200); const revokedState = (await revokedStart.json()).data.state as string;
    await store.mutateSharedIntegrationConnection(owner, revokedRef, { ...expected(revoked), grants: [] });
    const revokedBefore = await current(revokedRef), beforeRevokedCallback = database.queries();
    assert.equal((await callbackRoute.GET(authenticatedRequest(null, `/api/mcp/oauth/callback?${new URLSearchParams({
      state: revokedState, code: 'own-fixture-code', iss: provider.origin,
    })}`))).status, 200);
    assert.equal(database.queries(), beforeRevokedCallback, 'Revoked manager callback still only collects privately, without SQL authority.');
    const revokedPath = `/api/mcp/shared-connections/${encodeURIComponent(revokedRef)}/oauth/desktop?workspaceId=ws-http-manager`;
    const revokedReplies = [await desktopRoute.GET(authenticatedRequest(token, revokedPath + `&state=${revokedState}`), params(revokedRef))];
    for (const action of ['finalize', 'cancel']) revokedReplies.push(await desktopRoute.POST(authenticatedRequest(token, revokedPath,
      { method: 'POST', body: JSON.stringify({ state: revokedState, action }) }), params(revokedRef)));
    for (const response of revokedReplies) {
      assert.equal(response.status, 403); assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal((await response.json()).code, 'CONNECTION_ACCESS_DENIED');
    }
    assert.deepEqual(await current(revokedRef), revokedBefore); assert.equal(provider.forms.length, noExchange + 1);

    const expired = await create(), expiredRef = expired.resource.connectionRef;
    const expiredStart = await startRoute.POST(authenticatedRequest(token,
      `/api/mcp/shared-connections/${encodeURIComponent(expiredRef)}/oauth?workspaceId=ws-http-manager`,
      { method: 'POST', body: JSON.stringify({ ...expected(expired), desktop: true }) }), params(expiredRef));
    assert.equal(expiredStart.status, 200); const expiredState = (await expiredStart.json()).data.state as string;
    const sessionWriter = await database.openDb();
    await sessionWriter.run('DELETE FROM "session" WHERE id=$1 AND user_id=$2', ['http-session-manager', 'http-manager']);
    await sessionWriter.close(); const beforeExpiredCallback = database.queries();
    assert.equal((await callbackRoute.GET(authenticatedRequest(null, `/api/mcp/oauth/callback?${new URLSearchParams({
      state: expiredState, code: 'own-fixture-code', iss: provider.origin,
    })}`))).status, 200);
    assert.equal(database.queries(), beforeExpiredCallback);
    const expiredPath = `/api/mcp/shared-connections/${encodeURIComponent(expiredRef)}/oauth/desktop?workspaceId=ws-http-manager`;
    for (const [credential, status] of [[token, 401], [otherSession, 403]] as const) {
      const response = await desktopRoute.POST(authenticatedRequest(credential, expiredPath,
        { method: 'POST', body: JSON.stringify({ state: expiredState, action: 'finalize' }) }), params(expiredRef));
      assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.deepEqual(await current(expiredRef), expired); assert.equal(provider.forms.length, noExchange + 1);

    const ownerToken = tokens.get('http-session-owner')!, missingRef = `canvas-connection:${randomUUID()}`;
    const missingPath = `/api/mcp/shared-connections/${encodeURIComponent(missingRef)}/oauth?workspaceId=ws-http-owner`;
    const beforeRateLimit = provider.requests();
    for (let index = 0; index < 31; index += 1) {
      const response = await startRoute.POST(authenticatedRequest(ownerToken, missingPath,
        { method: 'POST', body: JSON.stringify({ ...expected(first), desktop: true }) }), params(missingRef));
      assert.equal(response.status, index < 30 ? 404 : 429); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(provider.requests(), beforeRateLimit, 'Verified-user rate denial cannot start provider discovery.');
    const unchangedBrowser = await startRoute.POST(authenticatedRequest(ownerToken, missingPath,
      { method: 'POST', body: JSON.stringify({ ...expected(first), desktop: false }) }), params(missingRef));
    assert.equal(unchangedBrowser.status, 404, 'The new desktop quota does not change the browser branch.');
    const observer = await database.openDb();
    assert.equal((await observer.get('SELECT COUNT(*) AS count FROM pi_sessions') as { count: number }).count, 0);
    await observer.close(); assert.deepEqual(provider.errors, []); assert.equal(forbiddenRequests, 0);
    console.log('PASS shared Desktop HTTP: exact server session, original manager, strict query/body/ref/workspace, safe no-store DTOs, Org finalize, Team cancel, fresh grant/session revocation, verified-user quota, zero-SQL public collection and unchanged browser starts.');
  } finally {
    loader._load = originalLoad;
    globalThis.fetch = originalFetch;
    await provider?.close(); await database?.close();
    const current = await fs.lstat(root);
    assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(root, { recursive: true, force: false });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
