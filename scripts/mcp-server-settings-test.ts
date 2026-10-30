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
    const { DIRECT_MCP_TOOL_IDS, DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS, getDirectMcpEnabledTools } = await import(
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
    assert(DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS.includes('copy_knowledge_source'));
    assert.deepEqual(getDirectMcpEnabledTools({ CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source' }), ['copy_knowledge_source']);
    assert.throws(() => getDirectMcpEnabledTools({ CANVAS_MCP_DIRECT_TOOLS: 'Copy_knowledge_source' }), /unsupported tools/u);
    await setServerPreferredTimeZone('admin-1', 'Europe/Berlin');
    const preferences = await setDirectMcpServerPreferences('admin-1', {
      enabled: true,
      tools: ['auth_probe'],
    });
    assert.equal(preferences.enabled, true);
    assert.equal(preferences.tools.includes('copy_knowledge_source'), false,
      'Activating MCP must not opt in to the reserved Copy capability.');
    assert.deepEqual(preferences.tools, DIRECT_MCP_TOOL_IDS.filter(tool => !(DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS as readonly string[]).includes(tool)));
    assert.equal(preferences.toolsVersion, 8);
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
      toolsVersion: 8,
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
        { id: 'get_knowledge_manifest', available: true, enabled: true, scopes: ['knowledge:read'] },
        { id: 'list_knowledge_tree', available: true, enabled: true, scopes: ['knowledge:tree'] },
        { id: 'search_knowledge', available: true, enabled: true, scopes: ['knowledge:search'] },
        { id: 'read_knowledge_source', available: true, enabled: true, scopes: ['knowledge:read'] },
        { id: 'edit_knowledge_source', available: true, enabled: true, scopes: ['knowledge:write'] },
        { id: 'replace_knowledge_source', available: true, enabled: false, scopes: ['knowledge:write'] },
        { id: 'copy_knowledge_source', available: true, enabled: false, scopes: ['knowledge:write'] },
        { id: 'move_knowledge_source', available: true, enabled: false, scopes: ['knowledge:write'] },
        { id: 'delete_knowledge_source', available: true, enabled: false, scopes: ['knowledge:write'] },
        { id: 'read_knowledge_asset', available: true, enabled: true, scopes: ['knowledge:assets'] },
        { id: 'upload_knowledge_asset', available: true, enabled: true, scopes: ['knowledge:write'] },
        { id: 'create_knowledge_source', available: true, enabled: false, scopes: ['knowledge:write'] },
        { id: 'import_knowledge_file', available: true, enabled: false, scopes: ['knowledge:write'] },
        { id: 'create_excalidraw_scene', available: true, enabled: false, scopes: ['knowledge:write'] },
        { id: 'get_excalidraw_scene', available: true, enabled: false, scopes: ['knowledge:read'] },
        { id: 'edit_excalidraw_scene', available: true, enabled: false, scopes: ['knowledge:write'] },
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

    await writeFile(settingsPath, JSON.stringify({ version: 1, settings: { directMcp: {
      enabled: true, tools: ['auth_probe', 'edit_knowledge_source'], toolsVersion: 6,
    } } }));
    assert.deepEqual((await getDirectMcpServerPreferences())?.tools, ['auth_probe', 'edit_knowledge_source'],
      'A version 6 installation must not silently gain scene capabilities on upgrade.');
    await setDirectMcpServerPreferences('admin-1', { enabled: false, tools: ['auth_probe'] });
    const reactivated = await setDirectMcpServerPreferences('admin-1', { enabled: true, tools: ['auth_probe'] });
    for (const tool of ['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene'] as const) {
      assert.equal(reactivated.tools.includes(tool), false, 'Reactivation must not opt in to scene tools.');
    }
    const selected = await setDirectMcpServerPreferences('admin-1', { enabled: true,
      tools: ['auth_probe', 'create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene'] });
    assert.deepEqual(selected.tools, ['auth_probe', 'create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene']);
    assert.equal(reactivated.tools.includes('copy_knowledge_source'), false);
    const reservedStatus = buildDirectMcpServerSettingsStatus(null, {
      BASE_URL: 'https://canvas.example.test', BETTER_AUTH_BASE_URL: 'https://canvas.example.test',
      CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_TOOLS: 'copy_knowledge_source',
    });
    assert.equal(reservedStatus.configurationError, null);
    assert.deepEqual(reservedStatus.capabilities.find(capability => capability.id === 'copy_knowledge_source'),
      { id: 'copy_knowledge_source', available: true, scopes: ['knowledge:write'], enabled: true },
      'The connected Copy capability is advertised after explicit selection with its actual Write scope.');
    const selectedCopy = await setDirectMcpServerPreferences('admin-1', { enabled: true,
      tools: ['auth_probe', 'copy_knowledge_source'] });
    assert.deepEqual(selectedCopy.tools, ['auth_probe', 'copy_knowledge_source']);
    assert.deepEqual((await getDirectMcpServerPreferences())?.tools, selectedCopy.tools);
    for (const tool of ['move_knowledge_source', 'delete_knowledge_source'] as const) {
      assert(DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS.includes(tool));
      assert.equal(getDirectMcpEnabledTools({}).includes(tool), false);
      assert.equal(preferences.tools.includes(tool), false);
      assert.equal(reactivated.tools.includes(tool), false);
      assert.deepEqual(getDirectMcpEnabledTools({ CANVAS_MCP_DIRECT_TOOLS: tool }), [tool]);
      const status = buildDirectMcpServerSettingsStatus(null, {
        BASE_URL: 'https://canvas.example.test', BETTER_AUTH_BASE_URL: 'https://canvas.example.test',
        CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_TOOLS: tool,
      });
      assert.equal(status.configurationError, null);
      assert.deepEqual(status.capabilities.find(capability => capability.id === tool),
        { id: tool, available: true, scopes: ['knowledge:write'], enabled: true },
        'The connected Move/Delete capability is advertised after explicit selection with its actual Write scope.');
      const saved = await setDirectMcpServerPreferences('admin-1', { enabled: true, tools: ['auth_probe', tool] });
      assert.deepEqual(saved.tools, ['auth_probe', tool]);
      assert.deepEqual((await getDirectMcpServerPreferences())?.tools, saved.tools);
    }
    console.log('mcp-server-settings-test: ok (scene capabilities require explicit activation, upgrade and reactivation selection)');
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
