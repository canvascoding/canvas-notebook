import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function countStarts(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.trim().split(/\n+/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startModernHttpMcpServer(): Promise<{
  url: string;
  requests: Array<{ body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
  const handler = createMcpHandler(() => {
    const mcp = new Server(
      { name: 'canvas-modern-http-fake-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler('tools/list', async () => ({
      tools: [{
        name: 'modern-echo',
        description: 'Echoes a message over MCP 2026-07-28.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
      }],
    }));
    mcp.setRequestHandler('tools/call', async (request) => ({
      content: [{
        type: 'text',
        text: `modern:${String((request.params.arguments as Record<string, unknown> | undefined)?.message || '')}`,
      }],
    }));
    return mcp;
  }, { legacy: 'reject' });

  let baseUrl = '';
  const server = http.createServer(async (req, res) => {
    try {
      const bodyBytes = await readRequestBody(req);
      const body = bodyBytes.length
        ? JSON.parse(bodyBytes.toString('utf8')) as Record<string, unknown>
        : {};
      requests.push({ body, headers: { ...req.headers } });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const response = await handler.fetch(new Request(`${baseUrl}${req.url || '/mcp'}`, {
        method: req.method,
        headers,
        body: bodyBytes.length ? bodyBytes.toString('utf8') : undefined,
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'Modern MCP test server failed.');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  baseUrl = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;
  return {
    url: `${baseUrl}/mcp`,
    requests,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startHttpMcpServer(): Promise<{
  url: string;
  requests: Array<{ authorization?: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ authorization?: string }> = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }));
      return;
    }

    requests.push({
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    });

    const mcp = new McpServer({ name: 'canvas-http-fake-mcp-server', version: '1.0.0' });
    mcp.registerTool(
      'http-echo',
      {
        title: 'HTTP Echo',
        description: 'Echoes a message over streamable HTTP.',
        inputSchema: {
          message: z.string(),
        },
      },
      async ({ message }) => ({
        content: [{ type: 'text', text: `http:${message}` }],
      }),
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
          id: null,
        }));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address && typeof address === 'object' ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-manager-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;
  process.env.MCP_ALLOW_STDIO = 'true';

  const projectRoot = process.cwd();
  const serverPath = path.join(projectRoot, 'scripts', 'fixtures', 'fake-mcp-server.ts');
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const startFile = path.join(tempRoot, 'starts.log');

  await fs.mkdir(path.join(tempRoot, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'secrets', 'Canvas-Integrations.env'), 'MCP_TEST_PREFIX=cached:\n', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'secrets', 'Canvas-Agents.env'), '', 'utf8');

  const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
  const {
    cleanupIdleMcpServers,
    callMcpTool,
    closeAllMcpServers,
    closeMcpServersForScope,
    getMcpRuntimeStatus,
    listMcpTools,
  } = await import('../app/lib/mcp/manager');
  const { createMcpProxyTool } = await import('../app/lib/mcp/proxy-tool');

  const writeConfig = async (extraEnv: Record<string, string> = {}) => {
    await writeMcpConfigRaw(JSON.stringify({
      settings: {
        toolPrefix: 'server',
        idleTimeout: 0,
      },
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [tsxCli, serverPath],
          env: {
            ECHO_PREFIX: '${MCP_TEST_PREFIX}',
            MCP_START_FILE: startFile,
            ...extraEnv,
          },
          timeoutMs: 10000,
        },
      },
    }, null, 2));
  };

  await writeConfig();

  const [toolsA, toolsB] = await Promise.all([
    listMcpTools('fake'),
    listMcpTools('fake'),
  ]);
  assert.equal(toolsA.some((tool) => tool.name === 'echo'), true);
  assert.equal(toolsB.some((tool) => tool.name === 'sum'), true);
  assert.equal(await countStarts(startFile), 2);

  const cachePath = path.join(tempRoot, 'settings', 'mcp-cache.json');
  const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(cache.servers.fake.tools.some((tool: { name: string }) => tool.name === 'echo'), true);

  await closeAllMcpServers();
  const proxy = createMcpProxyTool();
  const searchFromCache = await proxy.execute('search-cache', {
    action: 'search_tools',
    query: 'numbers',
  });
  assert.match(getText(searchFromCache), /fake\.sum/);
  assert.equal(await countStarts(startFile), 2);

  await listMcpTools('fake');
  assert.equal(await countStarts(startFile), 4);
  let status = await getMcpRuntimeStatus('fake');
  assert.equal(status.servers[0].connected, true);
  const closed = await cleanupIdleMcpServers(Date.now() + 1000);
  assert.equal(closed >= 1, true);
  status = await getMcpRuntimeStatus('fake');
  assert.equal(status.servers[0].connected, false);

  await writeConfig({ MCP_CONFIG_REVISION: 'changed' });
  const searchAfterConfigChange = await proxy.execute('search-config-change', {
    action: 'search_tools',
    query: 'numbers',
  });
  assert.match(getText(searchAfterConfigChange), /fake\.sum/);
  assert.equal(await countStarts(startFile), 6);

  await closeAllMcpServers();
  const httpMcp = await startHttpMcpServer();
  try {
    await writeMcpConfigRaw(JSON.stringify({
      settings: {
        toolPrefix: 'server',
        idleTimeout: 10,
      },
      mcpServers: {
        plainHttp: {
          url: httpMcp.url,
          timeoutMs: 10000,
        },
      },
    }, null, 2));

    const httpTools = await listMcpTools('plainHttp');
    assert.equal(httpTools.some((tool) => tool.name === 'http-echo'), true);
    assert.equal(httpMcp.requests.some((request) => Boolean(request.authorization)), false);

    const httpStatus = await getMcpRuntimeStatus('plainHttp');
    assert.equal(httpStatus.servers[0].connected, true);
  } finally {
    await closeAllMcpServers();
    await httpMcp.close();
  }

  const modernHttpMcp = await startModernHttpMcpServer();
  try {
    await writeMcpConfigRaw(JSON.stringify({
      settings: {
        toolPrefix: 'server',
        idleTimeout: 10,
      },
      mcpServers: {
        modernHttp: {
          url: modernHttpMcp.url,
          timeoutMs: 10000,
        },
      },
    }, null, 2));

    const modernTools = await listMcpTools('modernHttp');
    assert.equal(modernTools.some((tool) => tool.name === 'modern-echo'), true);
    const modernCall = await callMcpTool('modernHttp', 'modern-echo', { message: 'hello' });
    assert.equal(getText(modernCall), 'modern:hello');
    const modernStatus = await getMcpRuntimeStatus('modernHttp');
    assert.equal(modernStatus.servers[0].protocolVersion, '2026-07-28');

    const modernMethods = modernHttpMcp.requests.map((request) => String(request.body.method || ''));
    assert.equal(modernMethods[0], 'server/discover');
    assert.equal(modernMethods.includes('initialize'), false);
    assert.equal(modernMethods.includes('tools/list'), true);
    assert.equal(modernMethods.includes('tools/call'), true);
    for (const request of modernHttpMcp.requests) {
      const method = String(request.body.method || '');
      assert.equal(request.headers['mcp-protocol-version'], '2026-07-28');
      assert.equal(request.headers['mcp-method'], method);
      const params = request.body.params as Record<string, unknown>;
      const metadata = params._meta as Record<string, unknown>;
      assert.equal(metadata['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    }
    const modernCallRequest = modernHttpMcp.requests.find((request) => request.body.method === 'tools/call');
    assert.equal(modernCallRequest?.headers['mcp-name'], 'modern-echo');
  } finally {
    await closeAllMcpServers();
    await modernHttpMcp.close();
  }

  const userA = { userId: 'mcp-manager-user-a' };
  const userB = { userId: 'mcp-manager-user-b' };
  await fs.mkdir(path.join(tempRoot, 'users', userA.userId, 'secrets'), { recursive: true });
  await fs.mkdir(path.join(tempRoot, 'users', userB.userId, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'users', userA.userId, 'secrets', 'Canvas-Integrations.env'), 'MCP_TEST_PREFIX=user-a:\n', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'users', userB.userId, 'secrets', 'Canvas-Integrations.env'), 'MCP_TEST_PREFIX=user-b:\n', 'utf8');
  const sharedUserStartFile = path.join(tempRoot, 'scoped-user-starts.log');
  const userConfig = JSON.stringify({
    settings: { toolPrefix: 'server', idleTimeout: 10 },
    mcpServers: {
      shared: {
        command: process.execPath,
        args: [tsxCli, serverPath],
        env: { ECHO_PREFIX: '${MCP_TEST_PREFIX}', MCP_START_FILE: sharedUserStartFile },
      },
    },
  }, null, 2);
  await writeMcpConfigRaw(userConfig, userA);
  await writeMcpConfigRaw(userConfig, userB);
  await Promise.all([
    listMcpTools('shared', { scope: userA }),
    listMcpTools('shared', { scope: userB }),
  ]);
  assert.equal(await countStarts(sharedUserStartFile), 4);
  const [userAResult, userBResult] = await Promise.all([
    callMcpTool('shared', 'echo', { message: 'hello' }, undefined, userA),
    callMcpTool('shared', 'echo', { message: 'hello' }, undefined, userB),
  ]);
  assert.match((userAResult.content[0] as { text: string }).text, /^user-a:/);
  assert.match((userBResult.content[0] as { text: string }).text, /^user-b:/);
  assert.equal((await getMcpRuntimeStatus('shared', userA)).servers[0].connected, true);
  assert.equal((await getMcpRuntimeStatus('shared', userB)).servers[0].connected, true);
  await closeMcpServersForScope(userA);
  assert.equal((await getMcpRuntimeStatus('shared', userA)).servers[0].connected, false);
  assert.equal((await getMcpRuntimeStatus('shared', userB)).servers[0].connected, true);
  await closeAllMcpServers();

  console.log('mcp-manager-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
