import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import {
  createWorkspaceAccentCssTokens,
  createWorkspaceAppearanceCssTokens,
  normalizeWorkspaceAppearanceDefinition,
  workspaceAppearanceContrastRatio,
  workspaceAppearanceDefinitionFromProfile,
} from '../app/lib/workspaces/appearance-theme';
import { workspaceAppearanceInitScript } from '../app/lib/workspaces/appearance-theme-init';
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

// The first-paint cache must match the hydrated theme, including status colours
// whose contrast is adjusted for custom workspace backgrounds.
for (const backgroundColor of ['#fbf8f1', '#558899', '#047857']) {
  const cachedDefinition = { ...definition, backgroundColor };
  for (const { theme, systemDark, mode } of [
    { theme: 'light', systemDark: false, mode: 'light' },
    { theme: 'dark', systemDark: false, mode: 'dark' },
    { theme: 'system', systemDark: false, mode: 'light' },
    { theme: 'system', systemDark: true, mode: 'dark' },
  ] as const) {
    const applied: Record<string, string> = {};
    const dataset: Record<string, string> = {};
    const cache = new Map([
      ['canvas.activeWorkspaceId', 'appearance-test'],
      ['canvas.workspaceAppearance.appearance-test', JSON.stringify(cachedDefinition)],
      ['theme', theme],
    ]);
    runInNewContext(workspaceAppearanceInitScript, {
      window: {
        location: { pathname: '/de/studio' },
        matchMedia: () => ({ matches: systemDark }),
      },
      localStorage: { getItem: (key: string) => cache.get(key) ?? null },
      document: {
        documentElement: {
          dataset,
          style: { setProperty: (key: string, value: string) => { applied[key] = value; } },
        },
      },
    });
    assert.deepEqual(applied, createWorkspaceAppearanceCssTokens(cachedDefinition, mode),
      `First-paint and hydrated tokens must match for ${backgroundColor} in ${theme}/${systemDark ? 'dark' : 'light'}.`);
    assert.equal(dataset.workspaceAppearance, 'true');
    assert.equal(dataset.workspaceAppearanceWorkspace, 'appearance-test');
  }
}

console.log('workspace-appearance-theme-test: ok');
