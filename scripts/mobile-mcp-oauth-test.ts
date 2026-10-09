import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

async function main() {
  const originalEnv = { ...process.env }, dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-mcp-oauth-'));
  const access = installMcpAccessMocks();
  for (const userId of ['alice', 'bob']) access.memberships.set(userId, { organizationId: 'fixture-org', role: 'admin', status: 'active' });
  const sessions = new Map(['alice', 'bob'].map(userId => [`session-${userId}`, { user_id: userId, expires_at: Date.now() + 3600_000, banned: 0 }]));
  sessions.set('another-session', { user_id: 'alice', expires_at: Date.now() + 3600_000, banned: 0 });
  const unavailableWorkspaces = new Set<string>();
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db') return { openDb: async () => ({
      get: async (query: string, params: unknown[]) => {
        assert.match(query, /^SELECT s\.user_id,s\.expires_at,u\.banned FROM "session"/u);
        return sessions.get(String(params[0]));
      }, close: async () => undefined,
    }) };
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user'); return id ? { user: { id }, session: { id: headers.get('x-test-session') || `session-${id}` } } : null;
    } } } };
    if (name === '@/app/lib/workspaces/request') return { requireRequestWorkspace: async (request: NextRequest, options: { workspaceId: string; permissions: string }) => {
      assert.equal(options.permissions, 'canRead');
      const userId = request.headers.get('x-test-user');
      if (!userId) return { response: NextResponse.json({}, { status: 401 }) };
      if (options.workspaceId !== 'workspace-proof' && options.workspaceId !== 'workspace-other') return { response: NextResponse.json({}, { status: 403 }) };
      return { response: null, session: { user: { id: userId }, session: { id: request.headers.get('x-test-session') || `session-${userId}` } }, workspace: { workspaceId: options.workspaceId, status: 'active' } };
    }, requireSessionWorkspace: async (session: unknown, options: { workspaceId: string; permissions: string }) => {
      assert.equal(options.permissions, 'canRead');
      return unavailableWorkspaces.has(options.workspaceId) ? { response: NextResponse.json({}, { status: 404 }) }
        : { response: null, session, workspace: { workspaceId: options.workspaceId, status: 'active' } };
    } };
    return originalLoad(name, parent, isMain);
  };
  process.env.CANVAS_DATA_ROOT = dataRoot; process.env.BASE_URL = 'http://canvas.test';
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true'; process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
  delete process.env.CANVAS_SECRETS_MASTER_KEY; delete process.env.MCP_OAUTH_BASE_URL;
  let providerOrigin = '', exchanges = 0, toolLists = 0, businessCalls = 0;
  let duringTokenExchange: (() => void) | null = null;
  const mcpHandler = createMcpHandler(() => {
    const server = new Server({ name: 'mobile-connection-proof', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => { toolLists++; return { tools: [{ name: 'proof_business', description: 'Explicit approval required.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }; });
    server.setRequestHandler('tools/call', async () => { businessCalls++; return { content: [{ type: 'text', text: 'business proof' }] }; });
    return server;
  }, { legacy: 'reject' });
  const fixture = http.createServer(async (req, res) => {
    if (req.url === '/mcp') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) { if (Array.isArray(value)) value.forEach(entry => headers.append(name, entry)); else if (value !== undefined) headers.set(name, value); }
      const result = await mcpHandler.fetch(new Request(`${providerOrigin}/mcp`, { method: req.method, headers, ...(body.length ? { body: body.toString('utf8') } : {}) }));
      res.writeHead(result.status, Object.fromEntries(result.headers.entries())); res.end(Buffer.from(await result.arrayBuffer())); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.end(JSON.stringify({ issuer: providerOrigin, authorization_endpoint: `${providerOrigin}/authorize`, token_endpoint: `${providerOrigin}/token`,
        code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true })); return;
    }
    if (req.url === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      assert.equal(form.get('redirect_uri'), 'http://canvas.test/api/mcp/oauth/callback'); assert.ok(form.get('code_verifier'));
      assert.equal(form.get('grant_type'), 'authorization_code'); exchanges++;
      duringTokenExchange?.(); duringTokenExchange = null;
      res.end(JSON.stringify({ access_token: 'mobile-provider-token', refresh_token: 'mobile-provider-refresh', token_type: 'Bearer', expires_in: 3600 })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address(); assert.ok(address && typeof address !== 'string'); providerOrigin = `http://127.0.0.1:${address.port}`;
  const originalNow = Date.now;
  try {
    const config = await import('../app/lib/mcp/config');
    const connections = await import('../app/lib/mobile/mcp-connections');
    const oauth = await import('../app/lib/mcp/oauth');
    const credentials = await import('../app/lib/mcp/credential-storage');
    const storage = await import('../app/lib/mcp/storage');
    const callbackRoute = await import('../app/api/mcp/oauth/callback/route');
    const startRoute = await import('../app/api/mobile/v1/integrations/mcp/oauth/route');
    const flowRoute = await import('../app/api/mobile/v1/integrations/mcp/oauth/[flowId]/route');
    const listRoute = await import('../app/api/mobile/v1/integrations/mcp/connections/route');
    const connectionRoute = await import('../app/api/mobile/v1/integrations/mcp/connections/[connectionId]/route');
    await config.writeMcpConfigRaw(JSON.stringify({ mcpServers: { remote: { url: `${providerOrigin}/mcp`, auth: 'oauth', oauth: { issuer: providerOrigin, clientId: 'mobile-client' } } } }), { userId: 'alice' });
    const connection = (await config.readMcpConfig({ userId: 'alice' })).mcpServers.remote, connectionId = connection.connectionId!;
    const revision = connections.mobileMcpConnectionRevision(connection), returnUrl = 'canvasnotebook-dev://mcp-return';
    const request = (url: string, userId: string | null = 'alice', body?: object, options: { workspaceId?: string; sessionId?: string; noWorkspace?: boolean } = {}) => {
      const headers = new Headers(); if (userId) headers.set('x-test-user', userId);
      if (!options.noWorkspace) headers.set('x-canvas-workspace-id', options.workspaceId ?? 'workspace-proof');
      if (options.sessionId) headers.set('x-test-session', options.sessionId);
      if (body) headers.set('content-type', 'application/json');
      return new NextRequest(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    };
    const start = async (extra = {}) => startRoute.POST(request('http://canvas.test/api/mobile/v1/integrations/mcp/oauth', 'alice', { contractVersion: 1, connectionId, revision, returnUrl, ...extra }));
    const get = (flowId: string, userId: string | null = 'alice', options = {}) => flowRoute.GET(request('http://canvas.test/api/mobile/v1/integrations/mcp/oauth/flow', userId, undefined, options), { params: Promise.resolve({ flowId }) });
    const decide = (flowId: string, userId: string | null = 'alice', action: unknown = 'finalize', options = {}) => flowRoute.POST(request('http://canvas.test/api/mobile/v1/integrations/mcp/oauth/flow', userId, { contractVersion: 1, action }, options), { params: Promise.resolve({ flowId }) });
    const callback = (state: string, issuer = providerOrigin, error?: string) => {
      const url = new URL('http://canvas.test/api/mcp/oauth/callback'); url.searchParams.set('state', state); url.searchParams.set('iss', issuer);
      url.searchParams.set(error ? 'error' : 'code', error || 'mobile-provider-code');
      return callbackRoute.GET(request(url.toString(), null));
    };
    assert.equal((await listRoute.GET(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections', null))).status, 401);
    assert.equal((await listRoute.GET(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections', 'alice', undefined, { noWorkspace: true }))).status, 400);
    const list = await listRoute.GET(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections'));
    assert.equal(list.status, 200); const listed = await list.json();
    assert.equal(listed.contractVersion, 1); assert.equal(listed.workspaceId, 'workspace-proof'); assert.equal(listed.connections[0].connectionId, connectionId);
    assert.doesNotMatch(JSON.stringify(listed), /configPath|cachePath|codeVerifier|clientId|providerOrigin|\/mcp/u, 'status projects public fields only');
    assert.equal(exchanges, 0, 'connection status never exchanges tokens');
    for (const bad of ['https://evil.example/return', `${returnUrl}?code=private`, 'canvasnotebook-dev://other', `${returnUrl}#private`]) assert.equal((await start({ returnUrl: bad })).status, 400);
    assert.equal((await start({ revision: 'f'.repeat(64) })).status, 409);
    assert.equal((await start({ extra: 'not-in-contract' })).status, 400);
    assert.equal((await start({ userId: 'bob' })).status, 400);
    assert.equal((await start({ authSessionId: 'session-bob' })).status, 400);
    assert.equal((await listRoute.GET(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections?workspaceId=workspace-other'))).status, 400);
    assert.equal((await listRoute.GET(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections?workspaceId=workspace-proof&workspaceId=workspace-proof'))).status, 400);
    const begun = await start(); assert.equal(begun.status, 200); const started = await begun.json();
    const flowId = started.flow.flowId as string, desktopState = new URL(started.authorizationUrl).searchParams.get('state')!;
    assert.match(flowId, /^[A-Za-z0-9_-]{43}$/u); assert.match(desktopState, /^desktop_[A-Za-z0-9_-]{32}$/u);
    assert.equal(started.returnUrl, `${returnUrl}?flowId=${flowId}`);
    assert.equal(new URL(started.authorizationUrl).searchParams.get('redirect_uri'), 'http://canvas.test/api/mcp/oauth/callback', 'provider redirect remains existing server callback');
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
    const relative = `mobile-oauth-flows/${digest(flowId)}.json`, indexRelative = `mobile-oauth-states/${digest(desktopState)}.json`;
    const record = await credentials.readMcpCredentialJson<Record<string, unknown>>(relative, { legacy: true });
    const index = await credentials.readMcpCredentialJson(indexRelative, { legacy: true });
    assert.deepEqual(index, record, 'both durable locators exist before authorization URL leaves facade');
    assert.equal(record?.userId, 'alice'); assert.equal(record?.authSessionId, 'session-alice'); assert.equal(record?.workspaceId, 'workspace-proof'); assert.equal(record?.connectionId, connectionId);
    assert.equal(record?.connectionRevision, revision);
    const disk = await fs.readFile(storage.resolveMcpStoragePath(relative, { legacy: true }), 'utf8');
    assert.doesNotMatch(disk, /alice|session-alice|workspace-proof|desktop_|mcp-return/u, 'owner locator is encrypted');
    assert.equal((await get(flowId, null)).status, 401); assert.equal((await get(flowId, 'bob')).status, 404);
    assert.equal((await get(flowId, 'alice', { sessionId: 'another-session' })).status, 403);
    assert.equal((await get(flowId, 'alice', { workspaceId: 'workspace-other' })).status, 403);
    assert.equal((await get('../secret')).status, 404);
    assert.equal((await decide(flowId, 'alice', ['finalize'])).status, 400);
    await assert.rejects(connections.readMobileMcpConnections({ userId: 'alice', authSessionId: 'session-alice', workspaceId: 'workspace-proof', actor: { userId: 'alice', organizationId: 'fixture-org', canManageDefinitions: true } }),
      { code: 'UNAUTHORIZED' }, 'serialized contexts have no authority');
    assert.equal((await decide(flowId)).status, 200, 'finalize while waiting is a pure status response'); assert.equal(exchanges, 0);
    const captured = await callback(desktopState); assert.equal(captured.status, 302);
    assert.equal(captured.headers.get('location'), `${returnUrl}?flowId=${flowId}`);
    assert.doesNotMatch(captured.headers.get('location')!, /code=|state=|token|verifier|challenge/u, 'app return only contains opaque mobile locator');
    assert.equal(captured.headers.get('referrer-policy'), 'no-referrer'); assert.equal(exchanges, 0, 'public callback captures but cannot exchange');
    assert.equal((await (await get(flowId)).json()).flow.status, 'callback_received'); assert.equal(exchanges, 0);
    for (const denied of [decide(flowId, 'bob'), decide(flowId, 'alice', 'finalize', { sessionId: 'another-session' }), decide(flowId, 'alice', 'finalize', { workspaceId: 'workspace-other' })]) assert.ok([403, 404].includes((await denied).status));
    assert.equal(exchanges, 0, 'scope denials exchange no tokens');
    const finalized = await decide(flowId); assert.equal(finalized.status, 200); const finalBody = await finalized.json();
    assert.equal(finalBody.flow.status, 'completed'); assert.equal(exchanges, 1);
    assert.doesNotMatch(JSON.stringify(finalBody), /desktop_|mobile-provider-code|mobile-provider-token|mobile-provider-refresh|codeVerifier/u);
    assert.equal((await decide(flowId)).status, 200); assert.equal(exchanges, 1, 'owner finalize is idempotent');
    const connectionContext = { params: Promise.resolve({ connectionId }) };
    const statusBefore = await connectionRoute.GET(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections/connection'), connectionContext);
    assert.equal(statusBefore.status, 200); assert.equal(toolLists, 0); assert.equal(businessCalls, 0, 'GET status cannot dispatch business tools or list tools');
    const currentRevision = (await statusBefore.json()).connections[0].revision;
    const staleTest = await connectionRoute.POST(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections/connection', 'alice', { contractVersion: 1, action: 'test', revision: 'f'.repeat(64) }), connectionContext);
    assert.equal(staleTest.status, 409); assert.equal(toolLists, 0);
    for (const action of ['test', 'reconnect']) {
      const tested = await connectionRoute.POST(request('http://canvas.test/api/mobile/v1/integrations/mcp/connections/connection', 'alice', { contractVersion: 1, action, revision: currentRevision }), connectionContext);
      assert.equal(tested.status, 200); const proof = await tested.json(); assert.equal(proof.toolCount, 1); assert.equal(proof.connections[0].connected, true);
    }
    assert.ok(toolLists >= 2, 'explicit Test and Reconnect both use real SDK tool discovery'); assert.equal(businessCalls, 0, 'real SDK discovery never invokes business tool');
    assert.equal((await callback(desktopState)).status, 409, 'public callback is single use');
    const ordinary = await oauth.startMcpOAuth(connectionId, 'http://canvas.test', { userId: 'alice' }, { desktop: true });
    const ordinaryCallback = await callback(ordinary.state); assert.equal(ordinaryCallback.status, 200); assert.equal(ordinaryCallback.headers.get('location'), null, 'nonmobile desktop callbacks retain HTML behavior');
    const cancelled = await (await start()).json(); assert.equal((await decide(cancelled.flow.flowId, 'alice', 'cancel')).status, 200);
    assert.equal((await (await get(cancelled.flow.flowId)).json()).flow.status, 'cancelled');
    const badIssuer = await (await start()).json(); assert.equal((await callback(new URL(badIssuer.authorizationUrl).searchParams.get('state')!, 'https://wrong.example')).status, 400);
    assert.equal((await (await get(badIssuer.flow.flowId)).json()).flow.status, 'failed');
    const denied = await (await start()).json(); const deniedCallback = await callback(new URL(denied.authorizationUrl).searchParams.get('state')!, providerOrigin, 'access_denied');
    assert.equal(deniedCallback.status, 302); assert.equal((await (await get(denied.flow.flowId)).json()).flow.status, 'cancelled');
    const expired = await (await start()).json(); Date.now = () => Date.parse(expired.flow.expiresAt) + 1;
    assert.equal((await (await get(expired.flow.flowId)).json()).flow.status, 'expired'); Date.now = originalNow;
    assert.equal(exchanges, 1);
    unavailableWorkspaces.add('workspace-proof');
    assert.equal((await get(flowId)).status, 404); unavailableWorkspaces.clear();
    const revoked = await (await start()).json();
    await callback(new URL(revoked.authorizationUrl).searchParams.get('state')!);
    const beforeRevokedExchange = exchanges;
    sessions.delete('session-alice');
    assert.equal((await decide(revoked.flow.flowId)).status, 401);
    assert.equal(exchanges, beforeRevokedExchange, 'deleted original auth session denies before exchange');
    sessions.set('session-alice', { user_id: 'alice', expires_at: Date.now() + 3600_000, banned: 0 });
    const lateRevoked = await (await start()).json();
    await callback(new URL(lateRevoked.authorizationUrl).searchParams.get('state')!);
    duringTokenExchange = () => { sessions.delete('session-alice'); };
    assert.equal((await decide(lateRevoked.flow.flowId)).status, 401, 'session deleted during exchange is denied at token commit');
    sessions.set('session-alice', { user_id: 'alice', expires_at: Date.now() + 3600_000, banned: 0 });
    const afterLateRevocation = await oauth.getMcpOAuthStatus(connectionId, null, { userId: 'alice' });
    assert.notEqual(afterLateRevocation.lastCompletedState, new URL(lateRevoked.authorizationUrl).searchParams.get('state'), 'late session revocation cannot publish returned tokens');
    access.memberships.set('alice', { organizationId: 'fixture-org', role: 'admin', status: 'suspended' });
    assert.equal((await get(flowId)).status, 403, 'current seat/membership gates are preserved');
    console.log('Mobile MCP OAuth facade: sealed owner/session/workspace locator, fixed return, scope denial, no-exchange status, idempotent finalize and legacy callback passed.');
  } finally {
    Date.now = originalNow; internals._load = originalLoad; access.restore();
    const manager = await import('../app/lib/mcp/manager'); await manager.closeAllMcpServers();
    await mcpHandler.close(); fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    process.env = originalEnv; await fs.rm(dataRoot, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
