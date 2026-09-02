import { expect, test, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /email/i }).fill(TEST_EMAIL);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

async function openProviderSettings(page: Page) {
  await login(page);
  await page.goto('/en/settings?tab=ai-providers');
  await expect(page.getByRole('heading', { name: 'AI providers & models' })).toBeVisible();
  await expect(page.getByTestId('chat-default-card')).toBeVisible();
}

test.describe('Ollama provider setup', () => {
  test.setTimeout(90_000);

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
    await page.getByTestId('add-provider-select').selectOption('ollama');
    await page.locator('#add-provider-scope').selectOption('organization');
    await page.getByRole('button', { name: 'Continue to setup' }).click();

    const dialog = page.getByTestId('provider-editor-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('2', { exact: true })).toBeVisible();
    await expect(dialog.getByText('3', { exact: true })).toBeVisible();
    await expect(page.getByTestId('ollama-server-url')).toHaveValue('http://localhost:11434');
    await expect(page.getByTestId('provider-model-list')).toHaveCount(0);
    await expect(dialog.getByText('Test the connection to load models from this Ollama server.').first()).toBeVisible();

    await page.getByTestId('ollama-server-url').fill('http://ollama:11434/v1');
    await page.getByTestId('ollama-discover-models').click();
    await expect(dialog.getByText(/2 models found/)).toBeVisible();
    await expect(dialog.getByText('qwen2.5:7b', { exact: true }).first()).toBeVisible();

    await page.getByTestId('provider-custom-model-input').fill('research/custom:latest');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /research\/custom:latest/ }).check();
    await page.getByTestId('provider-enabled-switch').click();

    await expect(page.getByTestId('provider-save')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('ollama-provider-dialog-desktop.png'), fullPage: false });
    await page.getByTestId('provider-save').click();

    const summary = page.getByTestId('provider-summary-ollama-organization');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('research/custom:latest');
    await expect(summary).toContainText('http://ollama:11434');

    await defaultCard.getByRole('button', { name: 'Edit' }).click();
    const defaultDialog = page.getByTestId('chat-default-dialog');
    await expect(defaultDialog).toBeVisible();
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
