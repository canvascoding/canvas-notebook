import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_BOOTSTRAP_SEED_PLUGIN_NAMES,
  parseBootstrapSeedPluginNames,
} from '../app/lib/plugins/default-seed-plugins';
import { validateCanvasPluginPackage } from '../app/lib/plugins/canvas-plugin-manifest';

async function main() {
  assert.deepEqual([...DEFAULT_BOOTSTRAP_SEED_PLUGIN_NAMES].sort(), ['document-suite']);

  const defaultSet = parseBootstrapSeedPluginNames();
  assert.equal(defaultSet.has('document-suite'), true);
  assert.equal(defaultSet.has('sales-connectors-demo'), false);

  const customSet = parseBootstrapSeedPluginNames('document-suite, sales-connectors-demo');
  assert.deepEqual([...customSet].sort(), ['document-suite', 'sales-connectors-demo']);

  const pluginRoot = path.join(process.cwd(), 'seed_plugins', 'document-suite');
  const validation = await validateCanvasPluginPackage(pluginRoot);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.equal(validation.manifest?.name, 'document-suite');
  assert.equal(validation.manifest?.version, '1.0.0');

  const skillNames: string[] = [];
  const skillRoot = path.join(pluginRoot, 'skills');
  const entries = await fs.readdir(skillRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillRoot, entry.name, 'SKILL.md');
    const stat = await fs.stat(skillPath).catch(() => null);
    if (stat?.isFile()) {
      skillNames.push(entry.name);
    }
  }

  assert.deepEqual(skillNames.sort(), [
    'docx',
    'excalidraw-diagram',
    'pdf',
    'pptx',
    'xlsx',
  ]);

  console.log('default seed plugins test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
