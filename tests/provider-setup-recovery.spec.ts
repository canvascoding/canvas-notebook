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
  const writes: Array<{ expectedRevision: number; providers: Array<{ providerInstallationId: string }> }> = [];
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
