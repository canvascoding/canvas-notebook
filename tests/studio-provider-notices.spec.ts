import { expect, test } from '@playwright/test';
import de from '../messages/de.json';
import en from '../messages/en.json';

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
    timeout: 90_000,
  });
  expect(login.ok()).toBe(true);
});

const configResponse = (available = false) => ({ success: true, config: {
  localApiKeys: { gemini: available, openai: false, kie: false },
  managedMediaAvailable: false, canManageCentralCredentials: true,
} });

for (const [locale, messages, width] of [['de', de, 390], ['en', en, 1280]] as const) {
  test(`Studio ${locale} provider notice handles delayed checks and credential navigation`, async ({ page }, info) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    let releaseCheck: (() => void) | undefined;
    const delayedCheck = new Promise<void>((resolve) => { releaseCheck = resolve; });
    await page.route('**/api/studio/config', async (route) => {
      await delayedCheck;
      await route.fulfill({ json: configResponse() });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/${locale}/studio`, { waitUntil: 'domcontentloaded' });
    const copy = messages.studio.providerRequirements;
    await expect(page.getByText(copy.checkingTitle, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(copy.gemini.title, { exact: true })).toHaveCount(0);
    releaseCheck!();
    const notice = page.locator('[data-slot="alert"]').filter({ has: page.getByText(copy.gemini.title, { exact: true }) });
    await expect(notice).toBeVisible({ timeout: 90_000 });
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice.locator(':scope > svg')).toHaveCount(1);
    await expect(notice.getByText(/GEMINI_API_KEY/)).not.toBeVisible();
    await notice.locator('summary').click();
    await expect(notice.getByText(/GEMINI_API_KEY/)).toBeVisible();
    const setup = notice.getByRole('link', { name: copy.openCentralCredentials, exact: true });
    await expect(setup).toHaveAttribute('href', /\/settings\?tab=secrets#studio-media-credentials$/);
    expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (width < 640) expect(await setup.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`studio-provider-${locale}-${width}.png`), fullPage: true, animations: 'disabled' });
    if (locale === 'en') {
      await setup.click();
      await expect(page).toHaveURL(/\/settings\?tab=secrets#studio-media-credentials$/, { timeout: 90_000 });
      const credentials = page.locator('#studio-media-credentials');
      await expect(credentials).toBeVisible({ timeout: 90_000 });
      await expect(credentials.locator('button').first()).toHaveAttribute('aria-expanded', 'true');
      await expect(credentials.locator('button').first()).toBeFocused();
    }
    expect(pageErrors).toEqual([]);
  });
}

test('Studio failed provider check offers retry and retains the correct access state', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let available = false;
  await page.route('**/api/studio/config', async (route) => {
    await route.fulfill(available ? { json: configResponse(true) } : { status: 503, json: { success: false } });
  });
  await page.goto('/de/studio', { waitUntil: 'domcontentloaded' });
  const failed = page.locator('[data-slot="alert"]').filter({ has: page.getByText(de.studio.providerRequirements.checkFailedTitle, { exact: true }) });
  await expect(failed).toBeVisible({ timeout: 90_000 });
  await expect(failed).toHaveAttribute('role', 'alert');
  await expect(page.getByText(de.studio.providerRequirements.gemini.title, { exact: true })).toHaveCount(0);
  available = true;
  await failed.getByRole('button', { name: de.studio.providerRequirements.retry, exact: true }).click();
  await expect(failed).toHaveCount(0);
  await expect(page.getByText(de.studio.providerRequirements.gemini.title, { exact: true })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
