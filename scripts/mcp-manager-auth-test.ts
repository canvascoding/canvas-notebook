import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request.includes('license/seat-limit')) return { assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: 'fixture-org' }) };
  if (request.includes('organization/permissions')) return {
    readOrganizationPermissionForUser: async () => ({ configured: true, organizationId: 'fixture-org', permission: { role: 'admin', status: 'active' } }),
    assertUserOrganizationAdmin: async () => undefined,
  };
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-manager-auth-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  let url = '';
  let rejectCall = false;
  let refreshes = 0;
  let executions = 0;
  let rejectedCalls = 0;
  let pendingToolCallRelease: ReturnType<typeof deferred> | null = null;
  let toolCallEntered = deferred();
  const authorizations: string[] = [];
  const methods: string[] = [];
  const handler = createMcpHandler(() => {
    const mcp = new Server({ name: 'auth-fixture', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'change', inputSchema: { type: 'object' } }] }));
    mcp.setRequestHandler('tools/call', async () => {
      executions += 1;
      const release = pendingToolCallRelease;
      if (release) {
        pendingToolCallRelease = null;
        toolCallEntered.resolve();
        await release.promise;
      }
      return { content: [{ type: 'text', text: 'changed' }] };
    });
    return mcp;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    if (request.url === '/.well-known/oauth-authorization-server') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, code_challenge_methods_supported: ['S256'],
      }));
      return;
    }
    if (request.url === '/token') {
      refreshes += 1;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `renewed-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 3600, token_type: 'Bearer' }));
      return;
    }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (body) methods.push(JSON.parse(body).method);
    authorizations.push(request.headers.authorization || '');
    if (body && JSON.parse(body).method === 'tools/call' && rejectCall) {
      rejectedCalls += 1;
      response.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' }).end();
      return;
    }
    const result = await handler.fetch(new Request(`${url}${request.url}`, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      ...(body ? { body } : {}),
    }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  url = `http://127.0.0.1:${address.port}`;
  const scope = { userId: 'manager-oauth-user' };
  const credentialScope = { userId: scope.userId, organizationId: 'fixture-org' };
  const otherScope = { userId: 'manager-other-user' };
  const { readMcpConfig, writeMcpConfigRaw, setMcpServerEnabled } = await import('../app/lib/mcp/config');
  const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');
  const { writeMcpCredentialJson, readMcpCredentialJson } = await import('../app/lib/mcp/credential-storage');
  const { callMcpTool, listMcpTools, getMcpRuntimeStatus, probeMcpConnection, closeAllMcpServers } = await import('../app/lib/mcp/manager');
  const { recordMcpConnectionObservation } = await import('../app/lib/mcp/connection-health');
  const { completeMcpOAuthLifecycle } = await import('../app/lib/mcp/oauth-lifecycle');
  const { clearMcpOAuth } = await import('../app/lib/mcp/oauth');
  const { buildDirectMcpTools } = await import('../app/lib/mcp/direct-tools');
  try {
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { remote: { url: `${url}/mcp`, auth: 'oauth', organizationId: 'fixture-org', oauth: { issuer: url, authorizationUrl: `${url}/authorize`, tokenUrl: `${url}/token`, clientId: 'fixture' } } } }), scope);
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { other: { url: `${url}/mcp`, auth: 'none', organizationId: 'fixture-org' } } }), otherScope);
    const connection = (await readMcpConfig(scope)).mcpServers.remote;
    const tokenPath = `connections/${connection.connectionId}/tokens.json`;
    const token = {
      serverName: 'remote', connectionId: connection.connectionId, authVersion: connection.authVersion, generation: 0,
      serverUrl: connection.url, issuer: url, resource: connection.url, configHash: hashMcpAuthConfig(connection),
      clientId: 'fixture', accessToken: 'initial', refreshToken: 'refresh-initial', tokenType: 'Bearer',
      updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    await writeMcpCredentialJson(tokenPath, token, credentialScope);
    await getMcpRuntimeStatus(undefined, scope);
    await buildDirectMcpTools(scope, { cacheOnly: true });
    assert.equal(methods.length, 0, 'passive status and direct-tool metadata reads never contact providers');
    await probeMcpConnection('remote', scope, AbortSignal.timeout(5000));
    assert(methods.includes('server/discover'));
    assert(!methods.includes('tools/call') && !methods.includes('tools/list'), 'health checks only perform protocol operations');
    const healthy = (await getMcpRuntimeStatus(undefined, scope)).servers[0].health;
    assert.equal(healthy?.reachability, 'reachable');
    assert.equal(healthy?.incident, null);
    await listMcpTools('remote', { scope });
    assert(authorizations.includes('Bearer initial'));
    // A cached client must use a replacement credential on its next request.
    await writeMcpCredentialJson(tokenPath, { ...token, accessToken: 'replacement' }, credentialScope);
    await callMcpTool('remote', 'change', {}, undefined, scope);
    assert.equal(authorizations.at(-1), 'Bearer replacement');
    assert.equal(executions, 1);
    rejectCall = true;
    await assert.rejects(() => callMcpTool('remote', 'change', {}, undefined, scope), /not replayed|authorization|token|reconnect/i);
    assert.equal(rejectedCalls, 1, 'an operation rejected with 401 must never be replayed');
    assert.equal(executions, 1);
    assert.equal(refreshes, 1);
    assert.equal((await readMcpCredentialJson<{ accessToken: string }>(tokenPath, scope))?.accessToken, 'renewed-1');
    rejectCall = false;
    await callMcpTool('remote', 'change', {}, undefined, scope);
    assert.equal(executions, 2);
    assert.equal(authorizations.at(-1), 'Bearer renewed-1');
    const otherWorkerState = crypto.randomBytes(24).toString('base64url');
    await writeMcpCredentialJson(tokenPath, { ...token, accessToken: 'other-account', authorizationState: otherWorkerState }, credentialScope);
    await assert.rejects(() => callMcpTool('remote', 'change', {}, undefined, scope), /authorization changed/i, 'a cached session cannot receive a token before its new authorization state is published');
    assert.equal(executions, 2);
    await completeMcpOAuthLifecycle(connection.connectionId!, 0, otherWorkerState, scope);
    await listMcpTools('remote', { scope });
    const discoverCount = methods.filter((method) => method === 'server/discover').length;
    const nextWorkerState = crypto.randomBytes(24).toString('base64url');
    await writeMcpCredentialJson(tokenPath, { ...token, accessToken: 'next-account', authorizationState: nextWorkerState }, credentialScope);
    await completeMcpOAuthLifecycle(connection.connectionId!, 0, nextWorkerState, scope);
    await listMcpTools('remote', { scope });
    assert.equal(methods.filter((method) => method === 'server/discover').length, discoverCount + 1, 'authorization completed by another worker replaces the cached client without a local close callback');
    assert.equal(authorizations.at(-1), 'Bearer next-account');
    await recordMcpConnectionObservation(connection, scope, { kind: 'failure', code: 'insufficient_scope' });
    assert.equal((await getMcpRuntimeStatus(undefined, scope)).servers[0].health?.authStatus, 'reauth_required', 'a valid token does not resolve a missing-permission incident');
    await listMcpTools('remote', { scope });
    assert.equal((await getMcpRuntimeStatus(undefined, scope)).servers[0].health?.incident?.kind, 'reauth_required', 'an unrelated successful read does not resolve missing tool permissions');
    await setMcpServerEnabled('remote', false, scope);
    await assert.rejects(() => callMcpTool('remote', 'change', {}, undefined, scope), /disabled/);
    assert.equal(executions, 2);
    assert.equal((await getMcpRuntimeStatus(undefined, scope)).servers[0].health?.incident, null, 'disabled connections produce no alarm');
    await setMcpServerEnabled('remote', true, scope);
    await writeMcpCredentialJson(tokenPath, { ...token, refreshToken: undefined, expiresAt: new Date(Date.now() - 60_000).toISOString() }, credentialScope);
    const beforeExpiryRead = methods.length;
    const expired = (await getMcpRuntimeStatus(undefined, scope)).servers[0].health;
    assert.equal(expired?.authStatus, 'reauth_required');
    assert.equal(expired?.incident?.kind, 'reauth_required', 'expired non-refreshable credentials notify without a failed user action');
    assert.equal(methods.length, beforeExpiryRead, 'expiry status reconciliation is local');

    await writeMcpCredentialJson(tokenPath, { ...token, accessToken: 'close-regression', expiresAt: new Date(Date.now() + 3600_000).toISOString() }, credentialScope);
    await listMcpTools('remote', { scope });
    await listMcpTools('other', { scope: otherScope });
    assert.equal((await getMcpRuntimeStatus(undefined, scope)).servers[0].connected, true);
    assert.equal((await getMcpRuntimeStatus(undefined, otherScope)).servers[0].connected, true);
    const releaseHeldCall = deferred();
    toolCallEntered = deferred();
    pendingToolCallRelease = releaseHeldCall;
    const pendingCall = callMcpTool('remote', 'change', {}, undefined, scope);
    // Closing the transport may reject before clearMcpOAuth returns.
    void pendingCall.catch(() => undefined);
    await toolCallEntered.promise;
    await clearMcpOAuth(connection.connectionId!, scope);
    releaseHeldCall.resolve();
    await assert.rejects(pendingCall, /abort|closed|connection/i, 'OAuth clear aborts an in-flight client opened from a user-only scope');
    assert.equal((await getMcpRuntimeStatus(undefined, scope)).servers[0].connected, false, 'clearing an org-bound connection closes its user-only manager entry');
    assert.equal((await getMcpRuntimeStatus(undefined, otherScope)).servers[0].connected, true, 'clearing one owner never closes another account client');
    console.log('mcp-manager-auth-test: ok');
  } finally {
    await closeAllMcpServers();
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
