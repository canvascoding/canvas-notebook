import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-proxy-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;
  process.env.MCP_TEST_PREFIX = 'from-env:';

  const projectRoot = process.cwd();
  const serverPath = path.join(projectRoot, 'scripts', 'fixtures', 'fake-mcp-server.ts');
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  await fs.mkdir(path.join(tempRoot, 'secrets'), { recursive: true });
  await fs.writeFile(path.join(tempRoot, 'secrets', 'Canvas-Integrations.env'), 'MCP_TEST_PREFIX=from-integrations:\n', 'utf8');
  await fs.writeFile(path.join(tempRoot, 'secrets', 'Canvas-Agents.env'), '', 'utf8');

  const { writeMcpConfigRaw } = await import('../app/lib/mcp/config');
  const { closeAllMcpServers } = await import('../app/lib/mcp/manager');
  const { createMcpProxyTool } = await import('../app/lib/mcp/proxy-tool');

  await writeMcpConfigRaw(JSON.stringify({
    settings: {
      toolPrefix: 'server',
      idleTimeout: 10,
    },
    mcpServers: {
      fake: {
        command: process.execPath,
        args: [tsxCli, serverPath],
        env: {
          ECHO_PREFIX: '${MCP_TEST_PREFIX}',
        },
        timeoutMs: 10000,
      },
    },
  }, null, 2));

  const tool = createMcpProxyTool();

  const listServers = await tool.execute('list-servers', { action: 'list_servers' });
  assert.match(getText(listServers), /fake: stdio/);

  const status = await tool.execute('status', { action: 'status', server: 'fake' });
  assert.match(getText(status), /fake: configured \(stdio\)/);

  const listTools = await tool.execute('list-tools', { action: 'list_tools', server: 'fake' });
  assert.match(getText(listTools), /Tool: `fake\.echo`/);
  assert.match(getText(listTools), /Tool: `fake\.sum`/);

  const searchTools = await tool.execute('search-tools', { action: 'search_tools', query: 'numbers' });
  assert.match(getText(searchTools), /Tool: `fake\.sum`/);

  const describeTool = await tool.execute('describe-tool', { action: 'describe_tool', server: 'fake', tool: 'echo' });
  assert.match(getText(describeTool), /Input schema:/);
  assert.match(getText(describeTool), /message/);

  const describeQualifiedTool = await tool.execute('describe-qualified-tool', { action: 'describe_tool', tool: 'fake.echo' });
  assert.match(getText(describeQualifiedTool), /MCP tool "fake\.echo"/);

  const callEcho = await tool.execute('call-echo', {
    action: 'call_tool',
    server: 'fake',
    tool: 'echo',
    arguments: { message: 'hello' },
  });
  assert.match(getText(callEcho), /from-integrations:hello/);

  const callEchoWithTopLevelArguments = await tool.execute('call-echo-top-level', {
    action: 'call_tool',
    tool: 'fake.echo',
    message: 'from-top-level',
  });
  assert.match(getText(callEchoWithTopLevelArguments), /from-integrations:from-top-level/);

  const callSum = await tool.execute('call-sum', {
    action: 'call_tool',
    server: 'fake',
    tool: 'sum',
    arguments: { a: 2, b: 5 },
  });
  assert.match(getText(callSum), /^7$/);

  const unknownServer = await tool.execute('unknown-server', {
    action: 'list_tools',
    server: 'missing',
  });
  assert.match(getText(unknownServer), /^Error: Unknown MCP server "missing"/);

  await writeMcpConfigRaw(JSON.stringify({
    settings: {
      toolPrefix: 'server',
      idleTimeout: 10,
    },
    mcpServers: {
      fake: {
        command: process.execPath,
        args: [tsxCli, serverPath],
        env: {
          ECHO_PREFIX: '${MISSING_MCP_ENV}',
        },
      },
    },
  }, null, 2));

  const missingEnv = await tool.execute('missing-env', {
    action: 'list_tools',
    server: 'fake',
  });
  assert.match(getText(missingEnv), /^Error: Missing MCP environment variable/);
  assert.match(getText(missingEnv), /settings\?tab=integrations/);

  await closeAllMcpServers();
  console.log('mcp-proxy-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
