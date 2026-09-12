import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

for (const block of ['paragraph', 'code'] as const) {
test(`mobile ${block} moves retain the menu anchor and remain editable after undo`, async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(60_000);
  info.annotations.push({ type: 'input-scope', description: 'Touch viewport and reduced content area are emulated; no native OS keyboard or IME claim.' });
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const filePath = `editor-mobile-moves-${randomUUID()}.md`;
  await page.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: filePath, mimeType: 'text/markdown', buffer: Buffer.from(
      block === 'code' ? 'Alpha\n\n```text\nBravo\n```\n\nCharlie' : 'Alpha\n\nBravo\n\nCharlie',
    ),
  } } })).ok()).toBe(true);
  try {
    await page.goto(`/notebook?path=${filePath}`);
    await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).tap();
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    // The development badge overlaps the first mobile control; hide it through
    // its own UI. Production has no badge. Do not change application styles.
    const devTools = page.getByRole('button', { name: 'Open Next.js Dev Tools', exact: true });
    if (await devTools.count()) {
      await devTools.click();
      await page.getByText('Preferences', { exact: true }).click();
      await page.getByRole('button', { name: 'Hide', exact: true }).click();
    }
    const order = () => editor.evaluate(element => (element as HTMLElement & {
      editor: { getJSON(): { content: unknown[] } };
    }).editor.getJSON().content);
    const initial = await order();
    await editor.getByText('Bravo', { exact: true }).tap();
    // Model the reduced content area, not an operating-system IME.
    await page.setViewportSize({ width: 390, height: 544 });
    const trigger = page.getByTestId('markdown-mobile-move-block');
    await trigger.tap();
    // Exceed the toolbar's one-second pointer-interaction grace period.
    await page.waitForTimeout(1_200);
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box?.width).toBe(40);
    await page.screenshot({ path: info.outputPath('mobile-block-menu.png') });
    await page.getByRole('menuitem', { name: /^Move block up/ }).tap();
    await expect.poll(order).toEqual([initial[1], initial[0], initial[2]]);
    await page.getByRole('button', { name: 'Undo', exact: true }).filter({ visible: true }).tap();
    await expect.poll(order).toEqual(initial);
    await page.getByRole('button', { name: 'Redo', exact: true }).filter({ visible: true }).tap();
    await expect.poll(order).toEqual([initial[1], initial[0], initial[2]]);
    await page.getByRole('button', { name: 'Undo', exact: true }).filter({ visible: true }).tap();
    await expect.poll(order).toEqual(initial);
    await trigger.tap();
    await page.waitForTimeout(1_200);
    await page.getByRole('menuitem', { name: /^Move block down/ }).tap();
    await expect.poll(order).toEqual([initial[0], initial[2], initial[1]]);
    if (block === 'code') {
      await editor.locator('pre').tap();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('Delta');
      await expect(editor.locator('pre')).toHaveText('Bravo\nDelta');
      await page.keyboard.press('Backspace');
      await expect(editor.locator('pre')).toHaveText('Bravo\nDelt');
    } else {
      await editor.getByText('Bravo', { exact: true }).tap();
      await page.keyboard.press('End');
      await page.keyboard.insertText(' Delta');
      await page.keyboard.press('Backspace');
      await expect(editor.getByText('Bravo Delt', { exact: true })).toBeVisible();
    }
    await expect.poll(async () => (await (await page.request.get('/api/files/read', {
      headers, params: { path: filePath },
    })).json()).data?.content?.trim(), { timeout: 20_000 }).toBe(block === 'code'
      ? 'Alpha\n\nCharlie\n\n```text\nBravo\nDelt\n```' : 'Alpha\n\nCharlie\n\nBravo Delt');
    await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
  } finally {
    await page.close();
    await page.request.delete('/api/files/delete', { headers, data: { path: filePath } });
  }
});
}

test('mobile list and table deletion keep structure, history and focus during background persistence', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(60_000);
  info.annotations.push({ type: 'input-scope', description: 'Touch and DOM selection with browser keyboard events; native iPhone IME remains outside this test.' });
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  expect(workspace?.id).toBeTruthy();
  const headers = { 'x-canvas-workspace-id': workspace.id };
  await page.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  const filePath = `editor-mobile-delete-${randomUUID()}.md`;
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: filePath, mimeType: 'text/markdown', buffer: Buffer.from('- **One** two\n- Three\n\n| Name | Value |\n| --- | --- |\n| A | Cell value |'),
  } } })).ok()).toBe(true);
  try {
    await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).tap();
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    const tree = () => editor.evaluate(element => (element as HTMLElement & { editor: { getJSON(): unknown } }).editor.getJSON());
    const initial = await tree();
    const word = editor.locator('strong').filter({ hasText: /^One$/ });
    await word.tap();
    await word.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.press('Backspace');
    await expect(editor.locator('li').first()).toHaveText(' two');
    const afterList = await tree();
    await page.keyboard.press('ControlOrMeta+z'); await expect.poll(tree).toEqual(initial);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect.poll(tree).toEqual(afterList);
    const cell = editor.locator('td').last();
    await cell.tap();
    await cell.evaluate(element => {
      const paragraph = element.querySelector('p')!;
      const range = document.createRange(); range.selectNodeContents(paragraph);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.press('Backspace'); await expect(cell).toHaveText('');
    const afterCell = await tree();
    await page.keyboard.press('ControlOrMeta+z'); await expect.poll(tree).toEqual(afterList);
    await page.keyboard.press('ControlOrMeta+Shift+z'); await expect.poll(tree).toEqual(afterCell);
    const layout = () => editor.evaluate(element => {
      let scroll: HTMLElement | null = element.parentElement;
      while (scroll && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
      return { top: element.getBoundingClientRect().top, scrollTop: scroll?.scrollTop ?? 0,
        focused: element.contains(document.activeElement) || document.activeElement === element };
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const beforeBackground = await layout();
    await expect.poll(async () => (await (await page.request.get('/api/files/read', { headers, params: { path: filePath } })).json()).data?.content,
      { timeout: 20_000 }).not.toContain('Cell value');
    expect(await layout()).toEqual(beforeBackground);
    expect(beforeBackground.focused).toBe(true);
    await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('mobile-list-table-delete.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).tap();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect.poll(tree).toEqual(afterCell);
  } finally {
    await page.close();
    await page.request.delete('/api/files/delete', { headers, data: { path: filePath } });
  }
});
