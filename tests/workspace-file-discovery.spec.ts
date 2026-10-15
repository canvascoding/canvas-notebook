import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const profiles = [
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true },
  { name: 'desktop', viewport: { width: 1440, height: 960 }, mobile: false },
] as const;
const folders = Array.from({ length: 18 }, (_, index) => `level-${String(index).padStart(2, '0')}`);
const deepDirectory = folders.join('/');
const deepImage = `${deepDirectory}/deep-reference 1.png`;
const deepNote = `${deepDirectory}/deep-note.md`;
type OwnedWorkspace = { id: string; name: string };
type FilePage = { files: Array<{ path: string; name: string; type: string }>; total: number; nextCursor: string | null };

async function createWorkspace(request: APIRequestContext, name: string, owned: OwnedWorkspace[]) {
  const response = await request.post('/api/workspaces', { data: { type: 'personal', name } });
  const payload = await response.json();
  if (payload.workspace?.id) owned.push({ id: payload.workspace.id, name });
  expect(response.status()).toBe(201);
  expect(payload.workspace).toMatchObject({ name, type: 'personal', permissions: { canWrite: true, canManageWorkspace: true } });
  return payload.workspace.id as string;
}

async function filePage(request: APIRequestContext, workspaceId: string, query: Record<string, string>): Promise<FilePage> {
  const response = await request.get(`/api/files/list?${new URLSearchParams({ workspaceId, ...query })}`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function seedSource(request: APIRequestContext, workspaceId: string) {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 32, g: 128, b: 160 } } }).png().toBuffer();
  const multipart = new FormData();
  multipart.append('path', '.');
  for (let index = 0; index < 505; index += 1) {
    multipart.append('files', new File(['owned discovery fixture'], `Paged-${String(index).padStart(3, '0')}-text.txt`, { type: 'text/plain' }));
  }
  for (let index = 0; index < 105; index += 1) {
    multipart.append('files', new File([new Uint8Array(png)], `Paged-zz-image-${String(index).padStart(3, '0')}.png`, { type: 'image/png' }));
  }
  const uploaded = await request.post('/api/files/upload', { headers: { 'x-canvas-workspace-id': workspaceId }, multipart });
  expect(uploaded.status(), 'Seed more than 500 non-media files and two media pages in one owned workspace.').toBe(200);
  const deep = await request.post('/api/files/upload', {
    headers: { 'x-canvas-workspace-id': workspaceId },
    multipart: { path: deepDirectory, files: { name: 'deep-reference 1.png', mimeType: 'image/png', buffer: png } },
  });
  expect(deep.status()).toBe(200);
  await uploadWorkspaceTextFile({ request, workspaceId, filePath: deepNote, content: '# Deep note\nOwned fixture.' });
  const empty = await request.post('/api/files/create', { headers: { 'x-canvas-workspace-id': workspaceId },
    data: { path: `${deepDirectory}/empty`, type: 'directory' } });
  expect(empty.status()).toBe(200);
}

async function openWorkspacePicker(page: Page, sourceId: string) {
  const dialog = page.getByRole('dialog', { name: 'Select image reference' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await dialog.locator('select').selectOption(sourceId);
  return dialog;
}

async function expectImageLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64);
}

for (const profile of profiles) {
  test(`complete file discovery, foreign workspace model import and Resize (${profile.name})`, async ({ browser }, info) => {
    const context = await createAuthenticatedContext(browser, {
      viewport: profile.viewport, isMobile: profile.mobile, hasTouch: profile.mobile,
    });
    const owned: OwnedWorkspace[] = [];
    let productId: string | undefined;
    let targetId: string | undefined;
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      targetId = await createWorkspace(context.request, `E2E discovery target ${profile.name} ${randomUUID()}`, owned);
      const sourceId = await createWorkspace(context.request, `E2E discovery source ${profile.name} ${randomUUID()}`, owned);
      await seedSource(context.request, sourceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId: targetId, filePath: 'target-marker.txt', content: 'target' });

      await test.step('Complete catalogue, media filter before pagination, empty folders and mobile API', async () => {
        const media = await filePage(context.request, sourceId, { q: 'Paged', extensions: 'png', limit: '100' });
        expect(media.total).toBe(105);
        expect(media.files).toHaveLength(100);
        expect(media.nextCursor).toBeTruthy();
        const lastMedia = await filePage(context.request, sourceId, { q: 'Paged', extensions: 'png', limit: '100', cursor: media.nextCursor! });
        expect(lastMedia.files).toHaveLength(5);
        expect(lastMedia.nextCursor).toBeNull();
        expect(new Set([...media.files, ...lastMedia.files].map((file) => file.path)).size).toBe(105);
        expect([...media.files, ...lastMedia.files].every((file) => file.path.endsWith('.png'))).toBe(true);
        const all = await filePage(context.request, sourceId, { q: 'Paged', limit: '500' });
        expect(all.total).toBe(610);
        const later = await filePage(context.request, sourceId, { q: 'Paged', limit: '500', cursor: all.nextCursor! });
        expect(new Set([...all.files, ...later.files].map((file) => file.path)).size).toBe(610);
        const empty = await filePage(context.request, sourceId, { q: 'empty', type: 'directory' });
        expect(empty.files.map((file) => file.path)).toContain(`${deepDirectory}/empty`);
        const changed = await context.request.get(`/api/files/list?${new URLSearchParams({ workspaceId: sourceId, q: 'other', cursor: media.nextCursor! })}`);
        expect(changed.status()).toBe(409);
        for (const [endpoint, query, expectedPath, collection] of [
          ['files', 'deep-reference', deepImage, 'items'], ['notebook', 'deep-note', deepNote, 'items'],
        ]) {
          const response = await context.request.get(`/api/mobile/v1/${endpoint}?${new URLSearchParams({ workspaceId: sourceId, query })}`);
          expect(response.status()).toBe(200);
          const payload = await response.json();
          expect(payload[collection].map((entry: { path: string }) => entry.path)).toContain(expectedPath);
        }
      });

      await context.addInitScript((workspaceId) => {
        if (!sessionStorage.getItem('discovery-initialized')) {
          localStorage.setItem('canvas.activeWorkspaceId', workspaceId);
          sessionStorage.setItem('discovery-initialized', 'true');
        }
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
        localStorage.setItem('canvas-browser-mode', 'list');
      }, targetId);
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto('/en/notebook');
      if (profile.mobile) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
      await expect(page.locator('[data-file-path="target-marker.txt"]').first()).toBeVisible();
      await page.goto('/en/studio/models/new');
      await page.getByRole('button', { name: 'Add images', exact: true }).click();
      const dialog = await openWorkspacePicker(page, sourceId);
      await test.step('Browse 18 levels using shallow directory requests', async () => {
        for (const folder of folders) {
          const button = dialog.getByRole('button', { name: folder, exact: true });
          await button.click();
          await expect(button).toHaveAttribute('aria-expanded', 'true');
        }
        await dialog.getByText('deep-reference 1.png', { exact: true }).click();
      });
      await test.step('Load the second media page while retaining a deep selection', async () => {
        const search = dialog.getByPlaceholder('Search workspace files...');
        await search.fill('Paged');
        await expect(dialog.getByText('100 of 105 results', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Load more results', exact: true }).click();
        await expect(dialog.getByText('105 of 105 results', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: /Paged-zz-image-104\.png/u }).click();
        await search.fill('deep-reference');
        await expect(dialog.getByText('1 of 1 results', { exact: true })).toBeVisible();
        await expect(dialog.getByText('deep-reference 1.png', { exact: true })).toBeVisible();
        expect((await search.boundingBox())!.width, 'The search input remains usable in the narrow dialog.').toBeGreaterThan(120);
        const bounds = await dialog.boundingBox();
        expect(bounds).toBeTruthy();
        expect(bounds!.x).toBeGreaterThanOrEqual(-1);
        expect(bounds!.y).toBeGreaterThanOrEqual(-1);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(profile.viewport.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(profile.viewport.height + 1);
        await dialog.screenshot({ path: info.outputPath(`${profile.name}-picker.png`), animations: 'disabled' });
        await dialog.getByRole('button', { name: 'Add references', exact: true }).click();
        await expect(page.locator('img[src^="blob:"]')).toHaveCount(2);
        for (const image of await page.locator('img[src^="blob:"]').all()) await expectImageLoaded(image);
      });
      await test.step('Save and update a model in the target workspace', async () => {
        await page.getByPlaceholder('e.g. My Product').fill(`Discovery ${profile.name}`);
        const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/studio/products'
          && response.request().method() === 'POST');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        const receipt = await created;
        expect(receipt.status()).toBe(201);
        expect(receipt.request().headers()['x-canvas-workspace-id']).toBe(targetId);
        productId = (await receipt.json()).product.id;
        await expect(page).toHaveURL(new RegExp(`/studio/models/${productId}`));
        const saved = await context.request.get(`/api/studio/products/${productId}`, { headers: { 'x-canvas-workspace-id': targetId! } });
        const product = (await saved.json()).product;
        expect(product.images).toHaveLength(2);
        expect(product.images.map((image: { fileName: string }) => image.fileName)).toContain('deep-reference 1.png');
        await page.getByRole('button', { name: 'Add images', exact: true }).click();
        const existingPicker = await openWorkspacePicker(page, sourceId);
        await existingPicker.getByPlaceholder('Search workspace files...').fill('deep-reference');
        await existingPicker.getByText(deepImage, { exact: true }).click();
        const added = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/studio/products/${productId}/images`
          && response.request().method() === 'POST');
        await existingPicker.getByRole('button', { name: 'Add references', exact: true }).click();
        expect((await added).status()).toBe(201);
        const updated = await context.request.get(`/api/studio/products/${productId}`, { headers: { 'x-canvas-workspace-id': targetId! } });
        expect((await updated.json()).product.images).toHaveLength(3);
      });
      await test.step('Resize preserves the selected source workspace', async () => {
        await page.goto('/en/studio/aspect-ratio');
        await page.getByRole('button', { name: 'Select image', exact: true }).click();
        const resizePicker = await openWorkspacePicker(page, sourceId);
        await resizePicker.getByPlaceholder('Search workspace files...').fill('deep-reference');
        await resizePicker.getByText(deepImage, { exact: true }).click();
        await resizePicker.getByRole('button', { name: 'Add references', exact: true }).click();
        await expectImageLoaded(page.locator('img[src*="/api/media/"]').first());
        await expect(page.getByText('The frame is inside the image. The result will be cropped locally without an AI request.', { exact: true })).toBeVisible();
        const preview = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/studio/aspect-ratio/preview'
          && response.request().method() === 'POST');
        await page.getByRole('button', { name: 'Create preview', exact: true }).click();
        const response = await preview;
        expect(response.request().postDataJSON().mode).toBe('crop');
        expect(response.request().headers()['x-canvas-workspace-id']).toBe(targetId);
        expect(response.status()).toBe(201);
        const result = (await response.json()).preview;
        await expect(page.getByRole('img', { name: result.name, exact: true })).toBeVisible();
      });
      await test.step('Explorer exposes all 610 results and the deep image', async () => {
        await page.evaluate((id) => localStorage.setItem('canvas.activeWorkspaceId', id), sourceId);
        await page.goto('/en/notebook');
        if (profile.mobile) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
        const search = page.getByPlaceholder('Search files');
        await search.fill('Paged');
        for (const count of [200, 400, 600]) {
          await expect(page.getByText(`${count} of 610 results`, { exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Load more results', exact: true }).click();
        }
        await expect(page.getByText('610 of 610 results', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Load more results', exact: true })).toBeHidden();
        await search.fill('deep-reference');
        await expect(page.locator(`[data-file-path="${deepImage}"]`).first()).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${profile.name}-explorer.png`), animations: 'disabled' });
      });
    } catch (error) {
      primaryError = error;
      for (const page of context.pages()) {
        await page.screenshot({ path: info.outputPath(`${profile.name}-failure.png`), animations: 'disabled' }).catch(() => undefined);
      }
    }
    finally {
      for (const page of context.pages()) {
        try { await page.close(); } catch (error) { cleanupErrors.push(error); }
      }
      if (productId && targetId) {
        try {
          const deleted = await context.request.delete(`/api/studio/products/${productId}`, { headers: { 'x-canvas-workspace-id': targetId } });
          expect(deleted.status()).toBe(200);
        } catch (error) { cleanupErrors.push(error); }
      }
      for (const workspace of owned.reverse()) {
        try {
          const response = await context.request.get('/api/workspaces');
          expect(response.status()).toBe(200);
          const workspaces = (await response.json()).workspaces;
          expect(workspaces.find((entry: { id: string }) => entry.id === workspace.id)).toMatchObject({
            id: workspace.id, name: workspace.name, type: 'personal', permissions: { canManageWorkspace: true },
          });
          const deleted = await context.request.delete(`/api/workspaces/${workspace.id}`);
          expect(deleted.status()).toBe(200);
        } catch (error) { cleanupErrors.push(error); }
      }
      try { await context.close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, 'Discovery fixture cleanup failed.');
    if (primaryError) throw primaryError;
  });
}
