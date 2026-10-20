import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createCompletedWorkspaceMarkdownFile } from './helpers/managed-test-context';

test('header focus and width retain the editable document, panels, undo and native table navigation', async ({ page }, info) => {
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
  const availabilityResponse = await page.request.get('/api/terminal/availability');
  expect(availabilityResponse.ok()).toBe(true);
  const terminalEnabled = (await availabilityResponse.json()).data.terminalEnabled as boolean;
  expect(typeof terminalEnabled).toBe('boolean');
  const path = `editor-focus-${randomUUID()}.md`;
  await page.addInitScript(({ id, terminalEnabled }) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, explorerOpen: true,
      explorerWidth: 240, chatDocked: true, chatWidth: 360, terminalOpen: terminalEnabled }));
  }, { id: workspace.id, terminalEnabled });
  try {
    await createCompletedWorkspaceMarkdownFile({ request: page.request, workspaceId: workspace.id, filePath: path });
    const read = async () => (await (await page.request.get(`/api/files/read?path=${path}`, { headers })).json()).data?.content as string;
    await page.goto(`/notebook?path=${path}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    await editor.click();
    await page.getByTestId('markdown-toolbar-insert').click();
    await page.getByRole('menuitem', { name: 'Insert Markdown…', exact: true }).click();
    const insertion = page.getByRole('dialog', { name: 'Insert Markdown…', exact: true });
    await expect(insertion).toBeVisible();
    await insertion.getByRole('textbox', { name: 'Markdown', exact: true }).fill('# Width check\n\nFirst paragraph\n\n| One | Two | Three | Four | Five | Six | Seven | Last column |\n| :--- | :---: | ---: | --- | --- | --- | --- | --- |\n| A | B | C | D | E | F | G | Last value |');
    await insertion.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(insertion).toHaveCount(0);
    await expect(editor.getByRole('heading', { name: 'Width check', exact: true })).toBeVisible();
    await expect(editor.getByText('First paragraph', { exact: true })).toBeVisible();
    const documentHeader = page.getByTestId('document-header');
    await expect(documentHeader.getByRole('button', { name: 'Focus document', exact: true })).toBeVisible();
    await expect(documentHeader.getByRole('button', { name: 'Full width', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    expect(await page.locator('[data-editor-layout="document"]').locator(':scope > .markdown-mode-bar').count()).toBe(0);
    const explorer = page.locator('#onboarding-notebook-fileBrowser');
    const chat = page.getByTestId('notebook-desktop-chat');
    const terminal = page.locator('#app-layout-terminal');
    await expect(explorer).toBeVisible(); await expect(chat).toBeVisible();
    if (terminalEnabled) await expect(terminal).toBeVisible();
    else await expect(terminal).toHaveCount(0);
    const draft = chat.getByTestId('chat-inline-editor').getByRole('textbox');
    await expect(draft).toHaveAttribute('contenteditable', 'true');
    await draft.fill('Unsent focus test');
    const panels = await page.evaluate(() => localStorage.getItem('canvas.notebookLayout.v2'));
    const node = await editor.elementHandle();
    const terminalNode = terminalEnabled ? await terminal.elementHandle() : null;
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
    await expect(explorer).toBeVisible(); await expect(chat).toBeVisible();
    if (terminalEnabled) {
      await expect(terminal).toBeVisible();
      expect(await terminal.evaluate((current, before) => current === before, terminalNode)).toBe(true);
    } else await expect(terminal).toHaveCount(0);
    await expect(draft).toHaveText('Unsent focus test');
    await draft.fill('');
    expect(await page.evaluate(() => localStorage.getItem('canvas.notebookLayout.v2'))).toBe(panels);
    expect(sessions.filter((url) => url.includes('collaboration'))).toEqual([]);

    const scroll = editor.locator('.tableWrapper');
    await expect(scroll).toBeVisible();
    await expect(scroll.locator('th').nth(1)).toHaveCSS('text-align', 'center');
    await expect(scroll.locator('td').nth(2)).toHaveCSS('text-align', 'right');
    await scroll.locator('td').first().click();
    for (let column = 0; column < 7; column += 1) await page.keyboard.press('Tab');
    await expect(scroll.getByRole('cell', { name: 'Last value' })).toBeInViewport();
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(documentHeader.getByRole('button', { name: 'Focus document', exact: true })).toBeVisible();
    await documentHeader.getByRole('button', { name: 'Focus document', exact: true }).click();
    await expect(documentHeader.getByRole('button', { name: 'Exit focus', exact: true })).toBeVisible();
    await expect(page.getByTestId('notebook-header')).toBeHidden();
    await expect(page.getByTestId('notebook-toolbar')).toBeHidden();
    const focusedBounds = await page.locator('[data-document-focus="true"]').evaluate(element => {
      const root = element.getBoundingClientRect(), header = element.querySelector('[data-testid="document-header"]')!.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { top: header.top - root.top, left: header.left - root.left, right: root.right - header.right,
        paddingTop: parseFloat(style.paddingTop), paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight) };
    });
    expect(focusedBounds.top).toBeGreaterThanOrEqual(focusedBounds.paddingTop);
    expect(focusedBounds.left).toBeGreaterThanOrEqual(focusedBounds.paddingLeft);
    expect(focusedBounds.right).toBeGreaterThanOrEqual(focusedBounds.paddingRight);
    expect(await editor.evaluate((current, before) => current === before, node)).toBe(true);
    await documentHeader.getByRole('button', { name: 'Exit focus', exact: true }).click();
    await expect(page.getByTestId('notebook-header')).toBeVisible();
    await expect(page.getByTestId('notebook-toolbar')).toBeVisible();
    await documentHeader.getByRole('button', { name: 'Focus document', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(documentHeader.getByRole('button', { name: 'Focus document', exact: true })).toBeVisible();
    await expect(page.getByTestId('notebook-toolbar')).toBeVisible();
    expect(await editor.evaluate((current, before) => current === before, node)).toBe(true);
    const mobileScroll = editor.locator('.tableWrapper');
    await expect(mobileScroll).toBeVisible();
    await expect.poll(async () => (await mobileScroll.boundingBox())!.width).toBeLessThanOrEqual(390);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
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
