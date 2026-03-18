import { test, expect, type Browser, type Page } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/oauth-codex-auth.json';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');

  await Promise.race([
    expect(page).toHaveURL('/', { timeout: 15000 }),
    expect(page).toHaveURL('/onboarding', { timeout: 15000 }),
  ]);

  if (page.url().includes('/onboarding')) {
    await page.getByRole('button', { name: 'Später einrichten' }).click();
    await expect(page.getByText('Einrichtung abgeschlossen')).toBeVisible();
    await page.getByRole('button', { name: 'Zur App' }).click();
    await expect(page).toHaveURL('/', { timeout: 15000 });
  }
}

test.describe('OpenAI Codex OAuth E2E', () => {
  test.setTimeout(120000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('finalizes a pending codex OAuth flow through poll + complete', async ({ page }) => {
    let oauthConnected = false;
    let completionQueued = false;
    let completionPolls = 0;

    await page.addInitScript(() => {
      window.open = () => null;
    });

    await page.route('**/api/oauth/pi/status**', async (route) => {
      await route.fulfill({
        json: {
          success: true,
          providers: [
            { provider: 'anthropic', displayName: 'Anthropic (Claude)', connected: false },
            { provider: 'openai-codex', displayName: 'OpenAI Codex', connected: oauthConnected },
            { provider: 'github-copilot', displayName: 'GitHub Copilot', connected: false },
          ],
        },
      });
    });

    await page.route('**/api/agents/provider-status?providerId=*', async (route) => {
      const url = new URL(route.request().url());
      const providerId = url.searchParams.get('providerId');

      if (providerId !== 'openai-codex') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        json: {
          success: true,
          providerId,
          isReady: oauthConnected,
          hasApiKey: false,
          hasOAuth: oauthConnected,
          requiresKey: false,
          requiresOAuth: true,
          issues: oauthConnected ? [] : ['OAuth not connected. Please connect your account below.'],
        },
      });
    });

    await page.route('**/api/oauth/pi/initiate', async (route) => {
      await route.fulfill({
        json: {
          success: true,
          flowId: 'flow_test_codex',
          provider: 'openai-codex',
          displayName: 'OpenAI Codex',
          authUrl: 'https://auth.openai.com/oauth/authorize?response_type=code',
          instructions: 'Paste the callback URL here.',
        },
      });
    });

    await page.route('**/api/oauth/pi/exchange', async (route) => {
      completionQueued = true;
      completionPolls = 0;
      await route.fulfill({
        status: 202,
        json: {
          success: true,
          pending: true,
          message: 'Authorization code received. Waiting for provider completion...',
        },
      });
    });

    await page.route('**/api/oauth/pi/poll?flowId=flow_test_codex', async (route) => {
      if (completionQueued) {
        completionPolls += 1;
      }

      const isCompleted = completionQueued && completionPolls >= 2;

      await route.fulfill({
        json: {
          success: true,
          flowId: 'flow_test_codex',
          status: isCompleted ? 'completed' : 'waiting_for_code',
          authUrl: 'https://auth.openai.com/oauth/authorize?response_type=code',
          instructions: 'Paste the callback URL here.',
          hasCredentials: isCompleted,
        },
      });
    });

    await page.route('**/api/oauth/pi/complete', async (route) => {
      oauthConnected = true;
      await route.fulfill({
        json: {
          success: true,
          message: 'Successfully connected to OpenAI Codex',
        },
      });
    });

    await page.goto('/settings?tab=agent-settings');
    await page.getByTestId('provider-select').selectOption('openai-codex');
    await expect(page.getByText('OAuth Authentication')).toBeVisible();

    await page.getByTestId('pi-oauth-provider-select').click();
    await page.getByText('OpenAI Codex', { exact: true }).click();
    await page.getByTestId('pi-oauth-connect-button').click();

    await expect(page.getByTestId('pi-oauth-auth-url')).toHaveValue(/auth\.openai\.com/);
    await page
      .getByTestId('pi-oauth-code-input')
      .fill('http://localhost:1455/auth/callback?code=test-code&state=test-state');
    await page.getByTestId('pi-oauth-complete-button').click();

    await expect(page.getByText('Authorization code received. Waiting for provider completion...')).toBeVisible();
    await expect(page.getByText('Successfully connected to OpenAI Codex')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Connected and ready')).toBeVisible();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  });
});
