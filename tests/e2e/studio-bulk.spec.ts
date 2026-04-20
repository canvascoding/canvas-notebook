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

test.describe('Studio Bulk Generate', () => {
  test('navigates to bulk page and sees product selection', async ({ page }) => {
    await login(page);
    await page.goto('/studio/bulk', { waitUntil: 'networkidle' });

    await expect(page.getByText(/bulk|stapel/i)).toBeVisible({ timeout: 10000 });
  });

  test('selects products for bulk generation', async ({ page }) => {
    await login(page);

    const createRes = await page.request.post('/api/studio/products', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: 'E2E Bulk Product 1', description: 'For bulk test' },
    });
    const product = (await createRes.json()).product;

    await page.goto('/studio/bulk', { waitUntil: 'networkidle' });

    const productCheckbox = page.locator(`input[type="checkbox"]`).first();
    if (await productCheckbox.isVisible({ timeout: 5000 }).catch(() => false)) {
      await productCheckbox.click();
    }

    await page.request.delete(`/api/studio/products/${product.id}`).catch(() => {});
  });
});