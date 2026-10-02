import { expect, request, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('a known tab reopens after the first collaboration session was interrupted', async ({ page }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const filePath = `editor-first-session-${randomUUID()}.md`;
  const cleanupApi = await request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000',
    storageState: await page.context().storageState(), timeout: 15_000 });
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('First session remains recoverable.'),
  } } })).ok()).toBe(true);
  const sessionRoute = '**/api/files/collaboration/session';
  let attempts = 0;
  let failure: unknown;
  await page.route(sessionRoute, route => { attempts++; return route.abort(); });
  try {
    await page.goto(`/notebook?path=${filePath}`);
    const documentModes = page.getByRole('group', { name: /Document view|Dokumentansicht/u });
    await expect.poll(async () => attempts > 0 || await documentModes.isVisible()).toBe(true);
    if (attempts === 0) await documentModes.getByRole('button', { name: /^(Edit|Bearbeiten)$/u }).click({ timeout: 15_000 });
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
    await documentModes.getByRole('button', { name: /^(Edit|Bearbeiten)$/u }).click();
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    await expect(editor).toHaveText('First session remains recoverable.');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Reopened.');
    await expect.poll(async () => (await (await page.request.get('/api/files/read', {
      headers, params: { path: filePath },
    })).json()).data?.content?.trim(), { timeout: 20_000 }).toBe('First session remains recoverable. Reopened.');
    await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
    const initialized = await page.request.get('/api/files/collaboration/location', {
      headers, params: { workspaceId: workspace.id, documentId },
    });
    expect(await initialized.json()).toMatchObject({ documentId, path: filePath, lifecycleGeneration: 1, representation: 'tiptap_blocks' });
    await page.reload();
    await expect(editor).toHaveText('First session remains recoverable. Reopened.', { timeout: 30_000 });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const action of [
      async () => { if (!page.isClosed()) await page.close(); },
      async () => {
        const deleted = await cleanupApi.delete('/api/files/delete', { headers, data: { path: filePath } });
        const payload = await deleted.json();
        expect(deleted.status(), `Cleanup delete (${String(payload.code ?? '')})`).toBe(200);
        expect(payload).toMatchObject({ success: true, deleted: [filePath], failed: [] });
      },
      () => cleanupApi.dispose(),
    ]) {
      try { await action(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      if (failure) for (const error of cleanupErrors) console.error('First-session fixture cleanup failed:', error);
      else throw new AggregateError(cleanupErrors, 'First-session fixture cleanup failed.');
    }
  }
});
