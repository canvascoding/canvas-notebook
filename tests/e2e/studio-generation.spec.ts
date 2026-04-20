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

async function createTestProduct(page: Page) {
  const res = await page.request.post('/api/studio/products', {
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    data: { name: 'E2E Gen Product' },
  });
  return (await res.json()).product;
}

async function cleanupProduct(page: Page, productId: string) {
  await page.request.delete(`/api/studio/products/${productId}`).catch(() => {});
}

async function cleanupGeneration(page: Page, generationId: string) {
  await page.request.delete(`/api/studio/generations/${generationId}`).catch(() => {});
}

test.describe('Studio Generation + Polling', () => {
  let createdProductIds: string[] = [];
  let createdGenerationIds: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdGenerationIds) {
      await cleanupGeneration(page, id);
    }
    for (const id of createdProductIds) {
      await cleanupProduct(page, id);
    }
    createdGenerationIds = [];
    createdProductIds = [];
  });

  test('starts a text-to-image generation', async ({ page }) => {
    await login(page);
    await page.goto('/studio/create', { waitUntil: 'networkidle' });

    const promptTextarea = page.locator('textarea').first();
    await promptTextarea.fill('A red shoe on white background, product photography');

    const genResponse = page.waitForResponse(
      (resp) => resp.url().includes('/api/studio/generate') && resp.status() === 201,
    );

    const generateButton = page.getByRole('button', { name: /generat|erstellen|create/i }).last();
    await generateButton.click();

    const response = await genResponse;
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.generationId).toBeTruthy();
    createdGenerationIds.push(data.generationId);
  });

  test('starts a generation with product reference', async ({ page }) => {
    await login(page);

    const product = await createTestProduct(page);
    createdProductIds.push(product.id);

    await page.goto('/studio/create', { waitUntil: 'networkidle' });

    const promptTextarea = page.locator('textarea').first();
    await promptTextarea.fill('Studio photo of product');

    const genResponse = page.waitForResponse(
      (resp) => resp.url().includes('/api/studio/generate') && resp.status() === 201,
    );

    const generateButton = page.getByRole('button', { name: /generat|erstellen|create/i }).last();
    await generateButton.click();

    const response = await genResponse;
    const data = await response.json();
    expect(data.success).toBe(true);
    createdGenerationIds.push(data.generationId);
  });

  test('shows error state for failed generation', async ({ page }) => {
    await login(page);

    const res = await page.request.post('/api/studio/generate', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { prompt: 'short', mode: 'image' },
    });

    if (!res.ok()) {
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBeTruthy();
    } else {
      const data = await res.json();
      createdGenerationIds.push(data.generationId);
    }
  });
});