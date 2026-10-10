import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';

const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 960 }, mobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true },
] as const;

type Profile = typeof profiles[number];
type WorkspaceFixture = {
  page: Page;
  workspaceId: string;
  workspaceName: string;
  headers: Record<string, string>;
  read: (path: string) => Promise<string>;
};

async function withWorkspace(browser: Browser, profile: Profile,
  run: (fixture: WorkspaceFixture) => Promise<void>): Promise<void> {
  expect(process.env.E2E_EXTERNAL_SERVER, 'Use the single externally managed Notebook stack.').toBe('1');
  const context = await createAuthenticatedContext(browser, {
    viewport: profile.viewport, isMobile: profile.mobile, hasTouch: profile.mobile,
  });
  const workspaceName = `E2E destination folders ${profile.name} ${randomUUID()}`;
  let workspaceId: string | undefined;
  let failed = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const created = await context.request.post('/api/workspaces', {
      data: { type: 'personal', name: workspaceName },
    });
    const receipt = (await created.json()).workspace as { id: string; name: string; type: string;
      permissions: { canWrite: boolean; canManageWorkspace: boolean } } | undefined;
    if (receipt?.id) workspaceId = receipt.id;
    expect(created.status(), 'Create an isolated personal test workspace.').toBe(201);
    expect(receipt).toMatchObject({ id: workspaceId, name: workspaceName, type: 'personal',
      permissions: { canWrite: true, canManageWorkspace: true } });
    if (!workspaceId) throw new Error('The test workspace has no ID.');
    const id = workspaceId;
    const headers = { 'x-canvas-workspace-id': id };
    await context.addInitScript((activeWorkspaceId) => {
      localStorage.setItem('canvas.activeWorkspaceId', activeWorkspaceId);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
      localStorage.setItem('canvas-browser-mode', 'list');
    }, id);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const read = async (path: string): Promise<string> => {
      const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers });
      expect(response.status(), `Read owned test file ${path}.`).toBe(200);
      const payload = await response.json() as { data: { path: string; content: string } };
      expect(payload.data.path).toBe(path);
      return payload.data.content;
    };
    await run({ page, workspaceId: id, workspaceName, headers, read });
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    for (const page of context.pages()) {
      try { await page.close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (workspaceId) {
      try {
        const listed = await context.request.get('/api/workspaces');
        expect(listed.status(), 'Verify the owned workspace before cleanup.').toBe(200);
        const payload = await listed.json() as { workspaces: Array<{ id: string; name: string; type: string;
          permissions: { canManageWorkspace: boolean } }> };
        expect(payload.workspaces.find((workspace) => workspace.id === workspaceId)).toMatchObject({
          id: workspaceId, name: workspaceName, type: 'personal', permissions: { canManageWorkspace: true },
        });
        const deleted = await context.request.delete(`/api/workspaces/${workspaceId}`);
        expect(deleted.status(), 'Delete the exact owned test workspace.').toBe(200);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await context.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'Destination folder test cleanup failed.');
  if (failed) throw primaryError;
}

function waitForCreation(page: Page, workspaceId: string, path: string,
  type: 'file' | 'directory'): Promise<APIResponse> {
  return page.waitForResponse((response) => {
    const request = response.request();
    if (new URL(response.url()).pathname !== '/api/files/create' || request.method() !== 'POST') return false;
    const body = request.postDataJSON() as { path?: string; type?: string };
    return body.path === path && body.type === type && request.headers()['x-canvas-workspace-id'] === workspaceId;
  });
}

async function createDestinationFolder(fixture: WorkspaceFixture, dialog: Locator,
  name: string, expectedPath: string): Promise<void> {
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
  await dialog.getByLabel('New folder name', { exact: true }).fill(name);
  const created = waitForCreation(fixture.page, fixture.workspaceId, expectedPath, 'directory');
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  expect((await created).status(), `Create destination ${expectedPath} in the explicit workspace.`).toBe(200);
  await expect(dialog.getByLabel('New folder name', { exact: true })).toBeHidden();
  await expect(dialog.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toContainText(`Selected folder: /${expectedPath}`);
}

async function assertDialogBounds(page: Page, dialog: Locator, profile: Profile): Promise<void> {
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(profile.viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(profile.viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'The destination dialog must not introduce horizontal page scrolling.').toBe(true);
}

async function captureDialog(page: Page, dialog: Locator, profile: Profile,
  info: TestInfo, name: string): Promise<void> {
  await assertDialogBounds(page, dialog, profile);
  await page.screenshot({ path: info.outputPath(`${profile.name}-${name}.png`), animations: 'disabled' });
}

for (const profile of profiles) {
  test.describe(`${profile.name} destination folder creation`, () => {
    test.setTimeout(150_000);

    test('home note creates nested folders and keeps the draft open when cancelling inline creation', async ({ browser }, info) => {
      await withWorkspace(browser, profile, async (fixture) => {
        const { page } = fixture;
        await page.goto('/en');
        const files = page.getByTestId('home-files');
        await expect(files).toContainText(fixture.workspaceName);
        await files.getByRole('button', { name: 'New note', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'New note', exact: true });
        const noteName = 'Ideas kept while choosing folders';
        await dialog.getByLabel('Note name', { exact: true }).fill(noteName);
        await dialog.getByText('Choose another folder', { exact: true }).click();
        await createDestinationFolder(fixture, dialog, 'HomeFolder', 'HomeFolder');
        await expect(dialog.getByLabel('Note name', { exact: true })).toHaveValue(noteName);
        await createDestinationFolder(fixture, dialog, 'Nested', 'HomeFolder/Nested');
        await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
        const cancelledInput = dialog.getByLabel('New folder name', { exact: true });
        await cancelledInput.fill('CancelledFolder');
        await cancelledInput.press('Escape');
        await expect(cancelledInput).toBeHidden();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('Note name', { exact: true })).toHaveValue(noteName);
        await expect(dialog.getByRole('button', { name: 'Nested', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await captureDialog(page, dialog, profile, info, 'home-note-nested');
        const path = `HomeFolder/Nested/${noteName}.md`;
        const created = waitForCreation(page, fixture.workspaceId, path, 'file');
        await dialog.getByRole('button', { name: 'Create and open', exact: true }).click();
        expect((await created).status()).toBe(200);
        await expect(page).toHaveURL((url) => url.pathname.endsWith('/notebook')
          && url.searchParams.get('path') === path && url.searchParams.get('workspaceId') === fixture.workspaceId);
        expect(await fixture.read(path)).toBe('');
        const parent = await page.request.get('/api/files/tree?path=HomeFolder%2FNested&noCache=1', { headers: fixture.headers });
        expect(parent.status()).toBe(200);
        const children = (await parent.json()).data as Array<{ path: string }>;
        expect(children.some((entry) => entry.path === 'HomeFolder/Nested/CancelledFolder')).toBe(false);
      });
    });

    test('file creation preserves its name through invalid folders, collisions and nested folder creation', async ({ browser }, info) => {
      await withWorkspace(browser, profile, async (fixture) => {
        const { page } = fixture;
        const seeded = await page.request.post('/api/files/create', {
          headers: fixture.headers, data: { path: 'Taken', type: 'directory' },
        });
        expect(seeded.status()).toBe(200);
        await page.goto(`/en/files?workspaceId=${fixture.workspaceId}`);
        await page.getByRole('button', { name: 'Create', exact: true }).click();
        await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Create new file', exact: true });
        const filename = 'Retained file name.md';
        await dialog.getByLabel('File name', { exact: true }).fill(filename);
        await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
        const folderName = dialog.getByLabel('New folder name', { exact: true });
        await folderName.fill('invalid/name');
        await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
        await expect(dialog.getByRole('alert')).toHaveText('Enter a single folder name without / or \\.');
        await expect(folderName).toHaveValue('invalid/name');
        await expect(dialog.getByLabel('File name', { exact: true })).toHaveValue(filename);
        await folderName.fill('Taken');
        const conflict = waitForCreation(page, fixture.workspaceId, 'Taken', 'directory');
        await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
        expect((await conflict).status()).toBe(409);
        await expect(dialog.getByRole('alert')).toHaveText('A file or folder already exists with this name.');
        await expect(dialog.getByLabel('File name', { exact: true })).toHaveValue(filename);
        await captureDialog(page, dialog, profile, info, 'folder-conflict-retry');
        await folderName.fill('Documents');
        const retry = waitForCreation(page, fixture.workspaceId, 'Documents', 'directory');
        await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
        expect((await retry).status()).toBe(200);
        await expect(folderName).toBeHidden();
        await expect(dialog.getByRole('button', { name: 'Documents', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await createDestinationFolder(fixture, dialog, 'Nested', 'Documents/Nested');
        await expect(dialog.getByLabel('File name', { exact: true })).toHaveValue(filename);
        await captureDialog(page, dialog, profile, info, 'file-create-nested');
        const path = `Documents/Nested/${filename}`;
        const created = waitForCreation(page, fixture.workspaceId, path, 'file');
        await dialog.getByRole('button', { name: 'Create file', exact: true }).click();
        expect((await created).status()).toBe(200);
        await expect(dialog).toBeHidden();
        expect(await fixture.read(path)).toBe('');
      });
    });

    test('home import creates a nested destination before selecting the local file', async ({ browser }, info) => {
      await withWorkspace(browser, profile, async (fixture) => {
        const { page } = fixture;
        await page.goto('/en');
        const files = page.getByTestId('home-files');
        await expect(files).toContainText(fixture.workspaceName);
        await files.getByRole('button', { name: 'Import files', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
        await expect(dialog).toBeVisible();
        await createDestinationFolder(fixture, dialog, 'Imports', 'Imports');
        await createDestinationFolder(fixture, dialog, 'Nested', 'Imports/Nested');
        await captureDialog(page, dialog, profile, info, 'home-import-nested');
        const filename = 'imported.txt';
        const content = 'Synthetic import preserves bytes: äöü ß → 22 °C.\n';
        const uploaded = page.waitForResponse((response) => /^\/api\/files\/uploads\/[^/]+\/complete$/u.test(new URL(response.url()).pathname)
          && response.request().method() === 'POST'
          && response.request().headers()['x-canvas-workspace-id'] === fixture.workspaceId);
        await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
          name: filename, mimeType: 'text/plain', buffer: Buffer.from(content),
        });
        expect((await uploaded).status()).toBe(200);
        await expect(dialog).toBeHidden();
        expect(await fixture.read(`Imports/Nested/${filename}`)).toBe(content);
        expect((await page.request.get(`/api/files/read?path=${filename}`, { headers: fixture.headers })).status()).toBe(404);
      });
    });
  });
}
