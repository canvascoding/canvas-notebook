import { expect, test, type Page } from '@playwright/test';
import type { AiAppRuntimeCatalog, AiCatalogProviderUpdate, AiCatalogUpdate } from '../app/lib/agent-runtime-policy/types';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
type Provider = AiAppRuntimeCatalog['providers'][number];
type CatalogFixture = { before: AiAppRuntimeCatalog; attempted: boolean; created?: Provider };
const catalogFixtures = new WeakMap<Page, CatalogFixture>();

function providerUpdate(provider: Provider): AiCatalogProviderUpdate {
  return { providerInstallationId: provider.installationId, providerId: provider.providerId,
    enabled: provider.enabled, credentialScope: provider.credentialScope, config: provider.config,
    modelIds: provider.models.filter(model => model.enabled).map(model => model.id),
    defaultModelId: provider.models.find(model => model.isProviderDefault)?.id ?? '' };
}

async function readCatalog(page: Page): Promise<AiAppRuntimeCatalog> {
  const response = await page.request.get('/api/admin/agent-runtime/catalog');
  expect(response.status(), 'Read the genuine catalog for fixture preservation.').toBe(200);
  return (await response.json()).data.catalog;
}

async function restoreCatalogFixture(page: Page, fixture: CatalogFixture): Promise<void> {
  if (!fixture.attempted) return;
  const current = await readCatalog(page);
  const originalIds = new Set(fixture.before.providers.map(provider => provider.installationId));
  // Reconcile a lost save response only through the exact submitted fixture.
  const candidates = current.providers.filter(provider => !originalIds.has(provider.installationId)
    && provider.providerId === 'ollama' && provider.credentialScope === 'organization'
    && provider.config.ollamaHost === 'http://ollama:11434' && provider.enabled
    && provider.models.length === 1 && provider.models[0].id === 'research/custom:latest'
    && provider.models[0].enabled && provider.models[0].isProviderDefault);
  expect(candidates, 'Only the newly created fixture provider can be removed.').toHaveLength(1);
  const owned = candidates[0];
  if (fixture.created) expect(providerUpdate(owned)).toEqual(providerUpdate(fixture.created));
  const providers = current.providers.filter(provider => provider.installationId !== owned.installationId).map(providerUpdate);
  const defaultSelection = current.defaultSelection?.providerInstallationId === owned.installationId
    ? fixture.before.defaultSelection : current.defaultSelection;
  if (defaultSelection) expect(providers.some(provider => provider.providerInstallationId === defaultSelection.providerInstallationId
    && provider.enabled && provider.modelIds.includes(defaultSelection.modelId)), 'Retained default must still be available.').toBe(true);
  const restored = await page.request.put('/api/admin/agent-runtime/catalog', {
    data: { expectedRevision: current.revision, providers, defaultSelection },
  });
  expect(restored.status(), 'Restore through the revision-protected catalog API.').toBe(200);
  const verified = await readCatalog(page);
  expect(verified.providers.map(providerUpdate), 'Preserve every non-fixture provider.').toEqual(providers);
  expect(verified.defaultSelection).toEqual(defaultSelection);
  for (const original of fixture.before.providers) {
    const retained = verified.providers.find(provider => provider.installationId === original.installationId);
    expect(retained, 'Retain the original provider.').toBeDefined();
    expect(providerUpdate(retained!), 'Preserve the original provider configuration.').toEqual(providerUpdate(original));
    expect({ status: retained!.status, verifiedAt: retained!.verifiedAt },
      'Preserve genuine provider verification.').toEqual({ status: original.status, verifiedAt: original.verifiedAt });
  }
}

async function login(page: Page) {
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
}

async function openProviderSettings(page: Page) {
  await page.goto('/en/settings?tab=ai-providers');
  await expect(page.getByRole('heading', { name: 'AI providers & models' })).toBeVisible();
  await expect(page.getByTestId('chat-default-card')).toBeVisible();
}

test.describe('Ollama provider setup', () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
    catalogFixtures.set(page, { before: await readCatalog(page), attempted: false });
  });
  test.afterEach(async ({ page }) => {
    const fixture = catalogFixtures.get(page);
    try { if (fixture) await restoreCatalogFixture(page, fixture); }
    finally { catalogFixtures.delete(page); }
  });

  test('preserves unedited provider configuration when saving the default', async ({ page }) => {
    const response = await page.request.get('/api/admin/agent-runtime/catalog');
    expect(response.status()).toBe(200);
    const payload = await response.json();
    const catalog = payload.data.catalog as AiAppRuntimeCatalog;
    // Older valid catalogs omit optional model-editor fields. Exercise that
    // transport shape without changing the managed provider or its readiness.
    for (const provider of catalog.providers) {
      if (provider.providerId === 'ollama') delete provider.config.ollamaAdditionalModels;
    }
    expect(catalog.providers.some(provider => provider.providerId === 'ollama')).toBe(true);
    let submitted: AiCatalogUpdate | undefined;
    await page.route('**/api/admin/agent-runtime/catalog', async route => {
      if (route.request().method() === 'PUT') submitted = route.request().postDataJSON() as AiCatalogUpdate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });

    await openProviderSettings(page);
    await page.getByTestId('chat-default-card').getByRole('button', { name: 'Edit' }).click();
    await page.getByTestId('chat-default-dialog').getByRole('button', { name: 'Save default' }).click();
    await expect.poll(() => submitted?.providers).toEqual(catalog.providers.map(providerUpdate));
    expect(submitted?.defaultSelection).toEqual(catalog.defaultSelection);
    await page.unroute('**/api/admin/agent-runtime/catalog');
    expect(await readCatalog(page), 'The controlled transport test must not mutate the real catalog.')
      .toEqual(catalogFixtures.get(page)!.before);
  });

  test('uses a progressive setup dialog with discovered and custom models', async ({ page }, testInfo) => {
    await page.route('**/api/admin/agent-runtime/providers/ollama/discover', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            serverUrl: 'http://ollama:11434',
            models: [
              { id: 'qwen2.5:7b', name: 'qwen2.5:7b' },
              { id: 'team/model:latest', name: 'team/model:latest' },
            ],
          },
        }),
      });
    });

    await openProviderSettings(page);

    const defaultCard = page.getByTestId('chat-default-card');
    const providerHeading = page.getByRole('heading', { name: 'Providers', exact: true });
    const [defaultBox, providerBox] = await Promise.all([
      defaultCard.boundingBox(),
      providerHeading.boundingBox(),
    ]);
    expect(defaultBox).not.toBeNull();
    expect(providerBox).not.toBeNull();
    expect(defaultBox!.y).toBeLessThan(providerBox!.y);

    await page.getByRole('button', { name: 'Add provider' }).click();
    const dialog = page.getByTestId('provider-editor-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('provider-dialog-provider-select').selectOption('ollama');
    await expect(dialog.getByText('1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('2', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('3', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('ollama-server-url')).toHaveValue('http://localhost:11434');
    await expect(page.getByTestId('provider-model-list')).toHaveCount(0);
    await expect(dialog.getByText('Test the connection to load models from this Ollama server.').first()).toBeVisible();

    await page.getByTestId('ollama-server-url').fill('http://ollama:11434/v1');
    await page.getByTestId('ollama-discover-models').click();
    await expect(dialog.getByText(/2 models found/)).toBeVisible();
    await expect(dialog.getByText('2', { exact: true })).toBeVisible();
    await expect(dialog.getByText('3', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('qwen2.5:7b', { exact: true }).first()).toBeVisible();

    await page.getByTestId('provider-custom-model-input').fill('research/custom:latest');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /research\/custom:latest/ }).check();
    await expect(dialog.getByText('3', { exact: true })).toBeVisible();
    await dialog.locator('#provider-credential-scope').selectOption('organization');
    await expect(dialog.locator('#provider-credential-scope')).toHaveValue('organization');
    await expect(dialog.locator('#ollama-api-key')).toBeEnabled();
    await page.getByTestId('provider-enabled-switch').click();

    await expect(page.getByTestId('provider-save')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('ollama-provider-dialog-desktop.png'), fullPage: false });
    const fixture = catalogFixtures.get(page)!;
    fixture.attempted = true;
    const [savedResponse] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/agent-runtime/catalog'
        && response.request().method() === 'PUT'),
      page.getByTestId('provider-save').click(),
    ]);
    expect(savedResponse.status()).toBe(200);
    const savedPayload = await savedResponse.json();
    expect(savedPayload.success).toBe(true);
    const ownedProviders = savedPayload.data.catalog.providers.filter((provider: {
      providerId: string; credentialScope: string; enabled: boolean; config: { ollamaHost?: string };
      models: Array<{ id: string; enabled: boolean; isProviderDefault: boolean }>;
    }) => provider.providerId === 'ollama' && provider.credentialScope === 'organization'
      && provider.enabled && provider.config.ollamaHost === 'http://ollama:11434'
      && provider.models.length === 1 && provider.models[0].id === 'research/custom:latest'
      && provider.models[0].enabled && provider.models[0].isProviderDefault);
    expect(ownedProviders).toHaveLength(1);
    const ownedInstallationId = ownedProviders[0].installationId;
    expect(ownedInstallationId).toBeTruthy();
    fixture.created = ownedProviders[0];

    const summary = page.getByTestId('provider-summary-ollama-organization');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('research/custom:latest');
    await expect(summary).toContainText('http://ollama:11434');

    await defaultCard.getByRole('button', { name: 'Edit' }).click();
    const defaultDialog = page.getByTestId('chat-default-dialog');
    await expect(defaultDialog).toBeVisible();
    await defaultDialog.locator('#default-provider').selectOption(ownedInstallationId);
    await expect(defaultDialog.locator('#default-provider')).toHaveValue(ownedInstallationId);
    await expect(defaultDialog.locator('#default-model')).toHaveValue('research/custom:latest');
    await defaultDialog.getByRole('button', { name: 'Save default' }).click();
    await expect(defaultCard).toContainText('Ollama · research/custom:latest');

    await summary.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByTestId('provider-editor-dialog').getByText('research/custom:latest', { exact: true }).first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('provider-editor-dialog')).toBeVisible();
    await page.waitForTimeout(350);
    const dialogMetrics = await page.getByTestId('provider-editor-dialog').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    await page.screenshot({ path: testInfo.outputPath('ollama-provider-dialog-mobile.png'), fullPage: false });
    expect(dialogMetrics.left).toBeGreaterThanOrEqual(0);
    expect(dialogMetrics.right).toBeLessThanOrEqual(dialogMetrics.viewportWidth);
    expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(dialogMetrics.viewportWidth);
  });

  test('keeps the provider overview compact and the default card first', async ({ page }, testInfo) => {
    await openProviderSettings(page);
    await expect(page.getByText('The overview shows current state only. Edit connection, models, and access in the dialog.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add provider' })).toBeVisible();

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath('provider-overview-desktop.png'), fullPage: false });
  });
});
