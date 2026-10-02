import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { authenticateManagedTestPage, createAuthenticatedContext } from '../helpers/managed-test-context';
import type { StudioGeneration } from '../../app/apps/studio/types/generation';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const ownedGenerations = new Map<string, { prompt: string; clientRequestId: string }>();

async function login(page: Page) {
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
}

async function requireStudioGenerationProvider(page: Page) {
  const response = await page.request.get('/api/studio/config', { timeout: 15_000 });
  expect(response.status(), 'Studio provider preflight must succeed.').toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  expect(typeof payload.config?.localApiKeys?.gemini).toBe('boolean');
  expect(typeof payload.config?.managedMediaAvailable).toBe('boolean');
  test.skip(
    payload.config.localApiKeys.gemini === false && payload.config.managedMediaAvailable === false,
    'Studio detail requires a real image output; Gemini and Managed Media are explicitly unavailable for this test user.',
  );
}

async function createTestGeneration(page: Page) {
  const clientRequestId = randomUUID();
  const prompt = `A red shoe on a white background, Studio detail E2E ${clientRequestId}`;
  const res = await page.request.post('/api/studio/generate', {
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    data: { prompt, client_request_id: clientRequestId, mode: 'image', count: 1 },
    timeout: 15_000,
  });
  const payload = await res.json();
  expect(typeof payload.generationId).toBe('string');
  expect(payload.generationId).not.toBe('');
  ownedGenerations.set(payload.generationId, { prompt, clientRequestId });
  expect(res.status()).toBe(201);
  expect(payload.success).toBe(true);

  let completed: StudioGeneration | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/studio/generations/${encodeURIComponent(payload.generationId)}`, { timeout: 15_000 });
    expect(response.status(), 'Own generation status lookup must succeed.').toBe(200);
    const current = await response.json();
    expect(current.success).toBe(true);
    expect(current.generation.id).toBe(payload.generationId);
    expect(current.generation.rawPrompt).toBe(prompt);
    expect(current.generation.idempotencyKey).toBe(clientRequestId);
    expect(['pending', 'generating', 'completed', 'failed']).toContain(current.generation.status);
    if (current.generation.status === 'failed') throw new Error('The owned Studio detail generation failed.');
    completed = current.generation;
    return current.generation.status;
  }, { timeout: 120_000, intervals: [1000, 2000, 3000] }).toBe('completed');

  expect(completed!.outputs).toHaveLength(1);
  const output = completed!.outputs[0];
  expect(output.generationId).toBe(payload.generationId);
  expect(output.type).toBe('image');
  expect(typeof output.id).toBe('string');
  expect(output.id).not.toBe('');
  expect(typeof output.filePath).toBe('string');
  expect(output.filePath).not.toBe('');
  expect(typeof output.mediaUrl).toBe('string');
  expect(output.mediaUrl).not.toBe('');
  return { generation: completed!, output, prompt };
}

async function cleanupGeneration(request: APIRequestContext, generationId: string) {
  const url = `/api/studio/generations/${encodeURIComponent(generationId)}`;
  const existing = await request.get(url, { timeout: 15_000 });
  if (existing.status() === 404) return;
  expect(existing.status(), 'Owned generation cleanup lookup must succeed.').toBe(200);
  const payload = await existing.json();
  const owner = ownedGenerations.get(generationId)!;
  expect(payload.success).toBe(true);
  expect(payload.generation.id).toBe(generationId);
  expect(payload.generation.rawPrompt).toBe(owner.prompt);
  expect(payload.generation.idempotencyKey).toBe(owner.clientRequestId);
  expect(['completed', 'failed'], 'Refuse deletion while the owned generation is still executing.').toContain(payload.generation.status);
  const deleted = await request.delete(url, { timeout: 15_000, headers: { Origin: BASE_URL } });
  expect(deleted.status(), 'Owned generation cleanup must succeed.').toBe(200);
  expect((await deleted.json()).success).toBe(true);
  expect((await request.get(url, { timeout: 15_000 })).status()).toBe(404);
}

async function openOwnOutput(page: Page, filePath: string, prompt: string) {
  await page.goto('/studio/create', { waitUntil: 'domcontentloaded' });
  const thumbnail = page.locator('div.group').filter({ has: page.getByAltText(filePath, { exact: true }) })
    .getByRole('button', { name: 'Open Image output', exact: true });
  await expect(thumbnail).toHaveCount(1);
  await expect(thumbnail).toBeVisible();
  await thumbnail.click();
  const preview = page.getByRole('region', { name: 'Studio output preview', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(prompt);
  const image = preview.getByAltText(filePath, { exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => {
    const media = element as HTMLImageElement;
    return media.complete && media.naturalWidth > 0;
  }), { timeout: 15_000 }).toBe(true);
  return { thumbnail, preview };
}

test.describe('Studio Detail View + Chat', () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ browser }, info) => {
    info.setTimeout(60_000);
    if (ownedGenerations.size === 0) return;
    const cleanupContext = await createAuthenticatedContext(browser, {}, { email: TEST_EMAIL, password: TEST_PASSWORD });
    try {
      for (const id of ownedGenerations.keys()) {
        await cleanupGeneration(cleanupContext.request, id);
      }
    } finally {
      ownedGenerations.clear();
      await cleanupContext.close();
    }
  });

  test('opens detail view from output thumbnail', async ({ page }) => {
    await login(page);
    await requireStudioGenerationProvider(page);
    const { output, prompt } = await createTestGeneration(page);
    await openOwnOutput(page, output.filePath, prompt);
  });

  test('navigates back to grid from detail view', async ({ page }) => {
    await login(page);
    await requireStudioGenerationProvider(page);
    const { output, prompt } = await createTestGeneration(page);
    const { thumbnail, preview } = await openOwnOutput(page, output.filePath, prompt);
    await preview.getByRole('button', { name: 'Zurück zum Grid', exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(thumbnail).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Studio', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/studio\/create\/?$/);
  });
});
