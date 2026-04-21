# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-bootstrap.spec.ts >> Bootstrap auth flow >> redirects /sign-up to /login
- Location: tests/auth-bootstrap.spec.ts:8:18

# Error details

```
Error: Channel closed
```

```
Error: page.goto: Target page, context or browser has been closed
Call log:
  - navigating to "http://localhost:3000/sign-up", waiting until "load"

```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
  4  | const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
  5  | const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
  6  | 
  7  | test.describe('Bootstrap auth flow', () => {
  8  |   test('redirects /sign-up to /login', async ({ page }) => {
  9  |     await page.goto('/sign-up');
  10 |     await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
> 11 |   });
     |                ^ Error: page.goto: Target page, context or browser has been closed
  12 | 
  13 |   test('blocks public sign-up and rejects non-bootstrap sign-in', async ({ request }) => {
  14 |     const signUpResponse = await request.post('/api/auth/sign-up/email', {
  15 |       headers: {
  16 |         'Content-Type': 'application/json',
  17 |         Origin: BASE_URL,
  18 |       },
  19 |       data: {
  20 |         name: 'Intruder',
  21 |         email: 'intruder@example.com',
  22 |         password: 'NotAllowed123!',
  23 |       },
  24 |     });
  25 | 
  26 |     expect(signUpResponse.status()).toBe(403);
  27 | 
  28 |     const foreignLoginResponse = await request.post('/api/auth/sign-in/email', {
  29 |       headers: {
  30 |         'Content-Type': 'application/json',
  31 |         Origin: BASE_URL,
  32 |       },
  33 |       data: {
  34 |         email: 'intruder@example.com',
  35 |         password: 'NotAllowed123!',
  36 |       },
  37 |     });
  38 | 
  39 |     expect(foreignLoginResponse.status()).toBe(401);
  40 |   });
  41 | 
  42 |   test('allows scrolling the onboarding wizard on small screens', async ({ page }) => {
  43 |     await page.setViewportSize({ width: 390, height: 480 });
  44 |     await page.goto('/login');
  45 |     await page.fill('input[type="email"]', TEST_EMAIL);
  46 |     await page.fill('input[type="password"]', TEST_PASSWORD);
  47 |     await page.click('button[type="submit"]');
  48 | 
  49 |     await expect(page).toHaveURL('/onboarding', { timeout: 15000 });
  50 | 
  51 |     const scrollRoot = page.getByTestId('onboarding-scroll-root');
  52 |     await expect(scrollRoot).toBeVisible();
  53 | 
  54 |     const metrics = await scrollRoot.evaluate((element) => ({
  55 |       scrollHeight: element.scrollHeight,
  56 |       clientHeight: element.clientHeight,
  57 |     }));
  58 | 
  59 |     expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  60 | 
  61 |     await scrollRoot.evaluate((element) => {
  62 |       element.scrollTop = element.scrollHeight;
  63 |     });
  64 | 
  65 |     await expect
  66 |       .poll(() => scrollRoot.evaluate((element) => element.scrollTop))
  67 |       .toBeGreaterThan(0);
  68 |     await expect(page.getByRole('button', { name: 'Später einrichten' })).toBeVisible();
  69 |   });
  70 | 
  71 |   test('sends the bootstrap admin into provider-only onboarding and completes it', async ({ page }) => {
  72 |     await page.goto('/login');
  73 |     await page.fill('input[type="email"]', TEST_EMAIL);
  74 |     await page.fill('input[type="password"]', TEST_PASSWORD);
  75 |     await page.click('button[type="submit"]');
  76 | 
  77 |     await expect(page).toHaveURL('/onboarding', { timeout: 15000 });
  78 |     await expect(
  79 |       page.getByText(/du bist mit dem per environment konfigurierten admin bereits angemeldet/i),
  80 |     ).toBeVisible();
  81 |     await expect(page.locator('#name')).toHaveCount(0);
  82 |     await expect(page.locator('#email')).toHaveCount(0);
  83 |     await expect(page.locator('#password')).toHaveCount(0);
  84 | 
  85 |     await page.getByRole('button', { name: 'Später einrichten' }).click();
  86 |     await expect(page.getByText('Einrichtung abgeschlossen')).toBeVisible();
  87 | 
  88 |     await page.getByRole('button', { name: 'Zur App' }).click();
  89 |     await expect(page).toHaveURL('/', { timeout: 15000 });
  90 | 
  91 |     await page.goto('/onboarding');
  92 |     await expect(page).toHaveURL('/', { timeout: 15000 });
  93 |   });
  94 | });
  95 | 
```