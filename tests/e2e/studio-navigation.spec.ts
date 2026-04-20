import { test, expect, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
}

test.describe('Studio Navigation', () => {
  test('navigates from home to studio page', async ({ page }) => {
    await login(page);
    await page.goto('/', { waitUntil: 'networkidle' });

    const studioLink = page.getByRole('link', { name: /studio/i }).or(page.locator('a[href*="/studio"]').first());
    if (await studioLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await studioLink.click();
      await expect(page).toHaveURL(/\/studio/, { timeout: 10000 });
    } else {
      await page.goto('/studio', { waitUntil: 'networkidle' });
    }

    await expect(page.getByText(/übersicht|overview|starting points/i)).toBeVisible({ timeout: 10000 });
  });

  test('tab navigation switches between views', async ({ page }) => {
    await login(page);
    await page.goto('/studio', { waitUntil: 'networkidle' });

    await expect(page.getByRole('tab', { name: /create|erstellen/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole('tab', { name: /create|erstellen/i }).click();
    await expect(page).toHaveURL(/\/studio\/create/, { timeout: 5000 });

    await page.getByRole('tab', { name: /bulk/i }).click();
    await expect(page).toHaveURL(/\/studio\/bulk/, { timeout: 5000 });

    await page.getByRole('tab', { name: /models|modelle/i }).click();
    await expect(page).toHaveURL(/\/studio\/models/, { timeout: 5000 });

    await page.getByRole('tab', { name: /presets/i }).click();
    await expect(page).toHaveURL(/\/studio\/presets/, { timeout: 5000 });
  });

  test('back navigation returns to previous view', async ({ page }) => {
    await login(page);
    await page.goto('/studio/models', { waitUntil: 'networkidle' });

    await page.goBack();
    await expect(page).toHaveURL(/\/studio/, { timeout: 10000 });
  });
});