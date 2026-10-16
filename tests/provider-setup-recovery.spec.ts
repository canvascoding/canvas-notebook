import { test, expect, type Page } from '@playwright/test';
import type { AdminRuntimeCatalogData } from '@/app/components/settings/ai-runtime/catalog-client';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

async function fixture(page: Page) {
  const model = (id: string) => ({ id, name: id, enabled: true, isProviderDefault: true,
    reasoning: false, supportsVision: false, thinkingLevels: ['off' as const], metadata: {}, revision: 21 });
  const state: AdminRuntimeCatalogData = {
    catalog: { organizationId: 'fixture-org', revision: 21, migrationState: 'configured', legacySourceHash: null,
      updatedAt: null, updatedByUserId: null,
      defaultSelection: { providerInstallationId: 'managed', providerId: 'canvas-control-plane', modelId: 'managed-model', thinkingLevel: 'off' },
      providers: ['canvas-control-plane', 'openai-codex'].map((providerId, index) => ({
        installationId: index ? 'personal' : 'managed', providerId, name: index ? 'OpenAI Codex' : 'Canvas Control Plane',
        source: index ? 'built-in' : 'managed', credentialScope: index ? 'user' : 'managed',
        enabled: true, status: 'ready', config: index ? { authMethod: 'oauth' } : {}, revision: 21,
        sourceRevision: null, lastSyncedAt: null, verifiedAt: null, verifiedByUserId: null,
        models: [model(index ? 'codex-model' : 'managed-model')],
      })),
    }, discovery: {},
  };
  for (const provider of state.catalog.providers) state.discovery[provider.providerId] = {
    id: provider.providerId, name: provider.name, source: provider.source,
    models: provider.models.map(entry => ({ ...entry, contextWindow: 8192, maxTokens: 1024 })),
  };
  for (const id of ['openai', 'anthropic', 'google', 'openrouter']) state.discovery[id] = {
    id, name: id, source: 'built-in', installationIds: { system: `${id}-system`, organization: `${id}-organization`, user: `${id}-user` },
    models: [{ id: `${id}-model`, name: `${id}-model`, reasoning: false, supportsVision: false, contextWindow: 8192, maxTokens: 1024 }],
  };
  const writes: Array<{ expectedRevision: number; providers: Array<{ providerInstallationId: string; providerId: string; credentialScope: string }> }> = [];
  let reads = 0;
  let failedProbe = false;
  await page.route('**/api/admin/agent-runtime/catalog', async route => {
    if (route.request().method() === 'GET') {
      reads++;
      await route.fulfill({ json: { success: true, data: state } }); return;
    }
    const body = route.request().postDataJSON(); writes.push(body);
    if (body.expectedRevision !== state.catalog.revision) {
      await route.fulfill({ status: 409, json: { success: false, code: 'CATALOG_REVISION_CONFLICT', error: `Catalog revision conflict. Current revision is ${state.catalog.revision}.` } }); return;
    }
    state.catalog.revision++;
    state.catalog.providers = state.catalog.providers.filter(provider => body.providers.some((entry: { providerInstallationId: string }) => entry.providerInstallationId === provider.installationId));
    state.catalog.defaultSelection = body.defaultSelection;
    await route.fulfill({ json: { success: true, data: state } });
  });
  await page.route('**/api/admin/agent-runtime/providers/personal/verify', async route => {
    failedProbe = true; state.catalog.revision++;
    state.catalog.providers[1].status = 'degraded'; state.catalog.providers[1].revision++;
    await route.fulfill({ status: 502, json: { success: false, code: 'MODEL_TEST_FAILED', error: 'The model test failed.' } });
  });
  await page.route('**/api/oauth/pi/status**', route => route.fulfill({ json: { success: true,
    provider: { provider: 'openai-codex', displayName: 'OpenAI Codex', connected: true } } }));
  await authenticateManagedTestPage(page);
  await page.goto('/en/settings?tab=ai-providers');
  await expect(page.getByTestId('provider-summary-openai-codex-user')).toBeVisible();
  return { state, writes, reads: () => reads, failedProbe: () => failedProbe };
}

for (const [providerId, key, scope] of [
  ['openai', 'OPENAI_API_KEY', 'user'], ['anthropic', 'ANTHROPIC_API_KEY', 'organization'],
  ['google', 'GEMINI_API_KEY', 'system'], ['openrouter', 'OPENROUTER_API_KEY', 'user'],
] as const) {
  for (const width of [1280, 390]) test(`reuses ${providerId} Secrets in ${scope} scope at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    let secretWrites = 0;
    await page.route('**/api/integrations/env**', async route => {
      if (route.request().method() !== 'GET') { secretWrites++; await route.fulfill({ json: { success: true } }); return; }
      const url = new URL(route.request().url());
      const matches = url.searchParams.get('secretScope') === scope;
      const metadata = url.searchParams.get('metadataOnly') === '1';
      const requestedKey = url.searchParams.get('key');
      await route.fulfill({ json: { success: true, data: { entries: matches && (metadata || requestedKey === key)
        ? [metadata ? { key, configured: true, readable: true } : { key, value: 'existing-private-fixture', readable: true }] : [] } } });
    });
    const setup = await fixture(page);
    await page.getByRole('button', { name: 'Add provider', exact: true }).click();
    const dialog = page.getByTestId('provider-editor-dialog');
    await dialog.getByTestId('provider-dialog-provider-select').selectOption(providerId);
    await expect(dialog.getByTestId('provider-existing-credentials')).toBeVisible();
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog.getByText('Required field not configured yet', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('existing-secret-recognized.png'), scale: 'css' });
    await dialog.getByRole('button', { name: 'Continue to models', exact: true }).click();
    await dialog.getByRole('checkbox', { name: `${providerId}-model ${providerId}-model` }).check();
    await expect(dialog.locator('#provider-credential-scope')).toHaveValue(scope);
    await dialog.getByTestId('provider-save').click();
    await expect(dialog).toHaveCount(0);
    const saved = setup.writes.at(-1)?.providers.find(provider => provider.providerId === providerId);
    expect(saved?.credentialScope).toBe(scope);
    expect(secretWrites).toBe(0);
  });
}

for (const width of [1280, 390]) {
  test(`removes a provider after a failed check at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const setup = await fixture(page);
    await page.getByTestId('provider-summary-openai-codex-user').getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByTestId('provider-editor-dialog');
    await expect(dialog.getByText('Account connected', { exact: true })).toBeVisible();
    await dialog.getByTestId('provider-save-verify').click();
    await expect(dialog.getByText('The model test failed.', { exact: true })).toBeVisible();
    expect(setup.failedProbe()).toBe(true);
    await expect.poll(setup.reads).toBeGreaterThan(1);
    await page.screenshot({ path: testInfo.outputPath('failed-check-recovered.png'), scale: 'css' });
    page.once('dialog', confirmation => confirmation.accept());
    await dialog.getByRole('button', { name: 'Remove provider', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('provider-summary-openai-codex-user')).toHaveCount(0);
    expect(setup.writes.at(-1)?.expectedRevision).toBe(23);
    expect(setup.state.catalog.defaultSelection?.providerInstallationId).toBe('managed');
    await page.reload();
    await expect(page.getByTestId('chat-default-card')).toContainText('Canvas Control Plane');
    await expect(page.getByTestId('provider-summary-openai-codex-user')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('provider-removed.png'), scale: 'css' });
  });
}
