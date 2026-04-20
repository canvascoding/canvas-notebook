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

async function cleanupProduct(page: Page, productId: string) {
  await page.request.delete(`/api/studio/products/${productId}`);
}

test.describe('Studio Product Management', () => {
  let createdProductIds: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdProductIds) {
      await cleanupProduct(page, id).catch(() => {});
    }
    createdProductIds = [];
  });

  test('creates a product with name and description', async ({ page }) => {
    await login(page);
    await page.goto('/studio/models/new', { waitUntil: 'networkidle' });

    await page.locator('input').first().fill('E2E Test Product');
    await page.locator('textarea').first().fill('A product created by E2E test');

    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/studio/products') && resp.status() === 201,
    );

    await page.getByRole('button', { name: /speichern|save/i }).click();
    const response = await responsePromise;
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.product.name).toBe('E2E Test Product');
    createdProductIds.push(data.product.id);

    await expect(page).toHaveURL(/\/studio\/models\//, { timeout: 10000 });
  });

  test('lists products on models page', async ({ page }) => {
    await login(page);

    const createRes = await page.request.post('/api/studio/products', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: 'E2E Listed Product', description: 'For listing test' },
    });
    const createData = await createRes.json();
    createdProductIds.push(createData.product.id);

    await page.goto('/studio/models', { waitUntil: 'networkidle' });
    await expect(page.getByText('E2E Listed Product')).toBeVisible({ timeout: 10000 });
  });

  test('edits a product name', async ({ page }) => {
    await login(page);

    const createRes = await page.request.post('/api/studio/products', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: 'E2E Edit Product', description: 'For edit test' },
    });
    const createData = await createRes.json();
    const productId = createData.product.id;
    createdProductIds.push(productId);

    await page.goto(`/studio/models/${productId}`, { waitUntil: 'networkidle' });
    await expect(page.getByText('E2E Edit Product')).toBeVisible({ timeout: 10000 });

    await page.locator('button:has(svg.lucide-pencil)').first().click();

    const nameInput = page.locator('input.text-lg, input[name]').first();
    await nameInput.clear();
    await nameInput.fill('E2E Edited Name');

    const patchResponse = page.waitForResponse(
      (resp) => resp.url().includes(`/api/studio/products/${productId}`) && resp.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: /speichern|save/i }).first().click();
    await patchResponse;

    await expect(page.getByText('E2E Edited Name')).toBeVisible({ timeout: 10000 });
  });

  test('deletes a product with confirmation', async ({ page }) => {
    await login(page);

    const createRes = await page.request.post('/api/studio/products', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: 'E2E Delete Product', description: 'For delete test' },
    });
    const createData = await createRes.json();
    const productId = createData.product.id;

    await page.goto(`/studio/models/${productId}`, { waitUntil: 'networkidle' });
    await expect(page.getByText('E2E Delete Product')).toBeVisible({ timeout: 10000 });

    const deleteButton = page.getByRole('button', { name: /produkt löschen|delete product/i });
    await deleteButton.click();

    const confirmButton = page.getByRole('button', { name: /löschen|delete/i }).last();
    await confirmButton.click();

    await expect(page).toHaveURL(/\/studio\/models/, { timeout: 10000 });
  });
});