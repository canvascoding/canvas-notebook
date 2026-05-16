import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  const cachePath = path.join(tempRoot, 'canvas-agent', 'mcp-cache.json');
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
  console.log('mcp-manager-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
