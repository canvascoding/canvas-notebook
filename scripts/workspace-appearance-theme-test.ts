import assert from 'node:assert/strict';

import {
  createWorkspaceAccentCssTokens,
  createWorkspaceAppearanceCssTokens,
  normalizeWorkspaceAppearanceDefinition,
  workspaceAppearanceContrastRatio,
  workspaceAppearanceDefinitionFromProfile,
} from '../app/lib/workspaces/appearance-theme';
import {
  WORKSPACE_BRAND_PRESETS,
  cloneWorkspaceBrandProfile,
} from '../app/lib/workspaces/brand-profile';

const profile = cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS.editorial);
profile.appearance.enabled = true;
profile.appearance.radiusPx = 12;

const definition = workspaceAppearanceDefinitionFromProfile(profile);
assert.deepEqual(definition, {
  enabled: true,
  radiusPx: 12,
  backgroundColor: '#fbf8f1',
  textColor: '#29251f',
  accentColor: '#b24a2b',
  font: 'editorial-serif',
});

assert.deepEqual(normalizeWorkspaceAppearanceDefinition({ ...definition, radiusPx: 99 }), {
  ...definition,
  radiusPx: 16,
});
assert.equal(normalizeWorkspaceAppearanceDefinition({ ...definition, accentColor: 'red; color: white' }), null);
assert.equal(normalizeWorkspaceAppearanceDefinition({ ...definition, font: 'url(https://example.com/font)' }), null);

const light = createWorkspaceAppearanceCssTokens(definition, 'light');
assert.equal(light['--background'], '#fbf8f1');
assert.equal(light['--primary'], '#b24a2b');
assert.equal(light['--radius'], '12px');
assert.match(light['--app-font-sans'], /Georgia/u);
assert.ok(workspaceAppearanceContrastRatio(light['--foreground'], light['--background']) >= 4.5);
assert.ok(workspaceAppearanceContrastRatio(light['--primary-foreground'], light['--primary']) >= 4.5);

const dark = createWorkspaceAppearanceCssTokens(definition, 'dark');
assert.notEqual(dark['--background'], light['--background']);
assert.ok(workspaceAppearanceContrastRatio(dark['--foreground'], dark['--background']) >= 4.5);
assert.ok(workspaceAppearanceContrastRatio(dark['--muted-foreground'], dark['--muted']) >= 4.5);

const workspaceAccent = createWorkspaceAccentCssTokens('#047857', 'light');
assert.equal(workspaceAccent['--primary'], '#047857');
assert.equal(workspaceAccent['--ring'], workspaceAccent['--primary']);
assert.equal(workspaceAccent['--sidebar-primary'], workspaceAccent['--primary']);
assert.ok(workspaceAppearanceContrastRatio(workspaceAccent['--primary-foreground'], workspaceAccent['--primary']) >= 4.5);

const darkWorkspaceAccent = createWorkspaceAccentCssTokens('#A16207', 'dark');
assert.ok(workspaceAppearanceContrastRatio(darkWorkspaceAccent['--primary'], '#090c12') >= 3);
assert.notEqual(darkWorkspaceAccent['--accent'], workspaceAccent['--accent']);

const fallbackAccent = createWorkspaceAccentCssTokens('not-a-color', 'light');
assert.equal(fallbackAccent['--primary'], '#2563eb');

console.log('workspace-appearance-theme-test: ok');
