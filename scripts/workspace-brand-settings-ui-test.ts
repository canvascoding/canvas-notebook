import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const panelSource = readFileSync(path.join(root, 'app/components/settings/BrandSettingsPanel.tsx'), 'utf8');
const globalStyles = readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const german = JSON.parse(readFileSync(path.join(root, 'messages/de.json'), 'utf8')) as Record<string, unknown>;
const english = JSON.parse(readFileSync(path.join(root, 'messages/en.json'), 'utf8')) as Record<string, unknown>;

assert.match(globalStyles, /--radius-full:\s*var\(--radius\);/u);
assert.match(globalStyles, /\.rounded,\s*\.rounded-full\s*\{\s*border-radius:\s*var\(--radius\);/u);
assert.match(panelSource, /<BrandInterfacePreview profile=\{profile\} \/>/u);
assert.match(panelSource, /useState<BrandScope>\(\(\) => canManageOrganizationBrand \? 'organization' : 'workspace'\)/u);
assert.match(
  panelSource,
  /<BrandInterfacePreview profile=\{profile\} \/>[\s\S]*?<Button[\s\S]*?disabled=\{controlsDisabled \|\| !hasUnsavedChanges\}[\s\S]*?saveOrganization/u,
  'The primary save action must stay directly below the live interface preview.',
);
assert.equal((panelSource.match(/onClick=\{\(\) => void saveProfile\(\)\}/gu) || []).length, 1);
assert.match(panelSource, /id="brand-appearance-radius"[\s\S]*?type="range"[\s\S]*?max=\{16\}[\s\S]*?step=\{2\}/u);
assert.match(panelSource, /WORKSPACE_APPEARANCE_UPDATED_EVENT/u);
assert.match(panelSource, /<SettingsAccordionCard[\s\S]*?documentDetails\.title/u);
assert.equal((panelSource.match(/<SimpleColorField/gu) || []).length, 3);
assert.match(
  panelSource,
  /\{scope === 'workspace' \? \(\s*<div className="grid[\s\S]*?<NativeSelect[\s\S]*?\) : \(\s*<div className="flex[\s\S]*?organizationDefault\.title/u,
  'The workspace selector must only be rendered for workspace-scoped brand settings.',
);
assert.match(panelSource, /const organizationId = useWorkspaceStore\(\(state\) => state\.organizationId\);/u);
assert.equal((panelSource.match(/organizationDefault\.title/gu) || []).length, 1);
assert.doesNotMatch(panelSource, /scope\.organizationDescription/u);

for (const messages of [german, english]) {
  const settings = messages.settings as Record<string, unknown>;
  const brandDesign = settings.brandDesign as Record<string, unknown>;
  const scope = brandDesign.scope as Record<string, unknown>;
  const organizationDefault = brandDesign.organizationDefault as Record<string, unknown>;
  const appearance = brandDesign.appearance as Record<string, unknown>;
  const colors = appearance.colors as Record<string, unknown>;
  assert.equal('organizationDescription' in scope, false);
  assert.match(String(organizationDefault.title), /fallback/iu);
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
