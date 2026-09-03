import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';

test('focus and width retain the live editor, panels and undo; tables scroll within Read', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const path = `editor-focus-${randomUUID()}.md`;
  await page.addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, explorerOpen: true,
      explorerWidth: 240, chatDocked: true, chatWidth: 360, terminalOpen: true }));
  }, workspace.id);
  try {
  await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } });
  const original = await (await page.request.get(`/api/mobile/v1/notebook/document?path=${path}`, { headers })).json();
  const content = serializeRichMarkdownBody('# Width check\n\nFirst paragraph\n\n| One | Two | Three | Four | Five | Six | Seven | Last column |\n| :--- | :---: | ---: | --- | --- | --- | --- | --- |\n| A | B | C | D | E | F | G | Last value |');
  expect((await page.request.put('/api/mobile/v1/notebook/document', { headers, data: {
    path, content, expectedSha256: original.document.sha256, baseRevisionId: original.document.revisionId,
  } })).ok()).toBe(true);
  const read = async () => (await (await page.request.get(`/api/files/read?path=${path}`, { headers })).json()).data?.content as string;
    await page.goto(`/notebook?path=${path}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    const explorer = page.locator('#onboarding-notebook-fileBrowser');
    const chat = page.getByTestId('notebook-desktop-chat');
    const terminal = page.locator('#app-layout-terminal');
    await expect(explorer).toBeVisible(); await expect(chat).toBeVisible(); await expect(terminal).toBeVisible();
    const draft = chat.getByTestId('chat-input');
    await draft.fill('Unsent focus test');
    const panels = await page.evaluate(() => localStorage.getItem('canvas.notebookLayout.v2'));
    const node = await editor.elementHandle();
    const terminalNode = await terminal.elementHandle();
    const sessions: string[] = [];
    page.on('websocket', (socket) => sessions.push(socket.url()));
    await editor.getByText('First paragraph', { exact: true }).click();
    await page.keyboard.press('End'); await page.keyboard.type(' edited');
    await expect.poll(read).toContain('First paragraph edited');
    await page.getByRole('button', { name: 'Focus document', exact: true }).click();
    await expect(explorer).toBeHidden(); await expect(chat).toBeHidden(); await expect(terminal).toBeHidden();
    await expect(editor).toHaveCSS('max-width', '896px');
    await page.getByRole('button', { name: 'Full width', exact: true }).click();
    expect(await editor.evaluate((current, before) => current === before, node)).toBe(true);
    await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(1300);
    await page.screenshot({ path: info.outputPath('focus-wide.png') });
    await editor.getByText('First paragraph edited', { exact: true }).dblclick({ position: { x: 12, y: 10 } });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('First');
    await expect(page.getByTestId('markdown-selection-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('markdown-selection-menu')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Exit focus', exact: true })).toBeVisible();
    await editor.getByText('First paragraph edited', { exact: true }).click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(read).not.toContain('edited');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(read).toContain('First paragraph edited');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Focus document', exact: true })).toBeVisible();
    await expect(explorer).toBeVisible(); await expect(chat).toBeVisible(); await expect(terminal).toBeVisible();
    expect(await terminal.evaluate((current, before) => current === before, terminalNode)).toBe(true);
    await expect(draft).toHaveValue('Unsent focus test');
    await draft.fill('');
    expect(await page.evaluate(() => localStorage.getItem('canvas.notebookLayout.v2'))).toBe(panels);
    expect(sessions.filter((url) => url.includes('collaboration'))).toEqual([]);

    await page.getByRole('button', { name: 'Read', exact: true }).click();
    const scroll = page.getByRole('region', { name: 'Scrollable table', exact: true });
    await expect(scroll).toBeVisible();
    await expect(scroll.locator('th').nth(1)).toHaveCSS('text-align', 'center');
    await expect(scroll.locator('td').nth(2)).toHaveCSS('text-align', 'right');
    await scroll.focus(); await scroll.press('ArrowRight');
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Focus document', exact: true })).toBeHidden();
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    const mobileScroll = page.getByRole('region', { name: 'Scrollable table', exact: true });
    await expect(mobileScroll).toBeVisible();
    await expect.poll(async () => (await mobileScroll.boundingBox())!.width).toBeLessThanOrEqual(390);
    await mobileScroll.focus(); await mobileScroll.press('End');
    // Horizontal navigation stays inside the table and never widens the document viewport.
    await mobileScroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect(mobileScroll.getByRole('cell', { name: 'Last value' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await page.request.delete('/api/files/delete', { headers, data: { path } });
  }
});
