import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const internals = Module as typeof Module & { _load: LoadFn };
const originalLoad = internals._load;
const originalRegistryUrl = process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL;
const installed = { name: 'plugin-27', version: '1.0.0', enabled: true, resourceId: 'user:plugin-27', scopeType: 'user', skills: [] };
internals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (parent?.filename.endsWith('/canvas-plugin-store.ts')) {
    if (request === '@/app/lib/plugins/canvas-plugin-registry') return { listCanvasPlugins: async () => [installed] };
    if (request === '@/app/lib/plugins/visible-installed-plugins') return { listVisibleInstalledCanvasPlugins: async () => [installed] };
    if (request === '@/app/lib/skills/canvas-skill-store') return { readCanvasSkillRegistry: async () => ({ skills: {} }) };
    if (request === '@/app/lib/plugins/plugin-mcp-template-service') return {};
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-catalog-filters-'));
  try {
    const registryPath = path.join(root, 'registry.json');
    const plugins = Array.from({ length: 30 }, (_, i) => ({
      name: `plugin-${i}`, displayName: `Plugin ${String(i).padStart(2, '0')}`, description: i % 2 ? 'Collaborate with the team' : 'Developer tools',
      category: i % 2 ? 'Team' : 'Tools', latestVersion: '2.0.0',
      connectors: i % 4 === 0 ? { composioToolkits: ['gmail'] }
        : i % 4 === 1 ? { email: [{ required: true }], mcp: [{ name: 'shared' }] }
          : i % 4 === 2 ? { mcpServers: 'config.json' } : undefined,
      versions: { '2.0.0': { version: '2.0.0', downloadUrl: 'https://example.test/archive.zip', checksum: `sha256:${'a'.repeat(64)}` } },
    }));
    await fs.writeFile(registryPath, JSON.stringify({ schemaVersion: 1, id: 'filters', name: 'Filters', updatedAt: new Date().toISOString(), plugins }));
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();
    const { listCanvasPluginStore, parseCanvasPluginStoreConnectionType } = await import('../app/lib/plugins/canvas-plugin-store');
    const first = await listCanvasPluginStore({ pageSize: 12 });
    assert.equal(first.pagination.totalItems, 30);
    assert.equal(first.plugins.some(plugin => plugin.name === installed.name), false);
    assert.equal(first.installedPlugins[0].name, installed.name);
    assert.equal(first.installedPlugins[0].installed.updateAvailable, true, 'off-page installations keep global update metadata');
    assert.equal(first.installedPlugins[0].installed.installedPlugin?.resourceId, installed.resourceId);
    assert.deepEqual(first.facets.categories, ['Team', 'Tools']);
    assert.deepEqual(first.facets.connectionTypes, ['composio', 'email', 'mcp', 'none']);
    const combined = await listCanvasPluginStore({ query: 'team', category: ' Team ', connection: 'mcp', pageSize: 3, page: 2 });
    const expected = plugins.filter(plugin => plugin.category === 'Team' && plugin.connectors?.mcp?.length);
    assert.equal(combined.pagination.totalItems, expected.length);
    assert.equal(combined.stats.filteredTotal, expected.length);
    assert.equal(combined.pagination.page, 2);
    assert.deepEqual(combined.plugins.map(plugin => plugin.name), expected.slice(3, 6).map(plugin => plugin.name));
    assert.deepEqual(combined.facets, first.facets, 'facets describe the full catalog rather than the filtered page');
    assert.equal(combined.installedPlugins[0].name, installed.name, 'filtered-out installations still keep update metadata');
    assert.equal((await listCanvasPluginStore({ connection: 'composio' })).pagination.totalItems, 8, 'legacy Composio metadata participates');
    assert.equal((await listCanvasPluginStore({ connection: 'mcp' })).pagination.totalItems, 15, 'modern and legacy MCP metadata participate');
    assert.equal((await listCanvasPluginStore({ connection: 'none' })).pagination.totalItems, 7);
    assert.equal((await listCanvasPluginStore({ connection: 'none', state: 'updates' })).plugins[0].name, installed.name);
    const empty = await listCanvasPluginStore({ category: 'missing', page: 999 });
    assert.equal(empty.pagination.totalItems, 0);
    assert.equal(empty.pagination.page, 1);
    assert.equal(empty.stats.total, 30);
    assert.equal(empty.stats.updates, 1);
    assert.equal(parseCanvasPluginStoreConnectionType('unknown'), undefined);
    assert.equal(parseCanvasPluginStoreConnectionType('email'), 'email');
    console.log('Plugin catalog filters: global combined search/category/connection counts, pagination, full facets, legacy metadata and off-page updates passed.');
  } finally {
    internals._load = originalLoad;
    if (originalRegistryUrl === undefined) delete process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL;
    else process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = originalRegistryUrl;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
