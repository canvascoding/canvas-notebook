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
    setMcpServerEnabled,
    writeMcpConfigRaw,
  } = await import('../app/lib/mcp/config');

  const configPath = resolveMcpConfigPath();
  assert.equal(configPath, path.join(tempRoot, 'settings', 'mcp.json'));

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

  await fs.rm(configPath, { force: true });
  const legacyConfigPath = path.join(tempRoot, 'canvas-agent', 'mcp.json');
  await fs.mkdir(path.dirname(legacyConfigPath), { recursive: true });
  const legacyConfig = {
    settings: {
      toolPrefix: 'legacy',
      idleTimeout: 7,
    },
    mcpServers: {
      migrated: {
        command: 'node',
      },
    },
  };
  await fs.writeFile(legacyConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8');
  const migrated = await readMcpConfigState();
  assert.equal(migrated.path, configPath);
  assert.deepEqual(JSON.parse(migrated.rawContent), legacyConfig);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), legacyConfig);

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
  assert.throws(
    () => parseAndValidateMcpConfig('{ "settings": {}, "mcpServers": { "bad": { "enabled": "yes" } } }'),
    /enabled/,
  );
  assert.throws(
    () => parseAndValidateMcpConfig('{ "settings": {}, "mcpServers": { "bad": { "auth": "token" } } }'),
    /auth/,
  );
  assert.throws(
    () => parseAndValidateMcpConfig('{ "settings": {}, "mcpServers": { "bad": { "env": { "API_TOKEN": "plain-secret" } } } }'),
    /reference secret header or environment values/,
  );
  assert.throws(
    () => parseAndValidateMcpConfig('{ "settings": {}, "mcpServers": { "bad": { "oauth": { "clientSecret": "plain-secret" } } } }'),
    /must not store oauth.clientSecret/,
  );

  const validConfig = {
    settings: {
      toolPrefix: 'server',
      idleTimeout: 15,
      futureOption: true,
    },
    mcpServers: {
      example: {
        enabled: false,
        auth: 'none',
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

  const enabled = await setMcpServerEnabled('example', true);
  assert.equal(JSON.parse(enabled.rawContent).mcpServers.example.enabled, true);

  const userA = { userId: 'mcp-user-a' };
  const userB = { userId: 'mcp-user-b' };
  const userAPath = resolveMcpConfigPath(userA);
  assert.equal(userAPath, path.join(tempRoot, 'users', 'mcp-user-a', 'mcp', 'config.json'));
  await writeMcpConfigRaw(JSON.stringify({
    settings: { toolPrefix: 'user', idleTimeout: 5 },
    mcpServers: { private: { url: 'https://a.example.test/mcp' } },
  }), userA);
  const userAState = await readMcpConfigState(userA);
  const userBState = await readMcpConfigState(userB);
  assert.equal(JSON.parse(userAState.rawContent).mcpServers.private.url, 'https://a.example.test/mcp');
  assert.deepEqual(JSON.parse(userBState.rawContent).mcpServers, {});
  assert.equal(await modeOf(userAPath), 0o600);

  console.log('mcp-config-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
