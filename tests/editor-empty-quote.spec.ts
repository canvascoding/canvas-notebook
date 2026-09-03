import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import corpus from '../app/lib/markdown/core/fixtures.json';
import { serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';

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

test('shared Markdown structures render, edit, and checkpoint without losing cells or code', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(120_000);
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: {
      email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  expect(login.ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const path = `editor-core-${randomUUID()}.md`;
  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
  const content = serializeRichMarkdownBody(corpus.fixtures.map((fixture) => fixture.normalized.trimEnd()).join('\n\n') + '\n');
  expect((await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } })).ok()).toBe(true);
  const original = await (await page.request.get(`/api/mobile/v1/notebook/document?path=${encodeURIComponent(path)}`, { headers })).json();
  const write = await page.request.put('/api/mobile/v1/notebook/document', { headers, data: {
    path, content, expectedSha256: original.document.sha256, baseRevisionId: original.document.revisionId,
  } });
  expect(write.ok(), await write.text()).toBe(true);
  const readContent = async () => (await (await page.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers })).json()).data?.content as string;
  try {
    await page.goto(`/notebook?path=${encodeURIComponent(path)}`);
    const editor = page.locator('.tiptap-editor-shell .ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    await expect(editor.locator('td code').filter({ hasText: /^a\|b$/ })).toHaveCount(1);
    await expect(editor.locator('td code').filter({ hasText: /^two  spaces$/ })).toHaveCount(1);
    const cell = editor.locator('td').filter({ hasText: /^x\|y$/ });
    await cell.locator('p').fill('x|y updated');
    await expect.poll(readContent, { timeout: 20_000 }).toContain('x\\|y updated');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.locator('td').filter({ hasText: /^x\|y updated$/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('shared-markdown-edited.png') });
    await page.reload();
    await expect(editor.locator('td').filter({ hasText: /^x\|y updated$/ })).toHaveCount(1, { timeout: 30_000 });
    await expect(editor.locator('td code').filter({ hasText: /^a\|b$/ })).toHaveCount(1);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
  } finally {
    await page.goto('about:blank');
    await page.request.delete('/api/files/delete', { headers, data: { path } });
  }
});

test('reading observes live source without rewriting it and migration waits for other editors', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(120_000);
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string }) => entry.name === 'Shared Test Workspace');
  const headers = { 'x-canvas-workspace-id': workspace.id };
  const path = `editor-modes-${randomUUID()}.md`;
  const content = '# Live preview\n\n| Code | Value |\n|---|---|\n| `a\\|b` | Original |\n\n';
  await page.addInitScript((id) => { localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false'); }, workspace.id);
  const readContent = async () => (await (await page.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers })).json()).data?.content as string;
  const uploaded = await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: { name: path, mimeType: 'text/markdown', buffer: Buffer.from(content) } } });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const second = await page.context().newPage();
  try {
    await page.goto(`/notebook?path=${encodeURIComponent(path)}`);
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: 'Live preview' })).toBeVisible();
    expect(await readContent()).toBe(content);
    await second.goto(`/notebook?path=${encodeURIComponent(path)}`);
    await second.getByRole('button', { name: 'Source', exact: true }).click();
    const source = second.locator('.cm-content');
    await expect(source).toHaveAttribute('contenteditable', 'true');
    await source.click();
    await second.keyboard.press('ControlOrMeta+End');
    await second.keyboard.type('\n\nLive addition');
    await expect.poll(readContent).toContain('Live addition');
    await expect(page.getByText('Live addition', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
    await expect(page.getByText(/Other editors or pending changes prevent/)).toBeVisible();
    await second.close();
    await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
    await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Live addition', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(page.locator('.cm-content')).toContainText('Live addition');
    await expect(page.getByTestId('markdown-save-state')).toContainText('File checkpoint current');
    await page.screenshot({ path: info.outputPath('live-source-modes.png') });
    await page.route('**/api/files/collaboration/checkpoint', (route) => route.fulfill({ status: 422,
      contentType: 'application/json', body: JSON.stringify({ success: false, code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', error: 'Rich collaboration checkpoint validation failed (roundtrip_unstable).' }),
    }));
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('markdown-save-state')).toContainText('The file could not be saved safely');
    await expect(page.getByRole('button', { name: 'Retry file saving' })).toHaveCount(0);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Markdown', exact: true }).click();
    expect((await download).suggestedFilename()).toBe(path);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Live addition', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('checkpoint-recovery.png') });

  } finally {
    if (!second.isClosed()) await second.close();
    await page.goto('about:blank');
    await page.request.delete('/api/files/delete', { headers, data: { path } });
  }
});
