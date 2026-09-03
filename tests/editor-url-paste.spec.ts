import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('URL paste offers link, explicit preview and supported document embed without changing code paste', async ({ page, context }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires managed local PostgreSQL.');
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  expect((await page.request.post('/api/auth/sign-in/email', { headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' }, data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD } })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const path = `editor-url-${randomUUID()}.md`;
  const target = `editor-embed-${randomUUID()}.md`;
  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  for (const [file, content] of [[path, 'First slot\n\nSecond slot\n\nEmbed slot\n\n```text\ncode\n```'], [target, '# Embedded heading\n\nEmbedded content.']]) {
    await page.request.post('/api/files/create', { headers, data: { path: file, type: 'file' } });
    const original = await (await page.request.get(`/api/mobile/v1/notebook/document?path=${file}`, { headers })).json();
    expect((await page.request.put('/api/mobile/v1/notebook/document', { headers, data: { path: file, content, expectedSha256: original.document.sha256, baseRevisionId: original.document.revisionId } })).ok()).toBe(true);
  }
  let previewRequests = 0;
  await page.route('**/api/markdown/link-preview?**', (route) => { previewRequests++; return route.fulfill({ json: { success: true, data: { imageUrl: 'https://preview.example.test/image.svg', host: 'example.test' } } }); });
  await page.route('https://preview.example.test/image.svg', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#729b91"/></svg>' }));
  const paste = async (text: string) => { await page.evaluate((value) => navigator.clipboard.writeText(value), text); await page.keyboard.press('ControlOrMeta+v'); };
  const read = async () => (await (await page.request.get(`/api/files/read?path=${path}`, { headers })).json()).data?.content as string;
  try {
    await page.goto(`/notebook?path=${path}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    await editor.getByText('First slot', { exact: true }).dblclick({ position: { x: 12, y: 10 } });
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('First');
    await paste('https://example.test/cancel');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor.getByText('First slot', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('First');
    await paste('https://example.test/link');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: 'Link', exact: true })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: 'Embed document' })).toHaveCount(0);
    expect(previewRequests).toBe(0);
    await dialog.getByRole('button', { name: 'Apply link' }).click();
    await expect(editor.locator('a[href="https://example.test/link"]')).toHaveText('First');
    await expect.poll(read).toContain('[First](https://example.test/link)');
    await editor.getByText('Second slot', { exact: true }).click();
    await expect.poll(() => page.evaluate(()=>window.getSelection()?.anchorNode?.parentElement?.textContent)).toBe('Second slot');
    await page.keyboard.press('ControlOrMeta+ArrowRight');
    await page.keyboard.press('Enter');
    await paste('https://example.test/preview');
    await dialog.getByRole('radio', { name: 'Preview', exact: true }).check();
    await expect(dialog.getByRole('button', { name: 'Apply link' })).toBeEnabled();
    await page.screenshot({ path: info.outputPath('url-paste-choices.png') });
    await dialog.getByRole('button', { name: 'Apply link' }).click();
    await expect.poll(read, { timeout: 20_000 }).toContain('![Link preview: example.test]');
    await expect(editor.locator('a[href="https://example.test/link"]')).toHaveText('First');
    expect(await read()).toContain('Second slot\n\n[https://example.test/preview]');
    await expect(page.getByRole('status').filter({ hasText: 'File checkpoint current' })).toBeVisible();
    await editor.getByText('Embed slot', { exact: true }).click();
    await page.keyboard.press('ControlOrMeta+ArrowRight');
    await page.keyboard.press('Enter');
    await paste(`http://localhost:3000/notebook?path=${target}`);
    await dialog.getByRole('radio', { name: 'Embed document', exact: true }).check();
    await dialog.getByRole('button', { name: 'Apply link' }).click();
    await expect.poll(read).toContain(`![[${target.replace(/\.md$/u, '')}]]`);
    await editor.locator('pre').getByText('code', { exact: true }).click();
    await page.keyboard.press('ControlOrMeta+ArrowRight');
    await paste('https://example.test/code');
    await expect(dialog).toHaveCount(0);
    await expect(editor.locator('pre')).toContainText('codehttps://example.test/code');
    await expect.poll(read).toContain('codehttps://example.test/code');
    await page.reload();
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    await expect(editor.locator('.node-obsidianWikiLink')).toHaveCount(1);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByText('Embedded content.', { exact: true })).toBeVisible();
  } finally {
    await page.close();
    for (const file of [path, target]) await page.request.delete('/api/files/delete', { headers, data: { path: file } });
  }
});
