import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-server-settings-'));
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;

  try {
    process.env.CANVAS_DATA_ROOT = dataDir;
    const {
      getDirectMcpServerPreferences,
      getServerSettings,
      setDirectMcpServerPreferences,
      setServerPreferredTimeZone,
    } = await import('../app/lib/server-settings');
    const { buildDirectMcpServerSettingsStatus } = await import(
      '../app/lib/mcp/server/settings-status'
    );

    assert.equal(await getDirectMcpServerPreferences(), null);
    await setServerPreferredTimeZone('admin-1', 'Europe/Berlin');
    const preferences = await setDirectMcpServerPreferences('admin-1', {
      enabled: true,
      tools: ['auth_probe'],
    });
    assert.equal(preferences.enabled, true);
    assert.deepEqual(preferences.tools, ['auth_probe']);
    assert.equal(typeof preferences.updatedAt, 'string');
    assert.equal(preferences.updatedBy, 'admin-1');

    const settings = await getServerSettings();
    assert.equal(settings.timeZone, 'Europe/Berlin');
    assert.deepEqual(settings.directMcp, preferences);

    const settingsPath = path.join(dataDir, 'system', 'settings', 'server-preferences.json');
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      settings?: { directMcp?: unknown };
    };
    assert.deepEqual(persisted.settings?.directMcp, preferences);
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);

    await assert.rejects(
      setDirectMcpServerPreferences('admin-1', {
        enabled: true,
        tools: ['not_a_canvas_tool'],
      }),
      /unsupported value/u,
    );

    const status = buildDirectMcpServerSettingsStatus(preferences, {
      NODE_ENV: 'production',
      BASE_URL: 'https://canvas.example.test',
      BETTER_AUTH_BASE_URL: 'https://canvas.example.test',
      CANVAS_MCP_DIRECT_ENABLED: 'false',
    });
    assert.equal(status.endpoint, 'https://canvas.example.test/mcp');
    assert.equal(status.issuer, 'https://canvas.example.test/api/auth');
    assert.equal(status.desiredEnabled, true);
    assert.equal(status.runtimeEnabled, false);
    assert.equal(status.restartRequired, true);
    assert.equal(status.activationManagedByEnvironment, true);
    assert.equal(status.protocolVersion, '2026-07-28');
    assert.deepEqual(
      status.capabilities.filter((capability) => capability.available),
      [{
        id: 'auth_probe',
        available: true,
        enabled: true,
        scopes: ['workspace:list'],
      }],
    );

    const settingsManagedStatus = buildDirectMcpServerSettingsStatus(preferences, {
      NODE_ENV: 'production',
      BASE_URL: 'https://canvas.example.test',
      BETTER_AUTH_BASE_URL: 'https://canvas.example.test',
      CANVAS_MCP_DIRECT_ENABLED: 'true',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'settings',
      CANVAS_MCP_DIRECT_TOOLS: 'auth_probe',
    });
    assert.equal(settingsManagedStatus.restartRequired, false);
    assert.equal(settingsManagedStatus.activationManagedByEnvironment, false);
    assert.equal(settingsManagedStatus.settingsSource, 'settings');

    console.log('mcp-server-settings-test: ok');
  } finally {
    if (previousCanvasDataRoot === undefined) {
      delete process.env.CANVAS_DATA_ROOT;
    } else {
      process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
