import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;
const GRANT_LIFETIME_MS = 10 * 60 * 1000;

function randomId() {
  return randomBytes(24).toString('base64url');
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isAllowedRedirect(raw, allowedOrigins) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return false;
    if (allowedOrigins) return allowedOrigins.has(url.origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function sameChallenge(verifier, expected) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  const actual = createHash('sha256').update(verifier).digest('base64url');
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/**
 * A real, loopback-only HTTP MCP and OAuth provider for browser/Electron E2E.
 * The returned stats contain counters only; authorization codes and tokens stay
 * in memory and are never logged or exposed through a diagnostics endpoint.
 */
export async function startMcpOAuthProvider(options = {}) {
  const allowedOrigins = options.allowedRedirectOrigins
    ? new Set(options.allowedRedirectOrigins.map((entry) => new URL(entry).origin))
    : undefined;
  const clients = new Map();
  const consents = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const stats = {
    requests: 0,
    registrations: 0,
    consents: 0,
    approvals: 0,
    denials: 0,
    tokenExchanges: 0,
    failedTokenExchanges: 0,
    refreshes: 0,
    mcpInitializations: 0,
    toolsLists: 0,
    toolCalls: 0,
    unauthorizedMcpRequests: 0,
  };
  let origin;

  const server = createServer(async (request, response) => {
    stats.requests += 1;
    try {
      const target = new URL(request.url || '/', origin);
      const method = request.method || 'GET';
      const resource = `${origin}/mcp`;

      if (method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(target.pathname)) {
        return json(response, 200, { resource, authorization_servers: [origin], scopes_supported: ['tools:read', 'tools:call'] });
      }
      if (method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(target.pathname)) {
        return json(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (method === 'POST' && target.pathname === '/register') {
        const registration = JSON.parse(await readBody(request));
        if (!Array.isArray(registration.redirect_uris) || registration.redirect_uris.length !== 1
          || !isAllowedRedirect(registration.redirect_uris[0], allowedOrigins)) {
          return json(response, 400, { error: 'invalid_redirect_uri' });
        }
        const clientId = randomId();
        clients.set(clientId, { redirectUri: registration.redirect_uris[0] });
        stats.registrations += 1;
        return json(response, 201, {
          client_id: clientId,
          redirect_uris: registration.redirect_uris,
          token_endpoint_auth_method: 'none',
        });
      }
      if (method === 'GET' && target.pathname === '/authorize') {
        const clientId = target.searchParams.get('client_id');
        const client = clients.get(clientId);
        const redirectUri = target.searchParams.get('redirect_uri');
        const state = target.searchParams.get('state');
        const challenge = target.searchParams.get('code_challenge');
        if (!client || client.redirectUri !== redirectUri || !isAllowedRedirect(redirectUri, allowedOrigins)
          || target.searchParams.get('response_type') !== 'code' || !state
          || target.searchParams.get('code_challenge_method') !== 'S256'
          || !challenge || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
          || target.searchParams.get('resource') !== resource) {
          return json(response, 400, { error: 'invalid_request' });
        }
        const consent = randomId();
        consents.set(consent, {
          clientId, redirectUri, state, challenge, resource,
          scope: target.searchParams.get('scope') || 'tools:read tools:call',
          expiresAt: Date.now() + GRANT_LIFETIME_MS,
        });
        stats.consents += 1;
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          // Chromium checks form-action again when following the OAuth 303.
          // Permit only the callback origin validated against the registration.
          'Content-Security-Policy': `default-src 'none'; form-action 'self' ${new URL(redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
        });
        response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local MCP consent</title></head><body><main><h1>Connect Canvas Notebook</h1><p>Allow the local test MCP server to provide its echo tool.</p><form method="post" action="/consent"><input type="hidden" name="consent" value="${consent}"><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`);
        return;
      }
      if (method === 'POST' && target.pathname === '/consent') {
        const body = new URLSearchParams(await readBody(request));
        const consentId = body.get('consent');
        const grant = consents.get(consentId);
        consents.delete(consentId);
        if (!grant || grant.expiresAt <= Date.now()) return json(response, 400, { error: 'invalid_request' });
        const callback = new URL(grant.redirectUri);
        callback.searchParams.set('state', grant.state);
        callback.searchParams.set('iss', origin);
        if (body.get('decision') === 'approve') {
          const code = randomId();
          codes.set(code, grant);
          callback.searchParams.set('code', code);
          stats.approvals += 1;
        } else if (body.get('decision') === 'deny') {
          callback.searchParams.set('error', 'access_denied');
          stats.denials += 1;
        } else {
          return json(response, 400, { error: 'invalid_request' });
        }
        response.writeHead(303, { Location: callback.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        response.end();
        return;
      }
      if (method === 'POST' && target.pathname === '/token') {
        const body = new URLSearchParams(await readBody(request));
        const clientId = body.get('client_id');
        let grant;
        if (body.get('grant_type') === 'authorization_code') {
          const code = body.get('code');
          grant = codes.get(code);
          if (!grant || grant.expiresAt <= Date.now() || grant.clientId !== clientId
            || grant.redirectUri !== body.get('redirect_uri') || grant.resource !== body.get('resource')
            || !sameChallenge(body.get('code_verifier') || '', grant.challenge)) {
            stats.failedTokenExchanges += 1;
            return json(response, 400, { error: 'invalid_grant' });
          }
          codes.delete(code);
          stats.tokenExchanges += 1;
        } else if (body.get('grant_type') === 'refresh_token') {
          const refresh = body.get('refresh_token');
          grant = refreshTokens.get(refresh);
          if (!grant || grant.clientId !== clientId || grant.resource !== body.get('resource')) {
            stats.failedTokenExchanges += 1;
            return json(response, 400, { error: 'invalid_grant' });
          }
          refreshTokens.delete(refresh);
          stats.refreshes += 1;
        } else {
          return json(response, 400, { error: 'unsupported_grant_type' });
        }
        const accessToken = randomId();
        const refreshToken = randomId();
        accessTokens.set(accessToken, { ...grant, expiresAt: Date.now() + 60 * 60 * 1000 });
        refreshTokens.set(refreshToken, grant);
        return json(response, 200, {
          access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600, scope: grant.scope,
        });
      }
      if (method === 'POST' && target.pathname === '/revoke') {
        const body = new URLSearchParams(await readBody(request));
        accessTokens.delete(body.get('token'));
        refreshTokens.delete(body.get('token'));
        return json(response, 200, {});
      }
      if (target.pathname === '/mcp') {
        const authorization = request.headers.authorization || '';
        const grant = accessTokens.get(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
        if (!grant || grant.expiresAt <= Date.now()) {
          stats.unauthorizedMcpRequests += 1;
          return json(response, 401, { error: 'authorization_required' }, {
            'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        if (method === 'DELETE') return json(response, 200, {});
        if (method !== 'POST') return json(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' });
        const rpc = JSON.parse(await readBody(request));
        if (rpc.jsonrpc !== '2.0') return json(response, 400, { error: 'invalid_request' });
        if (rpc.id === undefined) {
          response.writeHead(202, { 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        let result;
        if (rpc.method === 'initialize') {
          stats.mcpInitializations += 1;
          result = {
            protocolVersion: rpc.params?.protocolVersion || '2025-11-25',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'canvas-local-oauth-fixture', version: '1.0.0' },
          };
        } else if (rpc.method === 'ping') {
          result = {};
        } else if (rpc.method === 'tools/list') {
          stats.toolsLists += 1;
          result = { tools: [{ name: 'echo', description: 'Echo a local test message.', inputSchema: {
            type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false,
          } }] };
        } else if (rpc.method === 'tools/call' && rpc.params?.name === 'echo') {
          stats.toolCalls += 1;
          result = { content: [{ type: 'text', text: String(rpc.params.arguments?.message || '') }] };
        } else {
          return json(response, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found.' } });
        }
        return json(response, 200, { jsonrpc: '2.0', id: rpc.id, result });
      }
      return json(response, 404, { error: 'not_found' });
    } catch {
      // Deliberately do not log request URLs, form bodies, authorization codes,
      // access tokens, or exception objects from this credential-bearing server.
      if (!response.headersSent) json(response, 400, { error: 'invalid_request' });
      else response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  let closing;
  return {
    origin,
    issuer: origin,
    url: `${origin}/mcp`,
    stats,
    close() {
      closing ||= new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      }).finally(() => {
        clients.clear();
        consents.clear();
        codes.clear();
        accessTokens.clear();
        refreshTokens.clear();
      });
      return closing;
    },
  };
}
