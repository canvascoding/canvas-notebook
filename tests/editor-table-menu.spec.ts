import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';

test('table menu moves rows and columns and checkpoints aligned inserted rows', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const path = `editor-table-${randomUUID()}.md`;
  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } });
  const original = await (await page.request.get(`/api/mobile/v1/notebook/document?path=${path}`, { headers })).json();
  const content = serializeRichMarkdownBody('| A | B |\n| --- | --- |\n| one | two |\n| three | four |');
  expect((await page.request.put('/api/mobile/v1/notebook/document', { headers, data: {
    path, content, expectedSha256: original.document.sha256, baseRevisionId: original.document.revisionId,
  } })).ok()).toBe(true);
  try {
    await page.goto(`/notebook?path=${path}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    const menu = page.getByTestId('markdown-table-menu');
    await editor.getByText('one', { exact: true }).click();
    await menu.getByRole('button', { name: 'Row 2', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move row down', exact: true }).click();
    await expect(editor.locator('tr').nth(2)).toHaveText('onetwo');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('tr').nth(1)).toHaveText('onetwo');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(editor.locator('tr').nth(2)).toHaveText('onetwo');
    await editor.getByText('one', { exact: true }).click();
    await menu.getByRole('button', { name: 'Column 1', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move column right', exact: true }).click();
    await expect(editor.locator('tr').first()).toHaveText('BA');
    await editor.getByText('one', { exact: true }).click();
    await menu.getByRole('button', { name: 'Column alignment' }).click();
    await page.getByRole('menuitem', { name: 'Align center', exact: true }).click();
    await menu.getByRole('button', { name: 'Row 3', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add row after', exact: true }).click();
    await expect(editor.locator('tr')).toHaveCount(4);
    const read = async () => (await (await page.request.get(`/api/files/read?path=${path}`, { headers })).json()).data?.content as string;
    await expect.poll(read, { timeout: 20_000 }).toContain(':-----:');
    await expect(page.getByRole('status').filter({ hasText: 'File checkpoint current' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('table-context-menu.png') });
    await page.reload();
    await expect(editor.locator('tr')).toHaveCount(4, { timeout: 30_000 });
    await expect(editor.locator('tr').first()).toHaveText('BA');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    for (let row = 0; row < 4; row++) await expect(editor.locator('tr').nth(row).locator('th,td').nth(1)).toHaveCSS('text-align', 'center');
    // Deleting a header promotes the next row in the same transaction.
    await editor.getByText('B', { exact: true }).click();
    await menu.getByRole('button', { name: 'Row 1', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete row', exact: true }).click();
    await expect(editor.locator('tr').first().locator('th')).toHaveCount(2);
    await expect.poll(read).not.toContain('| B');
    await expect(page.getByRole('status').filter({ hasText: 'File checkpoint current' })).toBeVisible();
  } finally {
    await page.close();
    await page.request.delete('/api/files/delete', { headers, data: { path } });
  }
});
