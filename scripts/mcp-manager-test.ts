import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    closeAllMcpServers,
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
  assert.equal(await countStarts(startFile), 1);

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
  assert.equal(await countStarts(startFile), 1);

  await listMcpTools('fake');
  assert.equal(await countStarts(startFile), 2);
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
  assert.equal(await countStarts(startFile), 3);

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

  console.log('mcp-manager-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
