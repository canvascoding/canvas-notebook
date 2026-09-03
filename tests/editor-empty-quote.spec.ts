import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('empty slash quote checkpoints and survives editing, undo, and reload', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(120_000);
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: {
      email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  expect(response.ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  expect(workspace).toBeTruthy();
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const path = `editor-empty-quote-${randomUUID()}.md`;
  await page.addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  expect((await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } })).ok()).toBe(true);
  const readContent = async () => {
    const result = await page.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers });
    return (await result.json()).data?.content as string;
  };
  try {
    await page.goto(`/notebook?path=${encodeURIComponent(path)}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 45_000 });
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.click();
    await page.keyboard.type('/quote');
    await expect(page.locator('.tiptap-slash-command')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(editor.locator('blockquote')).toHaveCount(1);
    await expect.poll(readContent, { timeout: 20_000 }).toMatch(/^>\s*$/u);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await page.screenshot({ path: info.outputPath('empty-quote-saved.png') });
    await page.keyboard.type('A quotation');
    await expect.poll(readContent).toContain('> A quotation');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('blockquote')).toHaveText('');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(editor.locator('blockquote')).toHaveText('A quotation');
    await editor.locator('blockquote p').click();
    await page.keyboard.press('ControlOrMeta+ArrowRight');
    await expect.poll(() => editor.evaluate(() => getSelection()?.anchorOffset)).toBe('A quotation'.length);
    for (let index = 0; index < 'A quotation'.length; index += 1) await page.keyboard.press('Backspace');
    await expect(editor.locator('blockquote')).toHaveText('');
    await expect.poll(readContent).toMatch(/^>\s*$/u);
    await page.reload();
    await expect(editor.locator('blockquote')).toHaveCount(1, { timeout: 30_000 });
    await expect(editor.locator('blockquote')).toHaveText('');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(page.getByText(/roundtrip_unstable/)).toHaveCount(0);
    const fit = await editor.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    });
    expect(fit).toBe(true);
    await page.screenshot({ path: info.outputPath('empty-quote-reopened.png') });
  } finally {
    await page.goto('about:blank');
    await page.request.delete('/api/files/delete', { headers, data: { path } });
  }
});
