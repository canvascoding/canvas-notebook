import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const evidenceRoot = path.resolve('docs/product/qa/not-found-2026-10-13');
const productUrl = 'https://canvas-notebook.app';

async function screenshot(page: Page, name: string) {
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: path.join(evidenceRoot, name), scale: 'css', fullPage: true });
}

async function checkFit(page: Page) {
  const bounds = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
  for (const control of [page.getByRole('heading', { level: 1 }), page.getByRole('button', { name: /^(Zurück|Go back)$/ }), page.locator('[data-slot="button"]').first()]) {
    const rect = await control.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(bounds.width);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
}

async function signIn(page: Page) {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  expect(Boolean(email && password), 'Bootstrap login must be configured in the local environment.').toBe(true);
  await page.goto('/en/login');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  try {
    await page.getByLabel('Email', { exact: true }).fill(email!);
    await page.getByLabel('Password', { exact: true }).fill(password!);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login(?:\?|$)/u);
  } catch {
    throw new Error('The configured bootstrap login could not be completed.');
  }
}

for (const locale of ['de', 'en']) {
  test(`anonymous ${locale} unknown pages render a branded 404`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(`/${locale}/this-page-does-not-exist`);
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'anonymous');
    await expect(page.getByTestId('not-found-promo')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page).toHaveTitle('404 · Canvas Notebook');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(locale === 'de' ? 'Diese Seite ist gerade nicht zu finden.' : 'This page seems to have wandered off.');
    for (const link of await page.getByRole('link', { name: locale === 'de' ? 'Canvas Notebook entdecken' : 'Discover Canvas Notebook', exact: true }).all()) {
      await expect(link).toHaveAttribute('href', productUrl);
    }
    await checkFit(page);
    expect(errors).toEqual([]);
    await screenshot(page, `guest-${locale}-desktop-light.png`);
    await page.getByRole('link', { name: locale === 'de' ? 'Anmelden' : 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/login$`));
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
}

test('guest dark/mobile layouts, nested URLs and expired cookies', async ({ page, context }) => {
  await context.addCookies([{ name: 'better-auth.session_token', value: 'expired-session', url: 'http://127.0.0.1:3000' }]);
  await page.addInitScript(() => {
    if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'dark');
  });
  let response = await page.goto('/en/settings/missing-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'anonymous');
  await expect(page.locator('html')).toHaveClass(/dark/u);
  await checkFit(page);
  await screenshot(page, 'guest-en-desktop-dark.png');
  await page.setViewportSize({ width: 390, height: 844 });
  response = await page.goto('/de/missing-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('not-found-promo')).toBeVisible();
  await checkFit(page);
  await screenshot(page, 'guest-de-mobile-dark.png');
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/light/u);
  await checkFit(page);
  await screenshot(page, 'guest-de-mobile-light.png');
});

test('session checks and failures never show guest advertising', async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/get-session**', async route => {
    await waiting;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Session check unavailable' }) });
  });
  await page.goto('/en/missing-page');
  await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'checking');
  await expect(page.getByTestId('not-found-promo')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Checking your sign-in…');
  release();
  await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'unavailable');
  await expect(page.getByTestId('not-found-promo')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to home', exact: true }).last()).toBeVisible();
  await screenshot(page, 'session-unavailable.png');
});

test('protected pages still send guests to login with the original destination', async ({ page }) => {
  await page.goto('/en/settings?tab=secrets');
  await expect(page).toHaveURL(/\/en\/login\?/u);
  expect(new URL(page.url()).searchParams.get('from')).toBe('/en/settings?tab=secrets');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
});

test('back uses existing history and falls back to home on a direct visit', async ({ page, browser }) => {
  await page.goto('/en/login');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await page.goto('/en/missing-page');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/login$/u);
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();

  const directContext = await browser.newContext();
  try {
    const directPage = await directContext.newPage();
    await directPage.goto('http://127.0.0.1:3000/en/missing-page');
    await directPage.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(directPage).toHaveURL(/\/en\/login\?/u);
    expect(new URL(directPage.url()).searchParams.get('from')).toBe('/en');
  } finally { await directContext.close(); }
});

test('signed-in users get home/back actions without advertising', async ({ page }) => {
  await signIn(page);
  const response = await page.goto('/en/missing-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'authenticated');
  await expect(page.getByTestId('not-found-promo')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  await checkFit(page);
  await screenshot(page, 'signed-in-en-desktop-light.png');
  await page.getByRole('link', { name: 'Go to home', exact: true }).last().click();
  await expect(page).toHaveURL(/\/en\/?$/u);
  await expect(page.getByTestId('not-found-page')).toHaveCount(0);
  await page.goto('/en/missing-page');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/?$/u);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.goto('/de/missing-page');
  await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'authenticated');
  await expect(page.getByTestId('not-found-promo')).toHaveCount(0);
  await checkFit(page);
  await screenshot(page, 'signed-in-de-mobile-dark.png');

  // A real matched page can also call notFound(), inside the locale layout.
  await page.goto('/en/browser/live');
  await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'authenticated');
  await expect(page.getByTestId('not-found-promo')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This page seems to have wandered off.');
  await checkFit(page);
  await screenshot(page, 'signed-in-en-local-not-found.png');
});

test('missing public shares use the same recovery view', async ({ page }) => {
  const response = await page.goto('/p/invalid-share-code');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('not-found-page')).toHaveAttribute('data-session-state', 'anonymous');
  await expect(page.getByTestId('not-found-promo')).toBeVisible();
});

test('localized missing filenames retain their language and static assets remain reachable', async ({ page }) => {
  const response = await page.goto('/en/this-page-does-not-exist.html');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This page seems to have wandered off.');
  const icon = await page.request.get('/images/bradley/bradley-icon.svg');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/svg+xml');
});
