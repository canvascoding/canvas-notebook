import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-manager-auth-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  let url = '';
  let rejectCall = false;
  let refreshes = 0;
  let executions = 0;
  let rejectedCalls = 0;
  const authorizations: string[] = [];
  const handler = createMcpHandler(() => {
    const mcp = new Server({ name: 'auth-fixture', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'change', inputSchema: { type: 'object' } }] }));
    mcp.setRequestHandler('tools/call', async () => {
      executions += 1;
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
  const { readMcpConfig, writeMcpConfigRaw, setMcpServerEnabled } = await import('../app/lib/mcp/config');
  const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');
  const { writeMcpCredentialJson, readMcpCredentialJson } = await import('../app/lib/mcp/credential-storage');
  const { callMcpTool, listMcpTools, closeAllMcpServers } = await import('../app/lib/mcp/manager');
  try {
    await writeMcpConfigRaw(JSON.stringify({ mcpServers: { remote: { url: `${url}/mcp`, auth: 'oauth', oauth: { issuer: url, authorizationUrl: `${url}/authorize`, tokenUrl: `${url}/token`, clientId: 'fixture' } } } }), scope);
    const connection = (await readMcpConfig(scope)).mcpServers.remote;
    const tokenPath = `connections/${connection.connectionId}/tokens.json`;
    const token = {
      serverName: 'remote', connectionId: connection.connectionId, authVersion: connection.authVersion, generation: 0,
      serverUrl: connection.url, issuer: url, resource: connection.url, configHash: hashMcpAuthConfig(connection),
      clientId: 'fixture', accessToken: 'initial', refreshToken: 'refresh-initial', tokenType: 'Bearer',
      updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    await writeMcpCredentialJson(tokenPath, token, scope);
    await listMcpTools('remote', { scope });
    assert(authorizations.includes('Bearer initial'));
    // A cached client must use a replacement credential on its next request.
    await writeMcpCredentialJson(tokenPath, { ...token, accessToken: 'replacement' }, scope);
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
    await setMcpServerEnabled('remote', false, scope);
    await assert.rejects(() => callMcpTool('remote', 'change', {}, undefined, scope), /disabled/);
    assert.equal(executions, 2);
    console.log('mcp-manager-auth-test: ok');
  } finally {
    await closeAllMcpServers();
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
