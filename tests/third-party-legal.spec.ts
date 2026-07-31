import { expect, test, type Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe('third-party legal inventory', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens the legal settings panel and exposes the offline artifacts', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/de/settings?tab=license', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: 'Rechtliches', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Rechtliches', exact: true })).toBeVisible();
    await expect(page.getByText('Kommerzielles Release-Gate freigegeben')).toBeVisible();
    await expect(page.getByText('Drittanbieter-Lizenzen', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Third-Party Notices öffnen/ })).toHaveAttribute(
      'href',
      '/api/legal/third-party/notices',
    );
    await expect(page.getByRole('link', { name: /JSON-Inventar öffnen/ })).toHaveAttribute(
      'href',
      '/api/legal/third-party/inventory',
    );

    const summaryResponse = await page.request.get('/api/legal/third-party');
    const summary = await summaryResponse.json() as {
      success?: boolean;
      summary?: { totalComponents?: number; distributedReviewRequired?: number; developmentOnlyReviewRequired?: number };
      releaseGate?: { status?: string; blockers?: unknown[] };
    };
    expect(summaryResponse.ok()).toBeTruthy();
    expect(summary.success).toBe(true);
    expect(summary.summary?.totalComponents).toBeGreaterThan(0);
    expect(summary.releaseGate?.status).toBe('approved');
    expect(summary.releaseGate?.blockers).toEqual([]);
    expect(summary.summary?.distributedReviewRequired).toBe(0);
    expect(summary.summary?.developmentOnlyReviewRequired).toBe(50);

    const noticesResponse = await page.request.get('/api/legal/third-party/notices');
    expect(noticesResponse.ok()).toBeTruthy();
    expect(noticesResponse.headers()['content-type']).toContain('text/markdown');
    await expect(noticesResponse.text()).resolves.toContain('# Canvas Notebook Third-Party Notices');

    const inventoryResponse = await page.request.get('/api/legal/third-party/inventory');
    expect(inventoryResponse.ok()).toBeTruthy();
    expect(inventoryResponse.headers()['content-type']).toContain('application/json');
    await expect(inventoryResponse.json()).resolves.toMatchObject({ schemaVersion: 1 });

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath('legal-settings-desktop.png'), fullPage: true });
  });

  test('keeps the legal status readable in the mobile settings layout', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/de/settings?tab=legal', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Rechtliches', exact: true })).toBeVisible();
    await expect(page.getByText('Kommerzielles Release-Gate freigegeben')).toBeVisible();
    await expect(page.getByText('Drittanbieter-Lizenzen', { exact: true })).toBeVisible();

    const mobileNavigation = page.getByRole('button', { name: /Bereiche.*Rechtliches/ });
    await expect(mobileNavigation).toBeVisible();
    await mobileNavigation.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath('legal-settings-mobile.png'), fullPage: true });
  });
});
