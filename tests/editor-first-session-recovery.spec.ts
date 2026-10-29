import { expect, request, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownedCollaborationQaEnabled, requireOwnedCollaborationQaTarget } from '../scripts/lib/owned-collaboration-qa';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { authenticateManagedTestPage, uploadWorkspaceTextFile } from './helpers/managed-test-context';

test('a known tab reopens after the first collaboration session was interrupted', async ({ page }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  if (process.env.CANVAS_YJS_AUTHORITY_E2E === '1') await requireOwnedYjsQaTarget();
  else if (ownedCollaborationQaEnabled()) await requireOwnedCollaborationQaTarget();
  await authenticateManagedTestPage(page);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  expect(workspace?.id).toBeTruthy();
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const filePath = `editor-first-session-${randomUUID()}.md`;
  const cleanupApi = await request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000',
    storageState: await page.context().storageState(), timeout: 15_000 });
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  const sessionRoute = '**/api/files/collaboration/session';
  let attempts = 0;
  let failure: unknown;
  await page.route(sessionRoute, route => { attempts++; return route.abort(); });
  try {
    await uploadWorkspaceTextFile({ request: page.request, workspaceId: workspace.id,
      filePath, content: 'First session remains recoverable.' });
    // A completed native upload owns its initial state before any browser session.
    const originalRead = await page.request.get('/api/files/read', { headers, params: { path: filePath } });
    expect(originalRead.status()).toBe(200);
    const originalMetadata = (await originalRead.json()).data;
    expect(originalMetadata.content).toBe('First session remains recoverable.');
    const originalDocumentId = originalMetadata.collaboration.document.id;
    expect(originalDocumentId).toBeTruthy();
    const originalIdentity = { documentId: originalDocumentId, path: filePath,
      lifecycleGeneration: 1, representation: 'tiptap_blocks' };
    const originalLocation = await page.request.get('/api/files/collaboration/location', {
      headers, params: { workspaceId: workspace.id, documentId: originalDocumentId },
    });
    expect(originalLocation.status()).toBe(200);
    expect(await originalLocation.json()).toMatchObject(originalIdentity);
    await page.goto(`/notebook?path=${filePath}`);
    await expect.poll(() => attempts).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: /^(Read|Lesen|Edit|Bearbeiten)$/u })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /The document could not be opened|Das Dokument konnte nicht geöffnet werden/u })).toBeVisible();
    const retry = page.getByRole('button', { name: /^(Reload|Neu laden)$/u });
    await expect(retry).toBeVisible();
    await expect(page.locator('.tiptap-editor-shell .ProseMirror[contenteditable="true"]')).toHaveCount(0);
    const metadata = (await (await page.request.get('/api/files/read', { headers, params: { path: filePath } })).json()).data;
    const documentId = metadata.collaboration.document.id;
    expect(documentId).toBe(originalDocumentId);
    const pending = await page.request.get('/api/files/collaboration/location', {
      headers, params: { workspaceId: workspace.id, documentId },
    });
    expect(pending.status()).toBe(200);
    expect(await pending.json()).toMatchObject(originalIdentity);
    const failedAttempts = attempts;
    await page.unroute(sessionRoute);
    const admitted = page.waitForResponse(response => response.url().endsWith('/api/files/collaboration/session')
      && response.request().method() === 'POST' && response.status() === 200);
    await retry.click();
    const session = await (await admitted).json();
    expect(session).toMatchObject({ documentId: originalDocumentId, lifecycleGeneration: originalIdentity.lifecycleGeneration,
      representation: originalIdentity.representation, permission: 'write' });
    expect(failedAttempts).toBeGreaterThan(0);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^(Read|Lesen|Edit|Bearbeiten|Source|Quelltext)$/u })).toHaveCount(0);
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
    expect(await initialized.json()).toMatchObject(originalIdentity);
    await page.reload();
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    await expect(editor).toHaveText('First session remains recoverable. Reopened.', { timeout: 30_000 });
    const reopened = await page.request.get('/api/files/collaboration/location', {
      headers, params: { workspaceId: workspace.id, documentId },
    });
    expect(await reopened.json()).toMatchObject(originalIdentity);
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
