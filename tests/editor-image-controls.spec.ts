import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('image size and alignment checkpoint, undo, reload and render in Read mode', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const path = `editor-image-${randomUUID()}.md`;
  const asset = `editor-image-${randomUUID()}.svg`;
  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: asset, mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#729b91"/><circle cx="240" cy="120" r="64" fill="#f7ead3"/></svg>'),
  } } })).ok()).toBe(true);
  await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } });
  const original = await (await page.request.get(`/api/mobile/v1/notebook/document?path=${path}`, { headers })).json();
  expect((await page.request.put('/api/mobile/v1/notebook/document', { headers, data: {
    path, content: `# Image check\n\n![Diagram](${asset})`, expectedSha256: original.document.sha256, baseRevisionId: original.document.revisionId,
  } })).ok()).toBe(true);
  const read = async () => (await (await page.request.get(`/api/files/read?path=${path}`, { headers })).json()).data?.content as string;
  try {
    await page.goto(`/notebook?path=${path}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    const image = editor.getByRole('img', { name: 'Diagram', exact: true });
    await image.click();
    const toolbar = page.getByRole('toolbar', { name: 'Image tools' });
    await toolbar.getByRole('spinbutton', { name: 'Image width' }).fill('240');
    await toolbar.getByRole('spinbutton', { name: 'Image width' }).press('Enter');
    await toolbar.getByRole('button', { name: 'Center image', exact: true }).click();
    await expect.poll(read).toContain('width="240"');
    await expect.poll(read).toContain('margin-left:auto;margin-right:auto');
    await expect(image).toHaveCSS('width', '240px');
    const handle = page.getByTestId('image-resize-handle');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + 12); await page.mouse.down();
    await page.mouse.move(box.x + 76, box.y + 12, { steps: 5 });
    // The preview must not write intermediate pointer positions to the document.
    expect(await read()).toContain('width="240"');
    await page.mouse.up();
    await expect.poll(read).toContain('width="304"');
    await image.click(); await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(read).toContain('width="240"');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(read).toContain('width="304"');
    await expect(page.getByRole('status').filter({ hasText: 'File checkpoint current' })).toBeVisible();
    await page.reload();
    await expect(image).toHaveCSS('width', '304px', { timeout: 30_000 });
    await image.click();
    await page.screenshot({ path: info.outputPath('image-controls.png') });
    const cancelBox = (await handle.boundingBox())!;
    await page.mouse.move(cancelBox.x + 12, cancelBox.y + 12); await page.mouse.down();
    await page.mouse.move(cancelBox.x + 60, cancelBox.y + 12);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(image).toHaveCSS('width', '304px');
    expect(await read()).toContain('width="304"');

    await page.getByRole('button', { name: 'Read', exact: true }).click();
    const readImage = page.getByRole('img', { name: 'Diagram', exact: true });
    await expect(readImage).toHaveCSS('width', '304px');
    await expect(page.getByRole('toolbar', { name: 'Image tools' })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await readImage.boundingBox())!.width).toBeLessThanOrEqual(390);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
    for (const file of [path, asset]) await page.request.delete('/api/files/delete', { headers, data: { path: file } });
  }
});
