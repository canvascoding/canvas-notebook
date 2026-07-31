import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/chat-file-reference-auth.json';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';

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
  await page.goto('/notebook?chat=open', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/notebook\?chat=open$/, { timeout: 15000 });
}

async function startFreshChat(page: Page) {
  await page.getByRole('button', { name: /new chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

async function getActiveWorkspaceId(page: Page): Promise<string> {
  await page.waitForFunction(() => Boolean(window.localStorage.getItem('canvas.activeWorkspaceId')));
  const workspaceId = await page.evaluate(() => window.localStorage.getItem('canvas.activeWorkspaceId'));
  expect(workspaceId).toBeTruthy();
  return workspaceId as string;
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/workspaces', { data: { name, type: 'personal' } });
  const payload = await response.json() as { workspace?: { id?: string }; error?: string };
  expect(response.ok(), payload.error || 'Failed to create test workspace').toBeTruthy();
  expect(payload.workspace?.id).toBeTruthy();
  return payload.workspace!.id!;
}

async function switchWorkspace(page: Page, workspaceId: string) {
  await page.evaluate((id) => window.localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('canvas.activeWorkspaceId'))).toBe(workspaceId);
}

async function createDirectory(page: Page, workspaceId: string, directoryPath: string) {
  const response = await page.request.post('/api/files/create', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { path: directoryPath, type: 'directory' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function writeWorkspaceFile(page: Page, workspaceId: string, filePath: string, content: string) {
  const response = await page.request.post('/api/files/write', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { path: filePath, content },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function deleteWorkspacePath(page: Page, workspaceId: string, targetPath: string) {
  await page.request.delete('/api/files/delete', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { path: targetPath },
  });
}

async function mockSkills(page: Page, enabled: boolean) {
  await page.route('**/api/skills', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        skills: enabled ? [{
          name: 'pdf',
          title: 'PDF',
          description: 'Read and create PDF files.',
          enabled: true,
          core: false,
        }] : [],
      }),
    });
  });
}

async function selectedReferenceIsInsidePicker(picker: Locator) {
  return picker.evaluate((element) => {
    const selectedItem = element.querySelector<HTMLElement>('[data-active="true"]');
    if (!selectedItem) return false;

    const selectedTop = selectedItem.offsetTop;
    const selectedBottom = selectedTop + selectedItem.offsetHeight;
    return selectedTop >= element.scrollTop && selectedBottom <= element.scrollTop + element.clientHeight;
  });
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

  test('searches the selected workspace and prefers direct filename matches', async ({ page }) => {
    await page.goto('/notebook?chat=open');
    const fixtureId = `playwright-file-picker-${Date.now()}`;
    const query = `PickerUnique${Date.now()}`;
    const workspaceId = await createWorkspace(page, `Reference Picker ${Date.now()}`);
    await switchWorkspace(page, workspaceId);
    const pathOnlyDir = `${fixtureId}/${query}`;
    const filenameDir = `${fixtureId}/Elsewhere`;
    await createDirectory(page, workspaceId, pathOnlyDir);
    await createDirectory(page, workspaceId, filenameDir);
    await writeWorkspaceFile(page, workspaceId, `${pathOnlyDir}/unrelated-notes.md`, '# Path-only match\n');
    await writeWorkspaceFile(page, workspaceId, `${filenameDir}/${query}.md`, '# Filename match\n');

    try {
      await startFreshChat(page);

      const input = page.getByTestId('chat-input');
      const searchRequest = page.waitForRequest((request) => request.url().includes('/api/files/list'));
      await input.fill(`@${query}`);
      const request = await searchRequest;
      expect(new URL(request.url()).searchParams.get('workspaceId')).toBe(workspaceId);
      expect(request.headers()[WORKSPACE_ID_HEADER]).toBe(workspaceId);

      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker.getByTestId('chat-reference-item').first()).toContainText(`${fixtureId}/Elsewhere/${query}`, { timeout: 15000 });
      await expect(picker.getByTestId('chat-reference-item').first()).not.toContainText(`/${query}/unrelated-notes.md`);
    } finally {
      await deleteWorkspacePath(page, workspaceId, fixtureId);
      await page.request.delete(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
    }
  });

  test('plus picker combines current workspace files, plugins, and skills', async ({ page }) => {
    await mockSkills(page, true);
    await page.route('**/api/plugins', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          plugins: [{
            name: 'reference-test-plugin',
            version: '1.0.0',
            description: 'Reference picker test plugin',
            enabled: true,
            skills: [],
          }],
        }),
      });
    });
    await page.goto('/notebook?chat=open');
    const workspaceId = await getActiveWorkspaceId(page);
    const fixtureId = `000-plus-reference-${Date.now()}`;
    await createDirectory(page, workspaceId, fixtureId);
    await writeWorkspaceFile(page, workspaceId, `${fixtureId}/plus-context.md`, '# Plus context\n');

    try {
      await startFreshChat(page);
      const input = page.getByTestId('chat-input');
      await input.fill('+');
      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker.locator('[data-reference-kind="file"]')).not.toHaveCount(0, { timeout: 15000 });
      await expect(picker.locator('[data-reference-kind="plugin"]')).toHaveCount(1);
      await expect(picker.locator('[data-reference-kind="skill"]')).not.toHaveCount(0);

      await picker.locator('[data-reference-kind="plugin"]').click();
      await expect(input).toHaveValue('/reference-test-plugin ');
    } finally {
      await deleteWorkspacePath(page, workspaceId, fixtureId);
      await page.unroute('**/api/plugins');
      await page.unroute('**/api/skills');
    }
  });

  test('shows active slash skill references and inserts the selected skill', async ({ page }) => {
    await mockSkills(page, true);
    await page.goto('/notebook?chat=open');

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
    await page.unroute('**/api/skills');
  });

  test('does not show disabled skills in the slash picker', async ({ page }) => {
    await mockSkills(page, false);
    await page.goto('/notebook?chat=open');

    try {
      await startFreshChat(page);

      const input = page.getByTestId('chat-input');
      await input.fill('/pdf');

      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker).toBeVisible({ timeout: 15000 });
      await expect(picker.locator('[data-reference-kind="skill"]')).toHaveCount(0);
      await expect(picker).toContainText(/No plugins or skills found matching|Keine Plugins oder Skills gefunden/);
      await expect(picker).not.toContainText('/pdf');
    } finally {
      await page.unroute('**/api/skills');
    }
  });

  test('does not open the slash picker inside normal paths or URLs', async ({ page }) => {
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    const picker = page.getByTestId('chat-reference-picker');

    await input.fill('foo/bar');
    await expect(picker).toHaveCount(0);

    await input.fill('https://example.com');
    await expect(picker).toHaveCount(0);
  });

  test('keeps the selected reference visible while navigating with arrow keys', async ({ page }) => {
    const fixtureId = `playwright-file-picker-scroll-${Date.now()}`;
    const query = `PickerScrollUnique${Date.now()}`;
    await page.goto('/notebook?chat=open');
    const workspaceId = await getActiveWorkspaceId(page);
    await createDirectory(page, workspaceId, fixtureId);
    for (let index = 0; index < 12; index += 1) {
      const paddedIndex = String(index).padStart(2, '0');
      await writeWorkspaceFile(page, workspaceId, `${fixtureId}/${query}-${paddedIndex}.md`, `# ${query} ${paddedIndex}\n`);
    }

    try {
      await startFreshChat(page);

      const input = page.getByTestId('chat-input');
      await input.fill(`@${query}`);

      const picker = page.getByTestId('chat-reference-picker');
      await expect(picker).toBeVisible({ timeout: 15000 });
      await expect(picker.getByTestId('chat-reference-item')).toHaveCount(12, { timeout: 15000 });

      for (let index = 0; index < 8; index += 1) {
        await input.press('ArrowDown');
      }

      await expect.poll(() => picker.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect.poll(() => selectedReferenceIsInsidePicker(picker)).toBe(true);

      for (let index = 0; index < 8; index += 1) {
        await input.press('ArrowUp');
      }

      await expect.poll(() => selectedReferenceIsInsidePicker(picker)).toBe(true);
    } finally {
      await deleteWorkspacePath(page, workspaceId, fixtureId);
    }
  });
});
