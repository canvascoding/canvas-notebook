import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DIRECT_MCP_OAUTH_SCOPES,
  resolveDirectMcpServerConfig,
} from '../app/lib/mcp/server/config';

const ORIGIN = 'https://notebook.example.test';
const REDIRECT_URI = 'https://chatgpt.com/connector/oauth/callback';
const EMAIL = 'mcp-auth-probe-owner@example.test';
const PASSWORD = 'McpAuthProbeOwnerPassword123!';
const MCP_ACCEPT = 'application/json, text/event-stream';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';
const DIRECT_MCP_TOOL_NAMES = [
  'auth_probe',
  'list_workspaces',
  'get_workspace_overview',
  'list_knowledge_tree',
  'search_knowledge',
  'read_knowledge_source',
] as const;
const DIRECT_MCP_RESOURCE_SCOPES = [
  'workspace:list',
  'knowledge:tree',
  'knowledge:search',
  'knowledge:read',
];

type JsonRecord = Record<string, unknown>;

function configureRuntime(dataDir: string): void {
  const environment = process.env as Record<string, string | undefined>;
  environment.DATA = dataDir;
  environment.NODE_ENV = 'test';
  environment.CANVAS_DATABASE_PROVIDER = 'sqlite';
  environment.CANVAS_MCP_DIRECT_ENABLED = 'true';
  environment.CANVAS_INSTANCE_ID = 'mcp-auth-probe-test';
  environment.BETTER_AUTH_BASE_URL = ORIGIN;
  environment.BASE_URL = ORIGIN;
  environment.BETTER_AUTH_TRUSTED_ORIGINS = ORIGIN;
  environment.BETTER_AUTH_SECRET = 'mcp-auth-probe-test-secret-at-least-32-characters';
  delete environment.DATABASE_URL;
  delete environment.NEXT_PHASE;
  delete environment.CANVAS_INSTANCE_TOKEN;
  delete environment.CANVAS_MANAGED_SERVICES_ENABLED;
  delete environment.CANVAS_LICENSE_CERT;
  delete environment.CANVAS_LICENSE_PUBLIC_KEY;
}

async function readJson(response: Response): Promise<JsonRecord> {
  const value = await response.json();
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as JsonRecord;
}

async function rpcRequest(input: {
  post: (request: Request) => Promise<Response>;
  body: JsonRecord;
  token?: string;
  accept?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    accept: input.accept ?? MCP_ACCEPT,
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  };
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  return input.post(new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input.body),
  }));
}

async function modernRpcRequest(input: {
  post: (request: Request) => Promise<Response>;
  id: number;
  method: string;
  params?: JsonRecord;
  token?: string;
  name?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    accept: MCP_ACCEPT,
    'content-type': 'application/json',
    'mcp-method': input.method,
    'mcp-protocol-version': MODERN_MCP_PROTOCOL_VERSION,
  };
  if (input.name) headers['mcp-name'] = input.name;
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  return input.post(new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: input.id,
      method: input.method,
      params: {
        ...(input.params || {}),
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': {
            name: 'canvas-auth-probe-modern-test',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  }));
}

function resultFromRpc(body: JsonRecord): JsonRecord {
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(typeof body.result, 'object');
  assert.notEqual(body.result, null);
  return body.result as JsonRecord;
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-auth-probe-'));
  configureRuntime(dataDir);
  const originalFetch = globalThis.fetch;
  const outboundRequests: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    outboundRequests.push(url);
    throw new Error(`Unexpected outbound request during Direct MCP test: ${url}`);
  }) as typeof fetch;

  try {
    const { createInitialOwner } = await import('../app/lib/auth-setup');
    await createInitialOwner({
      name: 'MCP Auth Probe Owner',
      email: EMAIL,
      password: PASSWORD,
    });

    const [
      { auth },
      { enforceDirectMcpOAuthRequestPolicy },
      { openDb },
      mcpRoute,
      {
        DIRECT_MCP_AUTH_PROBE_SCOPE,
        DIRECT_MCP_AUTH_PROBE_TOOL,
      },
      { default: appProxy },
      { NextRequest },
    ] = await Promise.all([
      import('../app/lib/auth'),
      import('../app/lib/mcp/server/oauth-request-policy'),
      import('../app/lib/db'),
      import('../app/mcp/route'),
      import('../app/lib/mcp/server/auth-probe'),
      import('../proxy'),
      import('next/server'),
    ]);
    const { issuer, resource, protectedResourceMetadataUrl } =
      resolveDirectMcpServerConfig();
    const proxyResponse = await appProxy(new NextRequest(`${ORIGIN}/mcp`, {
      method: 'POST',
    }));
    assert.equal(proxyResponse.status, 200);
    assert.equal(proxyResponse.headers.get('x-middleware-next'), '1');
    assert.equal(proxyResponse.headers.get('x-middleware-rewrite'), null);

    const untrustedOriginResponse = await mcpRoute.POST(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        accept: MCP_ACCEPT,
        'content-type': 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        origin: 'https://attacker.example.test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'untrusted-origin', version: '1.0.0' },
        },
      }),
    }));
    assert.equal(untrustedOriginResponse.status, 403);
    assert.equal(untrustedOriginResponse.headers.get('access-control-allow-origin'), null);
    assert.match(untrustedOriginResponse.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);

    const trustedPreflight = await mcpRoute.OPTIONS(new Request(`${ORIGIN}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN },
    }));
    assert.equal(trustedPreflight.status, 204);
    assert.equal(trustedPreflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(trustedPreflight.headers.get('vary') || '', /Origin/u);
    assert.match(trustedPreflight.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);

    const untrustedPreflight = await mcpRoute.OPTIONS(new Request(`${ORIGIN}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example.test' },
    }));
    assert.equal(untrustedPreflight.status, 403);

    const registrationRequest = new Request(`${issuer}/oauth2/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        client_name: 'MCP Auth Probe Test Client',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: DIRECT_MCP_OAUTH_SCOPES.join(' '),
      }),
    });
    const registrationResponse = (
      await enforceDirectMcpOAuthRequestPolicy(registrationRequest)
    ) ?? await auth.handler(registrationRequest);
    assert.equal([200, 201].includes(registrationResponse.status), true);
    const clientId = String((await readJson(registrationResponse)).client_id);
    assert.ok(clientId);

    const loginResponse = await auth.handler(new Request(`${issuer}/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        email: EMAIL,
        password: PASSWORD,
      }),
    }));
    assert.equal(loginResponse.status, 200);

    const identityDatabase = await openDb();
    let userId: string;
    let sessionId: string;
    try {
      const identity = await identityDatabase.get(`
        SELECT
          local_user.id AS user_id,
          auth_session.id AS session_id
        FROM "user" local_user
        INNER JOIN "session" auth_session
          ON auth_session.user_id = local_user.id
        WHERE local_user.email = ?
        ORDER BY auth_session.created_at DESC
        LIMIT 1
      `, [EMAIL]) as { user_id: string; session_id: string } | undefined;
      assert.ok(identity);
      userId = identity.user_id;
      sessionId = identity.session_id;
    } finally {
      await identityDatabase.close();
    }

    const now = Math.floor(Date.now() / 1000);
    async function signAccessToken(input: {
      issuer?: string;
      audience?: string;
      scopes?: string[];
    } = {}): Promise<string> {
      const signed = await auth.api.signJWT({
        body: {
          payload: {
            sub: userId,
            azp: clientId,
            sid: sessionId,
            scope: (input.scopes ?? [DIRECT_MCP_AUTH_PROBE_SCOPE]).join(' '),
            iss: input.issuer ?? issuer,
            aud: input.audience ?? resource,
            iat: now,
            exp: now + 900,
          },
        },
      });
      return signed.token;
    }

    const validToken = await signAccessToken();
    const workspaceToolsToken = await signAccessToken({
      scopes: DIRECT_MCP_RESOURCE_SCOPES,
    });
    const noProbeScopeToken = await signAccessToken({ scopes: ['knowledge:read'] });
    const foreignToken = await signAccessToken({
      audience: 'https://foreign-instance.example.test/mcp',
    });

    const initialization = await rpcRequest({
      post: mcpRoute.POST,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'canvas-auth-probe-test',
            version: '1.0.0',
          },
        },
      },
    });
    assert.equal(initialization.status, 200);
    const initializeResult = resultFromRpc(await readJson(initialization));
    assert.equal(typeof initializeResult.serverInfo, 'object');
    assert.equal(
      (initializeResult.serverInfo as JsonRecord).name,
      'canvas-notebook-direct-mcp',
    );

    const modernDiscovery = await modernRpcRequest({
      post: mcpRoute.POST,
      id: 100,
      method: 'server/discover',
    });
    assert.equal(modernDiscovery.status, 200);
    assert.equal(modernDiscovery.headers.get('mcp-session-id'), null);
    const modernDiscoveryResult = resultFromRpc(await readJson(modernDiscovery));
    assert.deepEqual(modernDiscoveryResult.supportedVersions, [MODERN_MCP_PROTOCOL_VERSION]);
    assert.equal(typeof modernDiscoveryResult.capabilities, 'object');
    assert.equal(
      ((modernDiscoveryResult._meta as JsonRecord)['io.modelcontextprotocol/serverInfo'] as JsonRecord).name,
      'canvas-notebook-direct-mcp',
    );

    const modernToolsList = await modernRpcRequest({
      post: mcpRoute.POST,
      id: 101,
      method: 'tools/list',
    });
    assert.equal(modernToolsList.status, 200);
    const modernToolsResult = resultFromRpc(await readJson(modernToolsList));
    assert.deepEqual(
      (modernToolsResult.tools as JsonRecord[]).map((tool) => tool.name),
      DIRECT_MCP_TOOL_NAMES,
    );
    assert.equal(modernToolsResult.cacheScope, 'private');
    assert.equal(modernToolsResult.ttlMs, 0);

    const modernAuthenticatedProbe = await modernRpcRequest({
      post: mcpRoute.POST,
      id: 102,
      method: 'tools/call',
      name: DIRECT_MCP_AUTH_PROBE_TOOL,
      token: validToken,
      params: {
        name: DIRECT_MCP_AUTH_PROBE_TOOL,
        arguments: {},
      },
    });
    assert.equal(modernAuthenticatedProbe.status, 200);
    const modernAuthenticatedResult = resultFromRpc(await readJson(modernAuthenticatedProbe));
    assert.equal((modernAuthenticatedResult.structuredContent as JsonRecord).authenticated, true);

    const toolsList = await rpcRequest({
      post: mcpRoute.POST,
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    });
    assert.equal(toolsList.status, 200);
    const toolsResult = resultFromRpc(await readJson(toolsList));
    const tools = toolsResult.tools as JsonRecord[];
    assert.equal(tools.length, DIRECT_MCP_TOOL_NAMES.length);
    assert.equal(tools[0].name, DIRECT_MCP_AUTH_PROBE_TOOL);
    assert.deepEqual(tools.map((tool) => tool.name), DIRECT_MCP_TOOL_NAMES);
    assert.deepEqual(tools[0].securitySchemes, [{
      type: 'oauth2',
      scopes: [DIRECT_MCP_AUTH_PROBE_SCOPE],
    }]);
    assert.deepEqual(
      (tools[0]._meta as JsonRecord).securitySchemes,
      tools[0].securitySchemes,
    );
    assert.deepEqual(tools[0].annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const { loadWorkspaceListingForActor } = await import('../app/lib/workspaces/listing-action');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { writeFile } = await import('../app/lib/filesystem/workspace-files');
    const workspaceListing = await loadWorkspaceListingForActor(resolveWorkspaceActor({
      id: userId,
      email: EMAIL,
      role: 'admin',
    }));
    assert.ok(workspaceListing.defaultWorkspace);
    const workspace = workspaceListing.defaultWorkspace;
    await writeFile(
      'mcp-server-test.md',
      'Canvas MCP workspace search fixture. This document is visible to the authenticated user.',
      { workspace },
    );

    const listWorkspaces = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'list_workspaces', arguments: {} },
      },
    });
    const listWorkspacesResult = resultFromRpc(await readJson(listWorkspaces));
    const listedWorkspaces = (listWorkspacesResult.structuredContent as JsonRecord).workspaces as JsonRecord[];
    assert.ok(listedWorkspaces.some((candidate) => candidate.id === workspace.workspaceId));

    const overview = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'get_workspace_overview',
          arguments: { workspace_id: workspace.workspaceId },
        },
      },
    });
    const overviewResult = resultFromRpc(await readJson(overview));
    assert.equal(
      ((overviewResult.structuredContent as JsonRecord).workspace as JsonRecord).id,
      workspace.workspaceId,
    );

    const tree = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'list_knowledge_tree',
          arguments: { workspace_id: workspace.workspaceId, max_depth: 0 },
        },
      },
    });
    const treeResult = resultFromRpc(await readJson(tree));
    const treeEntries = (treeResult.structuredContent as JsonRecord).entries as JsonRecord[];
    assert.ok(treeEntries.some((entry) => entry.path === 'mcp-server-test.md'));

    const search = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'search_knowledge',
          arguments: { workspace_id: workspace.workspaceId, query: 'workspace search' },
        },
      },
    });
    const searchResult = resultFromRpc(await readJson(search));
    const searchEntries = (searchResult.structuredContent as JsonRecord).results as JsonRecord[];
    assert.ok(searchEntries.some((entry) => entry.path === 'mcp-server-test.md'));

    const source = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 26,
        method: 'tools/call',
        params: {
          name: 'read_knowledge_source',
          arguments: { workspace_id: workspace.workspaceId, path: 'mcp-server-test.md' },
        },
      },
    });
    const sourceResult = resultFromRpc(await readJson(source));
    assert.match(
      String((sourceResult.structuredContent as JsonRecord).content),
      /Canvas MCP workspace search fixture/u,
    );

    process.env.CANVAS_MCP_DIRECT_TOOLS = '';
    try {
      const disabledToolsList = await rpcRequest({
        post: mcpRoute.POST,
        body: {
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/list',
          params: {},
        },
      });
      assert.equal(disabledToolsList.status, 200);
      const disabledToolsResult = resultFromRpc(await readJson(disabledToolsList));
      assert.deepEqual(disabledToolsResult.tools, []);
    } finally {
      delete process.env.CANVAS_MCP_DIRECT_TOOLS;
    }

    const anonymousProbe = await rpcRequest({
      post: mcpRoute.POST,
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: DIRECT_MCP_AUTH_PROBE_TOOL,
          arguments: {},
        },
      },
    });
    assert.equal(anonymousProbe.status, 200);
    const anonymousResult = resultFromRpc(await readJson(anonymousProbe));
    assert.equal(anonymousResult.isError, true);
    const anonymousChallenge = (
      anonymousResult._meta as JsonRecord
    )['mcp/www_authenticate'] as string[];
    assert.equal(anonymousChallenge.length, 1);
    assert.ok(
      anonymousChallenge[0].includes(
        `resource_metadata="${protectedResourceMetadataUrl}"`,
      ),
    );
    assert.ok(anonymousChallenge[0].includes('error="invalid_token"'));
    assert.ok(anonymousChallenge[0].includes('error_description='));

    const missingScopeProbe = await rpcRequest({
      post: mcpRoute.POST,
      token: noProbeScopeToken,
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: DIRECT_MCP_AUTH_PROBE_TOOL,
          arguments: {},
        },
      },
    });
    assert.equal(missingScopeProbe.status, 200);
    const missingScopeResult = resultFromRpc(await readJson(missingScopeProbe));
    assert.equal(missingScopeResult.isError, true);
    const scopeChallenge = (
      missingScopeResult._meta as JsonRecord
    )['mcp/www_authenticate'] as string[];
    assert.ok(scopeChallenge[0].includes('error="insufficient_scope"'));
    assert.ok(
      scopeChallenge[0].includes(`scope="${DIRECT_MCP_AUTH_PROBE_SCOPE}"`),
    );
    assert.ok(scopeChallenge[0].includes('error_description='));

    const authenticatedProbe = await rpcRequest({
      post: mcpRoute.POST,
      token: validToken,
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: DIRECT_MCP_AUTH_PROBE_TOOL,
          arguments: {},
        },
      },
    });
    assert.equal(authenticatedProbe.status, 200);
    const authenticatedBody = await readJson(authenticatedProbe);
    const authenticatedResult = resultFromRpc(authenticatedBody);
    assert.notEqual(authenticatedResult.isError, true);
    const structuredContent = authenticatedResult.structuredContent as JsonRecord;
    assert.equal(structuredContent.authenticated, true);
    assert.match(String(structuredContent.user_ref), /^[a-f0-9]{12}$/u);
    assert.deepEqual(structuredContent.scopes, [DIRECT_MCP_AUTH_PROBE_SCOPE]);
    assert.equal(JSON.stringify(authenticatedBody).includes(userId), false);
    assert.equal(JSON.stringify(authenticatedBody).includes('workspace'), true);
    assert.equal(JSON.stringify(authenticatedBody).includes('knowledge'), false);

    const foreignProbe = await rpcRequest({
      post: mcpRoute.POST,
      token: foreignToken,
      body: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: DIRECT_MCP_AUTH_PROBE_TOOL,
          arguments: {},
        },
      },
    });
    assert.equal(foreignProbe.status, 401);
    assert.ok(
      foreignProbe.headers.get('www-authenticate')?.includes(
        'error="invalid_token"',
      ),
    );

    const invalidAccept = await rpcRequest({
      post: mcpRoute.POST,
      accept: 'application/json',
      body: {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list',
        params: {},
      },
    });
    assert.equal(invalidAccept.status, 406);

    const getResponse = await mcpRoute.GET(new Request(`${ORIGIN}/mcp`));
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get('allow'), 'POST, OPTIONS');
    assert.match(getResponse.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);
    const optionsResponse = await mcpRoute.OPTIONS(new Request(`${ORIGIN}/mcp`, {
      method: 'OPTIONS',
    }));
    assert.equal(optionsResponse.status, 204);
    assert.match(optionsResponse.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/iu);
    assert.ok(
      optionsResponse.headers
        .get('access-control-allow-headers')
        ?.includes('authorization'),
    );

    const revokeDatabase = await openDb();
    try {
      await revokeDatabase.run(
        'DELETE FROM "session" WHERE id = ?',
        [sessionId],
      );
    } finally {
      await revokeDatabase.close();
    }
    const revokedProbe = await rpcRequest({
      post: mcpRoute.POST,
      token: validToken,
      body: {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: DIRECT_MCP_AUTH_PROBE_TOOL,
          arguments: {},
        },
      },
    });
    assert.equal(revokedProbe.status, 401);

    process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
    const disabled = await rpcRequest({
      post: mcpRoute.POST,
      body: {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/list',
        params: {},
      },
    });
    assert.equal(disabled.status, 404);
    assert.deepEqual(
      outboundRequests,
      [],
      'Direct V1 auth must not call the Canvas Control Plane or another remote service.',
    );

    console.log('mcp-server-auth-probe-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
