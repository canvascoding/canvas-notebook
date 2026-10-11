import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page, type Response as BrowserResponse, type TestInfo } from '@playwright/test';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';

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
  type: 'file' | 'directory'): Promise<BrowserResponse> {
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
  await waitForFileCreateBudget();
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
  await dialog.screenshot({ path: info.outputPath(`${profile.name}-${name}-dialog.png`), animations: 'disabled' });
}

async function openPathActions(page: Page, path: string): Promise<void> {
  const row = page.locator(`[data-file-path="${path}"]`).first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await expect(page.getByRole('menuitem', { name: 'Move', exact: true })).toBeVisible();
}

function waitForRename(fixture: WorkspaceFixture, oldPath: string, newPath: string): Promise<BrowserResponse> {
  return fixture.page.waitForResponse((response) => {
    const request = response.request();
    if (new URL(response.url()).pathname !== '/api/files/rename' || request.method() !== 'POST') return false;
    const body = request.postDataJSON() as { oldPath?: string; newPath?: string; dryRun?: boolean };
    return body.dryRun !== true && body.oldPath === oldPath && body.newPath === newPath
      && request.headers()['x-canvas-workspace-id'] === fixture.workspaceId;
  }, { timeout: 60_000 });
}

async function assertRenameApplied(fixture: WorkspaceFixture, response: BrowserResponse): Promise<void> {
  expect(response.ok(), 'The real move request succeeded.').toBe(true);
  const receipt = (await response.json()).operation as { batchId: string; planId: string; workspaceId: string };
  expect(receipt).toBeTruthy();
  expect(receipt.workspaceId).toBe(fixture.workspaceId);
  expect(receipt.batchId).toBeTruthy();
  expect(receipt.planId).toBeTruthy();
  await expect.poll(async () => {
    const polled = await fixture.page.request.get(`/api/files/operations/batches/${encodeURIComponent(receipt.batchId)}`, {
      headers: fixture.headers,
    });
    expect(polled.status(), 'Read the exact tracked move.').toBe(200);
    const operation = (await polled.json()).operation as { batchId: string; planId: string; workspaceId: string;
      status: string; phase: string; completedActions: number; totalActions: number };
    expect(operation.batchId).toBe(receipt.batchId);
    expect(operation.planId).toBe(receipt.planId);
    expect(operation.workspaceId).toBe(fixture.workspaceId);
    if (operation.status === 'applied') {
      expect(operation.phase).toBe('complete');
      expect(operation.completedActions).toBe(operation.totalActions);
    }
    return operation.status;
  }, { timeout: 60_000 }).toBe('applied');
}

async function assertSourceAbsent(fixture: WorkspaceFixture, path: string): Promise<void> {
  const response = await fixture.page.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, {
    headers: fixture.headers,
  });
  expect(response.status(), `The original path ${path} is absent after moving.`).toBe(404);
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
        await cancelledInput.fill('KeyboardCancelledFolder');
        const inlineCancel = cancelledInput.locator('..').getByRole('button', { name: 'Cancel', exact: true });
        await inlineCancel.focus();
        await inlineCancel.press('Enter');
        await expect(cancelledInput).toBeHidden();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
        await cancelledInput.fill('CancelledFolder');
        await cancelledInput.press('Escape');
        await expect(cancelledInput).toBeHidden();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('Note name', { exact: true })).toHaveValue(noteName);
        await expect(dialog.getByRole('button', { name: 'Nested', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await captureDialog(page, dialog, profile, info, 'home-note-nested');
        const path = `HomeFolder/Nested/${noteName}.md`;
        await waitForFileCreateBudget();
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
        expect(children.some((entry) => entry.path === 'HomeFolder/Nested/KeyboardCancelledFolder')).toBe(false);
      });
    });

    test('file creation preserves its name through invalid folders, collisions and nested folder creation', async ({ browser }, info) => {
      await withWorkspace(browser, profile, async (fixture) => {
        const { page } = fixture;
        await waitForFileCreateBudget();
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
        await waitForFileCreateBudget();
        const conflict = waitForCreation(page, fixture.workspaceId, 'Taken', 'directory');
        await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
        expect((await conflict).status()).toBe(409);
        await expect(dialog.getByRole('alert')).toHaveText('A file or folder already exists with this name.');
        await expect(dialog.getByLabel('File name', { exact: true })).toHaveValue(filename);
        await captureDialog(page, dialog, profile, info, 'folder-conflict-retry');
        await folderName.fill('Documents');
        await waitForFileCreateBudget();
        const retry = waitForCreation(page, fixture.workspaceId, 'Documents', 'directory');
        await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
        expect((await retry).status()).toBe(200);
        await expect(folderName).toBeHidden();
        await expect(dialog.getByRole('button', { name: 'Documents', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await createDestinationFolder(fixture, dialog, 'Nested', 'Documents/Nested');
        await expect(dialog.getByLabel('File name', { exact: true })).toHaveValue(filename);
        await captureDialog(page, dialog, profile, info, 'file-create-nested');
        const path = `Documents/Nested/${filename}`;
        await waitForFileCreateBudget();
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

for (const profile of profiles) {
  test.describe(`${profile.name} move and copy destination folders`, () => {
    test.setTimeout(180_000);

    test('single move preserves a changed file name while creating nested folders', async ({ browser }, info) => {
      await withWorkspace(browser, profile, async (fixture) => {
        const { page } = fixture;
        const source = 'single-source.txt';
        const content = 'Single move keeps these bytes: äöü ß → 22 °C.\n';
        await uploadWorkspaceTextFile({ request: page.request, workspaceId: fixture.workspaceId,
          filePath: source, content, mimeType: 'text/plain' });
        await page.goto(`/en/files?workspaceId=${fixture.workspaceId}`);
        await openPathActions(page, source);
        await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: `Move "${source}"`, exact: true });
        const changedName = 'renamed-before-folder-creation.txt';
        await dialog.getByLabel('Name', { exact: true }).fill(changedName);
        await createDestinationFolder(fixture, dialog, 'MoveTarget', 'MoveTarget');
        await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(changedName);
        await createDestinationFolder(fixture, dialog, 'Nested', 'MoveTarget/Nested');
        await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(changedName);
        await expect(dialog.getByLabel('Destination folder', { exact: true })).toHaveValue('MoveTarget/Nested');
        await captureDialog(page, dialog, profile, info, 'single-move-nested');
        const destination = `MoveTarget/Nested/${changedName}`;
        const moved = waitForRename(fixture, source, destination);
        await dialog.getByRole('button', { name: 'Move', exact: true }).click();
        await assertRenameApplied(fixture, await moved);
        await expect(dialog).toBeHidden({ timeout: 60_000 });
        expect(await fixture.read(destination)).toBe(content);
        await assertSourceAbsent(fixture, source);
      });
    });

    test('bulk move keeps both selected files while creating nested folders', async ({ browser }, info) => {
      await withWorkspace(browser, profile, async (fixture) => {
        const { page } = fixture;
        const sources = [
          { path: 'bulk-first.txt', content: 'First selected file: αβγ.\n' },
          { path: 'bulk-second.txt', content: 'Second selected file: äöü.\n' },
        ];
        for (const source of sources) {
          await uploadWorkspaceTextFile({ request: page.request, workspaceId: fixture.workspaceId,
            filePath: source.path, content: source.content, mimeType: 'text/plain' });
        }
        await page.goto(`/en/files?workspaceId=${fixture.workspaceId}`);
        for (const source of sources) {
          await expect(page.locator(`[data-file-path="${source.path}"]`).first()).toBeVisible();
        }
        await page.getByRole('button', { name: 'Toggle select mode', exact: true }).click();
        for (const source of sources) {
          await page.getByRole('button', { name: `Select ${source.path}`, exact: true }).filter({ visible: true }).first().click();
          await expect(page.getByRole('button', { name: `Deselect ${source.path}`, exact: true }).filter({ visible: true }).first())
            .toHaveAttribute('aria-pressed', 'true');
        }
        await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Move', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Move 2', exact: true });
        await createDestinationFolder(fixture, dialog, 'BulkTarget', 'BulkTarget');
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAccessibleName('Move 2');
        await createDestinationFolder(fixture, dialog, 'Nested', 'BulkTarget/Nested');
        await expect(dialog).toHaveAccessibleName('Move 2');
        await captureDialog(page, dialog, profile, info, 'bulk-move-nested');
        const moved = sources.map((source) => waitForRename(fixture, source.path, `BulkTarget/Nested/${source.path}`));
        await dialog.getByRole('button', { name: 'Move', exact: true }).click();
        for (const response of moved) await assertRenameApplied(fixture, await response);
        await expect(dialog).toBeHidden({ timeout: 60_000 });
        for (const source of sources) {
          expect(await fixture.read(`BulkTarget/Nested/${source.path}`)).toBe(source.content);
          await assertSourceAbsent(fixture, source.path);
        }
      });
    });

    test('copy to another workspace creates folders in the chosen target and preserves source bytes', async ({ browser }, info) => {
      await withWorkspace(browser, profile, async (fixture) => {
        const { page } = fixture;
        const targetName = `E2E copy destination ${profile.name} ${randomUUID()}`;
        let targetId: string | undefined;
        let failed = false;
        let primaryError: unknown;
        const cleanupErrors: unknown[] = [];
        try {
          const created = await page.request.post('/api/workspaces', { data: { type: 'personal', name: targetName } });
          const receipt = (await created.json()).workspace as { id: string; name: string; type: string;
            permissions: { canWrite: boolean; canManageWorkspace: boolean } } | undefined;
          if (receipt?.id) targetId = receipt.id;
          expect(created.status(), 'Create the separate owned destination workspace.').toBe(201);
          expect(receipt).toMatchObject({ id: targetId, name: targetName, type: 'personal',
            permissions: { canWrite: true, canManageWorkspace: true } });
          if (!targetId) throw new Error('The copy destination workspace has no ID.');
          const destinationWorkspaceId = targetId;
          const source = 'copy-source.txt';
          const content = 'Cross-workspace copy keeps exact bytes: λ → äöü ß.\n';
          await uploadWorkspaceTextFile({ request: page.request, workspaceId: fixture.workspaceId,
            filePath: source, content, mimeType: 'text/plain' });
          await page.goto(`/en/files?workspaceId=${fixture.workspaceId}`);
          await openPathActions(page, source);
          await page.getByRole('menuitem', { name: 'Copy to workspace', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Copy to workspace', exact: true });
          await dialog.getByRole('combobox', { name: 'Target workspace', exact: true }).selectOption(destinationWorkspaceId);
          await expect(dialog.getByRole('combobox', { name: 'Target workspace', exact: true })).toHaveValue(destinationWorkspaceId);
          const targetFixture = { ...fixture, workspaceId: destinationWorkspaceId };
          await createDestinationFolder(targetFixture, dialog, 'CopyTarget', 'CopyTarget');
          await createDestinationFolder(targetFixture, dialog, 'Nested', 'CopyTarget/Nested');
          const sourceTree = await page.request.get('/api/files/tree?path=.&noCache=1', { headers: fixture.headers });
          expect(sourceTree.status()).toBe(200);
          const sourceChildren = (await sourceTree.json()).data as Array<{ path: string }>;
          expect(sourceChildren.some((entry) => entry.path === 'CopyTarget'),
            'Target folders must not be created in the active source workspace.').toBe(false);
          await captureDialog(page, dialog, profile, info, 'foreign-workspace-copy-nested');
          const copied = page.waitForResponse((response) => {
            const request = response.request();
            if (new URL(response.url()).pathname !== '/api/files/copy' || request.method() !== 'POST') return false;
            const body = request.postDataJSON() as { dryRun?: boolean; sourceWorkspaceId?: string;
              targetWorkspaceId?: string; destDir?: string; sources?: string[] };
            return body.dryRun !== true && body.sourceWorkspaceId === fixture.workspaceId
              && body.targetWorkspaceId === destinationWorkspaceId && body.destDir === 'CopyTarget/Nested'
              && body.sources?.includes(source) === true
              && request.headers()['x-canvas-workspace-id'] === fixture.workspaceId;
          }, { timeout: 60_000 });
          await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
          expect((await copied).ok(), 'The real copy uses explicit source and target workspaces.').toBe(true);
          await expect(dialog).toBeHidden({ timeout: 60_000 });
          const targetFile = await page.request.get(`/api/files/read?path=${encodeURIComponent(`CopyTarget/Nested/${source}`)}`, {
            headers: { 'x-canvas-workspace-id': destinationWorkspaceId },
          });
          expect(targetFile.status()).toBe(200);
          const targetEvidence = (await targetFile.json()).data as { path: string; content: string };
          expect(targetEvidence.path).toBe(`CopyTarget/Nested/${source}`);
          expect(targetEvidence.content).toBe(content);
          expect(await fixture.read(source)).toBe(content);
          expect((await page.request.get(`/api/files/read?path=${encodeURIComponent(`CopyTarget/Nested/${source}`)}`, {
            headers: fixture.headers,
          })).status()).toBe(404);
        } catch (error) {
          failed = true;
          primaryError = error;
        } finally {
          if (targetId) {
            try {
              const listed = await page.request.get('/api/workspaces');
              expect(listed.status(), 'Verify the owned copy destination before cleanup.').toBe(200);
              const payload = await listed.json() as { workspaces: Array<{ id: string; name: string; type: string;
                permissions: { canManageWorkspace: boolean } }> };
              expect(payload.workspaces.find((workspace) => workspace.id === targetId)).toMatchObject({
                id: targetId, name: targetName, type: 'personal', permissions: { canManageWorkspace: true },
              });
              expect((await page.request.delete(`/api/workspaces/${targetId}`)).status(),
                'Delete the exact owned copy destination.').toBe(200);
            } catch (error) { cleanupErrors.push(error); }
          }
        }
        if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
          'Copy destination cleanup failed.');
        if (failed) throw primaryError;
      });
    });
  });
}

test('desktop drag moves into a folder created inline after cancelling the move dialog', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const profile = profiles[0];
  await withWorkspace(browser, profile, async (fixture) => {
    const { page } = fixture;
    const source = 'drag-source.txt';
    const content = 'A created destination is also available for drag and drop.\n';
    await uploadWorkspaceTextFile({ request: page.request, workspaceId: fixture.workspaceId,
      filePath: source, content, mimeType: 'text/plain' });
    await page.goto(`/en/files?workspaceId=${fixture.workspaceId}`);
    await openPathActions(page, source);
    await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Move "${source}"`, exact: true });
    await createDestinationFolder(fixture, dialog, 'DragTarget', 'DragTarget');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await fixture.read(source)).toBe(content);
    const sourceRow = page.locator(`[data-file-path="${source}"]`).first();
    const targetRow = page.locator('[data-file-drop-path="DragTarget"]').first();
    await expect(sourceRow).toBeVisible();
    await expect(targetRow).toBeVisible();
    const moved = waitForRename(fixture, source, `DragTarget/${source}`);
    await sourceRow.dragTo(targetRow);
    await assertRenameApplied(fixture, await moved);
    expect(await fixture.read(`DragTarget/${source}`)).toBe(content);
    await assertSourceAbsent(fixture, source);
    await page.screenshot({ path: info.outputPath('desktop-created-folder-drag-complete.png'), animations: 'disabled' });
  });
});
