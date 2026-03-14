import { test, expect, type Browser, type Page } from '@playwright/test';

const TEST_EMAIL = 'admin.com';
const TEST_PASSWORD = 'change-me';
const AUTH_STATE_PATH = 'test-results/automationen-auth.json';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/');
}

test.describe('Automationen API auth', () => {
  test.setTimeout(120000);

  test('automation APIs require auth', async ({ request }) => {
    const response = await request.get('/api/automations/jobs');
    expect(response.status()).toBe(401);
  });
});

test.describe('Automationen UI', () => {
  test.setTimeout(120000);
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('creates an automation, queues a run, and shows run history/logs', async ({ page }) => {
    const uniqueName = `PW Automation ${Date.now()}`;

    await page.goto('/');
    await expect(page.getByText('Automationen', { exact: true })).toBeVisible();
    await page.goto('/automationen');
    await expect(page).toHaveURL('/automationen');
    await page.getByTestId('automation-new').click();

    await page.getByTestId('automation-name').fill(uniqueName);
    await page.getByTestId('automation-prompt').fill('Schreibe eine kurze Zusammenfassung der relevanten Dateien in result.md oder antworte knapp, wenn nichts zu tun ist.');
    await page.getByTestId('automation-context-paths').fill('README.md');
    await page.getByTestId('automation-schedule-kind').selectOption('interval');
    await page.getByTestId('automation-interval-every').fill('1');
    await page.getByTestId('automation-save').click();

    await expect(page.getByTestId('automation-job-list')).toContainText(uniqueName, { timeout: 15000 });
    await expect(page.getByTestId('automation-run-now')).toBeEnabled();

    await page.getByTestId('automation-run-now').click();
    await expect(page.getByText('Lauf eingeplant.')).toBeVisible({ timeout: 15000 });

    const runItems = page.getByTestId('automation-run-list').locator('button[data-testid^="automation-run-"]');
    await expect(runItems.first()).toBeVisible({ timeout: 20000 });

    await expect
      .poll(
        async () => {
          await page.reload();
          await expect(page).toHaveURL('/automationen');
          await page.getByText(uniqueName).click();
          const firstRun = page.getByTestId('automation-run-list').locator('button[data-testid^="automation-run-"]').first();
          return ((await firstRun.textContent()) || '').toLowerCase();
        },
        { timeout: 45000, intervals: [1000, 2000, 5000] },
      )
      .toMatch(/running|success|failed|retry_scheduled/);

    const logContent = page.getByTestId('automation-log-content');
    await expect(logContent).not.toHaveText('Noch kein Log vorhanden.', { timeout: 45000 });
    await expect(page.getByText(/automationen\/.*\/runs\//)).toBeVisible();
  });
});
