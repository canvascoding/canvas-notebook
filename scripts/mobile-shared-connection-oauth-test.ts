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
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';

const BASE = 'http://127.0.0.1:3001', ORG = 'mobile-shared-oauth-org';
let failedImport: string | undefined;
let failedResponse: { status: number; code?: string } | undefined;
function expectMobileSharedOAuthCode(code: string) {
  return (error: unknown) => error instanceof Error && (error as { code?: string }).code === code;
}
async function seedAuthority(database: Awaited<ReturnType<typeof createPiTestDatabase>>) {
  const sql = await database.openDb();
  try {
    for (const id of ['owner', 'manager', 'other']) {
      await sql.run('INSERT INTO "user" (id,name,email,role,banned,email_verified,created_at,updated_at) VALUES ($1,$1,$2,$3,0,1,1000,1000)', [id, `${id}@mobile-shared.example.test`, id === 'owner' ? 'admin' : 'user']);
    }
    await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ($1,'owner','team',1,1000,1000)", [ORG]);
    for (const id of ['owner', 'manager', 'other']) {
      await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ($1,$2,$3,'active',0,1000,1000)", [ORG, id, id === 'owner' ? 'owner' : 'member']);
      await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,$2,'personal',$3,$4,$3,'active',1000,1000)", [`ws-${id}`, ORG, id, `workspaces/${id}/files`]);
    }
    await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('mobile-team',$1,'team','workspaces/mobile-team/files','Mobile team','active',1000,1000)", [ORG]);
    for (const id of ['owner', 'manager']) await sql.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ($1,'mobile-team',$2,'member','active',1,0,1000,1000)", [ORG, id]);
    for (const [sessionId, userId] of [['session-owner', 'owner'], ['session-manager', 'manager'], ['session-new-manager', 'manager'], ['session-other', 'other']]) {
      await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,1000,1000)', [sessionId, userId, randomUUID(), Date.now() + 3600_000]);
    }
  } finally { await sql.close(); }
}
async function createMobileSharedOAuthFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-shared-oauth-')); await fs.chmod(root, 0o700);
  const identity = await fs.lstat(root), environment = { DATA: root, CANVAS_DATA_ROOT: root,
    DATABASE_URL: 'postgresql://127.0.0.1:1/unused-owned-pglite', NODE_ENV: 'test', BASE_URL: BASE, MCP_OAUTH_BASE_URL: BASE,
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_ORGANIZATION_ID: ORG, CANVAS_TEAM_FEATURES_ENABLED: 'true',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', COMPOSIO_API_KEY: '', COMPOSIO_BASE_URL: '',
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_STDIO: 'false' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const database = await createPiTestDatabase(); await seedAuthority(database);
  const composio = await createComposioProviderFixture(); process.env.COMPOSIO_BASE_URL = composio.baseUrl;
  let mcpOrigin = '', mcpRequests = 0, exchanges = 0, failIndex = false, failDiscovery = false, stateWrites = 0, loseStart = false, changeNoAuthAck = false, lateSessionRevoke = false;
  const errors: unknown[] = [];
  const provider = http.createServer(async (request, response) => {
    try {
      mcpRequests++; response.setHeader('Content-Type', 'application/json');
      if (failDiscovery && request.url?.startsWith('/.well-known/')) { response.statusCode = 500; response.end('{}'); return; }
      if (request.url === '/.well-known/oauth-authorization-server') { response.end(JSON.stringify({ issuer: mcpOrigin,
        authorization_endpoint: `${mcpOrigin}/authorize`, token_endpoint: `${mcpOrigin}/token`, code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true })); return; }
      if (request.url === '/.well-known/oauth-protected-resource/mcp') { response.end(JSON.stringify({ resource: `${mcpOrigin}/mcp`, authorization_servers: [mcpOrigin] })); return; }
      if (request.url === '/token' && request.method === 'POST') {
        const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
        const form = new URLSearchParams(Buffer.concat(parts).toString()); assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('redirect_uri'), `${BASE}/api/mcp/oauth/callback`); assert(form.get('code_verifier')); exchanges++;
        response.end(JSON.stringify({ access_token: `own-mobile-token-${exchanges}`, token_type: 'Bearer', expires_in: 3600 })); return;
      }
      response.statusCode = 404; response.end('{}');
    } catch (error) { errors.push(error); response.statusCode = 500; response.end('{}'); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string'); mcpOrigin = `http://127.0.0.1:${address.port}`;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown }, originalLoad = loader._load;
  const originalFetch = globalThis.fetch; let externalRequests = 0, leases = 0, tail = Promise.resolve();
  const transport = { ...database, openDb: async (): Promise<SqlConnection> => {
    const prior = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await prior;
    const sql = await database.openDb(); leases++; let closed = false;
    return { get: sql.get, run: sql.run, all: sql.all, close: async () => { if (!closed) { closed = true; await sql.close(); leases--; release(); } } };
  } };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (![mcpOrigin, composio.baseUrl].includes(url.origin)) {
      if (url.hostname !== 'registry.npmjs.org' || url.pathname !== '/@composio/core/latest') externalRequests++;
      throw new Error('The owned protocol fixture blocks external network.');
    }
    return originalFetch(input, init);
  };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    // The error formatter imports Pi metadata transitively; this OAuth gate never runs a model or agent.
    if (name === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    if (name === '@earendil-works/pi-agent-core' || name === '@earendil-works/pi-ai/oauth') return {};
    if (name === '@earendil-works/pi-ai') return { getModels: () => [], getProviders: () => [], isContextOverflow: () => false };
    if (name === '@/app/lib/db' || /^(?:\.\.\/)+db$/u.test(name) || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return transport;
    if (name === '@/app/lib/license/seat-limit' || /\/license\/seat-limit(?:\.ts)?$/u.test(name)) {
      const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/license/seat-limit');
      return { ...actual, assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: ORG }) };
    }
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const sql = await transport.openDb();
      try {
        const row = await sql.get('SELECT s.id,s.user_id,s.expires_at,u.name,u.email,u.role FROM "session" s JOIN "user" u ON u.id=s.user_id WHERE s.id=$1', [headers.get('x-test-session')]) as Record<string, unknown> | undefined;
        return row ? { user: { id: row.user_id, name: row.name, email: row.email, role: row.role },
          session: { id: row.id, userId: row.user_id, expiresAt: new Date(Number(row.expires_at)) } } : null;
      } finally { await sql.close(); }
    } } } };
    if (name === '@/app/lib/mcp/credential-storage') {
      const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/mcp/credential-storage');
      return { ...actual, writeMcpCredentialJson: async (...args: Parameters<typeof actual.writeMcpCredentialJson>) => {
        if (args[0].includes('oauth-state')) stateWrites++;
        if (failIndex && args[0].startsWith('mobile-shared-oauth-states-v2/mcp-')) { failIndex = false; throw new Error('own-locator-write-failure'); }
        return actual.writeMcpCredentialJson(...args);
      } };
    }
    if (name === '@/app/lib/composio/composio-shared-desktop-oauth') {
      const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/composio/composio-shared-desktop-oauth');
      return { ...actual, startSharedComposioDesktopOAuth: async (...args: Parameters<typeof actual.startSharedComposioDesktopOAuth>) => {
        const result = await actual.startSharedComposioDesktopOAuth(...args);
        if (changeNoAuthAck && 'noAuth' in result) {
          changeNoAuthAck = false;
          const store = await import('../app/lib/integration-tools/connections/store'), record = await store.getIntegrationConnectionRecord(args[1]); assert(record);
          await store.mutateSharedIntegrationConnection({ userId: 'owner', workspaceId: 'ws-owner' }, args[1], {
            expectedMetadataRevision: record.resource.metadataRevision, expectedGrantsRevision: record.resource.grantsRevision,
            expectedBindingRevision: record.resource.bindingRevision, metadata: { description: 'Own completion changed before mobile confirmation' } });
        }
        if (loseStart) { loseStart = false; throw new Error('own-start-delivery-failure'); } return result;
      } };
    }
    if (name === '@/app/lib/mcp/shared-desktop-oauth') {
      const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/mcp/shared-desktop-oauth');
      return { ...actual, getSharedMcpDesktopOAuthStatus: async (...args: Parameters<typeof actual.getSharedMcpDesktopOAuthStatus>) => {
        const result = await actual.getSharedMcpDesktopOAuthStatus(...args);
        if (lateSessionRevoke) { lateSessionRevoke = false; const sql = await transport.openDb();
          try { await sql.run('DELETE FROM "session" WHERE id=$1', ['session-manager']); } finally { await sql.close(); } }
        return result;
      } };
    }
    try { return originalLoad(name, parent, isMain); }
    catch (error) { if ((error as { code?: string })?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' && /^[a-zA-Z0-9@._/-]{1,160}$/u.test(name)) failedImport ??= name; throw error; }
  };
  return { root, transport, composio, mcpOrigin, exchanges: () => exchanges, mcpRequests: () => mcpRequests,
    failIndex: () => { failIndex = true; }, loseStart: () => { loseStart = true; }, revokeAfterStatus: () => { lateSessionRevoke = true; },
    failDiscovery: (value: boolean) => { failDiscovery = value; }, stateWrites: () => stateWrites,
    changeNoAuthAck: () => { changeNoAuthAck = true; },
    close: async () => {
      const manager = await import('../app/lib/mcp/manager'); await manager.closeAllMcpServers();
      provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await composio.close();
      assert.equal(leases, 0); assert.deepEqual(errors, []); assert.equal(externalRequests, 0); loader._load = originalLoad; globalThis.fetch = originalFetch;
      await database.close(); const current = await fs.lstat(root); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
      assert(current.isDirectory() && !current.isSymbolicLink()); await fs.rm(root, { recursive: true, force: false });
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    } };
}
async function main() {
  const fixture = await createMobileSharedOAuthFixture();
  try {
    const startRoute = await import('../app/api/mobile/v1/integrations/shared-connections/[connectionRef]/oauth/route');
    const flowRoute = await import('../app/api/mobile/v1/integrations/shared-connections/[connectionRef]/oauth/[flowId]/route');
    const mcpCallback = await import('../app/api/mcp/oauth/callback/route'), composioCallback = await import('../app/api/composio/shared/desktop/callback/route');
    const store = await import('../app/lib/integration-tools/connections/store'), sharedMcp = await import('../app/lib/mcp/shared-connections');
    const profiles = await import('../app/lib/composio/composio-shared-profiles'), backend = await import('../app/lib/composio/composio-shared-backend');
    const env = await import('../app/lib/integrations/env-config'), service = await import('../app/lib/mobile/shared-connection-oauth');
    const contracts = await import('../app/lib/mobile/shared-connection-oauth-contracts'), scoped = await import('../app/lib/mobile/scoped-route-v2');
    const owner = { userId: 'owner', workspaceId: 'ws-owner' }, org = { type: 'organization' as const, organizationId: ORG }, team = { type: 'team' as const, organizationId: ORG, workspaceId: 'mobile-team' };
    const grants = [{ targetType: 'user' as const, targetId: 'manager', canUse: false, canManage: true, allowedToolNames: [] }];
    await env.replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-mobile-composio-key' }], { secretScope: 'organization', organizationId: ORG });
    const orgProfile = await profiles.createSharedComposioProfile({ actor: owner, ownership: org, name: 'Designs', providerMode: 'local' });
    const teamProfile = await profiles.createSharedComposioProfile({ actor: owner, ownership: team, name: 'Designs', providerMode: 'local' });
    const createMcp = (isTeam = false) => sharedMcp.createSharedMcpConnection(owner, { ownership: isTeam ? team : org, displayName: 'Designs',
      accessMode: 'restricted', allowedToolNames: [], secrets: [], grants,
      config: { url: `${fixture.mcpOrigin}/mcp`, auth: 'oauth', oauth: { issuer: fixture.mcpOrigin, clientId: 'mobile-shared-client' } } });
    const createComposio = async (isTeam = false, toolkit = 'canva') => store.createSharedIntegrationConnection(owner, { ownership: isTeam ? team : org,
      displayName: 'Designs', accessMode: 'restricted', allowedToolNames: [], grants,
      backend: await backend.prepareSharedComposioConnectionBackend(owner, { ownership: isTeam ? team : org, profileId: isTeam ? teamProfile.id : orgProfile.id, toolkit }) });
    const expected = (record: IntegrationConnectionRecord) => ({ expectedMetadataRevision: record.resource.metadataRevision, expectedGrantsRevision: record.resource.grantsRevision, expectedBindingRevision: record.resource.bindingRevision });
    const current = async (ref: string) => { const value = await store.getIntegrationConnectionRecord(ref); assert(value); return value; };
    const request = (pathname: string, json?: object, session = 'session-manager', workspace = 'ws-manager', extras: Record<string, string> = {}) => new NextRequest(BASE + pathname, {
      method: json ? 'POST' : 'GET', headers: { 'x-test-session': session, 'x-canvas-workspace-id': workspace, ...extras, ...(json ? { 'Content-Type': 'application/json' } : {}) }, ...(json ? { body: JSON.stringify(json) } : {}) });
    const start = (record: IntegrationConnectionRecord, flowId = randomBytes(32).toString('base64url'), extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => startRoute.POST(
      request(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(record.resource.connectionRef)}/oauth`,
        { contractVersion: 2, source: record.resource.source, flowId, ...expected(record), returnUrl: 'canvasnotebook-dev://integration-return', ...extra }, 'session-manager', 'ws-manager', headers),
      { params: Promise.resolve({ connectionRef: record.resource.connectionRef }) });
    const read = (ref: string, flowId: string, session = 'session-manager', workspace = 'ws-manager') => flowRoute.GET(
      request(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(ref)}/oauth/${flowId}`, undefined, session, workspace), { params: Promise.resolve({ connectionRef: ref, flowId }) });
    const decide = (ref: string, flowId: string, action = 'finalize', session = 'session-manager') => flowRoute.POST(
      request(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(ref)}/oauth/${flowId}`, { contractVersion: 2, action }, session), { params: Promise.resolve({ connectionRef: ref, flowId }) });
    const body = async (response: Response) => { const value = await response.json(); if (response.status !== 200) failedResponse = { status: response.status,
      ...(typeof value.code === 'string' && /^[A-Za-z0-9_]{1,100}$/u.test(value.code) ? { code: value.code } : {}) };
      assert.equal(response.status, 200); assert.equal(value.contractVersion, 2); assert.match(response.headers.get('Cache-Control')!, /no-store/u);
      const { authorizationUrl: _authorization, ...safe } = value.data;
      assert.doesNotMatch(JSON.stringify(safe), /authSessionId|profileId|pendingAccountId|composioUserId|desktop_|providerState|codeVerifier|own-mobile-token/u); return value.data; };
    const links = () => fixture.composio.calls.filter(call => call.path.endsWith('/link')).length;
    const first = await createMcp();
    for (const extra of [{ source: 'composio' }, { userId: 'owner' }, { actor: owner }, { authSessionId: 'session-owner' }, { returnUrl: 'https://outside.example.test/' }, { returnUrl: 'canvasnotebook-dev://integration-return?ref=unsafe' }]) {
      const response = await start(first, undefined, extra); assert([400, 409].includes(response.status));
    }
    assert.equal((await start(first, undefined, {}, { Origin: 'https://outside.example.test', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await start(first, undefined, {}, { 'Sec-Fetch-Mode': 'cors' })).status, 403, 'browser-marked origin-less requests stay denied');
    assert.equal(fixture.mcpRequests(), 0); assert.equal(links(), 0);
    for (const record of [first, await createMcp(true)]) {
      const started = await body(await start(record)), flowId = started.flow.flowId as string;
      assert.equal(started.flow.source, 'mcp'); assert.equal(started.flow.status, 'waiting');
      const state = new URL(started.authorizationUrl).searchParams.get('state')!;
      assert.equal(await service.mobileSharedOAuthReturn('composio', state), null, 'provider namespaces cannot cross-route');
      const callback = await mcpCallback.GET(new NextRequest(`${BASE}/api/mcp/oauth/callback?${new URLSearchParams({ state, code: 'own-mobile-code', iss: fixture.mcpOrigin })}`));
      assert.equal(callback.status, 302); assert.equal(callback.headers.get('Location'), `canvasnotebook-dev://integration-return?flowId=${flowId}`);
      assert.equal(callback.headers.get('Referrer-Policy'), 'no-referrer');
      assert.equal((await read(record.resource.connectionRef, flowId, 'session-new-manager')).status, 403);
      assert.equal((await read(record.resource.connectionRef, flowId, 'session-other', 'ws-other')).status, 404);
      assert.equal((await read(record.resource.connectionRef, flowId, 'session-manager', 'mobile-team')).status, 403);
      const before = fixture.exchanges(); assert.equal((await body(await read(record.resource.connectionRef, flowId))).flow.status, 'callback_received'); assert.equal(fixture.exchanges(), before);
      assert.equal((await body(await decide(record.resource.connectionRef, flowId))).flow.status, 'completed');
      assert.equal((await body(await decide(record.resource.connectionRef, flowId))).flow.status, 'completed'); assert.equal(fixture.exchanges(), before + 1);
      assert.equal((await current(record.resource.connectionRef)).resource.bindingRevision, record.resource.bindingRevision + 1);
    }
    const failRecord = await createMcp(), failId = randomBytes(32).toString('base64url'); fixture.failIndex();
    assert.equal((await start(failRecord, failId)).status, 503, 'the actual onCreated locator failure cannot acknowledge successful start');
    assert.equal((await body(await read(failRecord.resource.connectionRef, failId))).flow.status, 'cancelled');
    const beforeFailureReplay = fixture.mcpRequests(); assert.equal((await body(await start(failRecord, failId))).flow.status, 'cancelled'); assert.equal(fixture.mcpRequests(), beforeFailureReplay);
    const discoveryRecord = await createMcp(), discoveryId = randomBytes(32).toString('base64url'), beforeDiscoveryStates = fixture.stateWrites(), beforeDiscoveryExchange = fixture.exchanges();
    fixture.failDiscovery(true); assert.equal((await start(discoveryRecord, discoveryId)).status, 503); fixture.failDiscovery(false);
    assert.equal((await body(await read(discoveryRecord.resource.connectionRef, discoveryId))).flow.status, 'starting');
    assert.equal((await decide(discoveryRecord.resource.connectionRef, discoveryId, 'cancel', 'session-new-manager')).status, 403);
    const beforeDiscoveryReplay = fixture.mcpRequests();
    assert.equal((await body(await decide(discoveryRecord.resource.connectionRef, discoveryId, 'cancel'))).flow.status, 'cancelled');
    assert.equal((await body(await read(discoveryRecord.resource.connectionRef, discoveryId))).flow.status, 'cancelled');
    assert.equal((await body(await start(discoveryRecord, discoveryId))).flow.status, 'cancelled');
    assert.equal(fixture.mcpRequests(), beforeDiscoveryReplay); assert.equal(fixture.exchanges(), beforeDiscoveryExchange); assert.equal(fixture.stateWrites(), beforeDiscoveryStates);
    console.log('PASS actual MCP Org/Team native return, original session, one exchange and onCreated failure without restart.');
    for (const [record, profile] of [[await createComposio(), orgProfile], [await createComposio(true), teamProfile]] as const) {
      fixture.composio.accounts.set(profile.composioUserId, [{ id: `decoy-${randomUUID()}`, toolkit: 'canva', status: 'ACTIVE' }]);
      const started = await body(await start(record)), flowId = started.flow.flowId as string;
      const pending = fixture.composio.accounts.get(profile.composioUserId)?.find(item => item.status === 'INITIATED'); assert(pending);
      const callbackUrl = fixture.composio.completeOAuth(pending.id); assert(callbackUrl);
      const callback = await composioCallback.GET(new NextRequest(callbackUrl)); assert.equal(callback.status, 302);
      assert.equal(callback.headers.get('Location'), `canvasnotebook-dev://integration-return?flowId=${flowId}`); assert.equal(callback.headers.get('Referrer-Policy'), 'no-referrer');
      assert.equal((await body(await read(record.resource.connectionRef, flowId))).flow.status, 'callback_received');
      assert.equal((await decide(record.resource.connectionRef, flowId, 'finalize', 'session-new-manager')).status, 403);
      assert.equal((await body(await decide(record.resource.connectionRef, flowId))).flow.status, 'completed');
      const published = await current(record.resource.connectionRef); assert.equal(published.backend.source, 'composio');
      assert.equal(published.resource.bindingRevision, record.resource.bindingRevision + 1);
      if (published.backend.source === 'composio') { assert.equal(published.backend.connectedAccountId, pending.id); assert.equal(published.backend.profileId, profile.id); }
    }
    const lost = await createComposio(), lostId = randomBytes(32).toString('base64url'); fixture.loseStart();
    assert.equal((await start(lost, lostId)).status, 503); const beforeRecovery = links();
    assert.equal((await body(await read(lost.resource.connectionRef, lostId))).flow.status, 'waiting');
    assert.equal((await body(await start(lost, lostId))).flow.status, 'waiting'); assert.equal(links(), beforeRecovery, 'unconfirmed start is read-only recovery, never another link');
    assert.equal((await body(await decide(lost.resource.connectionRef, lostId, 'cancel'))).flow.status, 'cancelled');
    const noAuth = await createComposio(false, 'duckduckgo'), noAuthId = randomBytes(32).toString('base64url');
    const noAuthResult = await body(await start(noAuth, noAuthId)); assert.equal(noAuthResult.flow.noAuth, true); assert.equal(noAuthResult.flow.status, 'completed'); assert.equal('authorizationUrl' in noAuthResult, false);
    assert.equal((await current(noAuth.resource.connectionRef)).resource.bindingRevision, noAuth.resource.bindingRevision + 1);
    const noAuthLost = await createComposio(false, 'duckduckgo'), noAuthLostId = randomBytes(32).toString('base64url'); fixture.loseStart();
    assert.equal((await start(noAuthLost, noAuthLostId)).status, 503);
    assert.equal((await body(await read(noAuthLost.resource.connectionRef, noAuthLostId))).flow.status, 'starting', 'no receipt means no invented noAuth completion');
    await body(await start(noAuthLost, noAuthLostId)); assert.equal((await current(noAuthLost.resource.connectionRef)).resource.bindingRevision, noAuthLost.resource.bindingRevision + 1, 'unknown noAuth must not republish');
    console.log('PASS two exact Composio profiles/accounts, native collect-only callback, noAuth and lost-start read-only recovery.');
    const issued = await scoped.requireMobileScopedContext(request('/api/mobile/v1/integrations/shared-connections'));
    for (const reason of ['metadata', 'binding', 'profile', 'credentials', 'grants'] as const) {
      const record = await createComposio(false, 'duckduckgo'), flowId = randomBytes(32).toString('base64url');
      const completed = await service.startMobileSharedConnectionOAuth(issued, record.resource.connectionRef, {
        source: 'composio', flowId, ...expected(record), returnUrl: 'canvasnotebook-dev://integration-return' }, BASE);
      assert.equal(completed.flow.status, 'completed'); assert.equal(completed.flow.noAuth, true);
      assert.equal((await service.readMobileSharedConnectionOAuth(issued, record.resource.connectionRef, flowId)).flow.status, 'completed');
      const before = await current(record.resource.connectionRef), priorCalls = fixture.composio.calls.length;
      if (reason === 'metadata' || reason === 'grants') await store.mutateSharedIntegrationConnection(owner, record.resource.connectionRef, {
        ...expected(before), ...(reason === 'metadata' ? { metadata: { description: 'Own confirmed native binding changed' } } : { grants: [] }) });
      if (reason === 'binding') {
        assert.equal(before.backend.source, 'composio');
        await store.publishIntegrationConnectionBinding(owner, record.resource.connectionRef, {
          metadataRevision: before.resource.metadataRevision, grantsRevision: before.resource.grantsRevision, bindingRevision: before.resource.bindingRevision },
        { ...before.backend, source: 'composio', accountBinding: 'pending', connectedAccountId: null });
      }
      if (reason === 'profile') { const sql = await fixture.transport.openDb(); try {
        await sql.run('UPDATE composio_connection_profiles SET profile_revision=profile_revision+1 WHERE id=$1', [orgProfile.id]); } finally { await sql.close(); } }
      if (reason === 'credentials') await env.replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-mobile-composio-key-rotated' }], { secretScope: 'organization', organizationId: ORG });
      for (const operation of ['read', 'finalize', 'cancel'] as const) {
        await assert.rejects(operation === 'read' ? service.readMobileSharedConnectionOAuth(issued, record.resource.connectionRef, flowId)
          : service.decideMobileSharedConnectionOAuth(issued, record.resource.connectionRef, flowId, operation),
        (error: unknown) => error instanceof Error && [403, 409].includes((error as { status?: number }).status ?? 0));
      }
      assert.equal(fixture.composio.calls.length, priorCalls, 'stale NoAuth proof must not dispatch provider I/O');
      if (reason === 'profile') { const sql = await fixture.transport.openDb(); try {
        await sql.run('UPDATE composio_connection_profiles SET profile_revision=profile_revision-1 WHERE id=$1', [orgProfile.id]); } finally { await sql.close(); } }
      if (reason === 'credentials') await env.replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-mobile-composio-key' }], { secretScope: 'organization', organizationId: ORG });
    }
    const ackRace = await createComposio(false, 'duckduckgo'), ackRaceId = randomBytes(32).toString('base64url'); fixture.changeNoAuthAck();
    await assert.rejects(service.startMobileSharedConnectionOAuth(issued, ackRace.resource.connectionRef, {
      source: 'composio', flowId: ackRaceId, ...expected(ackRace), returnUrl: 'canvasnotebook-dev://integration-return' }, BASE), expectMobileSharedOAuthCode('MOBILE_OAUTH_BINDING_CHANGED'));
    assert.equal((await service.readMobileSharedConnectionOAuth(issued, ackRace.resource.connectionRef, ackRaceId)).flow.status, 'starting');
    console.log('PASS known NoAuth ACK proof rejects metadata/binding/profile/credentials/grant changes and pre-confirmation race without provider I/O.');
    const late = await createMcp(), lateFlow = await service.startMobileSharedConnectionOAuth(issued, late.resource.connectionRef, {
      source: 'mcp', flowId: randomBytes(32).toString('base64url'), ...expected(late), returnUrl: 'canvasnotebook-dev://integration-return' }, BASE); fixture.revokeAfterStatus();
    assert.equal((await read(late.resource.connectionRef, lateFlow.flow.flowId)).status, 401, 'fresh final session guard denies after real broker status returned');
    const sql = await fixture.transport.openDb(); try { await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,1000,1000)', ['session-manager', 'manager', randomUUID(), Date.now() + 3600_000]); } finally { await sql.close(); }
    const context = await scoped.requireMobileScopedContext(request('/api/mobile/v1/integrations/shared-connections'));
    await assert.rejects(service.readMobileSharedConnectionOAuth({ ...context }, first.resource.connectionRef, randomBytes(32).toString('base64url')), expectMobileSharedOAuthCode('UNAUTHORIZED'));
    for (const invalid of ['https://outside.example.test', 'canvasnotebook://mcp-return', 'canvasnotebook://integration-return#private']) assert.throws(() => contracts.normalizeMobileSharedOAuthReturnUrl(invalid));
    assert.equal(fixture.composio.calls.filter(call => /\/tools\/execute\//u.test(call.path)).length, 0);
    console.log('PASS v2 strict identity/source/body/native-origin envelope and fresh late-session denial; provider business calls zero.');
  } finally { await fixture.close(); }
}
void main().catch(error => { console.error('Mobile shared OAuth fixture failed.', { name: error instanceof Error ? error.name : 'UnknownError',
  code: error instanceof Error ? (error as { code?: string }).code : undefined,
  failedImport: (error as { code?: string })?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? failedImport : undefined,
  response: failedResponse,
  site: error instanceof Error ? error.stack?.match(/(?:scripts|app)\/[A-Za-z0-9_./\[\]-]+\.[cm]?[jt]sx?:\d+:\d+/u)?.[0] : undefined }); process.exitCode = 1; });
