import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-server-settings-'));
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const runtimeEnvironmentKeys = [
    'CANVAS_MCP_DIRECT_ENABLED',
    'CANVAS_MCP_DIRECT_TOOLS',
    'CANVAS_MCP_DIRECT_SETTINGS_SOURCE',
    'CANVAS_MCP_DIRECT_TOOLS_SOURCE',
  ] as const;
  const previousRuntimeEnvironment = Object.fromEntries(
    runtimeEnvironmentKeys.map((key) => [key, process.env[key]]),
  );

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
    const { DIRECT_MCP_SERVER_VERSION } = await import(
      '../app/lib/mcp/server/version'
    );
    const { DIRECT_MCP_TOOL_IDS, getDirectMcpEnabledTools } = await import(
      '../app/lib/mcp/server/config'
    );
    const {
      buildCodexMcpServerConfiguration,
      missingScopesForEnabledCapabilities,
    } = await import('../app/lib/mcp/client-configuration');
    const { applyDirectMcpSettingsToRuntime } = await import(
      '../app/lib/mcp/server/runtime-settings'
    );
    const { getDirectMcpRuntimeSettings } = await import(
      '../app/lib/mcp/server/runtime-settings'
    );

    assert.equal(await getDirectMcpServerPreferences(), null);
    assert.deepEqual(getDirectMcpEnabledTools({}), [
      'auth_probe',
      'list_workspaces',
      'get_workspace_overview',
      'list_knowledge_tree',
      'search_knowledge',
      'read_knowledge_source',
    ]);
    await setServerPreferredTimeZone('admin-1', 'Europe/Berlin');
    const preferences = await setDirectMcpServerPreferences('admin-1', {
      enabled: true,
      tools: ['auth_probe'],
    });
    assert.equal(preferences.enabled, true);
    assert.deepEqual(preferences.tools, DIRECT_MCP_TOOL_IDS);
    assert.equal(preferences.toolsVersion, 4);
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

    await writeFile(settingsPath, JSON.stringify({
      version: 1,
      settings: {
        directMcp: {
          enabled: true,
          tools: ['auth_probe'],
          toolsVersion: 2,
        },
      },
    }));
    assert.deepEqual(await getDirectMcpServerPreferences(), {
      enabled: true,
      tools: ['auth_probe'],
      toolsVersion: 4,
    });

    await writeFile(settingsPath, JSON.stringify({
      version: 1,
      settings: {
        directMcp: {
          enabled: true,
          tools: ['auth_probe'],
          toolsVersion: 1,
        },
      },
    }));
    assert.deepEqual((await getDirectMcpServerPreferences())?.tools, [
      'auth_probe',
      'list_workspaces',
      'get_workspace_overview',
      'list_knowledge_tree',
      'search_knowledge',
      'read_knowledge_source',
    ]);
    await setDirectMcpServerPreferences('admin-1', {
      enabled: true,
      tools: ['auth_probe'],
    });

    await assert.rejects(
      setDirectMcpServerPreferences('admin-1', {
        enabled: true,
        tools: ['not_a_canvas_tool'],
      }),
      /unsupported value/u,
    );
    assert.deepEqual(
      (await setDirectMcpServerPreferences('admin-1', {
        enabled: true,
        tools: ['read_knowledge_asset'],
      })).tools,
      ['read_knowledge_asset'],
    );
    await setDirectMcpServerPreferences('admin-1', {
      enabled: true,
      tools: ['auth_probe'],
    });

    const status = buildDirectMcpServerSettingsStatus(preferences, {
      NODE_ENV: 'production',
      BASE_URL: 'https://canvas.example.test',
      BETTER_AUTH_BASE_URL: 'https://canvas.example.test',
      CANVAS_MCP_DIRECT_ENABLED: 'false',
    });
    assert.equal(status.endpoint, 'https://canvas.example.test/mcp');
    assert.equal(status.issuer, 'https://canvas.example.test/api/auth');
    assert.equal(status.desiredEnabled, false);
    assert.equal(status.runtimeEnabled, false);
    assert.equal(status.restartRequired, false);
    assert.equal(status.activationManagedByEnvironment, true);
    assert.equal(status.protocolVersion, '2026-07-28');
    assert.equal(status.serverVersion, DIRECT_MCP_SERVER_VERSION);
    assert.deepEqual(
      status.capabilities.filter((capability) => capability.available),
      [
        { id: 'auth_probe', available: true, enabled: true, scopes: ['workspace:list'] },
        { id: 'list_workspaces', available: true, enabled: true, scopes: ['workspace:list'] },
        { id: 'get_workspace_overview', available: true, enabled: true, scopes: ['workspace:list'] },
        { id: 'list_knowledge_tree', available: true, enabled: true, scopes: ['knowledge:tree'] },
        { id: 'search_knowledge', available: true, enabled: true, scopes: ['knowledge:search'] },
        { id: 'read_knowledge_source', available: true, enabled: true, scopes: ['knowledge:read'] },
        { id: 'edit_knowledge_source', available: true, enabled: true, scopes: ['knowledge:write'] },
        { id: 'read_knowledge_asset', available: true, enabled: true, scopes: ['knowledge:assets'] },
        { id: 'upload_knowledge_asset', available: true, enabled: true, scopes: ['knowledge:write'] },
      ],
    );
    assert.equal(
      buildCodexMcpServerConfiguration({
        endpoint: status.endpoint || '',
        enabledTools: ['read_knowledge_asset', 'auth_probe', 'auth_probe'],
      }),
      [
        '[mcp_servers.canvas]',
        'url = "https://canvas.example.test/mcp"',
        'enabled_tools = [',
        '  "auth_probe",',
        '  "read_knowledge_asset",',
        ']',
      ].join('\n'),
    );
    assert.deepEqual(
      missingScopesForEnabledCapabilities({
        grantedScopes: ['workspace:list'],
        capabilities: status.capabilities.map((capability) => ({
          ...capability,
          enabled: capability.id === 'read_knowledge_asset',
        })),
      }),
      ['knowledge:assets'],
    );

    const localDockerStatus = buildDirectMcpServerSettingsStatus(preferences, {
      NODE_ENV: 'production',
      BASE_URL: 'http://localhost:3456',
      BETTER_AUTH_BASE_URL: 'http://localhost:3456',
      CANVAS_MCP_DIRECT_ENABLED: 'false',
    });
    assert.equal(localDockerStatus.endpoint, 'http://localhost:3456/mcp');
    assert.equal(localDockerStatus.configurationError, null);

    applyDirectMcpSettingsToRuntime({
      enabled: false,
      tools: [],
    }, {
      activation: true,
      capabilities: true,
    });
    const disabledPreferences = {
      ...preferences,
      enabled: false,
      tools: [],
    };
    const immediateDisableStatus = buildDirectMcpServerSettingsStatus(disabledPreferences, {
      ...process.env,
      NODE_ENV: 'production',
      BASE_URL: 'https://canvas.example.test',
      BETTER_AUTH_BASE_URL: 'https://canvas.example.test',
    });
    assert.equal(immediateDisableStatus.desiredEnabled, false);
    assert.equal(immediateDisableStatus.runtimeEnabled, false);
    assert.equal(immediateDisableStatus.restartRequired, false);

    const settingsManagedStatus = buildDirectMcpServerSettingsStatus(preferences, {
      NODE_ENV: 'production',
      BASE_URL: 'https://canvas.example.test',
      BETTER_AUTH_BASE_URL: 'https://canvas.example.test',
      CANVAS_MCP_DIRECT_ENABLED: 'false',
      CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'settings',
      CANVAS_MCP_DIRECT_TOOLS: 'auth_probe',
      CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'settings',
    });
    assert.equal(settingsManagedStatus.desiredEnabled, true);
    assert.equal(settingsManagedStatus.runtimeEnabled, true);
    assert.equal(settingsManagedStatus.restartRequired, false);
    assert.equal(settingsManagedStatus.activationManagedByEnvironment, false);
    assert.equal(settingsManagedStatus.settingsSource, 'settings');
    assert.deepEqual(await getDirectMcpRuntimeSettings(), {
      enabled: true,
      tools: ['auth_probe'],
    });

    console.log('mcp-server-settings-test: ok');
  } finally {
    for (const key of runtimeEnvironmentKeys) {
      if (previousRuntimeEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousRuntimeEnvironment[key];
    }
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
