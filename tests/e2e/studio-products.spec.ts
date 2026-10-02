import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { authenticateManagedTestPage, createAuthenticatedContext } from '../helpers/managed-test-context';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
}

async function cleanupProduct(request: APIRequestContext, productId: string, expectedNames: Set<string>) {
  const url = `/api/studio/products/${encodeURIComponent(productId)}`;
  const existing = await request.get(url, { timeout: 15_000 });
  if (existing.status() === 404) return;
  expect(existing.status(), 'Owned product cleanup lookup must succeed.').toBe(200);
  const payload = await existing.json();
  expect(payload.success).toBe(true);
  expect(payload.product.id).toBe(productId);
  expect(expectedNames.has(payload.product.name), 'Refuse cleanup of a product with a different fixture identity.').toBe(true);
  const deleted = await request.delete(url, { timeout: 15_000, headers: { Origin: BASE_URL } });
  expect(deleted.status(), 'Owned product cleanup must succeed.').toBe(200);
  expect((await deleted.json()).success).toBe(true);
  expect((await request.get(url, { timeout: 15_000 })).status()).toBe(404);
}

test.describe('Studio Product Management', () => {
  let createdProductIds: string[] = [];
  const ownedProductNames = new Map<string, Set<string>>();

  test.afterEach(async ({ browser }, info) => {
    info.setTimeout(60_000);
    if (createdProductIds.length === 0) return;
    const cleanupContext = await createAuthenticatedContext(browser, {}, { email: TEST_EMAIL, password: TEST_PASSWORD });
    try {
      for (const id of createdProductIds) {
        await cleanupProduct(cleanupContext.request, id, ownedProductNames.get(id)!);
      }
    } finally {
      createdProductIds = [];
      ownedProductNames.clear();
      await cleanupContext.close();
    }
  });

  test('creates a product with name and description', async ({ page }) => {
    await login(page);
    const productName = `E2E Test Product ${randomUUID()}`;
    await page.goto('/studio/models/new', { waitUntil: 'networkidle' });

    await page.locator('input').first().fill(productName);
    await page.locator('textarea').first().fill('A product created by E2E test');

    const [response] = await Promise.all([
      page.waitForResponse((resp) => new URL(resp.url()).pathname === '/api/studio/products' && resp.request().method() === 'POST'),
      page.getByRole('button', { name: /speichern|save/i }).click(),
    ]);
    const data = await response.json();
    expect(typeof data.product?.id).toBe('string');
    expect(data.product.id).not.toBe('');
    createdProductIds.push(data.product.id);
    ownedProductNames.set(data.product.id, new Set([productName]));
    expect(response.status()).toBe(201);
    expect(data.success).toBe(true);
    expect(data.product.name).toBe(productName);

    await expect(page).toHaveURL(/\/studio\/models\//, { timeout: 10000 });
  });

  test('lists products on models page', async ({ page }) => {
    await login(page);
    const productName = `E2E Listed Product ${randomUUID()}`;

    const createRes = await page.request.post('/api/studio/products', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: productName, description: 'For listing test' },
      timeout: 15_000,
    });
    const createData = await createRes.json();
    expect(typeof createData.product?.id).toBe('string');
    expect(createData.product.id).not.toBe('');
    createdProductIds.push(createData.product.id);
    ownedProductNames.set(createData.product.id, new Set([productName]));
    expect(createRes.status()).toBe(201);
    expect(createData.success).toBe(true);

    await page.goto('/studio/models', { waitUntil: 'networkidle' });
    await expect(page.getByText(productName, { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('edits a product name', async ({ page }) => {
    await login(page);
    const productName = `E2E Edit Product ${randomUUID()}`;
    const editedName = `E2E Edited Product ${randomUUID()}`;

    const createRes = await page.request.post('/api/studio/products', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: productName, description: 'For edit test' },
      timeout: 15_000,
    });
    const createData = await createRes.json();
    expect(typeof createData.product?.id).toBe('string');
    const productId = createData.product.id as string;
    expect(productId).not.toBe('');
    createdProductIds.push(productId);
    ownedProductNames.set(productId, new Set([productName]));
    expect(createRes.status()).toBe(201);
    expect(createData.success).toBe(true);

    await page.goto(`/studio/models/${encodeURIComponent(productId)}`, { waitUntil: 'networkidle' });
    await expect(page.getByText(productName, { exact: true })).toBeVisible({ timeout: 10000 });

    await page.locator('button:has(svg.lucide-pencil)').first().click();

    const nameInput = page.locator('input.text-lg, input[name]').first();
    await nameInput.clear();
    await nameInput.fill(editedName);

    ownedProductNames.get(productId)!.add(editedName);
    const [patched] = await Promise.all([
      page.waitForResponse((resp) => new URL(resp.url()).pathname === `/api/studio/products/${productId}` && resp.request().method() === 'PATCH'),
      page.getByRole('button', { name: /speichern|save/i }).first().click(),
    ]);
    expect(patched.status()).toBe(200);
    const updated = await patched.json();
    expect(updated.success).toBe(true);
    expect(updated.product.id).toBe(productId);
    expect(updated.product.name).toBe(editedName);

    await expect(page.getByText(editedName, { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('deletes a product with confirmation', async ({ page }) => {
    await login(page);
    const productName = `E2E Delete Product ${randomUUID()}`;

    const createRes = await page.request.post('/api/studio/products', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: productName, description: 'For delete test' },
      timeout: 15_000,
    });
    const createData = await createRes.json();
    expect(typeof createData.product?.id).toBe('string');
    const productId = createData.product.id as string;
    expect(productId).not.toBe('');
    createdProductIds.push(productId);
    ownedProductNames.set(productId, new Set([productName]));
    expect(createRes.status()).toBe(201);
    expect(createData.success).toBe(true);

    await page.goto(`/studio/models/${encodeURIComponent(productId)}`, { waitUntil: 'networkidle' });
    await expect(page.getByText(productName, { exact: true })).toBeVisible({ timeout: 10000 });

    const deleteButton = page.getByRole('button', { name: /produkt löschen|delete product/i });
    await deleteButton.click();

    const confirmButton = page.getByRole('button', { name: /löschen|delete/i }).last();
    const [deleted] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/studio/products/${productId}` && response.request().method() === 'DELETE'),
      confirmButton.click(),
    ]);
    expect(deleted.status()).toBe(200);
    expect((await deleted.json()).success).toBe(true);

    await expect(page).toHaveURL(/\/studio\/models\/?$/, { timeout: 10000 });
    expect((await page.request.get(`/api/studio/products/${encodeURIComponent(productId)}`, { timeout: 15_000 })).status()).toBe(404);
  });
});
