import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('a known tab reopens after the first collaboration session was interrupted', async ({ page }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(60_000);
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const filePath = `editor-first-session-${randomUUID()}.md`;
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('First session remains recoverable.'),
  } } })).ok()).toBe(true);
  const sessionRoute = '**/api/files/collaboration/session';
  let attempts = 0;
  await page.route(sessionRoute, route => { attempts++; return route.abort(); });
  try {
    await page.goto(`/notebook?path=${filePath}`);
    await expect.poll(() => attempts).toBeGreaterThan(0);
    const metadata = (await (await page.request.get('/api/files/read', { headers, params: { path: filePath } })).json()).data;
    const documentId = metadata.collaboration.document.id;
    const pending = await page.request.get('/api/files/collaboration/location', {
      headers, params: { workspaceId: workspace.id, documentId },
    });
    expect(pending.status()).toBe(200);
    expect(await pending.json()).toMatchObject({ documentId, path: filePath, lifecycleGeneration: null, representation: null });
    await page.unroute(sessionRoute);
    await page.reload();
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toHaveText('First session remains recoverable.');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Reopened.');
    await expect(page.getByTestId('markdown-save-state')).toContainText('File checkpoint current');
    const initialized = await page.request.get('/api/files/collaboration/location', {
      headers, params: { workspaceId: workspace.id, documentId },
    });
    expect(await initialized.json()).toMatchObject({ documentId, path: filePath, lifecycleGeneration: 1, representation: 'tiptap_blocks' });
    await page.reload();
    await expect(editor).toHaveText('First session remains recoverable. Reopened.', { timeout: 30_000 });
  } finally {
    await page.close();
    await page.request.delete('/api/files/delete', { headers, data: { path: filePath } });
  }
});
