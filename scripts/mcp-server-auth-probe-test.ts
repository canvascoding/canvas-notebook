import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  'edit_knowledge_source',
  'read_knowledge_asset',
  'upload_knowledge_asset',
] as const;
const DIRECT_MCP_RESOURCE_SCOPES = [
  'workspace:list',
  'knowledge:tree',
  'knowledge:search',
  'knowledge:read',
  'knowledge:write',
  'knowledge:assets',
];

type JsonRecord = Record<string, unknown>;

function configureRuntime(dataDir: string): void {
  const environment = process.env as Record<string, string | undefined>;
  environment.DATA = dataDir;
  environment.NODE_ENV = 'test';
  environment.CANVAS_DATABASE_PROVIDER = 'sqlite';
  environment.CANVAS_MCP_DIRECT_ENABLED = 'true';
  environment.CANVAS_MCP_DIRECT_TOOLS = DIRECT_MCP_TOOL_NAMES.join(',');
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

function createPdfFixture(): Buffer {
  const stream = 'BT /F1 12 Tf 20 100 Td (Canvas MCP PDF asset fixture.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let document = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, 'utf8'));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, 'utf8');
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, 'utf8');
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
      { DIRECT_MCP_SERVER_VERSION },
      { default: appProxy },
      { NextRequest },
    ] = await Promise.all([
      import('../app/lib/auth'),
      import('../app/lib/mcp/server/oauth-request-policy'),
      import('../app/lib/db'),
      import('../app/mcp/route'),
      import('../app/lib/mcp/server/auth-probe'),
      import('../app/lib/mcp/server/version'),
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
    assert.equal(
      (initializeResult.serverInfo as JsonRecord).version,
      DIRECT_MCP_SERVER_VERSION,
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
    assert.equal(
      ((modernDiscoveryResult._meta as JsonRecord)['io.modelcontextprotocol/serverInfo'] as JsonRecord).version,
      DIRECT_MCP_SERVER_VERSION,
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
    const assetTool = tools.find((tool) => tool.name === 'read_knowledge_asset');
    assert.ok(assetTool);
    assert.deepEqual(assetTool.securitySchemes, [{
      type: 'oauth2',
      scopes: ['knowledge:assets'],
    }]);
    assert.equal((assetTool.annotations as JsonRecord).readOnlyHint, true);
    const uploadTool = tools.find((tool) => tool.name === 'upload_knowledge_asset');
    assert.ok(uploadTool);
    assert.deepEqual(uploadTool.securitySchemes, [{
      type: 'oauth2',
      scopes: ['knowledge:write'],
    }]);
    assert.equal((uploadTool.annotations as JsonRecord).readOnlyHint, false);
    assert.equal((uploadTool.annotations as JsonRecord).destructiveHint, true);

    const { loadWorkspaceListingForActor } = await import('../app/lib/workspaces/listing-action');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readFile, writeFile } = await import('../app/lib/filesystem/workspace-files');
    const {
      grantDirectMcpDefaultWorkspaces,
      setDirectMcpWorkspaceEnabled,
    } = await import('../app/lib/mcp/server/workspace-access-policy');
    const workspaceListing = await loadWorkspaceListingForActor(resolveWorkspaceActor({
      id: userId,
      email: EMAIL,
      role: 'admin',
    }));
    assert.ok(workspaceListing.defaultWorkspace);
    const workspace = workspaceListing.defaultWorkspace;
    assert.deepEqual(await setDirectMcpWorkspaceEnabled({
      userId,
      workspaceId: workspace.workspaceId,
      enabled: true,
    }), { status: 'updated', enabled: true });
    assert.deepEqual(await grantDirectMcpDefaultWorkspaces({
      clientId,
      userId,
    }), { status: 'saved', allowedWorkspaceCount: 1 });
    await writeFile(
      'mcp-server-test.md',
      'Canvas MCP workspace search fixture. This document is visible to the authenticated user.',
      { workspace },
    );
    await writeFile(
      'mcp-server-asset.png',
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH8sAAAAASUVORK5CYII=', 'base64'),
      { workspace },
    );
    await writeFile('mcp-server-asset.pdf', createPdfFixture(), { workspace });
    await writeFile('mcp-server-asset.bin', Buffer.from([0, 1, 2, 3]), { workspace });

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
    const sourceContent = sourceResult.structuredContent as JsonRecord;
    assert.match(
      String(sourceContent.content),
      /Canvas MCP workspace search fixture/u,
    );
    assert.match(String(sourceContent.sha256), /^[a-f0-9]{64}$/u);
    assert.equal(sourceContent.source, 'file');

    const edit = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 27,
        method: 'tools/call',
        params: {
          name: 'edit_knowledge_source',
          arguments: {
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-test.md',
            old_text: 'search fixture',
            new_text: 'write fixture',
            expected_sha256: sourceContent.sha256,
          },
        },
      },
    });
    const editResult = resultFromRpc(await readJson(edit));
    assert.notEqual(editResult.isError, true);
    const editContent = editResult.structuredContent as JsonRecord;
    assert.equal(editContent.changed, true);
    assert.equal(editContent.review_required, false);
    assert.equal(editContent.before_sha256, sourceContent.sha256);
    assert.match(String(editContent.after_sha256), /^[a-f0-9]{64}$/u);
    assert.notEqual(editContent.after_sha256, sourceContent.sha256);

    const updatedSource = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 28,
        method: 'tools/call',
        params: {
          name: 'read_knowledge_source',
          arguments: { workspace_id: workspace.workspaceId, path: 'mcp-server-test.md' },
        },
      },
    });
    const updatedSourceResult = resultFromRpc(await readJson(updatedSource));
    const updatedSourceContent = updatedSourceResult.structuredContent as JsonRecord;
    assert.match(String(updatedSourceContent.content), /Canvas MCP workspace write fixture/u);
    assert.equal(updatedSourceContent.sha256, editContent.after_sha256);

    const imageAsset = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: {
          name: 'read_knowledge_asset',
          arguments: { workspace_id: workspace.workspaceId, path: 'mcp-server-asset.png' },
        },
      },
    });
    const imageAssetResult = resultFromRpc(await readJson(imageAsset));
    assert.notEqual(imageAssetResult.isError, true);
    const imageAssetContent = imageAssetResult.structuredContent as JsonRecord;
    assert.equal(imageAssetContent.type, 'image');
    assert.equal(imageAssetContent.mime_type, 'image/png');
    assert.match(String(imageAssetContent.sha256), /^[a-f0-9]{64}$/u);
    assert.ok((imageAssetResult.content as JsonRecord[]).some((part) => (
      part.type === 'image' && part.mimeType === 'image/png' && typeof part.data === 'string'
    )));

    const pdfAsset = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: {
          name: 'read_knowledge_asset',
          arguments: {
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-asset.pdf',
            pdf_text_pages: [1],
            include_pdf_images: true,
            pdf_image_pages: [1],
          },
        },
      },
    });
    const pdfAssetResult = resultFromRpc(await readJson(pdfAsset));
    assert.notEqual(pdfAssetResult.isError, true);
    const pdfAssetContent = pdfAssetResult.structuredContent as JsonRecord;
    assert.equal(pdfAssetContent.type, 'pdf');
    assert.equal(pdfAssetContent.mime_type, 'application/pdf');
    assert.equal(pdfAssetContent.pages, 1);
    assert.deepEqual(pdfAssetContent.text_pages_read, [1]);
    assert.ok((pdfAssetResult.content as JsonRecord[]).some((part) => (
      part.type === 'text' && String(part.text).includes('Canvas MCP PDF asset fixture')
    )));
    assert.ok((pdfAssetResult.content as JsonRecord[]).some((part) => (
      part.type === 'image' && part.mimeType === 'image/png' && typeof part.data === 'string'
    )));

    const missingAssetScope = await rpcRequest({
      post: mcpRoute.POST,
      token: noProbeScopeToken,
      body: {
        jsonrpc: '2.0',
        id: 34,
        method: 'tools/call',
        params: {
          name: 'read_knowledge_asset',
          arguments: { workspace_id: workspace.workspaceId, path: 'mcp-server-asset.png' },
        },
      },
    });
    const missingAssetScopeResult = resultFromRpc(await readJson(missingAssetScope));
    assert.equal(missingAssetScopeResult.isError, true);
    const assetScopeChallenge = (
      missingAssetScopeResult._meta as JsonRecord
    )['mcp/www_authenticate'] as string[];
    assert.ok(assetScopeChallenge[0].includes('error="insufficient_scope"'));
    assert.ok(assetScopeChallenge[0].includes('scope="knowledge:assets"'));
    const assetScopeMessage = String(
      (missingAssetScopeResult.content as Array<{ text?: string }>)[0]?.text,
    );
    assert.match(assetScopeMessage, /knowledge:assets/u);
    assert.match(assetScopeMessage, /Settings > MCP Server/u);
    assert.match(assetScopeMessage, /do not need to register a new client/u);

    const unsupportedAsset = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 35,
        method: 'tools/call',
        params: {
          name: 'read_knowledge_asset',
          arguments: { workspace_id: workspace.workspaceId, path: 'mcp-server-asset.bin' },
        },
      },
    });
    const unsupportedAssetResult = resultFromRpc(await readJson(unsupportedAsset));
    assert.equal(unsupportedAssetResult.isError, true);
    assert.match(
      String((unsupportedAssetResult.content as Array<{ text?: string }>)[0]?.text),
      /Only PNG, JPEG, GIF, WebP images, and PDF documents/u,
    );

    const uploadedAssetBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH8sAAAAASUVORK5CYII=',
      'base64',
    );
    const uploadedAssetSha256 = createHash('sha256').update(uploadedAssetBytes).digest('hex');
    const missingUploadScope = await rpcRequest({
      post: mcpRoute.POST,
      token: noProbeScopeToken,
      body: {
        jsonrpc: '2.0',
        id: 36,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'begin',
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-upload.png',
            size: uploadedAssetBytes.length,
            mime_type: 'image/png',
            sha256: uploadedAssetSha256,
          },
        },
      },
    });
    const missingUploadScopeResult = resultFromRpc(await readJson(missingUploadScope));
    assert.equal(missingUploadScopeResult.isError, true);
    const uploadScopeChallenge = (
      missingUploadScopeResult._meta as JsonRecord
    )['mcp/www_authenticate'] as string[];
    assert.ok(uploadScopeChallenge[0].includes('error="insufficient_scope"'));
    assert.ok(uploadScopeChallenge[0].includes('scope="knowledge:write"'));

    const beginUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 37,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'begin',
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-upload.png',
            size: uploadedAssetBytes.length,
            mime_type: 'image/png',
            sha256: uploadedAssetSha256,
          },
        },
      },
    });
    const beginUploadResult = resultFromRpc(await readJson(beginUpload));
    assert.notEqual(beginUploadResult.isError, true);
    const beginUploadContent = beginUploadResult.structuredContent as JsonRecord;
    assert.equal(beginUploadContent.operation, 'begin');
    assert.equal(beginUploadContent.next_offset, 0);
    assert.equal(beginUploadContent.before_sha256, null);
    assert.equal(beginUploadContent.total_size, uploadedAssetBytes.length);
    assert.equal(typeof beginUploadContent.upload_id, 'string');
    assert.ok(Number(beginUploadContent.max_chunk_bytes) >= uploadedAssetBytes.length);
    const uploadId = String(beginUploadContent.upload_id);

    const tamperedUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 38,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: `${uploadId.slice(0, -1)}${uploadId.endsWith('A') ? 'B' : 'A'}`,
            offset: 0,
            data_base64: uploadedAssetBytes.toString('base64'),
          },
        },
      },
    });
    const tamperedUploadResult = resultFromRpc(await readJson(tamperedUpload));
    assert.equal(tamperedUploadResult.isError, true);
    assert.match(
      String((tamperedUploadResult.content as Array<{ text?: string }>)[0]?.text),
      /invalid or expired/u,
    );

    const malformedChunk = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 39,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: uploadId,
            offset: 0,
            data_base64: `${uploadedAssetBytes.toString('base64')}\n`,
          },
        },
      },
    });
    const malformedChunkResult = resultFromRpc(await readJson(malformedChunk));
    assert.equal(malformedChunkResult.isError, true);
    assert.match(
      String((malformedChunkResult.content as Array<{ text?: string }>)[0]?.text),
      /canonical standard Base64/u,
    );

    const splitOffset = Math.floor(uploadedAssetBytes.length / 2);
    const offsetMismatch = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: uploadId,
            offset: 1,
            data_base64: uploadedAssetBytes.subarray(0, splitOffset).toString('base64'),
          },
        },
      },
    });
    const offsetMismatchResult = resultFromRpc(await readJson(offsetMismatch));
    assert.equal(offsetMismatchResult.isError, true);
    assert.match(
      String((offsetMismatchResult.content as Array<{ text?: string }>)[0]?.text),
      /expects byte 0/u,
    );

    const firstChunk = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: uploadId,
            offset: 0,
            data_base64: uploadedAssetBytes.subarray(0, splitOffset).toString('base64'),
          },
        },
      },
    });
    const firstChunkResult = resultFromRpc(await readJson(firstChunk));
    assert.equal((firstChunkResult.structuredContent as JsonRecord).next_offset, splitOffset);

    const duplicateChunk = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: uploadId,
            offset: 0,
            data_base64: uploadedAssetBytes.subarray(0, splitOffset).toString('base64'),
          },
        },
      },
    });
    const duplicateChunkResult = resultFromRpc(await readJson(duplicateChunk));
    assert.equal((duplicateChunkResult.structuredContent as JsonRecord).already_received, true);
    assert.equal((duplicateChunkResult.structuredContent as JsonRecord).next_offset, splitOffset);

    const finalChunk = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: uploadId,
            offset: splitOffset,
            data_base64: uploadedAssetBytes.subarray(splitOffset).toString('base64'),
          },
        },
      },
    });
    const finalChunkResult = resultFromRpc(await readJson(finalChunk));
    assert.equal(
      (finalChunkResult.structuredContent as JsonRecord).next_offset,
      uploadedAssetBytes.length,
    );

    const completeUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 44,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'complete',
            workspace_id: workspace.workspaceId,
            upload_id: uploadId,
          },
        },
      },
    });
    const completeUploadResult = resultFromRpc(await readJson(completeUpload));
    assert.notEqual(
      completeUploadResult.isError,
      true,
      JSON.stringify(completeUploadResult),
    );
    const completeUploadContent = completeUploadResult.structuredContent as JsonRecord;
    assert.equal(completeUploadContent.path, 'mcp-server-upload.png');
    assert.equal(completeUploadContent.after_sha256, uploadedAssetSha256);
    assert.equal(completeUploadContent.mime_type, 'image/png');
    assert.equal(completeUploadContent.detected_mime_type, 'image/png');
    assert.equal(completeUploadContent.already_completed, false);

    const readUploadedAsset = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 45,
        method: 'tools/call',
        params: {
          name: 'read_knowledge_asset',
          arguments: { workspace_id: workspace.workspaceId, path: 'mcp-server-upload.png' },
        },
      },
    });
    const readUploadedAssetResult = resultFromRpc(await readJson(readUploadedAsset));
    assert.equal(
      (readUploadedAssetResult.structuredContent as JsonRecord).sha256,
      uploadedAssetSha256,
    );

    const overwriteWithoutRevision = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 46,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'begin',
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-upload.png',
            size: uploadedAssetBytes.length,
            mime_type: 'image/png',
            sha256: uploadedAssetSha256,
            overwrite: true,
          },
        },
      },
    });
    const overwriteWithoutRevisionResult = resultFromRpc(await readJson(overwriteWithoutRevision));
    assert.equal(overwriteWithoutRevisionResult.isError, true);
    assert.match(
      String((overwriteWithoutRevisionResult.content as Array<{ text?: string }>)[0]?.text),
      /expected_sha256 is missing/u,
    );

    const badHashBytes = Buffer.from([0, 1, 2, 3]);
    const beginBadHashUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 47,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'begin',
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-bad-hash.bin',
            size: badHashBytes.length,
            sha256: '0'.repeat(64),
          },
        },
      },
    });
    const beginBadHashResult = resultFromRpc(await readJson(beginBadHashUpload));
    const badHashUploadId = String(
      (beginBadHashResult.structuredContent as JsonRecord).upload_id,
    );
    const badHashChunk = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 48,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: badHashUploadId,
            offset: 0,
            data_base64: badHashBytes.toString('base64'),
          },
        },
      },
    });
    assert.notEqual(resultFromRpc(await readJson(badHashChunk)).isError, true);
    const completeBadHash = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 49,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'complete',
            workspace_id: workspace.workspaceId,
            upload_id: badHashUploadId,
          },
        },
      },
    });
    const completeBadHashResult = resultFromRpc(await readJson(completeBadHash));
    assert.equal(completeBadHashResult.isError, true);
    assert.match(
      String((completeBadHashResult.content as Array<{ text?: string }>)[0]?.text),
      /does not match the declared size or SHA-256 hash/u,
    );

    const abortedBytes = Buffer.from([0, 7]);
    const beginAbortedUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'begin',
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-aborted.bin',
            size: abortedBytes.length,
            sha256: createHash('sha256').update(abortedBytes).digest('hex'),
          },
        },
      },
    });
    const abortedUploadId = String(
      (resultFromRpc(await readJson(beginAbortedUpload)).structuredContent as JsonRecord).upload_id,
    );
    const abortUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'abort',
            workspace_id: workspace.workspaceId,
            upload_id: abortedUploadId,
          },
        },
      },
    });
    assert.equal(
      (resultFromRpc(await readJson(abortUpload)).structuredContent as JsonRecord).operation,
      'abort',
    );
    const chunkAfterAbort = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: abortedUploadId,
            offset: 0,
            data_base64: abortedBytes.toString('base64'),
          },
        },
      },
    });
    assert.match(
      String((resultFromRpc(await readJson(chunkAfterAbort)).content as Array<{ text?: string }>)[0]?.text),
      /invalid or expired/u,
    );

    const initialConflictBytes = Buffer.from([0, 1]);
    const replacementConflictBytes = Buffer.from([0, 2]);
    const concurrentConflictBytes = Buffer.from([0, 9]);
    await writeFile('mcp-server-upload-conflict.bin', initialConflictBytes, { workspace });
    const initialConflictSha256 = createHash('sha256').update(initialConflictBytes).digest('hex');
    const beginConflictUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'begin',
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-upload-conflict.bin',
            size: replacementConflictBytes.length,
            sha256: createHash('sha256').update(replacementConflictBytes).digest('hex'),
            overwrite: true,
            expected_sha256: initialConflictSha256,
          },
        },
      },
    });
    const conflictUploadId = String(
      (resultFromRpc(await readJson(beginConflictUpload)).structuredContent as JsonRecord).upload_id,
    );
    const conflictChunk = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 55,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'chunk',
            workspace_id: workspace.workspaceId,
            upload_id: conflictUploadId,
            offset: 0,
            data_base64: replacementConflictBytes.toString('base64'),
          },
        },
      },
    });
    assert.notEqual(resultFromRpc(await readJson(conflictChunk)).isError, true);
    await writeFile('mcp-server-upload-conflict.bin', concurrentConflictBytes, { workspace });
    const completeConflictUpload = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 56,
        method: 'tools/call',
        params: {
          name: 'upload_knowledge_asset',
          arguments: {
            operation: 'complete',
            workspace_id: workspace.workspaceId,
            upload_id: conflictUploadId,
          },
        },
      },
    });
    const completeConflictResult = resultFromRpc(await readJson(completeConflictUpload));
    assert.equal(completeConflictResult.isError, true);
    assert.match(
      String((completeConflictResult.content as Array<{ text?: string }>)[0]?.text),
      /destination changed while the upload was in progress/u,
    );
    assert.deepEqual(
      await readFile('mcp-server-upload-conflict.bin', { workspace }),
      concurrentConflictBytes,
    );

    const staleEdit = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 29,
        method: 'tools/call',
        params: {
          name: 'edit_knowledge_source',
          arguments: {
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-test.md',
            old_text: 'write fixture',
            new_text: 'stale write fixture',
            expected_sha256: sourceContent.sha256,
          },
        },
      },
    });
    const staleEditResult = resultFromRpc(await readJson(staleEdit));
    assert.equal(staleEditResult.isError, true);
    assert.match(
      String((staleEditResult.content as Array<{ text?: string }>)[0]?.text),
      /changed since it was read/u,
    );

    const noMatchEdit = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'edit_knowledge_source',
          arguments: {
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-test.md',
            old_text: 'not present in this file',
            new_text: 'should not be written',
            expected_sha256: updatedSourceContent.sha256,
          },
        },
      },
    });
    const noMatchEditResult = resultFromRpc(await readJson(noMatchEdit));
    assert.equal(noMatchEditResult.isError, true);
    assert.match(
      String((noMatchEditResult.content as Array<{ text?: string }>)[0]?.text),
      /exact text replacement no longer matches/u,
    );

    const missingWriteScopeEdit = await rpcRequest({
      post: mcpRoute.POST,
      token: noProbeScopeToken,
      body: {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'edit_knowledge_source',
          arguments: {
            workspace_id: workspace.workspaceId,
            path: 'mcp-server-test.md',
            old_text: 'write fixture',
            new_text: 'unauthorized write fixture',
            expected_sha256: updatedSourceContent.sha256,
          },
        },
      },
    });
    const missingWriteScopeResult = resultFromRpc(await readJson(missingWriteScopeEdit));
    assert.equal(missingWriteScopeResult.isError, true);
    const writeScopeChallenge = (
      missingWriteScopeResult._meta as JsonRecord
    )['mcp/www_authenticate'] as string[];
    assert.ok(writeScopeChallenge[0].includes('error="insufficient_scope"'));
    assert.ok(writeScopeChallenge[0].includes('scope="knowledge:write"'));
    assert.match(
      String((missingWriteScopeResult.content as Array<{ text?: string }>)[0]?.text),
      /knowledge:write/u,
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

      const disabledToolCall = await rpcRequest({
        post: mcpRoute.POST,
        body: {
          jsonrpc: '2.0',
          id: 22,
          method: 'tools/call',
          params: {
            name: 'read_knowledge_asset',
            arguments: {},
          },
        },
      });
      const disabledToolBody = await readJson(disabledToolCall);
      assert.equal(typeof disabledToolBody.error, 'object');
      assert.match(
        String((disabledToolBody.error as JsonRecord).message),
        /disabled for this server.*Settings > MCP Server.*reload/iu,
      );
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

    const authorizedProbe = await rpcRequest({
      post: mcpRoute.POST,
      token: workspaceToolsToken,
      body: {
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: DIRECT_MCP_AUTH_PROBE_TOOL,
          arguments: {},
        },
      },
    });
    assert.equal(authorizedProbe.status, 200);
    const authorizedProbeResult = resultFromRpc(await readJson(authorizedProbe));
    assert.deepEqual(
      (authorizedProbeResult.structuredContent as JsonRecord).scopes,
      [...DIRECT_MCP_RESOURCE_SCOPES].sort(),
    );

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

    const { listRecentDirectMcpRequestHistory } = await import(
      '../app/lib/mcp/server/request-history'
    );
    const requestHistory = await listRecentDirectMcpRequestHistory();
    assert.equal(
      requestHistory.some((entry) => entry.operation === 'tools/list'),
      true,
      'Direct MCP tool-list requests should be traceable.',
    );
    assert.equal(
      requestHistory.some((entry) => (
        entry.operation === 'tools/call'
        && entry.toolName === DIRECT_MCP_AUTH_PROBE_TOOL
        && entry.code === 'MCP_TOOL_ERROR'
      )),
      true,
      'Failed Direct MCP tool calls should retain only their safe tool metadata.',
    );
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
