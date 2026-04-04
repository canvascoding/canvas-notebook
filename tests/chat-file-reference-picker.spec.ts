import { expect, test, type Browser, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/chat-file-reference-auth.json';
const WORKSPACE_ROOT = path.join(process.cwd(), 'data', 'workspace');

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: {
      Origin: process.env.BASE_URL || 'http://localhost:3000',
    },
    data: {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    },
  });

  expect(response.ok()).toBeTruthy();
  await page.goto('/chat', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/chat$/, { timeout: 15000 });
}

async function startFreshChat(page: Page) {
  await page.getByRole('button', { name: /new chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', /new chat/i);
}

async function setSkillEnabled(page: Page, skillName: string, enabled: boolean) {
  const response = await page.evaluate(async ({ enabled, skillName }) => {
    const res = await fetch(`/api/skills/${skillName}/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
    });

    return {
      body: await res.text(),
      ok: res.ok,
      status: res.status,
    };
  }, { enabled, skillName });

  expect(response.ok, `Failed to update skill "${skillName}": HTTP ${response.status} ${response.body}`).toBeTruthy();
}

test.describe('Chat File Reference Picker', () => {
  test.setTimeout(90000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    test.setTimeout(120000);
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('prefers direct filename matches over folder-name path matches', async ({ page }) => {
    const fixtureId = `playwright-file-picker-${Date.now()}`;
    const query = `PickerUnique${Date.now()}`;
    const fixtureRoot = path.join(WORKSPACE_ROOT, fixtureId);
    const pathOnlyDir = path.join(fixtureRoot, query);
    const filenameDir = path.join(fixtureRoot, 'Elsewhere');
    const pathOnlyFile = path.join(pathOnlyDir, 'unrelated-notes.md');
    const filenameMatchFile = path.join(filenameDir, `${query}.md`);

    await mkdir(pathOnlyDir, { recursive: true });
    await mkdir(filenameDir, { recursive: true });
    await writeFile(pathOnlyFile, '# Path-only match\n');
    await writeFile(filenameMatchFile, '# Filename match\n');

    try {
      await page.goto('/chat');
      await startFreshChat(page);

      const input = page.getByTestId('chat-input');
      await input.fill(`@${query}`);

      const pickerButtons = page.locator('textarea[data-testid="chat-input"] + div button');
      await expect(pickerButtons.first()).toBeVisible({ timeout: 15000 });
      await expect(pickerButtons.first()).toContainText(`${fixtureId}/Elsewhere/${query}.md`);
      await expect(pickerButtons.first()).not.toContainText(`/${query}/unrelated-notes.md`);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('shows active slash skill references and inserts the selected skill', async ({ page }) => {
    await page.goto('/chat');
    await setSkillEnabled(page, 'pdf', true);

    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    await input.fill('/pdf');

    const picker = page.getByTestId('chat-reference-picker');
    await expect(picker).toBeVisible({ timeout: 15000 });
    await expect(picker).toContainText(/pdf/i);
    await expect(picker).toContainText('/pdf');
    await expect(picker.locator('[data-reference-kind="skill"] [data-testid="chat-reference-icon"]').first()).toBeVisible();

    await input.press('Enter');
    await expect(input).toHaveValue('/pdf ');
    await expect(picker).toBeHidden();
  });

  test('does not show disabled skills in the slash picker', async ({ page }) => {
    await page.goto('/chat');
    await setSkillEnabled(page, 'pdf', false);

    try {
      await startFreshChat(page);

      const input = page.getByTestId('chat-input');
      await input.fill('/pdf');

      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker).toBeVisible({ timeout: 15000 });
      await expect(picker.locator('[data-reference-kind="skill"]')).toHaveCount(0);
      await expect(picker).toContainText(/No skills found matching|Keine Skills gefunden/);
      await expect(picker).not.toContainText('/pdf');
    } finally {
      await setSkillEnabled(page, 'pdf', true);
    }
  });

  test('does not open the slash picker inside normal paths or URLs', async ({ page }) => {
    await page.goto('/chat');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    const picker = page.getByTestId('chat-reference-picker');

    await input.fill('foo/bar');
    await expect(picker).toHaveCount(0);

    await input.fill('https://example.com');
    await expect(picker).toHaveCount(0);
  });
});
