import { test, expect, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: {
      Origin: process.env.BASE_URL || 'http://localhost:3000',
    },
    data: {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    },
  });

  expect(response.ok()).toBeTruthy();
}

test.describe('Home chat prompt', () => {
  test('redirects into notebook after submitting a prompt on the home page', async ({ page }) => {
    await login(page);
    await page.goto('/', { waitUntil: 'networkidle' });

    await page.locator('form textarea').first().fill('Bitte leite mich ins Notebook weiter');
    await page.locator('form').first().evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await expect(page).toHaveURL(/\/(?:en\/)?notebook(?:\?.*)?$/, { timeout: 15_000 });
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 });

    const storedPrompt = await page.evaluate(() => window.sessionStorage.getItem('canvas.chat.initialPrompt'));
    expect(storedPrompt).toBeNull();
  });
});
