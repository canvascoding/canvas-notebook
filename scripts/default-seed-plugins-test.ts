import assert from 'node:assert/strict';
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

  console.log('default seed plugins test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
