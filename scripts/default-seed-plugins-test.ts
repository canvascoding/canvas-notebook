import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
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
  assert.equal(validation.manifest?.version, '1.2.0');

  const skillNames = validation.manifest?.skillRefs?.map((skill) => skill.name).sort() || [];
  assert.deepEqual(skillNames, [
    'docx',
    'excalidraw-diagram',
    'marp-slides',
    'pdf',
    'pptx',
    'xlsx',
  ]);
  assert.equal(validation.skillsDir, undefined);

  const symlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-symlink-test-'));
  try {
    await fs.mkdir(path.join(symlinkRoot, '.canvas-plugin'), { recursive: true });
    await fs.writeFile(path.join(symlinkRoot, '.canvas-plugin', 'plugin.json'), JSON.stringify({
      name: 'symlink-test',
      version: '1.0.0',
      description: 'Temporary plugin package used to validate symlink rejection.',
      skillRefs: [{ name: 'pdf', source: 'seed' }],
    }), 'utf8');
    await fs.symlink('/tmp', path.join(symlinkRoot, 'outside-link'));

    const symlinkValidation = await validateCanvasPluginPackage(symlinkRoot);
    assert.equal(symlinkValidation.valid, false);
    assert.match(symlinkValidation.errors.join('\n'), /symbolic links/i);
  } finally {
    await fs.rm(symlinkRoot, { recursive: true, force: true });
  }

  console.log('default seed plugins test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
