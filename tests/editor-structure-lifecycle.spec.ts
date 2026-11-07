import { expect, test, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { authenticateManagedTestPage, createCompletedWorkspaceMarkdownFile, enterMarkdownEditMode } from './helpers/managed-test-context';
import { deleteOwnedFixtureFiles } from './helpers/owned-fixture-files';
import { completeNativeFixtureRename } from './helpers/completed-native-rename';

async function login(page: Page, peer = false) {
  if (peer) {
    expect(Boolean(process.env.TEST_SECONDARY_EMAIL && process.env.TEST_SECONDARY_PASSWORD)).toBe(true);
    await authenticateManagedTestPage(page, {
      email: process.env.TEST_SECONDARY_EMAIL,
      password: process.env.TEST_SECONDARY_PASSWORD,
    });
  } else {
    await authenticateManagedTestPage(page);
  }
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  expect(workspace?.id).toBeTruthy();
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  return { 'x-canvas-workspace-id': workspace.id as string };
}

async function upload(page: Page, headers: Record<string, string>, path: string, name: string, content: string) {
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path, files: {
    name, mimeType: 'text/markdown', buffer: Buffer.from(content),
  } } })).ok()).toBe(true);
}

async function editMode(page: Page) {
  await enterMarkdownEditMode(page);
  await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
}

async function tree(page: Page): Promise<JSONContent> {
  return page.locator('.tiptap-editor-shell .ProseMirror').evaluate(element =>
    (element as HTMLElement & { editor: { getJSON(): JSONContent } }).editor.getJSON());
}

test.describe('Block and document identity through browser lifecycles', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(90_000);

  for (const deleted of ['source', 'target'] as const) {
    test(`a peer deleting the drag ${deleted} revokes a later native drop`, async ({ page, browser }) => {
      const headers = await login(page);
      const peerContext = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 720 } });
      const peer = await peerContext.newPage();
      expect(await login(peer, true)).toEqual(headers);
      const identities = await Promise.all([page, peer].map(async target =>
        (await (await target.request.get('/api/auth/get-session')).json()).user.id as string));
      expect(identities[0]).toBeTruthy();
      expect(identities[1]).toBeTruthy();
      expect(identities[1]).not.toBe(identities[0]);
      const filePath = `editor-drag-revocation-${randomUUID()}.md`;
      await upload(page, headers, '.', filePath, 'A stays.\n\nB source.\n\nC target.\n\nD stays.');
      try {
        await page.goto(`/notebook?path=${filePath}`, { waitUntil: 'domcontentloaded' });
        await peer.goto(`/notebook?path=${filePath}`, { waitUntil: 'domcontentloaded' });
        await editMode(page); await editMode(peer);
        await expect(page.getByText('B source.', { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(peer.getByText('B source.', { exact: true })).toBeVisible({ timeout: 30_000 });
        const before = await tree(page);
        const deletedId = before.content![deleted === 'source' ? 1 : 2].attrs!.id;
        await page.getByText('B source.', { exact: true }).click();
        const grip = page.locator('.tiptap-block-drag-handle');
        await expect(grip).toBeVisible();
        const sourceBox = (await grip.boundingBox())!;
        const targetBox = (await page.getByText('C target.', { exact: true }).boundingBox())!;
        await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(targetBox.x + 100, targetBox.y + targetBox.height - 2, { steps: 8 });
        await page.mouse.move(targetBox.x + 101, targetBox.y + targetBox.height - 2);
        await expect(page.locator('.tiptap-block-drop-indicator')).toHaveCount(1);
        await peer.getByText(deleted === 'source' ? 'B source.' : 'C target.', { exact: true }).click({ clickCount: 3 });
        await peer.keyboard.press('Backspace');
        await peer.keyboard.press('Backspace');
        await expect(page.locator(`.ProseMirror [data-id="${deletedId}"]`)).toHaveCount(0);
        await expect(page.locator('.tiptap-block-drag-overlay-source')).toHaveCount(0);
        const afterDelete = await tree(page);
        await page.mouse.up();
        await expect.poll(() => tree(page)).toEqual(afterDelete);
        await expect.poll(() => tree(peer)).toEqual(afterDelete);
        await expect.poll(async () => (await (await page.request.get('/api/files/read', {
          headers, params: { path: filePath },
        })).json()).data?.content, { timeout: 20_000 }).not.toContain(deleted === 'source' ? 'B source.' : 'C target.');
        await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await editMode(page);
        await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => tree(page)).toEqual(afterDelete);
      } finally {
        await peerContext.close();
        await page.close();
        await page.request.delete('/api/files/delete', { headers, data: { path: filePath } });
      }
    });
  }

  test('a moved document deep link reopens its identity after the old path is reused', async ({ page }, info) => {
    test.setTimeout(180_000);
    const headers = await login(page);
    const readNativeFile = async (path: string) => {
      const deadline = Date.now() + 5_000;
      for (let attempt = 0; ; attempt++) {
        const response = await page.request.get('/api/files/read', { headers, params: { path },
          timeout: Math.max(1, deadline - Date.now()) });
        const payload = await response.json();
        if (response.status() === 503 && payload.code === 'ROOM_OWNER_BUSY' && attempt < 2 && Date.now() + 250 < deadline) {
          info.annotations.push({ type: 'room-owner-busy-read-retry', description: `${path}: attempt ${attempt + 1}` });
          await wait(250);
          continue;
        }
        expect(response.status(), `Native read (${String(payload.code ?? 'unknown')})`).toBe(200);
        expect(payload.success).toBe(true);
        return payload.data;
      }
    };
    const oldFolder = `editor-url-lifecycle-${randomUUID()}`;
    const newFolder = `${oldFolder}-moved`;
    expect((await page.request.post('/api/files/create', { headers, data: { path: oldFolder, type: 'directory' } })).ok()).toBe(true);
    await upload(page, headers, oldFolder, 'a.md', 'Original A.');
    await upload(page, headers, oldFolder, 'b.md', 'Original B.');
    try {
      await page.goto(`/notebook?path=${oldFolder}/a.md`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Original A.', { exact: true })).toBeVisible({ timeout: 30_000 });
      await editMode(page);
      await expect(page.getByRole('tab', { name: 'a.md', exact: true })).toHaveAttribute('aria-selected', 'true');
      // The URL is an explicit deep-link intent, independent of manual tab
      // selection. Fully admit A before navigating to B's deep link.
      await page.goto(`/notebook?path=${oldFolder}/b.md`, { waitUntil: 'domcontentloaded' });
      await editMode(page);
      await expect(page.getByRole('tab', { name: 'a.md', exact: true })).toBeVisible();
      await expect(page.getByRole('tabpanel', { name: 'b.md', exact: true })).toContainText('Original B.');
      await expect(page.getByText('Original B.', { exact: true })).toBeVisible({ timeout: 30_000 });
      const original = await readNativeFile(`${oldFolder}/b.md`);
      const documentId = original.collaboration.document.id;
      const before = await tree(page);
      await completeNativeFixtureRename(page.request, { workspaceId: headers['x-canvas-workspace-id'], oldPath: oldFolder, newPath: newFolder });
      await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe(`${newFolder}/b.md`);
      expect(await tree(page)).toEqual(before);
      expect((await page.request.post('/api/files/create', { headers, data: { path: oldFolder, type: 'directory' } })).ok()).toBe(true);
      await createCompletedWorkspaceMarkdownFile({ request: page.request, workspaceId: headers['x-canvas-workspace-id'], filePath: `${oldFolder}/b.md` });
      const replacement = (await (await page.request.get('/api/mobile/v1/notebook/document', { headers, params: { path: `${oldFolder}/b.md` } })).json()).document;
      const replacementSave = Object.freeze({ path: `${oldFolder}/b.md`, content: 'Replacement at the old path.',
        expectedSha256: replacement.sha256, baseRevisionId: replacement.revisionId, idempotencyKey: randomUUID() });
      let appliedOperation: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await page.request.put('/api/mobile/v1/notebook/document', { headers, data: replacementSave });
        const result = await response.json();
        if (response.ok()) {
          expect(response.status()).toBe(200); expect(result.success).toBe(true);
          expect(result.document.saveReceipt).toMatchObject({ applied: true, durable: true, operationId: expect.any(String) });
          appliedOperation = result.document.saveReceipt.operationId;
          break;
        }
        // Recover only the named admission denial with this exact original
        // version, body and key. Unknown HTTP/transport failures stay failures.
        expect(response.status(), `Mobile save (${String(result.code ?? 'unknown')})`).toBe(503);
        expect(result).toMatchObject({ success: false, code: 'COLLABORATION_BUSY' });
        expect(attempt, 'Mobile admission must settle within the fixed recovery budget.').toBeLessThan(2);
        info.annotations.push({ type: 'mobile-admission-same-request', description: `Explicit original-operation recovery ${attempt + 1}/2` });
        await wait(250);
      }
      expect(appliedOperation).toEqual(expect.any(String));
      const replaced = await readNativeFile(`${oldFolder}/b.md`);
      expect(replaced.collaboration.document.id).not.toBe(documentId);
      expect(replaced.content).toBe('Replacement at the old path.');
      await expect(page.getByRole('tab', { name: 'a.md', exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'a.md', exact: true }).click();
      await expect(page.getByText('Original A.', { exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'a.md', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: 'a.md', exact: true }).locator('..')).toHaveAttribute('title', `${newFolder}/a.md`);
      await expect(page.getByRole('tabpanel', { name: 'a.md', exact: true })).toContainText('Original A.');
      // Manual tab selection preserves the explicit, already relocated B deep link.
      expect(new URL(page.url()).searchParams.get('path')).toBe(`${newFolder}/b.md`);
      await page.getByRole('tab', { name: 'b.md', exact: true }).click();
      await expect(page.getByText('Original B.', { exact: true })).toBeVisible();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await editMode(page);
      await expect(page.getByText('Original B.', { exact: true })).toBeVisible();
      expect(await tree(page)).toEqual(before);
      const reopened = await readNativeFile(`${newFolder}/b.md`);
      expect(reopened.collaboration.document.id).toBe(documentId);
      await expect(page.getByRole('tab', { name: 'a.md', exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'a.md', exact: true }).click();
      await expect(page.getByText('Original A.', { exact: true })).toBeVisible();
    } finally {
      await page.close();
      await deleteOwnedFixtureFiles(page.request, headers['x-canvas-workspace-id'], [oldFolder, newFolder]);
    }
  });
});
