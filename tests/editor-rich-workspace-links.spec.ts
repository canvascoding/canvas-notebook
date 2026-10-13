import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';

const selector = '.tiptap-editor-shell .ProseMirror';
async function tree(page: Page): Promise<JSONContent> {
  return page.locator(selector).evaluate(element => (element as HTMLElement & { editor: { getJSON(): JSONContent } }).editor.getJSON());
}

test('rich writer plain-click menu and Ctrl/Cmd/Open navigate exact scoped documents and fragments without edits', async ({ page }, info) => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the explicitly selected sealed owned production host.');
  test.setTimeout(240_000); await requireOwnedYjsQaTarget(); await authenticateManagedTestPage(page);
  const response = await page.request.get('/api/workspaces'); expect(response.ok()).toBe(true);
  const workspaces = (await response.json()).workspaces;
  const shared = workspaces.find((entry: { name: string; permissions?: { canWrite: boolean } }) => entry.name === 'Shared Test Workspace' && entry.permissions?.canWrite);
  const personal = workspaces.find((entry: { type: string; permissions?: { canWrite: boolean } }) => entry.type === 'personal' && entry.permissions?.canWrite);
  expect(shared?.id).toBeTruthy(); expect(personal?.id).toBeTruthy(); expect(personal.id).not.toBe(shared.id);
  const headers = { 'x-canvas-workspace-id': shared.id }, privateHeaders = { 'x-canvas-workspace-id': personal.id };
  const root = `rich-links-${randomUUID()}`, source = `${root}/Notes/Start.md`, target = `${root}/Targets/A|B.md`;
  const privatePath = `private-link-${randomUUID()}.md`;
  const href = '../Targets/A%7CB.md#Section%20A';
  const content = serializeRichMarkdownBody(`[Internal](${href})\n\n[External](https://example.test/link-check)\n\n[Local](#local-heading)\n\n[Private](/${privatePath})\n\n# Local heading\n\nLocal marker.\n`);
  const destination = serializeRichMarkdownBody(`# Target title\n\n${Array.from({ length: 45 }, (_, n) => `Filler paragraph ${n}.`).join('\n\n')}\n\n## Section A\n\nScoped destination marker.\n`);
  await page.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, shared.id);
  const upload = async (filePath: string, value: string, scope: Record<string, string>) => {
    const slash = filePath.lastIndexOf('/'), directory = slash < 0 ? '.' : filePath.slice(0, slash), name = filePath.slice(slash + 1);
    expect((await page.request.post('/api/files/upload', { headers: scope, multipart: { path: directory,
      files: { name, mimeType: 'text/markdown', buffer: Buffer.from(value) } } })).ok()).toBe(true);
  };
  const createExactDocument = async (filePath: string, value: string) => {
    // Multipart uploads sanitize | to _. This resolver fixture needs a real
    // literal-pipe name, created through the existing exact-path JSON API.
    await waitForFileCreateBudget();
    const created = await page.request.post('/api/files/create', { headers, data: { path: filePath, type: 'file' } });
    expect(created.ok()).toBe(true);
    const originalResponse = await page.request.get('/api/mobile/v1/notebook/document', { headers, params: { path: filePath } });
    expect(originalResponse.ok()).toBe(true);
    const original = await originalResponse.json();
    expect(original.success).toBe(true);
    expect(original.document.path).toBe(filePath);
    expect(original.document.sha256).toMatch(/^[a-f\d]{64}$/u);
    const saved = await page.request.put('/api/mobile/v1/notebook/document', { headers, data: {
      path: filePath, content: value, expectedSha256: original.document.sha256, baseRevisionId: original.document.revisionId,
    } });
    expect(saved.ok()).toBe(true);
    const read = await page.request.get('/api/files/read', { headers, params: { path: filePath } });
    expect(read.ok()).toBe(true);
    const data = (await read.json()).data;
    expect(data.path).toBe(filePath);
    expect(data.content).toBe(value);
  };
  const openSource = async () => {
    await page.goto(`/en/notebook?path=${encodeURIComponent(source)}&workspaceId=${shared.id}`);
    await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    await expect(page.getByTestId('document-header')).toContainText('Start.md');
  };
  const popupPages: Page[] = []; page.context().on('page', popup => popupPages.push(popup));
  await page.context().route('https://example.test/link-check', route => route.fulfill({ contentType: 'text/html', body: '<p>External link fixture.</p>' }));
  try {
    for (const directory of [root, `${root}/Notes`, `${root}/Targets`]) {
      await waitForFileCreateBudget();
      expect((await page.request.post('/api/files/create', { headers, data: { path: directory, type: 'directory' } })).ok()).toBe(true);
    }
    await upload(source, content, headers); await createExactDocument(target, destination);
    await upload(privatePath, '# Private marker must stay outside the shared workspace.\n', privateHeaders);
    await openSource(); const initial = await tree(page);
    for (const method of ['ctrl', 'cmd', 'open-menu'] as const) {
      const internal = page.locator(selector).getByRole('link', { name: 'Internal', exact: true });
      if (method === 'open-menu') {
        await internal.click();
        const menu = page.getByRole('dialog', { name: 'Link menu', exact: true }); await expect(menu).toBeVisible();
        await expect(page.getByTestId('document-header')).toContainText('Start.md'); expect(await tree(page)).toEqual(initial);
        await menu.getByRole('button', { name: 'Open link', exact: true }).click();
      } else await internal.click({ modifiers: [method === 'ctrl' ? 'Control' : 'Meta'] });
      await expect(page.getByTestId('document-header')).toContainText('A|B.md');
      const heading = page.locator(selector).getByRole('heading', { name: 'Section A', exact: true });
      await expect(heading).toBeVisible({ timeout: 45_000 }); await expect(heading).toBeInViewport();
      await expect(page.locator(selector)).toContainText('Scoped destination marker.');
      expect(popupPages).toEqual([]); // No /en/Targets/... browser fallback or raw relative popup.
      await openSource(); expect(await tree(page)).toEqual(initial);
    }
    await page.locator(selector).getByRole('link', { name: 'Local', exact: true }).click({ modifiers: ['Control'] });
    await expect(page.locator(selector).getByRole('heading', { name: 'Local heading', exact: true })).toBeInViewport();
    expect(await tree(page)).toEqual(initial);
    await page.locator(selector).getByRole('link', { name: 'Private', exact: true }).click();
    await page.getByRole('dialog', { name: 'Link menu', exact: true }).getByRole('button', { name: 'Open link', exact: true }).click();
    const denied = page.locator('[data-sonner-toast]').filter({ hasText: privatePath });
    await expect(denied).toBeVisible(); await expect(denied).toContainText('Document not found:');
    await expect(page.getByTestId('document-header')).toContainText('Start.md');
    await expect(page.locator(selector)).not.toContainText('Private marker'); expect(await tree(page)).toEqual(initial);
    const outside = page.context().waitForEvent('page');
    await page.locator(selector).getByRole('link', { name: 'External', exact: true }).click({ modifiers: ['Control'] });
    const external = await outside; await external.waitForLoadState('domcontentloaded');
    expect(external.url()).toBe('https://example.test/link-check');
    expect(await external.evaluate(() => window.opener === null)).toBe(true); await external.close();
    expect(await tree(page)).toEqual(initial);
    const read = await page.request.get('/api/files/read', { headers, params: { path: source } });
    expect(read.ok()).toBe(true); expect((await read.json()).data.content).toBe(content);
    await page.screenshot({ path: info.outputPath('rich-workspace-links.png'), animations: 'disabled' });
  } finally {
    for (const popup of popupPages) await popup.close();
    await page.goto('about:blank').catch(() => undefined);
    await page.request.delete('/api/files/delete', { headers, data: { path: root } });
    await page.request.delete('/api/files/delete', { headers: privateHeaders, data: { path: privatePath } });
  }
});
