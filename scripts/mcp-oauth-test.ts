import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function modeOf(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.mode & 0o777;
}

function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>));
    req.on('error', reject);
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-oauth-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;
  process.env.BASE_URL = 'http://localhost:3000';

  let refreshCalls = 0;
  let registrationCalls = 0;
  const registeredRedirectUris: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/register' && req.method === 'POST') {
      const body = await readJson(req);
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((value): value is string => typeof value === 'string')
        : [];
      registeredRedirectUris.push(...redirectUris);
      registrationCalls += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ client_id: 'dynamic-client', client_secret: 'dynamic-secret' }));
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      }));
      return;
    }
    if (req.url === '/.well-known/oauth-protected-resource/tenant/mcp' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        resource: `${baseUrl}/tenant/mcp`,
        authorization_servers: [`${baseUrl}/tenant-auth`],
      }));
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server/tenant-auth' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        issuer: `${baseUrl}/tenant-auth`,
        authorization_endpoint: `${baseUrl}/tenant-auth/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      }));
      return;
    }
    if (req.url === '/token' && req.method === 'POST') {
      const form = await readForm(req);
      res.setHeader('Content-Type', 'application/json');
      if (form.get('grant_type') === 'refresh_token') {
        assert.equal(req.headers.authorization, `Basic ${Buffer.from('dynamic-client:dynamic-secret').toString('base64')}`);
        refreshCalls += 1;
        res.end(JSON.stringify({
          access_token: 'refreshed-token',
          refresh_token: 'refresh-token-2',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'tools',
        }));
        return;
      }
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'auth-code');
      assert.equal(Boolean(form.get('code_verifier')), true);
      res.end(JSON.stringify({
        access_token: 'initial-token',
        refresh_token: 'refresh-token-1',
        token_type: 'Bearer',
        expires_in: 1,
        scope: 'tools',
      }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;

  try {
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const {
      clearMcpOAuth,
      completeMcpOAuthCallback,
      getMcpOAuthStatus,
      getOAuthTokenPath,
      getValidMcpAccessToken,
      startMcpOAuth,
    } = await import('../app/lib/mcp/oauth');
    const { hashMcpServerConfig } = await import('../app/lib/mcp/manager');
    const { createMcpProxyTool } = await import('../app/lib/mcp/proxy-tool');

    const serverConfig = {
      url: 'https://example.test/mcp',
      auth: 'oauth',
      oauth: {
        authorizationUrl: `${baseUrl}/authorize`,
        tokenUrl: `${baseUrl}/token`,
        registrationUrl: `${baseUrl}/register`,
        scopes: ['tools'],
      },
    };

    await writeMcpConfigRaw(JSON.stringify({
      settings: { toolPrefix: 'server', idleTimeout: 10 },
      mcpServers: { remote: serverConfig },
    }, null, 2));

    const started = await startMcpOAuth('remote', 'http://localhost:3000');
    const authorizationUrl = new URL(started.authorizationUrl);
    assert.equal(authorizationUrl.origin + authorizationUrl.pathname, `${baseUrl}/authorize`);
    assert.equal(authorizationUrl.searchParams.get('client_id'), 'dynamic-client');
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'http://localhost:3000/api/mcp/oauth/callback');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(Boolean(authorizationUrl.searchParams.get('code_challenge')), true);
    assert.equal(registrationCalls, 1);
    assert.deepEqual(registeredRedirectUris, ['http://localhost:3000/api/mcp/oauth/callback']);

    const productionStarted = await startMcpOAuth('remote', 'https://canvas.example.com');
    const productionAuthorizationUrl = new URL(productionStarted.authorizationUrl);
    assert.equal(productionAuthorizationUrl.searchParams.get('redirect_uri'), 'https://canvas.example.com/api/mcp/oauth/callback');
    assert.equal(registrationCalls, 2);

    let status = await getMcpOAuthStatus('remote', 'https://canvas.example.com');
    assert.equal(status.redirectUri, 'https://canvas.example.com/api/mcp/oauth/callback');

    delete process.env.BASE_URL;
    const publicStarted = await startMcpOAuth('remote', 'https://canvas.example.com');
    const publicAuthorizationUrl = new URL(publicStarted.authorizationUrl);
    assert.equal(publicAuthorizationUrl.searchParams.get('redirect_uri'), 'https://canvas.example.com/api/mcp/oauth/callback');
    assert.equal(registrationCalls, 2);

    process.env.MCP_OAUTH_BASE_URL = 'https://mcp-callback.example.com';
    const overrideStarted = await startMcpOAuth('remote', 'https://canvas.example.com');
    const overrideAuthorizationUrl = new URL(overrideStarted.authorizationUrl);
    assert.equal(overrideAuthorizationUrl.searchParams.get('redirect_uri'), 'https://mcp-callback.example.com/api/mcp/oauth/callback');
    assert.equal(registrationCalls, 3);
    delete process.env.MCP_OAUTH_BASE_URL;

    assert.deepEqual(registeredRedirectUris, [
      'http://localhost:3000/api/mcp/oauth/callback',
      'https://canvas.example.com/api/mcp/oauth/callback',
      'https://mcp-callback.example.com/api/mcp/oauth/callback',
    ]);
    process.env.BASE_URL = 'http://localhost:3000';

    const token = await completeMcpOAuthCallback('auth-code', started.state);
    assert.equal(token.accessToken, 'initial-token');
    assert.equal(token.refreshToken, 'refresh-token-1');
    assert.equal(getOAuthTokenPath('remote'), path.join(tempRoot, 'settings', 'mcp-oauth', 'remote', 'tokens.json'));
    assert.equal(await modeOf(getOAuthTokenPath('remote')), 0o600);

    status = await getMcpOAuthStatus('remote');
    assert.equal(status.authorized, true);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const accessToken = await getValidMcpAccessToken('remote', serverConfig, hashMcpServerConfig(serverConfig));
    assert.equal(accessToken, 'refreshed-token');
    assert.equal(refreshCalls, 1);

    const proxy = createMcpProxyTool();
    const proxyStatus = await proxy.execute('auth-status', { action: 'auth_status', server: 'remote' });
    assert.match((proxyStatus.content[0] as { text: string }).text, /authorized/);

    const noAuthConfig = {
      url: `${baseUrl}/mcp`,
    };
    await writeMcpConfigRaw(JSON.stringify({
      settings: { toolPrefix: 'server', idleTimeout: 10 },
      mcpServers: { plain: noAuthConfig },
    }, null, 2));
    const noAuthStatus = await getMcpOAuthStatus('plain');
    assert.equal(noAuthStatus.configured, true);
    assert.equal(noAuthStatus.requiresAuth, false);
    const noAuthProxyStatus = await proxy.execute('auth-status-noauth', { action: 'auth_status', server: 'plain' });
    assert.match((noAuthProxyStatus.content[0] as { text: string }).text, /does not require OAuth/);

    const discoveredConfig = {
      url: `${baseUrl}/mcp`,
      auth: 'oauth',
    };
    await writeMcpConfigRaw(JSON.stringify({
      settings: { toolPrefix: 'server', idleTimeout: 10 },
      mcpServers: { discovered: discoveredConfig },
    }, null, 2));
    const discovered = await startMcpOAuth('discovered', 'http://localhost:3000');
    const discoveredUrl = new URL(discovered.authorizationUrl);
    assert.equal(discoveredUrl.origin + discoveredUrl.pathname, `${baseUrl}/authorize`);
    assert.equal(discoveredUrl.searchParams.get('client_id'), 'dynamic-client');

    const pathResourceConfig = {
      url: `${baseUrl}/tenant/mcp`,
      auth: 'oauth',
    };
    await writeMcpConfigRaw(JSON.stringify({
      settings: { toolPrefix: 'server', idleTimeout: 10 },
      mcpServers: { pathDiscovered: pathResourceConfig },
    }, null, 2));
    const pathDiscovered = await startMcpOAuth('pathDiscovered', 'http://localhost:3000');
    const pathDiscoveredUrl = new URL(pathDiscovered.authorizationUrl);
    assert.equal(pathDiscoveredUrl.origin + pathDiscoveredUrl.pathname, `${baseUrl}/tenant-auth/authorize`);
    assert.equal(pathDiscoveredUrl.searchParams.get('client_id'), 'dynamic-client');

    await writeMcpConfigRaw(JSON.stringify({
      settings: { toolPrefix: 'server', idleTimeout: 10 },
      mcpServers: {
        remote: {
          ...serverConfig,
          url: 'https://example.test/changed',
        },
      },
    }, null, 2));
    status = await getMcpOAuthStatus('remote');
    assert.equal(status.authorized, false);
    assert.match(status.reason || '', /does not match/);

    await clearMcpOAuth('remote');
    await assert.rejects(() => fs.stat(getOAuthTokenPath('remote')));

    console.log('mcp-oauth-test: ok');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
