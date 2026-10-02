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
    await page.waitForURL((url) => !/\/login\/?$/.test(url.pathname), { timeout: 15000 });

    const sessionResponse = await page.request.get('/api/auth/get-session', { timeout: 15000 });
    expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json() as {
      user?: { id?: string; email?: string; role?: string };
    };
    expect(session.user?.id).toEqual(expect.any(String));
    expect(session.user?.id).not.toBe('');
    expect(session.user?.email?.toLowerCase()).toBe(TEST_EMAIL.toLowerCase());
    expect(
      session.user?.role === 'admin'
      || session.user?.email?.toLowerCase() === process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase(),
      'The instance onboarding fixture requires the authenticated instance administrator.',
    ).toBe(true);

    const statusResponse = await page.request.get('/api/onboarding/status', { timeout: 15000 });
    expect(statusResponse.status()).toBe(200);
    const status = await statusResponse.json() as {
      success?: boolean;
      enabled?: boolean;
      complete?: boolean;
      instanceComplete?: boolean;
    };
    expect(status.success).toBe(true);
    expect(typeof status.enabled).toBe('boolean');
    expect(typeof status.complete).toBe('boolean');
    if (status.enabled) {
      expect(typeof status.instanceComplete).toBe('boolean');
      expect(status.complete).toBe(status.instanceComplete);
    } else {
      expect(status.complete).toBe(true);
    }

    const requireFreshOnboarding = process.env.FRESH_ONBOARDING_E2E === '1';
    test.skip(
      !requireFreshOnboarding && (status.enabled === false || status.instanceComplete === true),
      'Requires enabled, incomplete instance onboarding; this server is disabled or already initialized.',
    );
    expect(status.enabled, 'FRESH_ONBOARDING_E2E requires onboarding to be enabled.').toBe(true);
    expect(status.instanceComplete, 'FRESH_ONBOARDING_E2E requires incomplete instance onboarding.').toBe(false);

    const settingsResponse = await page.request.get('/api/server-settings', { timeout: 15000 });
    expect(settingsResponse.status()).toBe(200);
    const settings = await settingsResponse.json() as {
      success?: boolean;
      data?: { onboardingStep?: string };
    };
    expect(settings.success).toBe(true);
    expect(settings.data).toEqual(expect.any(Object));
    const instanceStep = settings.data!.onboardingStep ?? 'server';
    expect(['server', 'license', 'provider', 'workspace', 'review']).toContain(instanceStep);
    test.skip(
      !requireFreshOnboarding && instanceStep !== 'server',
      `Requires fresh instance onboarding at the server step; current step is ${instanceStep}.`,
    );
    expect(instanceStep, 'FRESH_ONBOARDING_E2E requires the initial server step.').toBe('server');

    await expect(page).toHaveURL(/\/(?:de|en)\/onboarding$/, { timeout: 15000 });

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
    await expect(page.getByRole('heading', { name: /Instanz-Einstellungen|Instance settings/ })).toBeVisible();
    await expect(page.locator('select')).toBeVisible();
    await expect(page.getByRole('button', { name: /Instanz-Einstellungen speichern|Save instance settings/ })).toBeVisible();
  });

  test('changes the public language with a document navigation', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.goto('/login');
    if (page.url().includes('/en/login')) {
      await page.getByRole('button', { name: 'Switch language' }).click();
      await page.getByRole('menuitem', { name: 'Deutsch' }).click();
      await expect(page).toHaveURL('/de/login', { timeout: 15000 });
      await page.getByRole('button', { name: 'Switch language' }).click();
      await page.getByRole('menuitem', { name: 'English' }).click();
      await expect(page).toHaveURL('/en/login', { timeout: 15000 });
    } else {
      await page.getByRole('button', { name: 'Switch language' }).click();
      await page.getByRole('menuitem', { name: 'English' }).click();
      await expect(page).toHaveURL('/en/login', { timeout: 15000 });
      await page.getByRole('button', { name: 'Switch language' }).click();
      await page.getByRole('menuitem', { name: 'Deutsch' }).click();
      await expect(page).toHaveURL('/de/login', { timeout: 15000 });
    }
    expect(pageErrors.some((error) => error.message.includes("Cannot read properties of undefined (reading 'toLowerCase')"))).toBe(false);
  });
});
