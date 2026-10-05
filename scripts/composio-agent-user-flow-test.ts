import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';

type ProviderCall = { path: string; body: Record<string, unknown>; userIds: string | null };

async function createProviderFixture() {
  const accounts = new Map<string, string>();
  const sessions = new Map<string, string>();
  const calls: ProviderCall[] = [];
  const tool = {
    slug: 'CANVA_LIST_USER_DESIGNS', name: 'List User Designs',
    description: 'List designs for the connected Canva user.',
    toolkit: { slug: 'canva', name: 'Canva' }, version: '20261005_00',
    input_parameters: { type: 'object', properties: {}, required: [] },
  };
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const url = new URL(request.url!, 'http://localhost');
    calls.push({ path: url.pathname, body, userIds: url.searchParams.get('user_ids') });
    const send = (payload: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === '/api/v3.1/connected_accounts') {
      const userId = url.searchParams.get('user_ids')!;
      const status = accounts.get(userId);
      const filter = url.searchParams.get('statuses');
      return send({ items: status && (!filter || filter.split(',').includes(status)) ? [{
        id: `ca_${userId}`, toolkit: { slug: 'canva' }, status, status_reason: null,
        auth_config: { id: 'ac_canva', is_composio_managed: true, is_disabled: false },
        is_disabled: false, created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z',
      }] : [], next_cursor: null, total_pages: 1 });
    }
    if (url.pathname === '/api/v3.1/toolkits') {
      return send({ items: [{ slug: 'canva', name: 'Canva', meta: {}, is_local_toolkit: false, no_auth: false }] });
    }
    if (url.pathname === '/api/v3.1/tool_router/session') {
      const sessionId = `session_${sessions.size}`;
      sessions.set(sessionId, String(body.user_id));
      return send({ session_id: sessionId, config: {}, config_version: 1, mcp: { type: 'http', url: 'https://example.test/mcp' } });
    }
    const link = url.pathname.match(/^\/api\/v3.1\/tool_router\/session\/([^/]+)\/link$/u);
    if (link) {
      const userId = sessions.get(link[1])!;
      accounts.set(userId, 'ACTIVE');
      return send({ connected_account_id: `ca_${userId}`, redirect_url: String(body.callback_url) });
    }
    if (url.pathname === '/api/v3.1/tools') {
      assert.equal(url.searchParams.get('toolkit_slug'), 'canva');
      return send({ items: [tool], next_cursor: null, total_pages: 1 });
    }
    if (url.pathname === `/api/v3.1/tools/${tool.slug}`) return send(tool);
    if (url.pathname === `/api/v3.1/tools/execute/${tool.slug}`) {
      const userId = String(body.user_id);
      const active = accounts.get(userId) === 'ACTIVE';
      return send({ successful: active, error: active ? null : 'Canva is not connected for this user',
        data: active ? { designs: [{ id: `design_${userId}` }], owner: userId } : {}, log_id: 'fixture-read' });
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: `Unexpected fixture endpoint: ${url.pathname}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return { accounts, calls, baseUrl: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find((item) => item.type === 'text')!.text!);
}

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-composio-flow-'));
  const testDb = await createPiTestDatabase();
  const provider = await createProviderFixture();
  process.env.DATA = dataDir;
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.COMPOSIO_BASE_URL = provider.baseUrl;
  process.env.CANVAS_MANAGED_SERVICES_ENABLED = 'false';
  process.env.BASE_URL = 'http://localhost:3000';
  const workspace = { workspaceId: 'composio-flow-workspace', workspaceType: 'team',
    organizationId: 'composio-flow-org', displayName: 'Composio test', legacy: false };
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return testDb;
    if (request === '@/app/lib/pi/session-workspace-context') return {
      resolveAgentSessionWorkspaceForUser: async ({ userId }: { userId: string }) => {
        assert.ok(['user-a', 'user-b'].includes(userId));
        return workspace;
      },
    };
    if (request === '@/app/lib/workspaces/request') return {
      requireRequestWorkspace: async (request: NextRequest) => ({
        session: { user: { id: request.headers.get('x-test-user') } }, workspace, response: null,
      }),
    };
    if (request === '@/app/lib/pi/tool-output-preparation') return {
      prepareToolOutput: async ({ result }: { result: unknown }) => result,
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const database = await testDb.openDb();
    for (const userId of ['user-a', 'user-b']) {
      await database.run('INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,$1,$2,1,1,1)', [userId, `${userId}@example.test`]);
    }
    await database.run("INSERT INTO canvas_organization_settings (organization_id, owner_user_id, created_at, updated_at) VALUES ('composio-flow-org','user-a',1,1)");
    await database.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,created_at,updated_at) VALUES ('composio-flow-workspace','composio-flow-org','team','workspaces/composio-flow','Composio test',1,1)");
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'fixture-key' }], { secretScope: 'legacy' });
    const { resolveComposioContext } = await import('../app/lib/composio/composio-context');
    const { createComposioTools } = await import('../app/lib/composio/composio-tools');
    const { createProgressiveGatewayTool, PROGRESSIVE_GATEWAY_DEFINITIONS } = await import('../app/lib/pi/progressive-tool-gateway');
    const { GET: uiStatus } = await import('../app/api/composio/status/route');
    const { POST: uiConnect } = await import('../app/api/composio/connect/[toolkit]/route');
    const { GET: oauthCallback } = await import('../app/api/composio/callback/route');
    const { createComposioProfile, setComposioWorkspaceProfileOverride } = await import('../app/lib/composio/composio-profiles');
    const { resolvePluginConnectionReadiness } = await import('../app/lib/plugins/plugin-connection-readiness');
    const definition = PROGRESSIVE_GATEWAY_DEFINITIONS.find((item) => item.name === 'composio')!;
    const request = (userId: string, url: string, method = 'GET') => new NextRequest(`http://localhost:3000${url}`, { method, headers: { 'x-test-user': userId } });
    const makeGateway = async (userId: string) => createProgressiveGatewayTool(definition,
      createComposioTools(await resolveComposioContext({ userId, workspaceId: workspace.workspaceId })));
    const statusFor = async (userId: string) => (await uiStatus(request(userId, '/api/composio/status'))).json();
    const connected = await uiConnect(request('user-a', '/api/composio/connect/canva', 'POST'), { params: Promise.resolve({ toolkit: 'canva' }) });
    assert.equal(connected.status, 200);
    const connection = await connected.json();
    const callback = await oauthCallback(new NextRequest(connection.redirectUrl));
    assert.equal(callback.status, 307);
    const contextA = await resolveComposioContext({ userId: 'user-a', workspaceId: workspace.workspaceId });
    const contextB = await resolveComposioContext({ userId: 'user-b', workspaceId: workspace.workspaceId });
    assert.notEqual(contextA.composioUserId, contextB.composioUserId);
    const uiA = await statusFor('user-a');
    assert.equal(uiA.effectiveProfile.id, contextA.profileId);
    assert.equal(uiA.connectedAccounts.length, 1);
    assert.equal((await statusFor('user-b')).connectedAccounts.length, 0);
    const pluginReadiness = (userId: string) => resolvePluginConnectionReadiness({
      userId, workspaceId: workspace.workspaceId, fresh: true,
      connectors: { composio: [{ toolkit: 'canva', required: true }] },
    });
    assert.equal((await pluginReadiness('user-a')).ready, true);
    assert.equal((await pluginReadiness('user-b')).ready, false);
    const gatewayA = await makeGateway('user-a');
    const operationSearch = await gatewayA.execute('find-canva', { action: 'search', query: 'Canva' });
    assert.equal((operationSearch.details as { fallback: boolean }).fallback, true);
    assert.match(JSON.stringify(operationSearch), /COMPOSIO_SEARCH_TOOLS/u);
    const search = payload(await gatewayA.execute('discover', { action: 'call', operation: 'COMPOSIO_SEARCH_TOOLS', arguments: { toolkits: ['canva'] } }));
    assert.equal((search.tools as Array<{ slug: string }>)[0].slug, 'CANVA_LIST_USER_DESIGNS');
    const schemas = payload(await gatewayA.execute('schema', { action: 'call', operation: 'COMPOSIO_GET_TOOL_SCHEMAS', arguments: { tools: ['CANVA_LIST_USER_DESIGNS'] } }));
    assert.equal((schemas.CANVA_LIST_USER_DESIGNS as { type: string }).type, 'object');
    const execute = (gateway: typeof gatewayA) => gateway.execute('read-designs', { action: 'call', operation: 'composio_execute', arguments: { action: 'CANVA_LIST_USER_DESIGNS', params: {} } }).then(payload);
    const resultA = await execute(gatewayA);
    assert.equal(resultA.successful, true);
    assert.equal((resultA.data as { owner: string }).owner, contextA.composioUserId);
    const resultB = await execute(await makeGateway('user-b'));
    assert.equal(resultB.successful, false);
    assert.deepEqual(resultB.data, {});
    const executionCalls = provider.calls.filter((call) => call.path.includes('/tools/execute/'));
    assert.deepEqual(executionCalls.map((call) => call.body.user_id), [contextA.composioUserId, contextB.composioUserId]);
    assert.ok(executionCalls.every((call) => call.body.version === '20261005_00'));
    assert.equal(provider.calls.find((call) => call.path === '/api/v3.1/tool_router/session')!.body.user_id, contextA.composioUserId);
    const profile = await createComposioProfile({ ownerUserId: 'user-a', name: 'Other Canva account' });
    await assert.rejects(setComposioWorkspaceProfileOverride({ userId: 'user-b', workspaceId: workspace.workspaceId, profileId: profile.id }), /not found/u);
    await setComposioWorkspaceProfileOverride({ userId: 'user-a', workspaceId: workspace.workspaceId, profileId: profile.id });
    const switchedContext = await resolveComposioContext({ userId: 'user-a', workspaceId: workspace.workspaceId });
    assert.equal((await statusFor('user-a')).effectiveProfile.id, profile.id);
    assert.equal((await pluginReadiness('user-a')).ready, false);
    assert.equal((await execute(await makeGateway('user-a'))).successful, false);
    assert.equal(provider.calls.filter((call) => call.path.includes('/tools/execute/')).at(-1)!.body.user_id, switchedContext.composioUserId);
    const switchedGateway = await makeGateway('user-a');
    for (const status of ['ACTIVE', 'EXPIRED', 'REVOKED', 'INACTIVE', 'INITIATED', 'FAILED']) {
      provider.accounts.set(switchedContext.composioUserId, status);
      const result = payload(await switchedGateway.execute(`status-${status}`, { action: 'call', operation: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { action: 'status', toolkit: 'canva' } }));
      assert.equal(result.connected, status === 'ACTIVE', `${status} must agree with the UI usable-connection state`);
      assert.equal(result.status, status);
      assert.equal(result.profile_id, switchedContext.profileId);
      assert.equal(result.workspace_id, workspace.workspaceId);
    }
    provider.accounts.delete(switchedContext.composioUserId);
    const missing = payload(await switchedGateway.execute('status-missing', { action: 'call', operation: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { action: 'status', toolkit: 'canva' } }));
    assert.equal(missing.connected, false);
    assert.equal(missing.status, 'NOT_CONNECTED');
    console.log('composio-agent-user-flow-test: ok (real SDK HTTP, UI routes, two users, profile switch, connection lifecycle)');
  } finally {
    internals._load = originalLoad;
    await provider.close();
    await testDb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
