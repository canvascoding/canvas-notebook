import { test, expect, type Browser, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/skills-runtime-auth.json';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/(en|de)$/, { timeout: 15_000 });
}

test.describe('Skills runtime docs', () => {
  test.setTimeout(60_000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('shows direct command docs and central integrations env guidance for Brave Search', async ({ page }) => {
    await page.goto('/skills');

    const braveCard = page.locator('.grid .border').filter({ hasText: 'Brave Search' }).first();
    await braveCard.getByRole('button', { name: 'Docs' }).click();

    const dialog = page.getByTestId('skill-detail-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('brave-search "query"');
    await expect(dialog).toContainText('brave-content https://example.com/article');
    await expect(dialog).toContainText('/data/secrets/Canvas-Integrations.env');
    await expect(dialog).not.toContainText('skill brave-search');
  });
});
