import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import JSZip from 'jszip';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function createTestPluginPackage(): Promise<string> {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-package-'));

  await writeFile(path.join(pluginRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({
    name: 'test-plugin',
    version: '1.0.0',
    description: 'Temporary plugin runtime test.',
    license: 'MIT',
    skills: './skills',
    interface: {
      displayName: 'Test Plugin',
      shortDescription: 'Runtime test plugin',
      brandColor: '#2563EB',
      icon: './assets/icon.svg',
    },
    connectors: {
      composio: ['google-drive'],
    },
  }, null, 2));

  await writeFile(path.join(pluginRoot, 'skills', 'test-plugin-skill', 'SKILL.md'), `---
name: test-plugin-skill
description: "Use this temporary plugin skill for Canvas plugin runtime tests."
metadata:
  version: "1.0.0"
---

# Test Plugin Skill

This is a temporary test skill.
`);

  await writeFile(path.join(pluginRoot, 'skills', 'test-plugin-skill', 'agents', 'canvas.yaml'), `interface:
  display_name: Test Plugin Skill
  short_description: Temporary plugin skill
  brand_color: "#2563EB"
  icon_small: "./icon.svg"
`);

  await writeFile(
    path.join(pluginRoot, 'skills', 'test-plugin-skill', 'icon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#2563EB"/><text x="16" y="21" font-size="12" text-anchor="middle" fill="white">TP</text></svg>\n',
  );

  return pluginRoot;
}

async function createStoreArchive(pluginRoot: string, checksum: string): Promise<string> {
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-store-'));
  const packagePrefix = 'canvas-plugin-marketplace-test/plugins/test-plugin/1.0.0';
  const zip = new JSZip();

  async function addDirectory(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await addDirectory(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(pluginRoot, fullPath).split(path.sep).join('/');
        zip.file(`${packagePrefix}/${relativePath}`, await fs.readFile(fullPath));
      }
    }
  }

  await addDirectory(pluginRoot);
  const zipPath = path.join(storeRoot, 'test-plugin.zip');
  await fs.writeFile(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const registryPath = path.join(storeRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1,
    id: 'test-store',
    name: 'Test Plugin Store',
    updatedAt: '2026-06-17T00:00:00.000Z',
    plugins: [
      {
        name: 'test-plugin',
        displayName: 'Test Plugin',
        description: 'Temporary plugin store test.',
        latestVersion: '1.0.0',
        icon: 'plugins/test-plugin/1.0.0/assets/icon.svg',
        brandColor: '#2563EB',
        skills: ['test-plugin-skill'],
        versions: {
          '1.0.0': {
            version: '1.0.0',
            downloadUrl: pathToFileURL(zipPath).toString(),
            packagePath: packagePrefix,
            checksum: `sha256:${checksum}`,
            manifestPath: '.canvas-plugin/plugin.json',
            releasedAt: '2026-06-17T00:00:00.000Z',
          },
        },
      },
    ],
  }, null, 2));

  return registryPath;
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-test-data-'));
  const pluginRoot = await createTestPluginPackage();
  let storeRoot: string | null = null;
  process.env.CANVAS_DATA_ROOT = dataRoot;

  try {
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    await writeFile(
      path.join(dataRoot, 'settings', 'pi-runtime-config.json'),
      JSON.stringify(DEFAULT_PI_CONFIG, null, 2),
    );

    const {
      deleteCanvasPlugin,
      computeCanvasPluginChecksum,
      installCanvasPluginFromPath,
      listCanvasPlugins,
      setCanvasPluginEnabled,
    } = await import('../app/lib/plugins/canvas-plugin-registry');
    const {
      installCanvasPluginFromStore,
      listCanvasPluginStore,
    } = await import('../app/lib/plugins/canvas-plugin-store');
    const {
      buildReferencedPluginRuntimeContext,
    } = await import('../app/lib/plugins/plugin-reference-context');
    const { loadSkillsFromDisk } = await import('../app/lib/skills/skill-loader');

    const install = await installCanvasPluginFromPath(pluginRoot, { enable: true });
    assert.equal(install.success, true, install.error || JSON.stringify(install.validation));

    let plugins = await listCanvasPlugins();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, 'test-plugin');
    assert.equal(plugins[0].skills[0].name, 'test-plugin-skill');

    let skills = await loadSkillsFromDisk();
    assert.equal(skills.some((skill) => skill.name === 'test-plugin-skill' && skill.plugin?.name === 'test-plugin'), true);

    const pluginRuntimeContext = await buildReferencedPluginRuntimeContext('Use /test-plugin for this workflow.');
    assert.match(pluginRuntimeContext || '', /Referenced Canvas Plugins/);
    assert.match(pluginRuntimeContext || '', /test-plugin-skill/);

    const disable = await setCanvasPluginEnabled('test-plugin', false);
    assert.equal(disable.success, true, disable.error);
    skills = await loadSkillsFromDisk();
    assert.equal(skills.some((skill) => skill.name === 'test-plugin-skill'), false);

    const enable = await setCanvasPluginEnabled('test-plugin', true);
    assert.equal(enable.success, true, enable.error);
    skills = await loadSkillsFromDisk();
    assert.equal(skills.some((skill) => skill.name === 'test-plugin-skill'), true);

    const deleted = await deleteCanvasPlugin('test-plugin');
    assert.equal(deleted.success, true, deleted.error);
    plugins = await listCanvasPlugins();
    assert.equal(plugins.length, 0);

    const checksum = await computeCanvasPluginChecksum(pluginRoot);
    const registryPath = await createStoreArchive(pluginRoot, checksum);
    storeRoot = path.dirname(registryPath);
    process.env.CANVAS_PLUGIN_STORE_REGISTRY_URL = pathToFileURL(registryPath).toString();

    let store = await listCanvasPluginStore();
    assert.equal(store.plugins.length, 1);
    assert.equal(store.plugins[0].name, 'test-plugin');
    assert.equal(store.plugins[0].installed.installed, false);

    const storeInstall = await installCanvasPluginFromStore('test-plugin', undefined, { enable: true });
    assert.equal(storeInstall.success, true, storeInstall.error || JSON.stringify(storeInstall.validation));

    store = await listCanvasPluginStore();
    assert.equal(store.plugins[0].installed.installed, true);
    assert.equal(store.plugins[0].installed.version, '1.0.0');

    console.log('canvas plugin runtime test passed');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
    if (storeRoot) {
      await fs.rm(storeRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
