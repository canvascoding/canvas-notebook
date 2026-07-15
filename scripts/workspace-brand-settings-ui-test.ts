import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const panelSource = readFileSync(path.join(root, 'app/components/settings/BrandSettingsPanel.tsx'), 'utf8');
const german = JSON.parse(readFileSync(path.join(root, 'messages/de.json'), 'utf8')) as Record<string, unknown>;
const english = JSON.parse(readFileSync(path.join(root, 'messages/en.json'), 'utf8')) as Record<string, unknown>;

assert.match(panelSource, /<BrandInterfacePreview profile=\{profile\} \/>/u);
assert.match(panelSource, /id="brand-appearance-radius"[\s\S]*?type="range"[\s\S]*?max=\{16\}[\s\S]*?step=\{2\}/u);
assert.match(panelSource, /WORKSPACE_APPEARANCE_UPDATED_EVENT/u);
assert.match(panelSource, /<SettingsAccordionCard[\s\S]*?documentDetails\.title/u);
assert.equal((panelSource.match(/<SimpleColorField/gu) || []).length, 3);

for (const messages of [german, english]) {
  const settings = messages.settings as Record<string, unknown>;
  const brandDesign = settings.brandDesign as Record<string, unknown>;
  const appearance = brandDesign.appearance as Record<string, unknown>;
  const colors = appearance.colors as Record<string, unknown>;
  assert.equal(typeof appearance.title, 'string');
  assert.equal(typeof appearance.radius, 'string');
  assert.equal(typeof appearance.radiusHint, 'string');
  assert.deepEqual(Object.keys(colors), [
    'accent',
    'accentHint',
    'background',
    'backgroundHint',
    'text',
    'textHint',
  ]);
}

console.log('workspace-brand-settings-ui-test: ok');
