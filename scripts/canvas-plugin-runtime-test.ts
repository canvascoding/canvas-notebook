import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-test-data-'));
  const pluginRoot = await createTestPluginPackage();
  process.env.CANVAS_DATA_ROOT = dataRoot;

  try {
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    await writeFile(
      path.join(dataRoot, 'settings', 'pi-runtime-config.json'),
      JSON.stringify(DEFAULT_PI_CONFIG, null, 2),
    );

    const {
      deleteCanvasPlugin,
      installCanvasPluginFromPath,
      listCanvasPlugins,
      setCanvasPluginEnabled,
    } = await import('../app/lib/plugins/canvas-plugin-registry');
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

    console.log('canvas plugin runtime test passed');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
