import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.use({ hasTouch: true });

test('selection formatting preserves its range through pointer, keyboard and link dialog actions', async ({ page }, info) => {
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
  const path = `editor-selection-${randomUUID()}.md`;
  await page.addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } });
  try {
    await page.goto(`/notebook?path=${encodeURIComponent(path)}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    await editor.click();
    await page.keyboard.type('Alpha bravo charlie.');
    await page.keyboard.press('ControlOrMeta+ArrowLeft');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => editor.evaluate(() => getSelection()?.toString())).toBe('Alpha');
    const menu = page.getByTestId('markdown-selection-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText('Alpha');
    await page.screenshot({ path: info.outputPath('selection-menu.png') });
    await page.keyboard.press('Alt+F10');
    await expect(menu.getByRole('button', { name: 'Bold', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(menu.getByRole('button', { name: 'Italic', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor.locator('em')).toHaveText('Alpha');
    await menu.getByRole('button', { name: 'Link', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Web link' }).click();
    await dialog.getByLabel('URL', { exact: true }).fill('https://example.com/selected');
    await dialog.getByRole('button', { name: 'Apply link' }).click();
    await expect(editor.locator('a[href="https://example.com/selected"]')).toHaveText('Alpha');
    await expect(editor).toHaveText('Alpha bravo charlie.');
    const read = async () => (await (await page.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers })).json()).data?.content;
    await expect.poll(read).toContain('https://example.com/selected');
    await page.screenshot({ path: info.outputPath('selection-formatting.png') });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor.locator('a[href="https://example.com/selected"]')).toHaveText('Alpha');
    // The same commands work in a narrow touch viewport without opening a second editor.
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.locator('p').first().click();
    await page.keyboard.press('ControlOrMeta+ArrowLeft');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
    const touchButton = await menu.getByRole('button', { name: 'Italic', exact: true }).boundingBox();
    expect(touchButton).toBeTruthy();
    await page.touchscreen.tap(touchButton!.x + touchButton!.width / 2, touchButton!.y + touchButton!.height / 2);
    await expect(editor.locator('em')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('selection-touch.png') });
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
    await page.request.delete('/api/files/delete', { headers, data: { path } });
  }
});
