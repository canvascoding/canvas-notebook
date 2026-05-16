import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-direct-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;

  const projectRoot = process.cwd();
  const serverPath = path.join(projectRoot, 'scripts', 'fixtures', 'fake-mcp-server.ts');
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  await fs.mkdir(path.join(tempRoot, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'secrets', 'Canvas-Integrations.env'), 'MCP_TEST_PREFIX=direct:\n', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'secrets', 'Canvas-Agents.env'), '', 'utf8');

  const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
  const { closeAllMcpServers } = await import('../app/lib/mcp/manager');
  const { buildDirectMcpTools, createDirectMcpToolName } = await import('../app/lib/mcp/direct-tools');

  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };
  const { getPiToolMetadata } = await import('../app/lib/pi/tool-registry');

  const baseServer = {
    command: process.execPath,
    args: [tsxCli, serverPath],
    env: {
      ECHO_PREFIX: '${MCP_TEST_PREFIX}',
    },
    timeoutMs: 10000,
    directTools: ['echo'],
  };

  assert.equal(createDirectMcpToolName('Fake Server', 'echo-tool'), 'mcp_fake_server_echo_tool');

  await writeMcpConfigRaw(JSON.stringify({
    settings: { toolPrefix: 'server', idleTimeout: 10 },
    mcpServers: {
      fake: baseServer,
      'fake-collision': baseServer,
      fake_collision: baseServer,
    },
  }, null, 2));

  const direct = await buildDirectMcpTools();
  assert.equal(direct.tools.some((tool) => tool.name === 'mcp_fake_echo'), true);
  assert.equal(direct.warnings.some((warning) => /collision/i.test(warning.message)), true);

  const echoTool = direct.tools.find((tool) => tool.name === 'mcp_fake_echo');
  assert.ok(echoTool);
  const result = await echoTool.execute('direct-echo', { message: 'hello' });
  assert.match(getText(result), /direct:hello/);

  const metadata = await getPiToolMetadata();
  const directMetadata = metadata.find((tool) => tool.name === 'mcp_fake_echo');
  assert.equal(directMetadata?.group, 'MCP');

  await closeAllMcpServers();
  moduleInternals._load = originalLoad;
  console.log('mcp-direct-tools-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
