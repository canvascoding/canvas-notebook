import assert from 'node:assert/strict';

const MCP_ACCEPT = 'application/json, text/event-stream';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';
const REQUEST_TIMEOUT_MS = 10_000;
const DIRECT_MCP_TOOL_NAMES = [
  'auth_probe',
  'list_workspaces',
  'get_workspace_overview',
  'list_knowledge_tree',
  'search_knowledge',
  'read_knowledge_source',
];

type JsonRecord = Record<string, unknown>;

function resolveTestOrigin(): string {
  const configured = process.env.MCP_TEST_ORIGIN
    || process.env.BASE_URL
    || 'http://localhost:3000';
  const parsed = new URL(configured);
  assert.equal(parsed.username, '', 'MCP_TEST_ORIGIN must not contain credentials.');
  assert.equal(parsed.password, '', 'MCP_TEST_ORIGIN must not contain credentials.');
  assert.equal(parsed.pathname, '/', 'MCP_TEST_ORIGIN must contain only the instance origin.');
  assert.equal(parsed.search, '', 'MCP_TEST_ORIGIN must not contain a query.');
  assert.equal(parsed.hash, '', 'MCP_TEST_ORIGIN must not contain a fragment.');
  return parsed.origin;
}

async function request(
  origin: string,
  route: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${origin}${route}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function requestJson(
  origin: string,
  route: string,
  init?: RequestInit,
): Promise<{ response: Response; body: JsonRecord }> {
  const response = await request(origin, route, init);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`${route} returned non-JSON content with HTTP ${response.status}.`);
  }
  assert.equal(typeof parsed, 'object', `${route} must return a JSON object.`);
  assert.notEqual(parsed, null, `${route} must return a JSON object.`);
  return {
    response,
    body: parsed as JsonRecord,
  };
}

function resultFromRpc(body: JsonRecord): JsonRecord {
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(typeof body.result, 'object');
  assert.notEqual(body.result, null);
  return body.result as JsonRecord;
}

async function rpcRequest(
  origin: string,
  id: number,
  method: string,
  params: JsonRecord,
): Promise<JsonRecord> {
  const { response, body } = await requestJson(origin, '/mcp', {
    method: 'POST',
    headers: {
      accept: MCP_ACCEPT,
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }),
  });
  assert.equal(response.status, 200, `${method} must return HTTP 200.`);
  return resultFromRpc(body);
}

async function modernRpcRequest(
  origin: string,
  id: number,
  method: string,
  params: JsonRecord = {},
  name?: string,
): Promise<{ response: Response; result: JsonRecord }> {
  const headers: Record<string, string> = {
    accept: MCP_ACCEPT,
    'content-type': 'application/json',
    'mcp-method': method,
    'mcp-protocol-version': MODERN_MCP_PROTOCOL_VERSION,
  };
  if (name) headers['mcp-name'] = name;

  const { response, body } = await requestJson(origin, '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': {
            name: 'canvas-notebook-http-smoke',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  assert.equal(response.status, 200, `${method} must return HTTP 200.`);
  assert.equal(response.headers.get('mcp-session-id'), null);
  return { response, result: resultFromRpc(body) };
}

async function main(): Promise<void> {
  const origin = resolveTestOrigin();
  const resource = `${origin}/mcp`;
  const issuer = `${origin}/api/auth`;

  const protectedCanonical = await requestJson(
    origin,
    '/.well-known/oauth-protected-resource/mcp',
  );
  const protectedAlias = await requestJson(
    origin,
    '/.well-known/oauth-protected-resource',
  );
  assert.equal(protectedCanonical.response.status, 200);
  assert.equal(protectedAlias.response.status, 200);
  assert.deepEqual(protectedAlias.body, protectedCanonical.body);
  assert.equal(protectedCanonical.body.resource, resource);
  assert.deepEqual(protectedCanonical.body.authorization_servers, [issuer]);

  const authorizationCanonical = await requestJson(
    origin,
    '/.well-known/oauth-authorization-server/api/auth',
  );
  const authorizationAlias = await requestJson(
    origin,
    '/api/auth/.well-known/oauth-authorization-server',
  );
  assert.equal(authorizationCanonical.response.status, 200);
  assert.equal(authorizationAlias.response.status, 200);
  assert.deepEqual(authorizationAlias.body, authorizationCanonical.body);
  assert.equal(authorizationCanonical.body.issuer, issuer);
  const supportedScopes = authorizationCanonical.body.scopes_supported;
  assert.ok(Array.isArray(supportedScopes));
  for (const scope of [
    'openid',
    'offline_access',
    'workspace:list',
    'knowledge:tree',
    'knowledge:search',
    'knowledge:read',
    'knowledge:write',
    'knowledge:assets',
  ]) {
    assert.ok(supportedScopes.includes(scope), `Missing OAuth scope ${scope}.`);
  }
  const challengeMethods =
    authorizationCanonical.body.code_challenge_methods_supported;
  assert.ok(Array.isArray(challengeMethods));
  assert.ok(challengeMethods.includes('S256'));

  const initialized = await rpcRequest(origin, 1, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: 'canvas-notebook-http-smoke',
      version: '1.0.0',
    },
  });
  assert.equal(
    (initialized.serverInfo as JsonRecord).name,
    'canvas-notebook-direct-mcp',
  );

  const toolsResult = await rpcRequest(origin, 2, 'tools/list', {});
  const tools = toolsResult.tools as JsonRecord[];
  assert.equal(tools.length, DIRECT_MCP_TOOL_NAMES.length);
  assert.equal(tools[0].name, 'auth_probe');
  assert.deepEqual(tools.map((tool) => tool.name), DIRECT_MCP_TOOL_NAMES);
  assert.deepEqual(tools[0].securitySchemes, [{
    type: 'oauth2',
    scopes: ['workspace:list'],
  }]);

  const probeResult = await rpcRequest(origin, 3, 'tools/call', {
    name: 'auth_probe',
    arguments: {},
  });
  assert.equal(probeResult.isError, true);
  const challenge = (
    probeResult._meta as JsonRecord
  )['mcp/www_authenticate'] as string[];
  assert.equal(challenge.length, 1);
  assert.ok(
    challenge[0].includes(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    ),
  );
  assert.ok(challenge[0].includes('error="invalid_token"'));

  const modernDiscovery = await modernRpcRequest(
    origin,
    100,
    'server/discover',
  );
  assert.deepEqual(
    modernDiscovery.result.supportedVersions,
    [MODERN_MCP_PROTOCOL_VERSION],
  );
  assert.equal(
    (((modernDiscovery.result._meta as JsonRecord)
      ['io.modelcontextprotocol/serverInfo']) as JsonRecord).name,
    'canvas-notebook-direct-mcp',
  );

  const modernToolsResult = (
    await modernRpcRequest(origin, 101, 'tools/list')
  ).result;
  assert.deepEqual(
    (modernToolsResult.tools as JsonRecord[]).map((tool) => tool.name),
    DIRECT_MCP_TOOL_NAMES,
  );
  assert.equal(modernToolsResult.cacheScope, 'private');
  assert.equal(modernToolsResult.ttlMs, 0);

  const modernProbeResult = (
    await modernRpcRequest(
      origin,
      102,
      'tools/call',
      { name: 'auth_probe', arguments: {} },
      'auth_probe',
    )
  ).result;
  assert.equal(modernProbeResult.isError, true);
  const modernChallenge = (
    modernProbeResult._meta as JsonRecord
  )['mcp/www_authenticate'] as string[];
  assert.ok(modernChallenge[0].includes('error="invalid_token"'));

  const unsupportedGet = await request(origin, '/mcp');
  assert.equal(unsupportedGet.status, 405);
  assert.equal(unsupportedGet.headers.get('allow'), 'POST, OPTIONS');

  const preflight = await request(origin, '/mcp', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.ok(
    preflight.headers.get('access-control-allow-methods')?.includes('POST'),
  );
  assert.ok(
    preflight.headers.get('access-control-allow-headers')?.includes('authorization'),
  );
  assert.ok(
    preflight.headers.get('access-control-allow-headers')?.includes('mcp-method'),
  );
  assert.ok(
    preflight.headers.get('access-control-allow-headers')?.includes('mcp-name'),
  );

  console.log(`mcp-server-http-smoke-test: ok (${origin})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
