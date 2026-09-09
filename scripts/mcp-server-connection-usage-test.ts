import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const userId = 'usage-user';
const clientId = 'usage-client';
const sessionId = 'usage-session';
const rawToken = 'usage-token-must-never-be-persisted';
const now = Math.floor(Date.now() / 1000);

class FixtureAuthorizationError extends Error {
  readonly code = 'invalid_token';
  constructor() { super('Invalid access token.'); }
  toResponse() { return Response.json({ error: 'invalid_token' }, { status: 401 }); }
}

function principal() {
  return {
    userId, clientId, sessionId, clientName: 'Usage fixture client',
    issuedAt: now - 10, expiresAt: now + 3600, scopes: ['workspace:list'],
    subject: userId, issuer: 'http://127.0.0.1:3000/api/auth', audience: 'http://127.0.0.1:3000/mcp', payload: {},
  };
}

const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = moduleInternals._load;
function installMocks() {
  moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request.includes('mcp/server/config')) return {
    DIRECT_MCP_AUTH_PROBE_TOOL: 'auth_probe',
    DIRECT_MCP_TOOL_IDS: ['auth_probe'],
    DIRECT_MCP_RESOURCE_SCOPES: ['workspace:list'],
    getDirectMcpEnabledTools: () => ['auth_probe'],
    resolveDirectMcpOAuthConfig: () => ({ resource: 'http://127.0.0.1:3000/mcp', issuer: 'http://127.0.0.1:3000/api/auth', protectedResourceMetadataUrl: 'http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp' }),
  };
  if (request.includes('mcp/server/runtime-settings')) return { getDirectMcpRuntimeSettings: async () => ({ enabled: true, tools: ['auth_probe'] }) };
  if (request.includes('mcp/server/access-token-verifier')) return {
    DirectMcpAuthorizationError: FixtureAuthorizationError,
    verifyDirectMcpRequest: async (request: Request) => {
      if (request.headers.get('authorization') === `Bearer ${rawToken}`) return principal();
      throw new FixtureAuthorizationError();
    },
  };
  if (request.includes('mcp/server/auth-probe')) return {
    DIRECT_MCP_AUTH_PROBE_TOOL: 'auth_probe',
    getDirectMcpAuthProbeToolDescriptor: () => ({ name: 'auth_probe', description: 'fixture', inputSchema: { type: 'object' } }),
    runDirectMcpAuthProbe: async (args: unknown) => (args as { fail?: boolean } | undefined)?.fail
      ? { isError: true, content: [{ type: 'text', text: 'fixture failure' }] }
      : { content: [{ type: 'text', text: 'ok' }] },
  };
  if (request.includes('mcp/server/workspace-tools')) return { getDirectMcpWorkspaceToolDefinitions: () => [] };
  if (request.includes('security/trusted-origins')) return { isConfiguredTrustedOrigin: () => false };
    return originalLoad(request, parent, isMain);
  };
}

function rpc(method: string, token?: string, params: Record<string, unknown> = {}): Request {
  return new Request('http://127.0.0.1:3000/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function modernRpc(method: string, token?: string, params: Record<string, unknown> = {}): Request {
  return new Request('http://127.0.0.1:3000/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params: {
      ...params,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'usage-fixture', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} },
    } }),
  });
}

async function allFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(target) : [target];
  }));
  return nested.flat();
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-usage-'));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.DATA = root;
  installMocks();
  const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
  const { readDirectMcpConnectionUsage, recordDirectMcpConnectionUsage } = await import('../app/lib/mcp/server/connection-usage');
  try {
    assert.deepEqual(await readDirectMcpConnectionUsage(userId, clientId), { lastSuccessfulRequestAt: null, grants: [] });

    const anonymous = await handleDirectMcpPost(rpc('tools/list'));
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await readDirectMcpConnectionUsage(userId, clientId), { lastSuccessfulRequestAt: null, grants: [] }, 'anonymous discovery never creates usage evidence');

    const unauthorized = await handleDirectMcpPost(rpc('tools/list', 'invalid-token'));
    assert.equal(unauthorized.status, 401, 'a rejected bearer request returns the OAuth invalid-token response');
    assert.deepEqual(await readDirectMcpConnectionUsage(userId, clientId), { lastSuccessfulRequestAt: null, grants: [] }, 'failed authentication never creates usage evidence');

    const listed = await handleDirectMcpPost(rpc('tools/list', rawToken));
    assert.equal(listed.status, 200);
    const afterList = await readDirectMcpConnectionUsage(userId, clientId);
    assert.equal(afterList.grants.length, 1, 'a verified successful tools/list records one observed grant');
    assert.equal(afterList.grants[0].sessionId, sessionId);
    assert.equal(afterList.grants[0].tokenHash, createHash('sha256').update(rawToken).digest('base64url'));
    assert.ok(afterList.lastSuccessfulRequestAt);

    const modernList = await handleDirectMcpPost(modernRpc('tools/list', rawToken));
    assert.equal(modernList.status, 200, 'the 2026-07-28 handler records verified successful discovery too');
    const afterModernList = await readDirectMcpConnectionUsage(userId, clientId);
    assert.equal(afterModernList.grants.length, 1);

    const failedTool = await handleDirectMcpPost(rpc('tools/call', rawToken, { name: 'not-a-tool', arguments: {} }));
    assert.equal(failedTool.status, 200);
    const afterFailure = await readDirectMcpConnectionUsage(userId, clientId);
    assert.equal(afterFailure.grants.length, 1, 'failed tools/call does not add a grant');
    assert.equal(afterFailure.grants[0].observedAt, afterModernList.grants[0].observedAt, 'failed tools/call does not refresh observed evidence');

    const businessFailure = await handleDirectMcpPost(rpc('tools/call', rawToken, { name: 'auth_probe', arguments: { fail: true } }));
    assert.equal(businessFailure.status, 200);
    const afterBusinessFailure = await readDirectMcpConnectionUsage(userId, clientId);
    assert.equal(afterBusinessFailure.grants[0].observedAt, afterModernList.grants[0].observedAt, 'a business isError result does not refresh observed evidence');

    const successfulTool = await handleDirectMcpPost(rpc('tools/call', rawToken, { name: 'auth_probe', arguments: {} }));
    assert.equal(successfulTool.status, 200);
    assert.equal((await readDirectMcpConnectionUsage(userId, clientId)).grants.length, 1, 'successful tools/call retains deduplicated evidence');

    await Promise.all(Array.from({ length: 12 }, (_, index) => recordDirectMcpConnectionUsage({
      ...principal(), tokenHash: createHash('sha256').update(`parallel-${index}`).digest('base64url'),
    })));
    const bounded = await readDirectMcpConnectionUsage(userId, clientId);
    assert.equal(bounded.grants.length, 10, 'concurrent grant observations retain the bounded newest set');

    const persistedText = (await Promise.all((await allFiles(root)).map((file) => fs.readFile(file, 'utf8').catch(() => '')))).join('\n');
    assert.equal(persistedText.includes(rawToken), false, 'raw bearer token never appears in private files or request history');
    assert.equal(persistedText.includes('Usage fixture client'), false, 'client display name is not retained as usage evidence');
    console.log('mcp-server-connection-usage-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
