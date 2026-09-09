import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  filterMcpToolsForModel,
  isMcpAppResourceMimeType,
  isMcpAppToolVisibleToApp,
  isMcpAppToolVisibleToModel,
  readMcpAppToolMetadata,
} from '../app/lib/mcp/apps-metadata';
import { installMcpAccessMocks } from './fixtures/mcp-test-access';

const RESOURCE_URI = 'ui://canvas-test/mcp-app.html';
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function startAppServer(): Promise<{ url: string; calls: string[]; advertisedMimeTypes: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const advertisedMimeTypes: string[] = [];
  const server = http.createServer(async (request, response) => {
    const mcp = new McpServer({ name: 'canvas-mcp-app-test', version: '1.0.0' });
    mcp.registerTool('app-source', {
      title: 'App source',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['app'] } },
    }, async () => ({ content: [{ type: 'text', text: 'source' }] }));
    mcp.registerTool('app-action', {
      title: 'App action',
      inputSchema: z.object({ value: z.string() }),
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['app'] } },
    }, async ({ value }) => {
      calls.push(value);
      return { content: [{ type: 'text', text: `app:${value}` }], structuredContent: { value } };
    });
    mcp.registerTool('app-view', {
      title: 'App view',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['model', 'app'] } },
    }, async () => ({
      content: [{ type: 'text', text: 'view' }], structuredContent: { chart: [1, 2] }, _meta: { privateProviderValue: 'kept-in-details-only' },
    }));
    mcp.registerTool('model-action', {
      title: 'Model action',
      inputSchema: z.object({}),
    }, async () => ({ content: [{ type: 'text', text: 'model' }] }));
    mcp.registerTool('model-only', {
      title: 'Model only',
      inputSchema: z.object({}),
      _meta: { ui: { visibility: ['model'] } },
    }, async () => ({ content: [{ type: 'text', text: 'model-only' }] }));
    mcp.registerTool('model-source', {
      title: 'Model-visible app resource source',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['model'] } },
    }, async () => ({ content: [{ type: 'text', text: 'model-source' }] }));
    mcp.registerTool('app-only-action-no-resource', {
      title: 'App-only action without resource binding',
      inputSchema: z.object({}),
      _meta: { ui: { visibility: ['app'] } },
    }, async () => ({ content: [{ type: 'text', text: 'app-only-action' }] }));
    mcp.registerResource('app-html', RESOURCE_URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
      contents: [{ uri: RESOURCE_URI, mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><title>Canvas test</title>' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => { void transport.close(); void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
      // This stateless fixture creates a server per HTTP request: capture the
      // capabilities on the initialize request, before the next notification.
      const capabilities = mcp.server.getClientCapabilities() as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined;
      const mimeTypes = capabilities?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes;
      if (Array.isArray(mimeTypes)) advertisedMimeTypes.push(...mimeTypes.filter((item): item is string => typeof item === 'string'));
    } catch (error) {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      if (!response.headersSent) response.writeHead(500).end(error instanceof Error ? error.message : 'MCP app test error');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address && typeof address === 'object' ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, calls, advertisedMimeTypes, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function main(): Promise<void> {
  const accessMocks = installMcpAccessMocks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-apps-'));
  const previous = {
    CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT,
    CANVAS_MCP_APPS_ENABLED: process.env.CANVAS_MCP_APPS_ENABLED,
    BASE_URL: process.env.BASE_URL,
  };
  process.env.CANVAS_DATA_ROOT = root;
  process.env.CANVAS_MCP_APPS_ENABLED = 'true';
  process.env.BASE_URL = 'http://localhost:3000';
  await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(root, 'secrets', 'Canvas-Integrations.env'), '');
  await fs.writeFile(path.join(root, 'secrets', 'Canvas-Agents.env'), '');
  const appServer = await startAppServer();
  try {
    const appOnlyWithoutResource = {
      name: 'app-action', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } },
    } as never;
    const malformedVisibility = {
      name: 'malformed', inputSchema: { type: 'object' }, _meta: { ui: { visibility: 'app' } },
    } as never;
    assert.equal(isMcpAppToolVisibleToModel(appOnlyWithoutResource), false);
    assert.equal(isMcpAppToolVisibleToApp(appOnlyWithoutResource), true);
    assert.equal(isMcpAppToolVisibleToModel(malformedVisibility), false);
    assert.equal(isMcpAppToolVisibleToApp(malformedVisibility), false);
    const { MCP_SYSTEM_SCOPE } = await import('../app/lib/mcp/scope');
    const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const { buildDirectMcpTools } = await import('../app/lib/mcp/direct-tools');
    const { createMcpProxyTool } = await import('../app/lib/mcp/proxy-tool');
    const { callMcpAppTool, callMcpTool, closeAllMcpServers, listMcpTools, readMcpAppResource } = await import('../app/lib/mcp/manager');
    await writeMcpConfigRaw(JSON.stringify({
      settings: { idleTimeout: 10 },
      mcpServers: { apps: { connectionId: CONNECTION_ID, url: appServer.url, directTools: ['app-source', 'app-action', 'app-view', 'model-action', 'app-only-action-no-resource'] } },
    }), MCP_SYSTEM_SCOPE);

    const tools = await listMcpTools('apps', { scope: MCP_SYSTEM_SCOPE });
    assert.ok(appServer.advertisedMimeTypes.includes('text/html;profile=mcp-app'), 'the server receives the MCP Apps capability during initialization');
    const sourceTool = tools.find((tool) => tool.name === 'app-source');
    assert.ok(sourceTool);
    assert.equal(readMcpAppToolMetadata(sourceTool)?.resourceUri, RESOURCE_URI);
    assert.deepEqual(filterMcpToolsForModel(tools).map((tool) => tool.name).sort(), ['app-view', 'model-action', 'model-only', 'model-source']);
    assert.equal(isMcpAppResourceMimeType('text/html;profile=mcp-app'), true);
    assert.equal(isMcpAppResourceMimeType('text/html'), false);

    const direct = await buildDirectMcpTools(MCP_SYSTEM_SCOPE);
    assert.deepEqual(direct.tools.map((tool) => tool.name).length, 2, 'app-only tools are never published as direct model tools');
    const appView = direct.tools.find((tool) => tool.label === 'MCP apps.app-view');
    assert.ok(appView);
    const appViewResult = await appView.execute('view', {});
    const appViewDetails = appViewResult.details as { mcpApp?: unknown; mcpToolInput?: unknown; result?: { structuredContent?: unknown; _meta?: unknown } };
    assert.deepEqual(appViewDetails.mcpApp, { version: 1, connectionId: CONNECTION_ID, toolName: 'app-view', resourceUri: RESOURCE_URI });
    assert.deepEqual(appViewDetails.mcpToolInput, {});
    assert.deepEqual(appViewDetails.result?.structuredContent, { chart: [1, 2] });
    assert.deepEqual(appViewDetails.result?._meta, { privateProviderValue: 'kept-in-details-only' });
    assert.doesNotMatch(getText(appViewResult), /privateProviderValue/);
    const proxy = createMcpProxyTool(undefined, MCP_SYSTEM_SCOPE);
    const listed = await proxy.execute('list', { action: 'list_tools', server: 'apps' });
    assert.match(getText(listed), /model-action/);
    assert.doesNotMatch(getText(listed), /app-source|app-action|app-only-action-no-resource/);
    const proxyResult = await proxy.execute('view-proxy', { action: 'call_tool', server: 'apps', tool: 'app-view', arguments: {} });
    const proxyDetails = proxyResult.details as { mcpApp?: unknown; mcpToolInput?: unknown; result?: { _meta?: unknown } };
    assert.deepEqual(proxyDetails.mcpApp, { version: 1, connectionId: CONNECTION_ID, toolName: 'app-view', resourceUri: RESOURCE_URI });
    assert.deepEqual(proxyDetails.mcpToolInput, {});
    assert.deepEqual(proxyDetails.result?._meta, { privateProviderValue: 'kept-in-details-only' });
    await assert.rejects(() => callMcpTool('apps', 'app-action', { value: 'blocked' }, undefined, MCP_SYSTEM_SCOPE), /only to its MCP App/i);

    const resource = await readMcpAppResource(CONNECTION_ID, 'app-source', RESOURCE_URI, MCP_SYSTEM_SCOPE);
    assert.equal(resource.contents[0]?.mimeType, 'text/html;profile=mcp-app');
    assert.match(String(resource.contents[0] && 'text' in resource.contents[0] ? resource.contents[0].text : ''), /Canvas test/);
    const appResult = await callMcpAppTool(CONNECTION_ID, 'app-source', RESOURCE_URI, 'app-action', { value: 'approved' }, undefined, MCP_SYSTEM_SCOPE);
    assert.equal(getText(appResult), 'app:approved');
    assert.deepEqual(appServer.calls, ['approved']);
    const modelSourceResource = await readMcpAppResource(CONNECTION_ID, 'model-source', RESOURCE_URI, MCP_SYSTEM_SCOPE);
    assert.equal(modelSourceResource.contents[0]?.mimeType, 'text/html;profile=mcp-app');
    const modelSourceAppResult = await callMcpAppTool(CONNECTION_ID, 'model-source', RESOURCE_URI, 'app-action', { value: 'approved-model-source' }, undefined, MCP_SYSTEM_SCOPE);
    assert.equal(getText(modelSourceAppResult), 'app:approved-model-source');
    assert.deepEqual(appServer.calls, ['approved', 'approved-model-source']);
    await assert.rejects(() => callMcpAppTool(CONNECTION_ID, 'app-source', RESOURCE_URI, 'model-only', {}, undefined, MCP_SYSTEM_SCOPE), /not visible to the selected app/i);
    await assert.rejects(() => readMcpAppResource(CONNECTION_ID, 'app-source', 'ui://other/app.html', MCP_SYSTEM_SCOPE), /not currently bound/i);

    process.env.CANVAS_MCP_APPS_ENABLED = 'false';
    await assert.rejects(() => readMcpAppResource(CONNECTION_ID, 'app-source', RESOURCE_URI, MCP_SYSTEM_SCOPE), /disabled by instance policy/i);
    await closeAllMcpServers();
  } finally {
    await (await import('../app/lib/mcp/manager')).closeAllMcpServers();
    await appServer.close();
    accessMocks.restore();
    await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  console.log('mcp-apps-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
