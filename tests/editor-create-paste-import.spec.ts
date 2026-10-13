import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';

const editorSelector = '.tiptap-editor-shell .ProseMirror';
const importTitle = 'Insert Markdown…';
const plainText = 'First paste: äöü ß 😀\nSecond line preserves plain text.\n\nLast paragraph.';
const markdownBody = '# Imported heading\n\nA **bold** paragraph with a [link](https://example.test/docs).\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n\n```javascript\nconsole.log("hello");\n```\n';

type Workspace = { id: string; headers: Record<string, string> };

async function login(page: Page, secondary = false): Promise<Workspace> {
  if (secondary) expect(Boolean(process.env.TEST_SECONDARY_EMAIL && process.env.TEST_SECONDARY_PASSWORD)).toBe(true);
  await authenticateManagedTestPage(page, secondary ? {
    email: process.env.TEST_SECONDARY_EMAIL, password: process.env.TEST_SECONDARY_PASSWORD,
  } : undefined);
  const response = await page.request.get('/api/workspaces');
  expect(response.ok()).toBe(true);
  const { workspaces } = await response.json();
  const workspace = workspaces.find((entry: { id: string; name: string; permissions?: { canWrite: boolean } }) =>
    entry.name === 'Shared Test Workspace' && entry.permissions?.canWrite);
  expect(workspace?.id).toBeTruthy();
  await page.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  return { id: workspace.id, headers: { 'x-canvas-workspace-id': workspace.id } };
}

async function open(page: Page, workspace: Workspace, path: string) {
  await page.goto(`/en/notebook?path=${encodeURIComponent(path)}&workspaceId=${workspace.id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.locator(editorSelector)).not.toBeFocused();
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('document-header').getByRole('button', { name: 'Full width', exact: true })).toBeVisible();
}

async function createInUi(page: Page, workspace: Workspace, path: string, entry: 'home' | 'file-browser') {
  await page.goto(entry === 'home' ? '/en' : `/en/files?workspaceId=${workspace.id}`);
  let dialog: Locator;
  if (entry === 'home') {
    await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'New note', exact: true });
    await dialog.getByLabel('Note name', { exact: true }).fill(path);
  } else {
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Create new file', exact: true });
    await dialog.getByLabel('File name', { exact: true }).fill(path);
  }
  await waitForFileCreateBudget();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
    && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id
    && response.request().postDataJSON()?.path === path);
  await dialog.getByRole('button', { name: entry === 'home' ? 'Create and open' : 'Create file', exact: true }).click();
  expect((await created).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(url => url.pathname === (entry === 'home' ? '/en/notebook' : '/en/files')
    && url.searchParams.get('path') === path && url.searchParams.get('workspaceId') === workspace.id);
  // Both creation dialogs must open the exact new document through their real follow-up.
  await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.getByTestId('document-header')).toContainText(path);
  await expect(page.locator(editorSelector)).toHaveText('');
}

async function clipboardPaste(page: Page, target: Locator, text: string) {
  await target.focus();
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.keyboard.press('ControlOrMeta+v');
}

async function tree(page: Page): Promise<JSONContent> {
  return page.locator(editorSelector).evaluate(element =>
    (element as HTMLElement & { editor: { getJSON(): JSONContent } }).editor.getJSON());
}

async function nativeParagraph(page: Page, text: string): Promise<Locator> {
  const paragraphs = (await tree(page)).content?.filter(node => node.type === 'paragraph'
    && node.content?.every(child => child.type === 'text')
    && node.content.map(child => child.text ?? '').join('') === text) ?? [];
  expect(paragraphs).toHaveLength(1);
  const id = paragraphs[0].attrs?.id;
  expect(typeof id).toBe('string');
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
  // A remote-caret label adds DOM text to the paragraph without changing its
  // native content. Select its stable node ID, then actually click and type.
  const paragraph = page.locator(editorSelector).locator(`p[data-id="${id}"]`);
  await expect(paragraph).toBeVisible();
  await expect(paragraph).toContainText(text);
  return paragraph;
}

async function readText(page: Page, workspace: Workspace, path: string): Promise<string> {
  const response = await page.request.get('/api/files/read', { headers: workspace.headers, params: { path } });
  expect(response.ok()).toBe(true);
  return (await response.json()).data.content;
}

async function session(page: Page, workspace: Workspace, path: string) {
  const response = await page.request.post('/api/files/collaboration/session', {
    headers: workspace.headers, data: { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.ok()).toBe(true);
  const value = await response.json();
  expect(value.documentId).toBeTruthy();
  expect(value.lifecycleGeneration).toBeGreaterThan(0);
  return value as { documentId: string; lifecycleGeneration: number; representation: string; documentSequence: number };
}

async function insertDialog(page: Page) {
  await page.getByTestId('markdown-toolbar-insert').click();
  await page.getByRole('menuitem', { name: importTitle, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: importTitle, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Manual document creation and first content', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1',
    'Requires an explicitly selected isolated application/PG target and two real managed fixture users.');
  test.setTimeout(150_000);
  test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

  for (const entry of ['home', 'file-browser'] as const) {
    test(`${entry}: first plain clipboard paste, separate undo, peer edits and fresh browser reopen`, async ({ page, browser }, info) => {
      info.annotations.push({ type: 'clipboard-scope', description: 'Real browser clipboard text/plain and paste shortcut; no native OS keyboard/IME claim.' });
      const workspace = await login(page);
      const path = `manual-paste-${entry}-${randomUUID()}.md`;
      const peerContext = await browser.newContext({ baseURL: process.env.BASE_URL });
      const peer = await peerContext.newPage();
      try {
        await createInUi(page, workspace, path, entry);
        const identity = await session(page, workspace, path);
        await clipboardPaste(page, page.locator(editorSelector), plainText);
        await expect(page.locator(editorSelector)).toContainText('First paste: äöü ß 😀');
        await expect(page.locator(editorSelector)).toContainText('Last paragraph.');
        expect((await tree(page)).content?.map(node => ({ type: node.type, content: node.content }))).toEqual([
          { type: 'paragraph', content: [{ type: 'text', text: 'First paste: äöü ß 😀' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second line preserves plain text.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Last paragraph.' }] },
        ]);
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.insertText(' Typed after paste.');
        await expect(page.locator(editorSelector)).toContainText('Last paragraph. Typed after paste.');
        await page.keyboard.press('ControlOrMeta+z');
        await expect(page.locator(editorSelector)).not.toContainText('Typed after paste.');
        await expect(page.locator(editorSelector)).toContainText('First paste: äöü ß 😀');
        await page.keyboard.press('ControlOrMeta+z');
        await expect(page.locator(editorSelector)).toHaveText('');
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(page.locator(editorSelector)).toContainText('Last paragraph.');
        expect(await login(peer, true)).toEqual(workspace);
        const users = await Promise.all([page, peer].map(async target =>
          (await (await target.request.get('/api/auth/get-session')).json()).user.id as string));
        expect(users[0]).not.toBe(users[1]);
        await open(peer, workspace, path);
        await expect.poll(() => tree(peer)).toEqual(await tree(page));
        await info.attach('plain-peer-native-and-dom', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
          native: await tree(peer),
          paragraphs: await peer.locator(editorSelector).locator('p[data-id]').evaluateAll(paragraphs => paragraphs.map(paragraph => {
            const clean = paragraph.cloneNode(true) as HTMLElement;
            clean.querySelectorAll('.collaboration-carets__caret').forEach(caret => caret.remove());
            return { id: paragraph.getAttribute('data-id'), documentText: clean.textContent,
              caretCount: paragraph.querySelectorAll('.collaboration-carets__caret').length,
              caretLabelCharacters: [...paragraph.querySelectorAll('.collaboration-carets__label')]
                .reduce((length, label) => length + (label.textContent?.length ?? 0), 0) };
          })),
        })) });
        await (await nativeParagraph(peer, 'Last paragraph.')).click();
        await peer.keyboard.press('End'); await peer.keyboard.insertText(' Peer keeps this.');
        await expect(page.locator(editorSelector)).toContainText('Last paragraph. Peer keeps this.');
        // Undo must remain local to the initiating user and preserve the peer's edit.
        await (await nativeParagraph(page, 'Second line preserves plain text.')).click();
        await page.keyboard.press('End'); await page.keyboard.insertText(' Own edit.');
        await page.keyboard.press('ControlOrMeta+z');
        await expect(page.locator(editorSelector)).not.toContainText('Own edit.');
        await expect(page.locator(editorSelector)).toContainText('Peer keeps this.');
        const final = await tree(page);
        await expect.poll(() => tree(peer)).toEqual(final);
        await expect.poll(() => readText(page, workspace, path), { timeout: 20_000 }).toContain('Peer keeps this.');
        const persisted = await session(page, workspace, path);
        expect(persisted.documentId).toBe(identity.documentId);
        expect(persisted.lifecycleGeneration).toBe(identity.lifecycleGeneration);
        expect(persisted.documentSequence).toBeGreaterThan(identity.documentSequence);
        await page.screenshot({ path: info.outputPath(`manual-${entry}-paste.png`), animations: 'disabled' });
        await peerContext.close();
        await page.goto('about:blank');
        const freshContext = await browser.newContext({ baseURL: process.env.BASE_URL });
        try {
          const fresh = await freshContext.newPage();
          expect(await login(fresh)).toEqual(workspace);
          await open(fresh, workspace, path);
          await expect.poll(() => tree(fresh)).toEqual(final);
          await fresh.reload();
          await expect.poll(() => tree(fresh)).toEqual(final);
        } finally { await freshContext.close(); }
      } finally {
        await peerContext.close();
        await page.goto('about:blank').catch(() => undefined);
        await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
      }
    });
  }

  test('manual empty document imports a Markdown body and retains rejected full-document drafts', async ({ page }, info) => {
    const workspace = await login(page);
    const path = `manual-markdown-${randomUUID()}.md`;
    try {
      await createInUi(page, workspace, path, 'home');
      const identity = await session(page, workspace, path);
      let dialog = await insertDialog(page);
      await clipboardPaste(page, dialog.getByRole('textbox', { name: 'Markdown', exact: true }), markdownBody);
      await expect(dialog.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(markdownBody);
      await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
      const editor = page.locator(editorSelector);
      await expect(editor.getByRole('heading', { name: 'Imported heading', exact: true })).toBeVisible();
      await expect(editor.locator('strong')).toHaveText('bold');
      await expect(editor.locator('li')).toHaveText(['First', 'Second']);
      await expect(editor.locator('table')).toContainText('Alpha');
      await expect(editor.locator('pre')).toContainText('console.log("hello");');
      const imported = await tree(page);
      await page.keyboard.press('ControlOrMeta+z'); await expect(editor).toHaveText('');
      await page.keyboard.press('ControlOrMeta+Shift+z'); await expect.poll(() => tree(page)).toEqual(imported);
      for (const draft of ['---\ntitle: Preserve metadata\n---\n\n# Full document\n', '<custom-widget>Preserve this verbatim</custom-widget>\n']) {
        dialog = await insertDialog(page);
        await clipboardPaste(page, dialog.getByRole('textbox', { name: 'Markdown', exact: true }), draft);
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(draft);
        await expect(dialog.getByRole('button', { name: 'Insert', exact: true })).toBeDisabled();
        expect(await tree(page)).toEqual(imported);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      await expect.poll(() => readText(page, workspace, path), { timeout: 20_000 }).toContain('# Imported heading');
      expect((await session(page, workspace, path)).documentId).toBe(identity.documentId);
      await page.reload(); await expect.poll(() => tree(page)).toEqual(imported);
      await page.screenshot({ path: info.outputPath('manual-markdown-body.png'), animations: 'disabled' });
    } finally {
      await page.goto('about:blank').catch(() => undefined);
      await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
    }
  });

  test('genuine HTML plus plain clipboard uses the native safe rich parser once', async ({ page }) => {
    const workspace = await login(page);
    const path = `manual-html-paste-${randomUUID()}.md`;
    try {
      await createInUi(page, workspace, path, 'file-browser');
      await page.locator(editorSelector).focus();
      await page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob(['Plain fallback'], { type: 'text/plain' }),
        'text/html': new Blob(['<p>Rich <strong>pasted</strong></p>'], { type: 'text/html' }),
      })]));
      await page.keyboard.press('ControlOrMeta+v');
      await expect(page.locator(editorSelector)).toHaveText('Rich pasted');
      await expect(page.locator(editorSelector).locator('strong')).toHaveText('pasted');
      await page.keyboard.press('ControlOrMeta+z'); await expect(page.locator(editorSelector)).toHaveText('');
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(page.locator(editorSelector)).toHaveText('Rich pasted');
      await expect.poll(() => readText(page, workspace, path), { timeout: 20_000 }).toContain('**pasted**');
      const final = await tree(page);
      const identity = await session(page, workspace, path);
      await page.reload(); await expect(page.locator(editorSelector)).toHaveText('Rich pasted');
      await expect.poll(() => tree(page)).toEqual(final);
      const reloaded = await session(page, workspace, path);
      expect(reloaded.documentId).toBe(identity.documentId);
      expect(reloaded.lifecycleGeneration).toBe(identity.lifecycleGeneration);
      // The actual Files route owns the preview's location and browser history.
      await page.goBack();
      await expect(page).toHaveURL(url => url.pathname === '/en/files' && !url.searchParams.has('path')
        && url.searchParams.get('workspaceId') === workspace.id);
      await expect(page.locator(editorSelector)).toHaveCount(0);
      await page.goForward();
      await expect(page).toHaveURL(url => url.pathname === '/en/files' && url.searchParams.get('path') === path
        && url.searchParams.get('workspaceId') === workspace.id);
      await expect.poll(() => tree(page)).toEqual(final);
      await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true');
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(url => !url.searchParams.has('path') && url.searchParams.get('workspaceId') === workspace.id);
      await expect(page.locator(editorSelector)).toHaveCount(0);
      await page.reload(); await expect(page.locator(editorSelector)).toHaveCount(0);
    } finally {
      await page.goto('about:blank').catch(() => undefined);
      await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
    }
  });

  test('full Markdown file import retains frontmatter and unsupported syntax in editable Source', async ({ page }, info) => {
    const workspace = await login(page);
    const path = `manual-full-import-${randomUUID()}.md`;
    const content = '---\ntitle: Full import\ncustom:\n  keep: true\n---\n\n# Imported file\n\n<custom-widget preserve="yes">Exact source</custom-widget>\n';
    try {
      await page.goto('/en');
      await page.getByTestId('home-files').getByRole('button', { name: 'Import files', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
      const uploaded = page.waitForResponse(response => /^\/api\/files\/uploads\/[^/]+\/complete$/u.test(new URL(response.url()).pathname)
        && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id);
      await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
        name: path, mimeType: 'text/markdown', buffer: Buffer.from(content),
      });
      expect((await uploaded).ok()).toBe(true); await expect(dialog).toHaveCount(0);
      expect(await readText(page, workspace, path)).toBe(content);
      await page.goto(`/en/notebook?path=${encodeURIComponent(path)}&workspaceId=${workspace.id}`);
      await expect(page.locator('.markdown-source-shell .cm-content')).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
      await expect(page.locator(editorSelector)).toHaveCount(0);
      expect((await session(page, workspace, path)).representation).toBe('plain_text');
      await expect(page.locator('.cm-line').filter({ hasText: 'keep: true' })).toBeVisible();
      const last = page.locator('.cm-line').filter({ hasText: '<custom-widget preserve="yes">Exact source</custom-widget>' });
      await last.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' Tail');
      await expect.poll(() => readText(page, workspace, path)).toBe(content.replace('</custom-widget>', '</custom-widget> Tail'));
      await page.keyboard.press('ControlOrMeta+z'); await expect.poll(() => readText(page, workspace, path)).toBe(content);
      await page.reload();
      await expect(page.locator('.markdown-source-shell .cm-content')).toHaveAttribute('contenteditable', 'true');
      expect(await readText(page, workspace, path)).toBe(content);
      await page.screenshot({ path: info.outputPath('manual-full-source-import.png'), animations: 'disabled' });
    } finally {
      await page.goto('about:blank').catch(() => undefined);
      await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
    }
  });

  test('ordinary revision-checked text preview revalidates through the scoped loader on browser history reopen', async ({ page }) => {
    const workspace = await login(page);
    const basename = `manual-history-text-${randomUUID()}`;
    const path = `${basename}.log`;
    const content = 'Ordinary text preview must revalidate when history reopens it.';
    try {
      expect((await page.request.post('/api/files/upload', { headers: workspace.headers, multipart: { path: '.',
        files: { name: path, mimeType: 'text/plain', buffer: Buffer.from(content) } } })).ok()).toBe(true);
      await page.goto(`/en/files?workspaceId=${workspace.id}`);
      await page.getByRole('button', { name: 'Tree view', exact: true }).click();
      await page.getByRole('treeitem').filter({ hasText: basename }).click();
      await expect(page).toHaveURL(url => url.pathname === '/en/files' && url.searchParams.get('path') === path
        && url.searchParams.get('workspaceId') === workspace.id);
      await expect(page.locator('.cm-content')).toContainText(content);
      await page.goBack();
      await expect(page).toHaveURL(url => url.pathname === '/en/files' && !url.searchParams.has('path')
        && url.searchParams.get('workspaceId') === workspace.id);
      await expect(page.locator('.cm-content')).toHaveCount(0);
      const reread = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/api/files/read' && url.searchParams.get('path') === path
          && response.request().headers()['x-canvas-workspace-id'] === workspace.id;
      });
      await page.goForward();
      const response = await reread;
      expect(response.ok()).toBe(true);
      expect((await response.json()).data.content).toBe(content);
      await expect(page.locator('.cm-content')).toContainText(content);
      await expect(page).toHaveURL(url => url.pathname === '/en/files' && url.searchParams.get('path') === path
        && url.searchParams.get('workspaceId') === workspace.id);
    } finally {
      await page.goto('about:blank').catch(() => undefined);
      await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
    }
  });
});
