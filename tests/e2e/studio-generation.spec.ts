import { test, expect, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { authenticateManagedTestPage } from '../helpers/managed-test-context';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
}

async function requireStudioGenerationProvider(page: Page) {
  const response = await page.request.get('/api/studio/config');
  expect(response.status()).toBe(200);

  const payload = await response.json();
  expect(payload.success).toBe(true);
  expect(typeof payload.config).toBe('object');
  expect(payload.config).not.toBeNull();

  const gemini = payload.config?.localApiKeys?.gemini;
  const managedEnabled = payload.config?.managedMediaAvailable;
  expect(typeof gemini).toBe('boolean');
  expect(typeof managedEnabled).toBe('boolean');

  test.skip(
    !gemini && !managedEnabled,
    'Studio image generation requires a real Gemini credential for the test user or configured Managed Media; both are unavailable.',
  );
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

  test('carries dashboard prompt into create generation handoff', async ({ page }) => {
    await login(page);
    await requireStudioGenerationProvider(page);
    await page.goto('/studio', { waitUntil: 'networkidle' });

    const prompt = `Dashboard handoff product shot ${Date.now()}`;
    await page.locator('textarea').first().fill(prompt);

    const genRequest = page.waitForRequest(
      (req) => req.url().includes('/api/studio/generate') && req.method() === 'POST',
    );
    const genResponse = page.waitForResponse(
      (resp) => resp.url().includes('/api/studio/generate') && resp.status() === 201,
    );

    const generateButton = page.getByRole('button', { name: /generat|erstellen|create/i }).last();
    await generateButton.click();

    const request = await genRequest;
    const payload = JSON.parse(request.postData() || '{}') as { prompt?: string };
    expect(payload.prompt).toBe(prompt);

    const response = await genResponse;
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.generationId).toBeTruthy();
    createdGenerationIds.push(data.generationId);
    await expect(page).toHaveURL(/\/studio\/create\?generation=/, { timeout: 10000 });
  });

  test('starts a text-to-image generation', async ({ page }) => {
    await login(page);
    await requireStudioGenerationProvider(page);
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
    await requireStudioGenerationProvider(page);

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

  test('rejects empty and whitespace prompts without references', async ({ page }) => {
    await login(page);

    for (const prompt of ['', ' \t\n ']) {
      const res = await page.request.post('/api/studio/generate', {
        headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
        data: { prompt, mode: 'image' },
      });

      expect(res.status()).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Prompt or reference images required');
      expect(data.generationId).toBeUndefined();
    }
  });
});
