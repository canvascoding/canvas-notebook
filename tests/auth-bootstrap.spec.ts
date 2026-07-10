import { expect, test } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

test.describe('Bootstrap auth flow', () => {
  test('redirects /sign-up to /login', async ({ page }) => {
    await page.goto('/sign-up');
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  });

  test('blocks public sign-up and rejects non-bootstrap sign-in', async ({ request }) => {
    const signUpResponse = await request.post('/api/auth/sign-up/email', {
      headers: {
        'Content-Type': 'application/json',
        Origin: BASE_URL,
      },
      data: {
        name: 'Intruder',
        email: 'intruder@example.com',
        password: 'NotAllowed123!',
      },
    });

    expect(signUpResponse.status()).toBe(403);

    const foreignLoginResponse = await request.post('/api/auth/sign-in/email', {
      headers: {
        'Content-Type': 'application/json',
        Origin: BASE_URL,
      },
      data: {
        email: 'intruder@example.com',
        password: 'NotAllowed123!',
      },
    });

    expect(foreignLoginResponse.status()).toBe(401);
  });

  test('allows scrolling the onboarding wizard on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 480 });
    await page.goto('/login');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/(?:en\/)?onboarding$/, { timeout: 15000 });

    const scrollRoot = page.getByTestId('onboarding-scroll-root');
    await expect(scrollRoot).toBeVisible();

    const metrics = await scrollRoot.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));

    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await scrollRoot.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });

    await expect
      .poll(() => scrollRoot.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(page.locator('select')).toBeVisible();
    await expect(page.getByRole('button', { name: /Weiter|Continue/ })).toBeVisible();
  });

  test('changes the onboarding language with a document navigation', async ({ page }) => {
    const pageErrors: Error[] = [];
    const preferenceUpdates: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.url().includes('/api/user-preferences') && request.method() === 'PATCH') {
        preferenceUpdates.push(request.postData() || '');
      }
    });

    await page.goto('/login');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/(?:en\/)?onboarding$/, { timeout: 15000 });
    if (page.url().includes('/en/onboarding')) {
      await expect(page.getByRole('button', { name: 'Deutsch' })).toBeEnabled();
      await page.getByRole('button', { name: 'Deutsch' }).click();
      await expect.poll(() => preferenceUpdates).toContain(JSON.stringify({ locale: 'de' }));
      await expect(page).toHaveURL('/onboarding', { timeout: 15000 });
      await expect(page.getByRole('heading', { name: 'Sprache auswählen' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'English' })).toBeEnabled();
      await page.getByRole('button', { name: 'English' }).click();
      await expect(page).toHaveURL('/en/onboarding', { timeout: 15000 });
    } else {
      await expect(page.getByRole('button', { name: 'English' })).toBeEnabled();
      await page.getByRole('button', { name: 'English' }).click();
      await expect(page).toHaveURL('/en/onboarding', { timeout: 15000 });
      await expect(page.getByRole('button', { name: 'Deutsch' })).toBeEnabled();
      await page.getByRole('button', { name: 'Deutsch' }).click();
      await expect(page).toHaveURL('/onboarding', { timeout: 15000 });
      await expect(page.getByRole('button', { name: 'English' })).toBeEnabled();
      await page.getByRole('button', { name: 'English' }).click();
      await expect(page).toHaveURL('/en/onboarding', { timeout: 15000 });
    }
    await expect(page.getByRole('heading', { name: 'Choose language' })).toBeVisible();
    expect(preferenceUpdates).toContain(JSON.stringify({ locale: 'de' }));
    expect(preferenceUpdates).toContain(JSON.stringify({ locale: 'en' }));
    expect(pageErrors.some((error) => error.message.includes("Cannot read properties of undefined (reading 'toLowerCase')"))).toBe(false);
  });
});
