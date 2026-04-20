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

async function cleanupPersona(page: Page, personaId: string) {
  await page.request.delete(`/api/studio/personas/${personaId}`);
}

test.describe('Studio Persona Management', () => {
  let createdPersonaIds: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of createdPersonaIds) {
      await cleanupPersona(page, id).catch(() => {});
    }
    createdPersonaIds = [];
  });

  test('creates a persona with name', async ({ page }) => {
    await login(page);
    await page.goto('/studio/models/new?tab=personas', { waitUntil: 'networkidle' });

    await page.locator('input').first().fill('E2E Test Persona');

    const responsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/studio/personas') && resp.status() === 201,
    );

    await page.getByRole('button', { name: /speichern|save/i }).click();
    const response = await responsePromise;
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.persona.name).toBe('E2E Test Persona');
    createdPersonaIds.push(data.persona.id);
  });

  test('lists personas on models page', async ({ page }) => {
    await login(page);

    const createRes = await page.request.post('/api/studio/personas', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: 'E2E Listed Persona', description: 'For listing test' },
    });
    const createData = await createRes.json();
    createdPersonaIds.push(createData.persona.id);

    await page.goto('/studio/models', { waitUntil: 'networkidle' });

    const personaTab = page.getByRole('button', { name: /personas/i });
    await personaTab.click();

    await expect(page.getByText('E2E Listed Persona')).toBeVisible({ timeout: 10000 });
  });

  test('deletes a persona with confirmation', async ({ page }) => {
    await login(page);

    const createRes = await page.request.post('/api/studio/personas', {
      headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
      data: { name: 'E2E Delete Persona' },
    });
    const createData = await createRes.json();
    const personaId = createData.persona.id;

    await page.goto(`/studio/models/${personaId}`, { waitUntil: 'networkidle' });
    await expect(page.getByText('E2E Delete Persona')).toBeVisible({ timeout: 10000 });

    const deleteButton = page.getByRole('button', { name: /persona löschen|delete persona/i });
    await deleteButton.click();

    const confirmButton = page.getByRole('button', { name: /^löschen$|^delete$/i }).last();
    await confirmButton.click();

    await expect(page).toHaveURL(/\/studio\/models/, { timeout: 10000 });
  });
});