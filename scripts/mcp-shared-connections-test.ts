import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { IntegrationConnectionRecord } from '../app/lib/integration-tools/connections/contracts';
import type { McpServerConfig } from '../app/lib/mcp/config';

async function fixture() {
  let origin = '';
  const calls: Array<{ name: string; authorization: string }> = [];
  const forms: URLSearchParams[] = [];
  let requests = 0;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'shared-account', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: ['create_design', 'read_design'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
    server.setRequestHandler('tools/call', async request => ({ content: [{ type: 'text', text: `Executed ${request.params.name}` }] }));
    return server;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    try {
      requests += 1;
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.url === '/.well-known/oauth-authorization-server') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true })); return;
      }
      if (request.url === '/.well-known/oauth-protected-resource/mcp') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] })); return;
      }
      if (request.url === '/token') {
        const form = new URLSearchParams(body); forms.push(form);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert(form.get('code_verifier'));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ access_token: 'shared-oauth-token', token_type: 'Bearer', expires_in: 3600 })); return;
      }
      if (request.url === '/register') {
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ client_id: 'fixture-client' })); return;
      }
      if (body) {
        const rpc = JSON.parse(body);
        if (rpc.method === 'tools/call') calls.push({ name: rpc.params.name, authorization: String(request.headers.authorization ?? '') });
      }
      const result = await handler.fetch(new Request(`${origin}${request.url}`, { method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        ...(body ? { body } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { response.writeHead(500); response.end(error instanceof Error ? error.message : 'fixture error'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, url: `${origin}/mcp`, calls, forms, requests: () => requests,
    close: async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-shared-'));
  const provider = await fixture();
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_INSTANCE_ID: 'mcp-shared-fixture', CANVAS_ORGANIZATION_ID: 'org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: 'false',
    MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_STDIO: 'false',
    INTEGRATIONS_ENV_MASTER_KEY: randomUUID() + randomUUID(), BASE_URL: 'http://localhost:3000' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const database = await createPiTestDatabase();
  console.log('Shared MCP fixture: PostgreSQL schema ready.');
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  let requestActorUserId = 'admin';
  internals._load = (name, parent, main) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async () => ({ user: { id: requestActorUserId } }) } } };
    // Isolated external licensing boundary; current SQL user, owner, membership,
    // workspace and resource grants are real PostgreSQL, without ACL doubles.
    if (name.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: 'org' }) };
    return originalLoad(name, parent, main);
  };
  try {
    const sql = await database.openDb();
    for (const id of ['admin', 'alice', 'bob']) {
      await sql.run('INSERT INTO "user" (id,name,email,role,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'member\',1,1,1)', [id, `${id}@fixture.test`]);
    }
    await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('org','admin','team',1,1,1)");
    for (const id of ['admin', 'alice', 'bob']) {
      await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('org',$1,$2,'active',1,1,1)", [id, id === 'admin' ? 'owner' : 'member']);
      await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'org','personal',$2,$3,$2,'active',1,1)", [`ws-${id}`, id, `workspaces/${id}/files`]);
    }
    await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('team','org','team','workspaces/team/files','Team','active',1,1)");
    const store = await import('../app/lib/integration-tools/connections/store');
    console.log('Shared MCP fixture: current authority seeded.');
    const shared = await import('../app/lib/mcp/shared-connections');
    const oauth = await import('../app/lib/mcp/shared-oauth');
    const manager = await import('../app/lib/mcp/manager');
    const access = await import('../app/lib/mcp/shared-access');
    const admin = { userId: 'admin', workspaceId: 'ws-admin' }, alice = { userId: 'alice', workspaceId: 'ws-alice' }, bob = { userId: 'bob', workspaceId: 'ws-bob' };
    const owner = { type: 'team' as const, organizationId: 'org', workspaceId: 'team' };
    const grants = [{ targetType: 'user' as const, targetId: 'alice', canUse: true, canManage: false, allowedToolNames: ['create_design'] }];
    const rev = (record: IntegrationConnectionRecord) => ({ metadataRevision: record.resource.metadataRevision, grantsRevision: record.resource.grantsRevision, bindingRevision: record.resource.bindingRevision });
    const current = async (ref: string) => (await store.getIntegrationConnectionRecord(ref))!;
    const env = await import('../app/lib/secrets/unified-env-store');
    await env.patchUnifiedEnvEntries([{ key: 'OTHER_ACCOUNT_TOKEN', value: 'foreign-org-token' }], { secretScope: 'organization', organizationId: 'org' });
    const countBeforeInvalid = (await sql.all('SELECT connection_ref FROM integration_connection_resources')).length;
    await assert.rejects(() => shared.createSharedMcpConnection(admin, { ownership: owner, displayName: 'Invalid ENV', grants,
      config: { url: provider.url, headersFromEnv: { Authorization: 'OTHER_ACCOUNT_TOKEN' } } }), { code: 'CONNECTION_CONFIG_INVALID' });
    const invalidConfigurations: McpServerConfig[] = [{ url: provider.url, headers: { Authorization: 'Bearer literal-private-token' } },
      { url: provider.url, headers: { 'X-Custom-Key': 'literal-private-token' } },
      { url: provider.url, oauth: { clientSecret: 'literal-client-secret' } },
      { url: provider.url, oauth: { tokenUrl: `${provider.origin}/token?api_key=literal-private-token` } }];
    for (const config of invalidConfigurations) {
      await assert.rejects(() => shared.createSharedMcpConnection(admin, { ownership: owner, displayName: 'Invalid literal', grants, config }), { code: 'CONNECTION_CONFIG_INVALID' });
    }
    assert.equal((await sql.all('SELECT connection_ref FROM integration_connection_resources')).length, countBeforeInvalid, 'Invalid resource configuration creates no partially configured record.');
    const connection = await shared.createSharedMcpConnection(admin, { ownership: owner, displayName: 'Shared design', grants,
      config: { url: provider.url, headersFromEnv: { Authorization: 'MCP_SLOT_TOKEN' } }, secrets: [{ name: 'TOKEN', value: 'Bearer account-a' }] });
    console.log('Shared MCP fixture: resource configured.');
    assert.equal(connection.resource.bindingRevision, 2);
    const rawConfig = await readFile(path.join(root, 'organizations/org/mcp/shared', connection.backend.source === 'mcp' ? connection.backend.connectionId : '', 'config.json'), 'utf8');
    assert(!rawConfig.includes('Bearer account-a')); assert(!rawConfig.includes('foreign-org-token')); assert(!rawConfig.includes('ownerUserId'));
    const beforeDiscovery = provider.requests();
    await shared.resolveSharedMcpBackend(alice, connection.resource.connectionRef, 'inspect');
    assert.equal(provider.requests(), beforeDiscovery);
    await assert.rejects(() => shared.resolveSharedMcpBackend(bob, connection.resource.connectionRef, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    assert.equal(provider.requests(), beforeDiscovery);
    const aliceBackend = await shared.resolveSharedMcpBackend(alice, connection.resource.connectionRef, 'use', 'create_design');
    await manager.listMcpTools(aliceBackend.serverName, { scope: aliceBackend.scope });
    const requireCopy = Module.createRequire(import.meta.url);
    const managerPath = requireCopy.resolve('../app/lib/mcp/manager');
    const originalManagerModule = requireCopy.cache[managerPath];
    let managerCopy: typeof manager;
    delete requireCopy.cache[managerPath];
    try {
      managerCopy = requireCopy('../app/lib/mcp/manager') as typeof manager;
      assert.notEqual(managerCopy.listMcpTools, manager.listMcpTools, 'The fixture really uses a second bundled manager instance.');
      await managerCopy.listMcpTools(aliceBackend.serverName, { scope: aliceBackend.scope });
    } finally { if (originalManagerModule) requireCopy.cache[managerPath] = originalManagerModule; }
    await manager.callMcpToolWithCurrentMetadata(aliceBackend.serverName, 'create_design', {}, undefined, aliceBackend.scope);
    assert.equal(provider.calls.at(-1)?.authorization, 'Bearer account-a');
    await assert.rejects(() => manager.callMcpToolWithCurrentMetadata(aliceBackend.serverName, 'read_design', {}, undefined, aliceBackend.scope), { code: 'provider_denied' });
    assert.equal(provider.calls.length, 1);

    const updated = await shared.updateSharedMcpSecretSlots(admin, connection.resource.connectionRef, rev(connection), [{ name: 'TOKEN', value: 'Bearer account-b' }]);
    await assert.rejects(() => manager.callMcpToolWithCurrentMetadata(aliceBackend.serverName, 'create_design', {}, undefined, aliceBackend.scope), { code: 'binding_changed' });
    const fresh = await shared.resolveSharedMcpBackend(alice, updated.resource.connectionRef, 'use', 'create_design');
    await manager.callMcpToolWithCurrentMetadata(fresh.serverName, 'create_design', {}, undefined, fresh.scope);
    assert.equal(provider.calls.at(-1)?.authorization, 'Bearer account-b');

    // Actual SQL rollback after resource-bound ENV/file changes, without mocking
    // common authority or publication. An uncommitted marker cannot execute.
    await assert.rejects(() => store.withAuthorizedIntegrationConnection(admin, updated.resource.connectionRef, 'manage', rev(updated), async authority => {
      const { stageSharedMcpBindingPublication } = await import('../app/lib/mcp/shared-publication');
      const { sharedMcpSecretSlot, writeSharedMcpSecretSlot } = await import('../app/lib/mcp/shared-secrets');
      await stageSharedMcpBindingPublication(authority);
      const scope = access.sharedMcpScope(authority);
      await writeSharedMcpSecretSlot(scope, sharedMcpSecretSlot(scope, 'TOKEN'), 'Bearer uncommitted-account');
      throw new Error('Simulated SQL transaction failure');
    }), /Simulated SQL transaction failure/u);
    assert.equal((await current(updated.resource.connectionRef)).resource.bindingRevision, updated.resource.bindingRevision);
    const blockedRequests = provider.requests();
    await assert.rejects(() => shared.resolveSharedMcpBackend(alice, updated.resource.connectionRef, 'use'), { code: 'binding_changed' });
    assert.equal(provider.requests(), blockedRequests);
    const archived = await store.mutateSharedIntegrationConnection(admin, updated.resource.connectionRef, { expectedMetadataRevision: updated.resource.metadataRevision,
      expectedGrantsRevision: updated.resource.grantsRevision, expectedBindingRevision: updated.resource.bindingRevision, status: 'archived' });
    await store.mutateSharedIntegrationConnection(admin, updated.resource.connectionRef, { expectedMetadataRevision: archived.resource.metadataRevision,
      expectedGrantsRevision: archived.resource.grantsRevision, expectedBindingRevision: archived.resource.bindingRevision, status: 'active' });
    await assert.rejects(() => shared.resolveSharedMcpBackend(alice, updated.resource.connectionRef, 'use'), { code: 'binding_changed' });
    const repaired = await shared.updateSharedMcpSecretSlots(admin, updated.resource.connectionRef, rev(await current(updated.resource.connectionRef)), [{ name: 'TOKEN', value: 'Bearer repaired-account' }]);
    const repairedBackend = await shared.resolveSharedMcpBackend(alice, repaired.resource.connectionRef, 'use', 'create_design');
    await manager.callMcpToolWithCurrentMetadata(repairedBackend.serverName, 'create_design', {}, undefined, repairedBackend.scope);
    assert.equal(provider.calls.at(-1)?.authorization, 'Bearer repaired-account');

    const reconnect = await shared.createSharedMcpConnection(admin, { ownership: owner, displayName: 'Configuration reconnect', grants, config: { url: provider.url } });
    const reconnectUpdated = await shared.updateSharedMcpConfiguration(admin, reconnect.resource.connectionRef, rev(reconnect), {
      config: { url: provider.url, bearerTokenEnv: 'MCP_SLOT_TOKEN' }, secrets: [{ name: 'TOKEN', value: 'configuration-account' }] });
    const reconnectArchived = await store.mutateSharedIntegrationConnection(admin, reconnect.resource.connectionRef, { expectedMetadataRevision: reconnectUpdated.resource.metadataRevision,
      expectedGrantsRevision: reconnectUpdated.resource.grantsRevision, expectedBindingRevision: reconnectUpdated.resource.bindingRevision, status: 'archived' });
    await store.mutateSharedIntegrationConnection(admin, reconnect.resource.connectionRef, { expectedMetadataRevision: reconnectArchived.resource.metadataRevision,
      expectedGrantsRevision: reconnectArchived.resource.grantsRevision, expectedBindingRevision: reconnectArchived.resource.bindingRevision, status: 'active' });
    const reconnectBackend = await shared.resolveSharedMcpBackend(alice, reconnect.resource.connectionRef, 'use', 'create_design');
    await manager.callMcpToolWithCurrentMetadata(reconnectBackend.serverName, 'create_design', {}, undefined, reconnectBackend.scope);
    assert.equal(provider.calls.at(-1)?.authorization, 'Bearer configuration-account', 'An explicitly published config reconnect survives independent status revisions.');

    let lateDenied = false;
    let finalDispatchChecks = 0;
    const beforeLate = provider.calls.length;
    await assert.rejects(() => managerCopy.callMcpToolWithCurrentMetadata(repairedBackend.serverName, 'create_design', {}, undefined, repairedBackend.scope, {
      expectedEnvironmentRevision: repairedBackend.environmentRevision,
      beforeDispatch: async () => {
        finalDispatchChecks += 1;
        if (finalDispatchChecks !== 2) return;
        const record = await current(repaired.resource.connectionRef);
        await store.mutateSharedIntegrationConnection(admin, record.resource.connectionRef, { expectedMetadataRevision: record.resource.metadataRevision,
          expectedGrantsRevision: record.resource.grantsRevision, expectedBindingRevision: record.resource.bindingRevision, grants: [] });
        lateDenied = true;
        await access.authorizeSharedMcpScope(repairedBackend.scope);
      },
    }), { code: 'provider_denied' });
    assert(lateDenied); assert.equal(provider.calls.length, beforeLate, 'Final current grant guard prevents the actual tools/call POST.');
    assert.equal(finalDispatchChecks, 2, 'The old cached transport closure executes the later bundle final dispatch guard.');

    const oauthConnection = await shared.createSharedMcpConnection(admin, { ownership: owner, displayName: 'Shared OAuth', grants,
      config: { url: provider.url, auth: 'oauth', oauth: { issuer: provider.origin, authorizationUrl: `${provider.origin}/authorize`, tokenUrl: `${provider.origin}/token`,
        registrationUrl: `${provider.origin}/register`, clientId: 'fixture-client' } } });
    const started = await oauth.startSharedMcpOAuth(admin, oauthConnection.resource.connectionRef, rev(oauthConnection), 'http://localhost:3000');
    assert.equal(started.redirectUri, 'http://localhost:3000/api/mcp/shared-connections/oauth/callback');
    await assert.rejects(() => oauth.completeSharedMcpOAuth(bob, { state: started.state, code: 'auth-code' }), { code: 'CONNECTION_OAUTH_STATE_INVALID' });
    assert.equal(provider.forms.length, 0);
    const authorized = (await oauth.completeSharedMcpOAuth(admin, { state: started.state, code: 'auth-code', issuer: provider.origin }))!;
    assert.equal(authorized.resource.bindingRevision, oauthConnection.resource.bindingRevision + 1);
    const oauthBackend = await shared.resolveSharedMcpBackend(alice, authorized.resource.connectionRef, 'use', 'create_design');
    await manager.callMcpToolWithCurrentMetadata(oauthBackend.serverName, 'create_design', {}, undefined, oauthBackend.scope);
    assert.equal(provider.calls.at(-1)?.authorization, 'Bearer shared-oauth-token', 'Another granted user uses the same organization credential; OAuth manager is not its owner.');
    await assert.rejects(() => oauth.completeSharedMcpOAuth(admin, { state: started.state, code: 'auth-code' }), { code: 'CONNECTION_OAUTH_STATE_INVALID' });
    const staleStart = await oauth.startSharedMcpOAuth(admin, authorized.resource.connectionRef, rev(authorized), 'http://localhost:3000');
    await store.mutateSharedIntegrationConnection(admin, authorized.resource.connectionRef, { expectedMetadataRevision: authorized.resource.metadataRevision,
      expectedGrantsRevision: authorized.resource.grantsRevision, expectedBindingRevision: authorized.resource.bindingRevision, grants: [] });
    const exchangeCount = provider.forms.length;
    await assert.rejects(() => oauth.completeSharedMcpOAuth(admin, { state: staleStart.state, code: 'auth-code' }), { code: 'CONNECTION_REVISION_CONFLICT' });
    assert.equal(provider.forms.length, exchangeCount, 'Stale OAuth revisions cannot exchange/publish credentials.');

    const returns = await import('../app/lib/integration-tools/connections/oauth-return');
    const { NextRequest } = await import('next/server');
    const callbackRoute = await import('../app/api/mcp/shared-connections/oauth/callback/route');
    const oauthRoute = await import('../app/api/mcp/shared-connections/[connectionRef]/oauth/route');
    const returnRecord = await current(authorized.resource.connectionRef);
    const returnContext = returns.createSharedConnectionOAuthReturn(returnRecord.resource, admin, 'de');
    assert.equal(returnContext.workspaceId, admin.workspaceId);
    assert.deepEqual(returnContext.ownership, owner, 'The return team is the actual owner, not the execution workspace.');
    const href = returns.sharedConnectionOAuthReturnHref(returnContext, 'connected');
    const local = new URL(href, 'http://localhost:3000');
    assert.equal(local.pathname, '/de/plugins');
    assert.deepEqual([...local.searchParams.keys()], ['view', 'scope', 'teamId', 'workspaceId', 'connectionRef', 'sharedOAuth']);
    assert.equal(local.searchParams.get('view'), 'advanced'); assert.equal(local.searchParams.get('scope'), 'team');
    assert.equal(local.searchParams.get('teamId'), 'team'); assert.equal(local.hash, '');
    for (const context of [
      { ...returnContext, version: 2 }, { ...returnContext, locale: 'fr' }, { ...returnContext, workspaceId: '' },
      { ...returnContext, state: 'private-state' }, { ...returnContext, returnTo: '//foreign.invalid' },
      { ...returnContext, ownership: { ...owner, backendId: 'private-backend' } },
    ]) assert.throws(() => returns.validateSharedConnectionOAuthReturn(context, returnRecord.resource, admin), { code: 'CONNECTION_OAUTH_RETURN_INVALID' });
    for (const context of [
      { ...returnContext, workspaceId: 'ws-bob' }, { ...returnContext, connectionRef: `canvas-connection:${randomUUID()}` },
      { ...returnContext, ownership: { ...owner, workspaceId: 'another-team' } },
    ]) assert.throws(() => returns.validateSharedConnectionOAuthReturn(context, returnRecord.resource, admin), { code: 'CONNECTION_OAUTH_RETURN_CHANGED' });
    assert.throws(() => returns.sharedConnectionOAuthReturnHref(returnContext, 'unknown' as never), { code: 'CONNECTION_OAUTH_RETURN_INVALID' });
    const beforeInvalidReturn = provider.requests();
    await assert.rejects(() => oauth.startSharedMcpOAuth({ ...admin, workspaceId: null }, returnRecord.resource.connectionRef,
      rev(returnRecord), 'http://localhost:3000', { returnLocale: 'de' }), { code: 'CONNECTION_OAUTH_RETURN_INVALID' });
    assert.equal(provider.requests(), beforeInvalidReturn, 'A missing return workspace rejects before any provider discovery.');

    const localeStart = await oauth.startSharedMcpOAuth(admin, returnRecord.resource.connectionRef, rev(returnRecord), 'http://localhost:3000', { returnLocale: 'de' });
    await assert.rejects(() => oauth.completeSharedMcpOAuthWithReturn(bob, { state: localeStart.state, code: 'auth-code', issuer: provider.origin }), { code: 'CONNECTION_OAUTH_STATE_INVALID' });
    const beforeReturnExchange = provider.forms.length, beforeReturnCalls = provider.calls.length;
    const returned = await callbackRoute.GET(new NextRequest(`http://callback-host.invalid/api/mcp/shared-connections/oauth/callback?${new URLSearchParams({
      state: localeStart.state, code: 'auth-code', iss: provider.origin, returnTo: 'https://foreign.invalid/', returnLocale: 'en',
      workspaceId: 'ws-bob', connectionRef: `canvas-connection:${randomUUID()}`,
    })}`));
    assert.equal(returned.status, 303); assert.equal(returned.headers.get('location'), `http://localhost:3000${href}`);
    assert.equal(returned.headers.get('Cache-Control'), 'no-store'); assert.equal(returned.headers.get('Referrer-Policy'), 'no-referrer');
    assert(!returned.headers.get('location')!.includes(localeStart.state)); assert(!returned.headers.get('location')!.includes('auth-code'));
    assert(!returned.headers.get('location')!.includes(provider.origin));
    assert.equal(provider.forms.length, beforeReturnExchange + 1); assert.equal(provider.calls.length, beforeReturnCalls);
    const afterReturn = await current(returnRecord.resource.connectionRef);
    assert.equal(afterReturn.resource.bindingRevision, returnRecord.resource.bindingRevision + 1);
    assert.equal(afterReturn.resource.metadataRevision, returnRecord.resource.metadataRevision); assert.equal(afterReturn.resource.grantsRevision, returnRecord.resource.grantsRevision);
    const cancelStart = await oauth.startSharedMcpOAuth(admin, afterReturn.resource.connectionRef, rev(afterReturn), 'http://localhost:3000', { returnLocale: 'en' });
    const cancelCount = provider.forms.length;
    const cancelled = await callbackRoute.GET(new NextRequest(`http://callback-host.invalid/api/mcp/shared-connections/oauth/callback?${new URLSearchParams({ state: cancelStart.state, error: 'access_denied', iss: provider.origin })}`));
    const cancelHref = returns.sharedConnectionOAuthReturnHref(returns.createSharedConnectionOAuthReturn(afterReturn.resource, admin, 'en'), 'cancelled');
    assert.equal(cancelled.status, 303); assert.equal(cancelled.headers.get('location'), `http://localhost:3000${cancelHref}`);
    assert.deepEqual(await current(afterReturn.resource.connectionRef), afterReturn); assert.equal(provider.forms.length, cancelCount);
    const replay = await callbackRoute.GET(new NextRequest(`http://localhost:3000/api/mcp/shared-connections/oauth/callback?${new URLSearchParams({ state: cancelStart.state, error: 'access_denied', iss: provider.origin })}`));
    assert.equal(replay.status, 409); assert.equal(replay.headers.get('location'), null);
    const providerError = await oauth.startSharedMcpOAuth(admin, afterReturn.resource.connectionRef, rev(afterReturn), 'http://localhost:3000', { returnLocale: 'en' });
    const failedReturn = await callbackRoute.GET(new NextRequest(`http://localhost:3000/api/mcp/shared-connections/oauth/callback?${new URLSearchParams({ state: providerError.state, error: 'server_error', iss: provider.origin })}`));
    assert.equal(failedReturn.status, 400); assert.equal(failedReturn.headers.get('location'), null); assert.equal(provider.forms.length, cancelCount);
    const legacyCancel = await oauth.startSharedMcpOAuth(admin, afterReturn.resource.connectionRef, rev(afterReturn), 'http://localhost:3000');
    const legacyResponse = await callbackRoute.GET(new NextRequest(`http://localhost:3000/api/mcp/shared-connections/oauth/callback?${new URLSearchParams({ state: legacyCancel.state, error: 'access_denied', iss: provider.origin })}`));
    assert.equal(legacyResponse.status, 200); assert.equal(legacyResponse.headers.get('location'), null);
    assert((await legacyResponse.text()).includes('Shared sign-in was cancelled.'));

    const organizationReturn = await shared.createSharedMcpConnection(admin, { ownership: { type: 'organization', organizationId: 'org' }, displayName: 'Organization browser return',
      config: { url: provider.url, auth: 'oauth' } });
    const requestRevisions = { expectedMetadataRevision: organizationReturn.resource.metadataRevision,
      expectedGrantsRevision: organizationReturn.resource.grantsRevision, expectedBindingRevision: organizationReturn.resource.bindingRevision };
    const beforeInvalidPost = provider.requests();
    for (const fields of [{ returnLocale: 'fr' }, { returnLocale: 'en', returnContext }, { returnLocale: 'en', returnTo: '//foreign.invalid' }]) {
      const rejected = await oauthRoute.POST(new Request('http://localhost:3000/api/mcp/shared-connections/own/oauth', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': admin.workspaceId }, body: JSON.stringify({ ...requestRevisions, ...fields }),
      }), { params: Promise.resolve({ connectionRef: organizationReturn.resource.connectionRef }) });
      assert.equal(rejected.status, 400);
    }
    assert.equal(provider.requests(), beforeInvalidPost, 'Forged public return data never reaches OAuth discovery.');
    const acceptedReturn = await oauthRoute.POST(new Request('http://localhost:3000/api/mcp/shared-connections/own/oauth', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': admin.workspaceId }, body: JSON.stringify({ ...requestRevisions, returnLocale: 'en' }),
    }), { params: Promise.resolve({ connectionRef: organizationReturn.resource.connectionRef }) });
    assert.equal(acceptedReturn.status, 200);
    const acceptedStart = (await acceptedReturn.json()).data;
    assert.deepEqual(Object.keys(acceptedStart).sort(), ['authorizationUrl', 'expiresAt', 'redirectUri', 'state'], 'Public starts never expose private return receipts or origins.');
    const organizationCompleted = await oauth.completeSharedMcpOAuthWithReturn(admin, { state: acceptedStart.state, error: 'access_denied', issuer: provider.origin });
    assert.equal(organizationCompleted.record, null); assert.equal(organizationCompleted.appOrigin, 'http://localhost:3000');
    assert.equal(organizationCompleted.returnContext?.ownership.type, 'organization');
    assert(!returns.sharedConnectionOAuthReturnHref(organizationCompleted.returnContext!, 'cancelled').includes('teamId'));
    console.log('Shared MCP return: exact Org/Team/context, real callback 303, private source origin, strict request fields, cancellation, replay and legacy terminal HTML PASS.');

    const startFile = path.join(root, 'stdio-starts.txt');
    const stdioInput = { ownership: owner, displayName: 'Shared STDIO', grants: [{ ...grants[0], allowedToolNames: ['echo'] }], config: {
      command: process.execPath, args: [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/fixtures/fake-mcp-server.ts')],
      env: { ECHO_PREFIX: '${MCP_SLOT_PREFIX}', MCP_START_FILE: '${MCP_SLOT_START_FILE}' }, timeoutMs: 10000 },
      secrets: [{ name: 'PREFIX', value: 'shared-process' }, { name: 'START_FILE', value: startFile }] };
    await assert.rejects(() => shared.createSharedMcpConnection(admin, stdioInput), { code: 'CONNECTION_MANAGEMENT_REQUIRED' });
    process.env.MCP_ALLOW_STDIO = 'true';
    await assert.rejects(() => shared.createSharedMcpConnection(admin, { ...stdioInput, config: { ...stdioInput.config,
      args: ['--token', 'literal-private-token'] } }), { code: 'CONNECTION_CONFIG_INVALID' });
    await assert.rejects(() => shared.createSharedMcpConnection(admin, { ...stdioInput, config: { ...stdioInput.config,
      env: { API_TOKEN: 'literal-private-token' } } }), { code: 'CONNECTION_CONFIG_INVALID' });
    const stdio = await shared.createSharedMcpConnection(admin, stdioInput);
    const stdioBackend = await shared.resolveSharedMcpBackend(alice, stdio.resource.connectionRef, 'use', 'echo');
    const stdioResult = await manager.callMcpToolWithCurrentMetadata(stdioBackend.serverName, 'echo', { message: 'works' }, undefined, stdioBackend.scope);
    assert(JSON.stringify(stdioResult.result).includes('shared-processworks'));
    const starts = await readFile(startFile, 'utf8');
    await assert.rejects(() => shared.resolveSharedMcpBackend(bob, stdio.resource.connectionRef, 'use'), { code: 'CONNECTION_ACCESS_DENIED' });
    assert.equal(await readFile(startFile, 'utf8'), starts, 'An ungranted actor cannot launch a shared process.');

    const routes = await import('../app/api/mcp/shared-connections/route');
    const request = (body: unknown) => new Request('http://localhost:3000/api/mcp/shared-connections?workspaceId=ws-admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const api = await routes.POST(request({ ownership: { type: 'team', workspaceId: 'team' }, displayName: 'API-created connection', grants,
      config: { url: provider.url, bearerTokenEnv: 'MCP_SLOT_TOKEN' }, secrets: [{ name: 'TOKEN', value: 'api-secret' }] }));
    assert.equal(api.status, 200);
    const apiJson = await api.json();
    assert.equal(apiJson.data.resource.ownership.organizationId, 'org', 'The authenticated API derives organization ownership.');
    assert(!JSON.stringify(apiJson).includes('api-secret')); assert(!JSON.stringify(apiJson).includes('backend'));
    const invalidApi = await routes.POST(request({ ownership: { type: 'organization' }, displayName: 'Forged backend', config: { url: provider.url }, backend: { source: 'mcp', connectionId: randomUUID() } }));
    assert.equal(invalidApi.status, 400);
    requestActorUserId = 'bob';
    const deniedApi = await routes.POST(request({ ownership: { type: 'organization' }, displayName: 'Denied create', config: { url: provider.url } }));
    assert.equal(deniedApi.status, 403, 'Fresh current SQL management authority controls the actual API.');
    console.log('PASS shared MCP: actual PostgreSQL + HTTP/OAuth/STDIO, resource-only encrypted slots, metadata without startup, exact tools, final grant revocation, account rotation, failed publication + explicit repair, status history, manager-bound OAuth and no personal fallback.');
  } finally {
    try { await (await import('../app/lib/mcp/manager')).closeAllMcpServers(); } catch { /* Preserve the primary assertion. */ }
    internals._load = originalLoad;
    await Promise.allSettled([database.close(), provider.close(), rm(root, { recursive: true, force: true })]);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
