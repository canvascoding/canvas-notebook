import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadAppEnv } = require('../server/load-app-env.js');

const ENV_KEYS = [
  'CANVAS_DATA_ROOT',
  'CANVAS_ENV_FILE',
  'CANVAS_MCP_DIRECT_ENABLED',
  'CANVAS_MCP_DIRECT_TOOLS',
  'CANVAS_MCP_DIRECT_SETTINGS_SOURCE',
  'CANVAS_MCP_DIRECT_TOOLS_SOURCE',
];

async function writePreferences(dataDir, directMcp) {
  const settingsDir = path.join(dataDir, 'system', 'settings');
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, 'server-preferences.json'),
    `${JSON.stringify({ version: 1, settings: { directMcp } }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-runtime-bootstrap-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  try {
    process.env.CANVAS_DATA_ROOT = dataDir;
    process.env.CANVAS_ENV_FILE = path.join(dataDir, 'missing.env');
    for (const key of ENV_KEYS.slice(2)) delete process.env[key];

    await writePreferences(dataDir, { enabled: true, tools: [] });
    assert.equal(loadAppEnv(process.cwd()), null);
    assert.equal(process.env.CANVAS_MCP_DIRECT_ENABLED, 'true');
    assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS, '');
    assert.equal(process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE, 'settings');
    assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE, 'settings');

    await writePreferences(dataDir, { enabled: false, tools: ['auth_probe'] });
    loadAppEnv(process.cwd());
    assert.equal(process.env.CANVAS_MCP_DIRECT_ENABLED, 'false');
    assert.equal(
      process.env.CANVAS_MCP_DIRECT_TOOLS,
      'auth_probe,list_workspaces,get_workspace_overview,list_knowledge_tree,search_knowledge,read_knowledge_source',
    );

    await writePreferences(dataDir, {
      enabled: false,
      tools: ['auth_probe'],
      toolsVersion: 2,
    });
    loadAppEnv(process.cwd());
    assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS, 'auth_probe');

    await writePreferences(dataDir, {
      enabled: true,
      tools: ['auth_probe', 'read_knowledge_source', 'edit_knowledge_source', 'read_knowledge_asset'],
      toolsVersion: 4,
    });
    loadAppEnv(process.cwd());
    assert.equal(process.env.CANVAS_MCP_DIRECT_ENABLED, 'true');
    assert.equal(
      process.env.CANVAS_MCP_DIRECT_TOOLS,
      'auth_probe,read_knowledge_source,edit_knowledge_source,read_knowledge_asset',
    );

    process.env.CANVAS_MCP_DIRECT_ENABLED = 'true';
    process.env.CANVAS_MCP_DIRECT_TOOLS = '';
    delete process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE;
    delete process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE;
    await writePreferences(dataDir, {
      enabled: false,
      tools: ['auth_probe'],
      toolsVersion: 2,
    });
    loadAppEnv(process.cwd());
    assert.equal(process.env.CANVAS_MCP_DIRECT_ENABLED, 'true');
    assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS, '');
    assert.equal(process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE, 'environment');
    assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE, 'environment');

    await rm(path.join(dataDir, 'system'), { recursive: true, force: true });
    delete process.env.CANVAS_MCP_DIRECT_ENABLED;
    delete process.env.CANVAS_MCP_DIRECT_TOOLS;
    process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE = 'settings';
    process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE = 'settings';
    loadAppEnv(process.cwd());
    assert.equal(process.env.CANVAS_MCP_DIRECT_ENABLED, undefined);
    assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS, undefined);
    assert.equal(process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE, undefined);
    assert.equal(process.env.CANVAS_MCP_DIRECT_TOOLS_SOURCE, undefined);

    console.log('mcp-server-runtime-bootstrap-test: ok');
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
