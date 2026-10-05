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

// Different catalogs and parameter schemas exercise the shared Composio protocol.
// These are controlled API fixtures, not live-provider acceptance tests.
const APP_FIXTURES = [
  { toolkit: 'canva', name: 'Canva', action: 'CANVA_LIST_USER_DESIGNS', params: { query: 'test' },
    properties: { query: { type: 'string' } } },
  { toolkit: 'gmail', name: 'Gmail', action: 'GMAIL_FIXTURE_READ_MESSAGES', params: { limit: 3 },
    properties: { limit: { type: 'integer' } } },
  { toolkit: 'github', name: 'GitHub', action: 'GITHUB_FIXTURE_READ_REPOSITORY', params: { owner: 'fixture', repo: 'sample' },
    properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
  { toolkit: 'slack', name: 'Slack', action: 'SLACK_FIXTURE_READ_CHANNEL', params: { channel_id: 'channel-fixture' },
    properties: { channel_id: { type: 'string' } } },
  { toolkit: 'googledrive', name: 'Google Drive', action: 'GOOGLEDRIVE_FIXTURE_READ_FILES', params: { folder_id: 'folder-fixture' },
    properties: { folder_id: { type: 'string' } } },
];

async function createProviderFixture() {
  const accounts = new Map<string, Map<string, string>>();
  const sessions = new Map<string, string>();
  const calls: ProviderCall[] = [];
  const tools = APP_FIXTURES.map((app) => ({
    slug: app.action, name: `Read ${app.name} fixture records`,
    description: `Read records for the connected ${app.name} user.`,
    toolkit: { slug: app.toolkit, name: app.name }, version: '20261005_00',
    input_parameters: { type: 'object', properties: app.properties, required: Object.keys(app.properties) },
  }));
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
      const filter = url.searchParams.get('statuses');
      const items = Array.from(accounts.get(userId) || []).filter(([, status]) => !filter || filter.split(',').includes(status))
        .map(([toolkit, status]) => ({
        id: `ca_${userId}_${toolkit}`, toolkit: { slug: toolkit }, status, status_reason: null,
        auth_config: { id: `ac_${toolkit}`, is_composio_managed: true, is_disabled: false },
        is_disabled: false, created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z',
      }));
      return send({ items, next_cursor: null, total_pages: 1 });
    }
    if (url.pathname === '/api/v3.1/toolkits') {
      return send({ items: APP_FIXTURES.map((app) => ({ slug: app.toolkit, name: app.name, meta: {}, is_local_toolkit: false, no_auth: false })) });
    }
    if (url.pathname === '/api/v3.1/tool_router/session') {
      const sessionId = `session_${sessions.size}`;
      sessions.set(sessionId, String(body.user_id));
      return send({ session_id: sessionId, config: {}, config_version: 1, mcp: { type: 'http', url: 'https://example.test/mcp' } });
    }
    const link = url.pathname.match(/^\/api\/v3.1\/tool_router\/session\/([^/]+)\/link$/u);
    if (link) {
      const userId = sessions.get(link[1])!;
      const toolkit = String(body.toolkit);
      assert.ok(APP_FIXTURES.some((app) => app.toolkit === toolkit));
      const userAccounts = accounts.get(userId) || new Map<string, string>();
      userAccounts.set(toolkit, 'ACTIVE');
      accounts.set(userId, userAccounts);
      return send({ connected_account_id: `ca_${userId}_${toolkit}`, redirect_url: String(body.callback_url) });
    }
    if (url.pathname === '/api/v3.1/tools') {
      return send({ items: tools.filter((tool) => tool.toolkit.slug === url.searchParams.get('toolkit_slug')), next_cursor: null, total_pages: 1 });
    }
    const schemaTool = tools.find((tool) => url.pathname === `/api/v3.1/tools/${tool.slug}`);
    if (schemaTool) return send(schemaTool);
    const executionTool = tools.find((tool) => url.pathname === `/api/v3.1/tools/execute/${tool.slug}`);
    if (executionTool) {
      const userId = String(body.user_id);
      const active = accounts.get(userId)?.get(executionTool.toolkit.slug) === 'ACTIVE';
      return send({ successful: active, error: active ? null : `${executionTool.toolkit.name} is not connected for this user`,
        data: active ? { toolkit: executionTool.toolkit.slug, owner: userId, params: body.arguments } : {}, log_id: 'fixture-read' });
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
    const contextA = await resolveComposioContext({ userId: 'user-a', workspaceId: workspace.workspaceId });
    const contextB = await resolveComposioContext({ userId: 'user-b', workspaceId: workspace.workspaceId });
    assert.notEqual(contextA.composioUserId, contextB.composioUserId);
    // User B has their own Slack account. That cannot authorize any other app,
    // nor can user A inherit it merely by sharing the workspace.
    provider.accounts.set(contextB.composioUserId, new Map([['slack', 'ACTIVE']]));
    const pluginReadiness = (userId: string, toolkit: string) => resolvePluginConnectionReadiness({
      userId, workspaceId: workspace.workspaceId, fresh: true,
      connectors: { composio: [{ toolkit, required: true }] },
    });
    const gatewayA = await makeGateway('user-a');
    const gatewayB = await makeGateway('user-b');
    const execute = (gateway: typeof gatewayA, app: typeof APP_FIXTURES[number]) => gateway.execute(`read-${app.toolkit}`, {
      action: 'call', operation: 'composio_execute', arguments: { action: app.action, params: app.params },
    }).then(payload);
    for (const [index, app] of APP_FIXTURES.entries()) {
      assert.equal((await execute(gatewayA, app)).successful, false, 'Another user connection cannot authorize this user');
      const connected = await uiConnect(request('user-a', `/api/composio/connect/${app.toolkit}`, 'POST'), { params: Promise.resolve({ toolkit: app.toolkit }) });
      assert.equal(connected.status, 200);
      const callback = await oauthCallback(new NextRequest((await connected.json()).redirectUrl));
      assert.equal(callback.status, 307);
      const uiA = await statusFor('user-a');
      assert.equal(uiA.effectiveProfile.id, contextA.profileId);
      assert.equal(uiA.connectedAccounts.length, index + 1);
      assert.ok(uiA.connectedAccounts.some((account: { toolkit: { slug: string } }) => account.toolkit.slug === app.toolkit));
      assert.equal((await pluginReadiness('user-a', app.toolkit)).ready, true);
      assert.equal((await pluginReadiness('user-b', app.toolkit)).ready, app.toolkit === 'slack');
      const operationSearch = await gatewayA.execute(`find-${app.toolkit}`, { action: 'search', query: app.name });
      assert.equal((operationSearch.details as { fallback: boolean }).fallback, true);
      assert.match(JSON.stringify(operationSearch), /COMPOSIO_SEARCH_TOOLS/u);
      const search = payload(await gatewayA.execute('discover', { action: 'call', operation: 'COMPOSIO_SEARCH_TOOLS', arguments: { toolkits: [app.toolkit] } }));
      assert.deepEqual((search.tools as Array<{ slug: string }>).map((tool) => tool.slug), [app.action]);
      const schemas = payload(await gatewayA.execute('schema', { action: 'call', operation: 'COMPOSIO_GET_TOOL_SCHEMAS', arguments: { tools: [app.action] } }));
      const schema = schemas[app.action] as { type: string; properties: Record<string, unknown> };
      assert.equal(schema.type, 'object');
      assert.deepEqual(schema.properties, app.properties);
      const resultA = await execute(gatewayA, app);
      assert.equal(resultA.successful, true);
      assert.deepEqual(resultA.data, { toolkit: app.toolkit, owner: contextA.composioUserId, params: app.params });
      const resultB = await execute(gatewayB, app);
      assert.equal(resultB.successful, app.toolkit === 'slack');
      assert.deepEqual(resultB.data, app.toolkit === 'slack'
        ? { toolkit: app.toolkit, owner: contextB.composioUserId, params: app.params } : {});
      const executionCalls = provider.calls.filter((call) => call.path.endsWith(`/tools/execute/${app.action}`));
      assert.deepEqual(executionCalls.map((call) => call.body.user_id), [contextA.composioUserId, contextA.composioUserId, contextB.composioUserId]);
      assert.ok(executionCalls.every((call) => JSON.stringify(call.body.arguments) === JSON.stringify(app.params)));
    }
    assert.deepEqual((await statusFor('user-b')).connectedAccounts.map((account: { toolkit: { slug: string } }) => account.toolkit.slug), ['slack']);
    const executionCalls = provider.calls.filter((call) => call.path.includes('/tools/execute/'));
    assert.ok(executionCalls.every((call) => call.body.version === '20261005_00'));
    assert.ok(provider.calls.filter((call) => call.path === '/api/v3.1/tool_router/session').every((call) => call.body.user_id === contextA.composioUserId));
    const profile = await createComposioProfile({ ownerUserId: 'user-a', name: 'Other app accounts' });
    await assert.rejects(setComposioWorkspaceProfileOverride({ userId: 'user-b', workspaceId: workspace.workspaceId, profileId: profile.id }), /not found/u);
    await setComposioWorkspaceProfileOverride({ userId: 'user-a', workspaceId: workspace.workspaceId, profileId: profile.id });
    const switchedContext = await resolveComposioContext({ userId: 'user-a', workspaceId: workspace.workspaceId });
    assert.equal((await statusFor('user-a')).effectiveProfile.id, profile.id);
    const switchedGateway = await makeGateway('user-a');
    for (const app of APP_FIXTURES) {
      assert.equal((await pluginReadiness('user-a', app.toolkit)).ready, false);
      assert.equal((await execute(switchedGateway, app)).successful, false);
      assert.equal(provider.calls.filter((call) => call.path.includes('/tools/execute/')).at(-1)!.body.user_id, switchedContext.composioUserId);
      for (const status of ['ACTIVE', 'EXPIRED', 'REVOKED', 'INACTIVE', 'INITIATED', 'FAILED']) {
        provider.accounts.set(switchedContext.composioUserId, new Map([[app.toolkit, status]]));
        const result = payload(await switchedGateway.execute(`status-${app.toolkit}-${status}`, { action: 'call', operation: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { action: 'status', toolkit: app.toolkit } }));
        assert.equal(result.connected, status === 'ACTIVE', `${app.toolkit}: ${status} must agree with the UI usable-connection state`);
        assert.equal(result.status, status);
        assert.equal(result.profile_id, switchedContext.profileId);
        assert.equal(result.workspace_id, workspace.workspaceId);
        assert.equal((await statusFor('user-a')).connectedAccounts.length, status === 'ACTIVE' ? 1 : 0);
      }
      provider.accounts.delete(switchedContext.composioUserId);
      const missing = payload(await switchedGateway.execute(`status-missing-${app.toolkit}`, { action: 'call', operation: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { action: 'status', toolkit: app.toolkit } }));
      assert.equal(missing.connected, false);
      assert.equal(missing.status, 'NOT_CONNECTED');
    }
    assert.ok(provider.calls.filter((call) => call.path === '/api/v3.1/connected_accounts').every((call) => call.userIds && [contextA.composioUserId, contextB.composioUserId, switchedContext.composioUserId].includes(call.userIds)));
    console.log('composio-agent-user-flow-test: ok (5 app catalogs, real SDK HTTP, UI routes, app/user isolation, profile switch, connection lifecycle)');
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
