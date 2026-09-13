import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Editor } from '@tiptap/core';

test('mobile HTTP edit survives export failure and retries without replacing later peer edits', async ({ browser }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || !process.env.DATA, 'Requires the managed local stack.');
  test.setTimeout(90_000);
  const baseURL = process.env.BASE_URL!;
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const folder = `mobile-save-recovery-${randomUUID()}`;
  const filePath = `${folder}/document.md`;
  let directory = '';
  let originalMode: number | undefined;
  let headers: Record<string, string> = {};
  try {
    const login = await page.request.post('/api/auth/sign-in/email', { headers: { Origin: baseURL },
      data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD } });
    expect(login.ok()).toBe(true);
    const workspaces = await (await page.request.get('/api/workspaces')).json();
    const workspace = workspaces.workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
    expect(workspace.rootRelativePath.split(/[\\/]/u)).not.toContain('..');
    expect(path.isAbsolute(workspace.rootRelativePath)).toBe(false);
    headers = { 'x-canvas-workspace-id': workspace.id };
    expect((await page.request.post('/api/files/create', { headers, data: { path: folder, type: 'directory' } })).ok()).toBe(true);
    directory = path.resolve(process.env.DATA!, workspace.rootRelativePath, folder);
    originalMode = (await stat(directory)).mode & 0o777;
    expect((await page.request.post('/api/files/upload', { headers, multipart: { path: folder,
      files: { name: 'document.md', mimeType: 'text/markdown', buffer: Buffer.from('First\n\nKeep\n') } } })).ok()).toBe(true);
    await context.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
    await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`);
    await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    const read = async () => {
      const response = await page.request.get(`/api/mobile/v1/notebook/document?path=${encodeURIComponent(filePath)}`, { headers });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()).document;
    };
    const base = await read();
    const request = { path: filePath, content: 'Changed\n\nKeep', expectedSha256: base.sha256,
      baseRevisionId: base.revisionId, idempotencyKey: randomUUID() };
    // Only our newly created fixture directory is made unwritable. Yjs remains
    // available in PostgreSQL while the ordinary Markdown writer fails.
    await chmod(directory, 0o555);
    const saved = await page.request.put('/api/mobile/v1/notebook/document', { headers, data: request });
    expect(saved.ok(), await saved.text()).toBe(true);
    const firstReceipt = (await saved.json()).document.saveReceipt;
    expect(firstReceipt).toMatchObject({ applied: true, durable: true, projectionPending: true });
    await expect(editor).toContainText('Changed');
    await editor.evaluate(element => {
      const instance = (element as HTMLElement & { editor: Editor }).editor;
      const first = instance.state.doc.firstChild!;
      instance.commands.deleteRange({ from: 0, to: first.nodeSize });
      instance.commands.insertContentAt(1, 'Peer ');
    });
    await expect.poll(async () => (await read()).content).toBe('Peer Keep');
    const retry = await page.request.put('/api/mobile/v1/notebook/document', { headers, data: request });
    expect(retry.ok(), await retry.text()).toBe(true);
    const retried = (await retry.json()).document;
    expect(retried.saveReceipt.operationId).toBe(firstReceipt.operationId);
    expect(retried.content).toBe('Peer Keep');
    expect(retried.saveReceipt.durable).toBe(true);
    const conflict = await page.request.put('/api/mobile/v1/notebook/document', {
      headers, data: { ...request, content: 'Different edit using the same key' },
    });
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
    // Legacy clients also receive a stable operation identity without a key.
    const latest = await read();
    const legacy = { path: filePath, content: 'Legacy\n\nPeer Keep', expectedSha256: latest.sha256, baseRevisionId: latest.revisionId };
    const once = await page.request.put('/api/mobile/v1/notebook/document', { headers, data: legacy });
    expect(once.ok(), await once.text()).toBe(true);
    const twice = await page.request.put('/api/mobile/v1/notebook/document', { headers, data: legacy });
    expect(twice.ok(), await twice.text()).toBe(true);
    expect((await twice.json()).document.saveReceipt.operationId).toBe((await once.json()).document.saveReceipt.operationId);
    await chmod(directory, originalMode);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await page.screenshot({ path: test.info().outputPath('mobile-save-export-failure.png') });
  } finally {
    if (directory && originalMode !== undefined) await chmod(directory, originalMode);
    if (headers['x-canvas-workspace-id']) await page.request.delete('/api/files/delete', { headers, data: { path: folder } });
    await context.close();
  }
});
