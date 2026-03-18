import { expect, test } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin.com';
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

    await expect(page).toHaveURL('/onboarding', { timeout: 15000 });

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
    await expect(page.getByRole('button', { name: 'Später einrichten' })).toBeVisible();
  });

  test('sends the bootstrap admin into provider-only onboarding and completes it', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('/onboarding', { timeout: 15000 });
    await expect(
      page.getByText(/du bist mit dem per environment konfigurierten admin bereits angemeldet/i),
    ).toBeVisible();
    await expect(page.locator('#name')).toHaveCount(0);
    await expect(page.locator('#email')).toHaveCount(0);
    await expect(page.locator('#password')).toHaveCount(0);

    await page.getByRole('button', { name: 'Später einrichten' }).click();
    await expect(page.getByText('Einrichtung abgeschlossen')).toBeVisible();

    await page.getByRole('button', { name: 'Zur App' }).click();
    await expect(page).toHaveURL('/', { timeout: 15000 });

    await page.goto('/onboarding');
    await expect(page).toHaveURL('/', { timeout: 15000 });
  });
});
