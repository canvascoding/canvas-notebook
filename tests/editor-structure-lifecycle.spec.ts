import { expect, test, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { randomUUID } from 'node:crypto';

async function login(page: Page, peer = false) {
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: peer ? process.env.TEST_SECONDARY_EMAIL : process.env.TEST_LOGIN_EMAIL,
      password: peer ? process.env.TEST_SECONDARY_PASSWORD : process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
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
  await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
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

  test('a moved document deep link reopens its identity after the old path is reused', async ({ page }) => {
    const headers = await login(page);
    const oldFolder = `editor-url-lifecycle-${randomUUID()}`;
    const newFolder = `${oldFolder}-moved`;
    expect((await page.request.post('/api/files/create', { headers, data: { path: oldFolder, type: 'directory' } })).ok()).toBe(true);
    await upload(page, headers, oldFolder, 'a.md', 'Original A.');
    await upload(page, headers, oldFolder, 'b.md', 'Original B.');
    try {
      await page.goto(`/notebook?path=${oldFolder}/a.md`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Original A.', { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.goto(`/notebook?path=${oldFolder}/b.md`, { waitUntil: 'domcontentloaded' });
      await editMode(page);
      await expect(page.getByText('Original B.', { exact: true })).toBeVisible({ timeout: 30_000 });
      const before = await tree(page);
      expect((await page.request.post('/api/files/rename', { headers, data: {
        oldPath: oldFolder, newPath: newFolder, updateLinks: false,
      } })).ok()).toBe(true);
      await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe(`${newFolder}/b.md`);
      expect(await tree(page)).toEqual(before);
      expect((await page.request.post('/api/files/create', { headers, data: { path: oldFolder, type: 'directory' } })).ok()).toBe(true);
      await upload(page, headers, oldFolder, 'b.md', 'Replacement at the old path.');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await editMode(page);
      await expect(page.getByText('Original B.', { exact: true })).toBeVisible();
      expect(await tree(page)).toEqual(before);
      await expect(page.getByRole('tab', { name: 'a.md', exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'a.md', exact: true }).click();
      await expect(page.getByText('Original A.', { exact: true })).toBeVisible();
    } finally {
      await page.close();
      await page.request.delete('/api/files/delete', { headers, data: { path: [oldFolder, newFolder] } });
    }
  });
});
