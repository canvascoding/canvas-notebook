import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createMobileCompatibility } from '../app/lib/mobile/compatibility';
import type { CanvasPluginStorePluginWithState } from '../app/lib/plugins/canvas-plugin-store';
import {
  serializeMobileInstalledPlugin,
  serializeMobilePluginPreflight,
  serializeMobilePluginSummary,
} from '../app/lib/mobile/extensions';

const routeExports = new Map<string, string>([
  ['app/api/mobile/v1/agents/route.ts', "export { GET, PATCH, POST } from '@/app/api/agents/route';"],
  ['app/api/mobile/v1/agents/files/route.ts', "export { GET, PUT } from '@/app/api/agents/files/route';"],
  ['app/api/mobile/v1/extensions/skills/route.ts', "export { GET } from '@/app/api/skills/route';"],
  ['app/api/mobile/v1/extensions/skills/store/route.ts', "export { GET } from '@/app/api/skills/store/route';"],
  ['app/api/mobile/v1/extensions/skills/store/install/route.ts', "export { POST } from '@/app/api/skills/store/install/route';"],
  ['app/api/mobile/v1/extensions/skills/[name]/enable/route.ts', "export { POST } from '@/app/api/skills/[name]/enable/route';"],
  ['app/api/mobile/v1/extensions/skills/[name]/disable/route.ts', "export { POST } from '@/app/api/skills/[name]/disable/route';"],
]);

async function main() {
  const compatibility = createMobileCompatibility({
    rawInstanceId: 'mobile-agent-store-test',
    instanceName: 'Agent Store Test',
    serverVersion: '2026.7.24',
    deploymentMode: 'managed-team',
  });

  assert.equal(compatibility.mobileApi.capabilities.includes('agents.manage'), true);
  assert.equal(compatibility.mobileApi.capabilities.includes('extensions.store'), true);
  assert.equal(compatibility.mobileApi.capabilities.includes('extensions.marketplace_v2'), true);
  assert.equal(compatibility.mobileApi.capabilities.includes('integrations.composio_catalog'), true);
  assert.equal(compatibility.mobileApi.capabilities.includes('integrations.composio_mobile_auth'), true);

  for (const [file, expected] of routeExports) {
    const content = (await readFile(path.resolve(process.cwd(), file), 'utf8')).trim();
    assert.equal(content, expected, `${file} must remain a versioned alias of the authorized domain route.`);
  }

  const mobileRouteMarkers = new Map<string, string>([
    ['app/api/mobile/v1/extensions/plugins/route.ts', 'serializeMobileInstalledPlugin'],
    ['app/api/mobile/v1/extensions/plugins/store/route.ts', 'serializeMobilePluginSummary'],
    ['app/api/mobile/v1/extensions/plugins/store/[name]/route.ts', 'serializeMobilePluginDetail'],
    ['app/api/mobile/v1/extensions/plugins/store/preflight/route.ts', 'serializeMobilePluginPreflight'],
    ['app/api/mobile/v1/extensions/plugins/store/[name]/icon/route.ts', 'readCanvasPluginStoreIcon'],
    ['app/api/mobile/v1/extensions/plugins/asset/route.ts', 'getCanvasPlugin'],
  ]);
  for (const [file, marker] of mobileRouteMarkers) {
    const content = await readFile(path.resolve(process.cwd(), file), 'utf8');
    assert.equal(content.includes(marker), true, `${file} must use the curated mobile contract.`);
  }

  const storePlugin: CanvasPluginStorePluginWithState = {
    name: 'sales-helper',
    displayName: 'Sales Helper',
    description: 'Helps sales teams.',
    latestVersion: '2.0.0',
    iconUrl: 'https://example.com/icon.png',
    brandColor: '#4455ff',
    skills: ['lead-research'],
    connectors: {
      composio: [{ toolkit: 'hubspot' }],
      mcp: [{ name: 'crm-mcp' }],
    },
    versions: {
      '2.0.0': {
        version: '2.0.0',
        downloadUrl: 'https://example.com/plugin.zip',
        checksum: 'sha256:test',
      },
    },
    installed: {
      installed: true,
      enabled: true,
      version: '1.0.0',
      updateAvailable: true,
      installedPlugin: {
        name: 'sales-helper',
        version: '1.0.0',
        description: 'private',
        installedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        enabled: true,
        checksum: 'secret',
        installDir: '/private/plugin',
        manifestPath: '/private/plugin/.canvas-plugin/plugin.json',
        skills: [],
        scopeType: 'user',
      },
      skills: [],
      skillSummary: {
        total: 0,
        installed: 0,
        missing: 0,
        updateAvailable: 0,
        modified: 0,
        repairable: 0,
      },
    },
  };
  const summary = serializeMobilePluginSummary(storePlugin);
  assert.equal(summary.icon.url, '/api/mobile/v1/extensions/plugins/store/sales-helper/icon');
  assert.deepEqual(summary.contents, {
    skills: 1,
    apps: 1,
    mcpServers: 1,
    emailConnections: 0,
    total: 3,
  });
  assert.equal('versions' in summary, false);
  assert.equal('installedPlugin' in summary.state, false);

  const installed = serializeMobileInstalledPlugin(storePlugin.installed.installedPlugin!);
  assert.equal('installDir' in installed, false);
  assert.equal('checksum' in installed, false);
  assert.equal(installed.icon.initials, 'SH');

  const preflight = serializeMobilePluginPreflight({
    pluginName: 'sales-helper',
    version: '2.0.0',
    ready: false,
    hasRequiredMissing: true,
    hasSkillIssues: false,
    items: [{
      type: 'mcp',
      key: 'crm-mcp',
      label: 'CRM MCP',
      required: true,
      ready: false,
      action: 'configure-mcp',
    }],
    skills: [],
    summary: { total: 1, ready: 0, requiredMissing: 1, recommendedMissing: 0 },
    skillSummary: {
      total: 0,
      installed: 0,
      missing: 0,
      updateAvailable: 0,
      modified: 0,
      repairable: 0,
    },
  });
  assert.equal(preflight.items[0]?.icon.url, '/api/mobile/v1/integrations/mcp-icon/crm-mcp');
  assert.equal('skills' in preflight, false);

  console.log('mobile-agents-extensions-test: ok');
}

void main();
