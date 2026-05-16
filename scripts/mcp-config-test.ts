import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function modeOf(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.mode & 0o777;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-config-'));
  process.env.CANVAS_DATA_ROOT = tempRoot;

  const {
    McpConfigValidationError,
    parseAndValidateMcpConfig,
    readMcpConfigState,
    resolveMcpConfigPath,
    writeMcpConfigRaw,
  } = await import('../app/lib/mcp/config');

  const configPath = resolveMcpConfigPath();
  assert.equal(configPath, path.join(tempRoot, 'canvas-agent', 'mcp.json'));

  const initial = await readMcpConfigState();
  assert.equal(initial.path, configPath);
  assert.equal(initial.exists, false);
  assert.deepEqual(JSON.parse(initial.rawContent), {
    settings: {
      toolPrefix: 'server',
      idleTimeout: 10,
    },
    mcpServers: {},
  });
  assert.equal(await modeOf(configPath), 0o600);

  assert.throws(
    () => parseAndValidateMcpConfig('{ "mcpServers": {'),
    McpConfigValidationError,
  );
  assert.throws(
    () => parseAndValidateMcpConfig('[]'),
    /MCP config must be a JSON object/,
  );
  assert.throws(
    () => parseAndValidateMcpConfig('{ "settings": {}, "mcpServers": [] }'),
    /mcpServers/,
  );
  assert.throws(
    () => parseAndValidateMcpConfig('{ "settings": { "idleTimeout": -1 }, "mcpServers": {} }'),
    /idleTimeout/,
  );

  const validConfig = {
    settings: {
      toolPrefix: 'server',
      idleTimeout: 15,
      futureOption: true,
    },
    mcpServers: {
      example: {
        command: 'node',
        args: ['server.js'],
        extraFutureField: {
          preserved: true,
        },
      },
    },
    futureTopLevel: 'preserved',
  };
  const validRaw = JSON.stringify(validConfig, null, 2);
  const updated = await writeMcpConfigRaw(validRaw);
  assert.equal(updated.exists, true);
  assert.equal(updated.rawContent, `${validRaw}\n`);
  assert.deepEqual(JSON.parse(updated.rawContent), validConfig);
  assert.equal(await modeOf(configPath), 0o600);

  console.log('mcp-config-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
