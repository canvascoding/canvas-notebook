import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const panelSource = readFileSync(path.join(root, 'app/components/settings/BrandSettingsPanel.tsx'), 'utf8');
const appearanceProviderSource = readFileSync(path.join(root, 'app/components/WorkspaceAppearanceProvider.tsx'), 'utf8');
const brandLogoSource = readFileSync(path.join(root, 'app/components/branding/BrandLogoImage.tsx'), 'utf8');
const workspaceBrandLogoSource = readFileSync(path.join(root, 'app/components/workspaces/WorkspaceBrandLogo.tsx'), 'utf8');
const homeSource = readFileSync(path.join(root, 'app/[locale]/(routes)/page.tsx'), 'utf8');
const globalStyles = readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const german = JSON.parse(readFileSync(path.join(root, 'messages/de.json'), 'utf8')) as Record<string, unknown>;
const english = JSON.parse(readFileSync(path.join(root, 'messages/en.json'), 'utf8')) as Record<string, unknown>;

assert.match(globalStyles, /--radius-full:\s*var\(--radius\);/u);
assert.match(globalStyles, /\.rounded,\s*\.rounded-full\s*\{\s*border-radius:\s*var\(--radius\);/u);
assert.doesNotMatch(globalStyles, /border-radius:\s*(?:50%|999px)/u);
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
assert.match(
  panelSource,
  /const uploadLogo[\s\S]*?applyResponseState\(payload, scope, scopeEntityKey\);[\s\S]*?WORKSPACE_APPEARANCE_UPDATED_EVENT[\s\S]*?identity\.logo\.uploaded/u,
  'Uploading a logo must refresh the active workspace branding immediately.',
);
assert.match(
  panelSource,
  /const removeLogo[\s\S]*?applyResponseState\(payload, scope, scopeEntityKey\);[\s\S]*?WORKSPACE_APPEARANCE_UPDATED_EVENT[\s\S]*?identity\.logo\.removed/u,
  'Removing a logo must refresh the active workspace branding immediately.',
);
assert.match(
  panelSource,
  /const applyPreset[\s\S]*?enabled: current\.enabled,[\s\S]*?appearance: \{[\s\S]*?\.\.\.preset\.appearance,[\s\S]*?enabled: current\.appearance\.enabled/u,
  'Presets must change the shared visual style without silently changing where it is enabled.',
);
assert.match(panelSource, /title=\{t\('customization\.title'\)\}[\s\S]*?isOpen=\{isCustomizationOpen\}/u);
assert.ok(
  panelSource.indexOf("t('activation.presetTitle')") < panelSource.indexOf("t('customization.title')"),
  'Preset selection must be presented before optional customization.',
);
assert.match(panelSource, /id="brand-appearance-enabled"[\s\S]*?id="brand-enabled"/u);
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
assert.match(
  appearanceProviderSource,
  /profile\.appearance\.enabled && profile\.logoPath[\s\S]*?\/api\/workspaces\/\$\{encodeURIComponent\(activeWorkspaceId\)\}\/brand\/logo/u,
  'The UI logo must use the effective workspace endpoint and follow the Canvas activation switch.',
);
assert.match(appearanceProviderSource, /WorkspaceBrandingContext\.Provider/u);
assert.match(homeSource, /<WorkspaceBrandLogo/u);
assert.doesNotMatch(homeSource, /src="\/logo\.jpg"/u);
assert.match(workspaceBrandLogoSource, /<BrandLogoImage/u);
assert.match(brandLogoSource, /fallbackSrc = '\/images\/bradley\/bradley-icon\.svg'/u);
assert.match(brandLogoSource, /unoptimized=\{usesBrandLogo \|\| imageProps\.unoptimized\}/u);
assert.match(brandLogoSource, /onError=\{\(event\) => \{[\s\S]*?setFailedLogoUrl\(logoUrl\)/u);

for (const messages of [german, english]) {
  const settings = messages.settings as Record<string, unknown>;
  const brandDesign = settings.brandDesign as Record<string, unknown>;
  const scope = brandDesign.scope as Record<string, unknown>;
  const organizationDefault = brandDesign.organizationDefault as Record<string, unknown>;
  const activation = brandDesign.activation as Record<string, unknown>;
  const customization = brandDesign.customization as Record<string, unknown>;
  const appearance = brandDesign.appearance as Record<string, unknown>;
  const colors = appearance.colors as Record<string, unknown>;
  const identity = brandDesign.identity as Record<string, unknown>;
  const logo = identity.logo as Record<string, unknown>;
  assert.equal('organizationDescription' in scope, false);
  assert.match(String(organizationDefault.title), /fallback/iu);
  assert.equal(typeof activation.presetTitle, 'string');
  assert.equal(typeof activation.sharedSettings, 'string');
  assert.equal(typeof customization.title, 'string');
  assert.equal(typeof customization.radiusSummary, 'string');
  assert.equal(typeof appearance.title, 'string');
  assert.equal(typeof appearance.radius, 'string');
  assert.equal(typeof appearance.radiusHint, 'string');
  assert.match(String(identity.description), /Canvas/iu);
  assert.match(String(identity.description), /PDF/iu);
  assert.match(String(logo.uploaded), /Canvas/iu);
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
