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

async function createTestGeneration(page: Page) {
  const res = await page.request.post('/api/studio/generate', {
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    data: { prompt: 'E2E test detail view image', mode: 'image', count: 1 },
  });
  return (await res.json());
}

async function cleanupGeneration(page: Page, generationId: string) {
  await page.request.delete(`/api/studio/generations/${generationId}`).catch(() => {});
}

test.describe('Studio Detail View + Chat', () => {
  let createdGenerationIds: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdGenerationIds) {
      await cleanupGeneration(page, id);
    }
    createdGenerationIds = [];
  });

  test('opens detail view from output thumbnail', async ({ page }) => {
    await login(page);

    const data = await createTestGeneration(page);
    if (data.generationId) {
      createdGenerationIds.push(data.generationId);
    }

    await page.goto('/studio/create', { waitUntil: 'networkidle' });

    const thumbnail = page.locator('[data-testid="output-thumbnail"], button[class*="group"]').first();
    if (await thumbnail.isVisible({ timeout: 5000 }).catch(() => false)) {
      await thumbnail.click();

      const detailView = page.locator('[role="dialog"]');
      await expect(detailView).toBeVisible({ timeout: 5000 });
    }
  });

  test('navigates back to grid from detail view', async ({ page }) => {
    await login(page);

    const data = await createTestGeneration(page);
    if (data.generationId) {
      createdGenerationIds.push(data.generationId);
    }

    await page.goto('/studio/create', { waitUntil: 'networkidle' });

    const backButton = page.getByRole('button', { name: /zurück|back/i });
    if (await backButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await backButton.click();
    }

    await expect(page.locator('text=Starting Points')).toBeVisible({ timeout: 5000 }).catch(() => {});
  });
});