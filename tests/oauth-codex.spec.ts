import { test, expect, type Browser, type Page } from '@playwright/test';

const TEST_EMAIL = 'info@canvasstudios.store';
const TEST_PASSWORD = 'Canvas2026!';
const AUTH_STATE_PATH = 'test-results/oauth-codex-auth.json';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/');
}

test.describe('OpenAI Codex OAuth E2E', () => {
  test.setTimeout(60000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('should show OAuth button for openai-codex provider', async ({ page }) => {
    await page.goto('/settings?tab=agent-settings');
    await page.getByTestId('provider-select').click();
    await page.getByText('OpenAI Codex').click();
    const oauthButton = page.getByTestId('openai-codex-oauth-button');
    await expect(oauthButton).toBeVisible();
    await expect(oauthButton).toHaveText(/Connect/);
  });
});
