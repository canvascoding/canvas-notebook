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

async function cleanupPersona(request: APIRequestContext, personaId: string, expectedName: string) {
  const url = `/api/studio/personas/${encodeURIComponent(personaId)}`;
  const existing = await request.get(url, { timeout: 15_000 });
  if (existing.status() === 404) return;
  expect(existing.status(), 'Owned persona cleanup lookup must succeed.').toBe(200);
  const payload = await existing.json();
  expect(payload.success).toBe(true);
  expect(payload.persona.id).toBe(personaId);
  expect(payload.persona.name, 'Refuse cleanup of a persona with a different fixture identity.').toBe(expectedName);
  const deleted = await request.delete(url, { timeout: 15_000, headers: { Origin: BASE_URL } });
  expect(deleted.status(), 'Owned persona cleanup must succeed.').toBe(200);
  expect((await deleted.json()).success).toBe(true);
  expect((await request.get(url, { timeout: 15_000 })).status()).toBe(404);
}

test.describe('Studio Persona Management', () => {
  let createdPersonaIds: string[] = [];
  const ownedPersonaNames = new Map<string, string>();

  test.afterEach(async ({ browser }, info) => {
    info.setTimeout(60_000);
    if (createdPersonaIds.length === 0) return;
    const cleanupContext = await createAuthenticatedContext(browser, {}, { email: TEST_EMAIL, password: TEST_PASSWORD });
    try {
      for (const id of createdPersonaIds) {
        await cleanupPersona(cleanupContext.request, id, ownedPersonaNames.get(id)!);
      }
    } finally {
      createdPersonaIds = [];
      ownedPersonaNames.clear();
      await cleanupContext.close();
    }
  });

  test('creates a persona with name', async ({ page }) => {
    await login(page);
    const personaName = `E2E Test Persona ${randomUUID()}`;
    await page.goto('/studio/models/new?type=persona', { waitUntil: 'networkidle' });

    await page.locator('input').first().fill(personaName);

    const [response] = await Promise.all([
      page.waitForResponse((resp) => new URL(resp.url()).pathname === '/api/studio/personas' && resp.request().method() === 'POST'),
      page.getByRole('button', { name: /speichern|save/i }).click(),
    ]);
    const data = await response.json();
    expect(typeof data.persona?.id).toBe('string');
    expect(data.persona.id).not.toBe('');
    createdPersonaIds.push(data.persona.id);
    ownedPersonaNames.set(data.persona.id, personaName);
    expect(response.status()).toBe(201);
    expect(data.success).toBe(true);
    expect(data.persona.name).toBe(personaName);
  });

  test('lists personas on models page', async ({ page }) => {
    await login(page);
    const personaName = `E2E Listed Persona ${randomUUID()}`;

    const createRes = await page.request.post('/api/studio/personas', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: personaName, description: 'For listing test' },
      timeout: 15_000,
    });
    const createData = await createRes.json();
    expect(typeof createData.persona?.id).toBe('string');
    expect(createData.persona.id).not.toBe('');
    createdPersonaIds.push(createData.persona.id);
    ownedPersonaNames.set(createData.persona.id, personaName);
    expect(createRes.status()).toBe(201);
    expect(createData.success).toBe(true);

    await page.goto('/studio/models', { waitUntil: 'networkidle' });

    const personaTab = page.getByRole('button', { name: /personas/i });
    await personaTab.click();

    await expect(page.getByText(personaName, { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('deletes a persona with confirmation', async ({ page }) => {
    await login(page);
    const personaName = `E2E Delete Persona ${randomUUID()}`;

    const createRes = await page.request.post('/api/studio/personas', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: personaName },
      timeout: 15_000,
    });
    const createData = await createRes.json();
    expect(typeof createData.persona?.id).toBe('string');
    const personaId = createData.persona.id as string;
    expect(personaId).not.toBe('');
    createdPersonaIds.push(personaId);
    ownedPersonaNames.set(personaId, personaName);
    expect(createRes.status()).toBe(201);
    expect(createData.success).toBe(true);

    await page.goto(`/studio/models/${encodeURIComponent(personaId)}?type=persona`, { waitUntil: 'networkidle' });
    await expect(page.getByText(personaName, { exact: true })).toBeVisible({ timeout: 10000 });

    const deleteButton = page.getByRole('button', { name: /persona löschen|delete persona/i });
    await deleteButton.click();

    const confirmButton = page.getByRole('button', { name: /^löschen$|^delete$/i }).last();
    const [deleted] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/studio/personas/${personaId}` && response.request().method() === 'DELETE'),
      confirmButton.click(),
    ]);
    expect(deleted.status()).toBe(200);
    expect((await deleted.json()).success).toBe(true);

    await expect(page).toHaveURL(/\/studio\/models\/?$/, { timeout: 10000 });
    expect((await page.request.get(`/api/studio/personas/${encodeURIComponent(personaId)}`, { timeout: 15_000 })).status()).toBe(404);
  });
});
