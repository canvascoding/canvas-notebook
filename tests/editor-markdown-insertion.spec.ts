import { expect, test, type Locator, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { randomUUID } from 'node:crypto';
import { ownedCollaborationQaEnabled, requireOwnedCollaborationQaTarget } from '../scripts/lib/owned-collaboration-qa';
import { authenticateManagedTestPage, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const editorSelector = '.tiptap-editor-shell .ProseMirror';
const insertTitle = 'Insert Markdown…';
const sample = '# Imported document\n\nA **bold** paragraph with a [link](https://example.test/docs).\n\n- First item\n- Second item\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n\n```javascript\nconsole.log("hello");\n```\n';

async function login(page: Page, secondary = false) {
  if (secondary) {
    expect(Boolean(process.env.TEST_SECONDARY_EMAIL && process.env.TEST_SECONDARY_PASSWORD)).toBe(true);
    await authenticateManagedTestPage(page, {
      email: process.env.TEST_SECONDARY_EMAIL,
      password: process.env.TEST_SECONDARY_PASSWORD,
    });
  } else {
    await authenticateManagedTestPage(page);
  }
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string; permissions?: { canWrite: boolean } }) =>
    entry.name === 'Shared Test Workspace' && entry.permissions?.canWrite);
  expect(workspace?.id).toBeTruthy();
  await page.addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  return { 'x-canvas-workspace-id': workspace.id as string };
}

async function openEditor(page: Page, path: string) {
  await page.goto(`/notebook?path=${encodeURIComponent(path)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveCount(0);
}

async function tree(page: Page): Promise<JSONContent> {
  return page.locator(editorSelector).evaluate((element) =>
    (element as HTMLElement & { editor: { getJSON(): JSONContent } }).editor.getJSON());
}

async function openInsertDialog(page: Page) {
  await page.getByTestId('markdown-toolbar-insert').click();
  await page.getByRole('menuitem', { name: insertTitle, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: insertTitle, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function pasteDraft(page: Page, dialog: Locator, text: string) {
  await dialog.getByRole('textbox', { name: 'Markdown', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(dialog.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(text);
}

async function persistedText(page: Page, headers: Record<string, string>, path: string) {
  const response = await page.request.get('/api/files/read', { headers, params: { path } });
  expect(response.ok()).toBe(true);
  return (await response.json()).data?.content as string;
}

async function expectDistinctUsers(page: Page, peer: Page) {
  const identities = await Promise.all([page, peer].map(async (target) =>
    (await (await target.request.get('/api/auth/get-session')).json()).user.id as string));
  expect(identities[0]).toBeTruthy();
  expect(identities[1]).toBeTruthy();
  expect(identities[1]).not.toBe(identities[0]);
}

test.describe('Explicit Markdown insertion in the live editor', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(120_000);
  test.beforeEach(async ({ context }) => {
    if (ownedCollaborationQaEnabled()) await requireOwnedCollaborationQaTarget();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('a new document imports formatted Markdown with separate undo, peer sync and reload persistence', async ({ page, browser }, info) => {
    const headers = await login(page);
    const path = `editor-markdown-insert-${randomUUID()}.md`;
    expect((await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } })).ok()).toBe(true);
    const peerContext = await browser.newContext({ baseURL: process.env.BASE_URL });
    const peer = await peerContext.newPage();
    try {
      expect(await login(peer, true)).toEqual(headers);
      await expectDistinctUsers(page, peer);
      await openEditor(page, path);
      await openEditor(peer, path);
      const editor = page.locator(editorSelector);
      const initial = await tree(page);
      await expect.poll(() => tree(peer)).toEqual(initial);
      await editor.click();
      const dialog = await openInsertDialog(page);
      await pasteDraft(page, dialog, sample);
      await page.screenshot({ path: info.outputPath('markdown-insertion-dialog.png'), animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(editor.getByRole('heading', { name: 'Imported document', exact: true })).toBeVisible();
      await expect(editor.locator('strong')).toHaveText('bold');
      await expect(editor.getByRole('link', { name: 'link', exact: true })).toHaveAttribute('href', 'https://example.test/docs');
      await expect(editor.locator('li')).toHaveText(['First item', 'Second item']);
      await expect(editor.locator('td')).toHaveText(['Alpha', 'Beta']);
      await expect(editor.locator('pre')).toHaveText('console.log("hello");');
      const imported = await tree(page);
      await expect.poll(() => tree(peer)).toEqual(imported);
      await editor.getByRole('heading', { name: 'Imported document', exact: true }).click({ clickCount: 3 });
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe('Imported document');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.insertText(' edited');
      await expect(editor.locator('h1')).toHaveText('Imported document edited');
      const edited = await tree(page);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => tree(page)).toEqual(imported);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => tree(page)).toEqual(initial);
      await expect.poll(() => tree(peer)).toEqual(initial);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(() => tree(page)).toEqual(imported);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(() => tree(page)).toEqual(edited);
      await expect.poll(() => tree(peer)).toEqual(edited);
      await expect.poll(() => persistedText(page, headers, path), { timeout: 20_000 }).toContain('# Imported document edited');
      const saved = await persistedText(page, headers, path);
      expect(saved).toContain('**bold**');
      expect(saved).toContain('console.log("hello");');
      await page.screenshot({ path: info.outputPath('markdown-insertion-formatted.png'), animations: 'disabled' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect.poll(() => tree(page)).toEqual(edited);
      await peer.reload({ waitUntil: 'domcontentloaded' });
      await peer.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(peer.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect.poll(() => tree(peer)).toEqual(edited);
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
    } finally {
      await peerContext.close();
      if (!page.isClosed()) await page.goto('about:blank', { timeout: 5_000 }).catch(() => undefined);
      await page.request.delete('/api/files/delete', { headers, data: { path } });
    }
  });

  test('selection replacement is one undo and invalid drafts or a changed peer selection preserve the document', async ({ page, browser }, info) => {
    const headers = await login(page);
    const path = `editor-markdown-selection-${randomUUID()}.md`;
    await uploadWorkspaceTextFile({ request: page.request, workspaceId: headers['x-canvas-workspace-id'],
      filePath: path, content: 'Before stays.\n\nReplace me.\n\nAfter stays.\n' });
    const peerContext = await browser.newContext({ baseURL: process.env.BASE_URL });
    const peer = await peerContext.newPage();
    try {
      expect(await login(peer, true)).toEqual(headers);
      await expectDistinctUsers(page, peer);
      await openEditor(page, path);
      await openEditor(peer, path);
      const editor = page.locator(editorSelector);
      await editor.getByText('Before stays.', { exact: true }).click();
      await page.keyboard.press('End');
      await page.keyboard.insertText(' Typed first.');
      const before = await tree(page);
      await editor.getByText('Replace me.', { exact: true }).dblclick({ position: { x: 20, y: 10 } });
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Replace');
      let dialog = await openInsertDialog(page);
      await pasteDraft(page, dialog, '**Replaced**');
      await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(editor.locator('strong')).toHaveText('Replaced');
      await expect(editor.getByText('Replaced me.', { exact: true })).toBeVisible();
      const replaced = await tree(page);
      expect(replaced.content?.[0]).toEqual(before.content?.[0]);
      expect(replaced.content?.at(-1)).toEqual(before.content?.at(-1));
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => tree(page)).toEqual(before);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(() => tree(page)).toEqual(replaced);
      await expect.poll(() => tree(peer)).toEqual(replaced);
      await expect.poll(() => persistedText(page, headers, path), { timeout: 20_000 }).toContain('**Replaced** me.');
      const saved = await persistedText(page, headers, path);
      dialog = await openInsertDialog(page);
      for (const draft of ['---\ntitle: Preserve this metadata\n---\n\n# Document\n', '<custom-widget>Keep this verbatim</custom-widget>\n']) {
        await pasteDraft(page, dialog, draft);
        const insert = dialog.getByRole('button', { name: 'Insert', exact: true });
        if (await insert.isEnabled()) await insert.click();
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(draft);
        expect(await tree(page)).toEqual(replaced);
        expect(await persistedText(page, headers, path)).toBe(saved);
      }
      await page.screenshot({ path: info.outputPath('markdown-insertion-rejected.png'), animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await editor.getByText('Before stays. Typed first.', { exact: true }).dblclick({ position: { x: 20, y: 10 } });
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Before');
      dialog = await openInsertDialog(page);
      await pasteDraft(page, dialog, '**Do not overwrite the peer**');
      await peer.locator(editorSelector).getByText('Before stays. Typed first.', { exact: true }).dblclick({ position: { x: 20, y: 10 } });
      await expect.poll(() => peer.evaluate(() => window.getSelection()?.toString())).toBe('Before');
      await peer.keyboard.insertText('Peer');
      await expect(editor.getByText('Peer stays. Typed first.', { exact: true })).toBeVisible();
      const peerChanged = await tree(page);
      const insert = dialog.getByRole('button', { name: 'Insert', exact: true });
      if (await insert.isEnabled()) await insert.click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue('**Do not overwrite the peer**');
      expect(await tree(page)).toEqual(peerChanged);
      await expect.poll(() => tree(peer)).toEqual(peerChanged);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect.poll(() => persistedText(page, headers, path), { timeout: 20_000 }).toContain('Peer stays. Typed first.');
      expect(await persistedText(page, headers, path)).not.toContain('Do not overwrite the peer');
    } finally {
      await peerContext.close();
      if (!page.isClosed()) await page.goto('about:blank', { timeout: 5_000 }).catch(() => undefined);
      await page.request.delete('/api/files/delete', { headers, data: { path } });
    }
  });

  test.describe('mobile toolbar', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('the same dialog fits a reduced viewport and inserts from touch controls', async ({ page }, info) => {
      info.annotations.push({ type: 'input-scope', description: 'Touch and reduced viewport are emulated; this does not validate an operating-system keyboard or IME.' });
      const headers = await login(page);
      const path = `editor-markdown-mobile-${randomUUID()}.md`;
      expect((await page.request.post('/api/files/create', { headers, data: { path, type: 'file' } })).ok()).toBe(true);
      try {
        await openEditor(page, path);
        const editor = page.locator(editorSelector);
        await editor.tap();
        await page.setViewportSize({ width: 390, height: 544 });
        await page.getByRole('button', { name: insertTitle, exact: true }).filter({ visible: true }).tap();
        const dialog = page.getByRole('dialog', { name: insertTitle, exact: true });
        await expect(dialog).toBeVisible();
        await expect(page.getByRole('toolbar', { name: 'Markdown tools', exact: true }).filter({ visible: true })).toHaveCount(0);
        await pasteDraft(page, dialog, '# Mobile import\n\n- First\n- Second\n');
        const fit = await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
        });
        expect(fit).toBe(true);
        await expect(dialog.getByRole('button', { name: 'Insert', exact: true })).toBeInViewport();
        await page.screenshot({ path: info.outputPath('markdown-insertion-mobile.png'), animations: 'disabled' });
        await dialog.getByRole('button', { name: 'Insert', exact: true }).tap();
        await expect(dialog).toHaveCount(0);
        await expect(editor.getByRole('heading', { name: 'Mobile import', exact: true })).toBeVisible();
        await expect(editor.locator('li')).toHaveText(['First', 'Second']);
        await expect.poll(() => persistedText(page, headers, path), { timeout: 20_000 }).toContain('# Mobile import');
        await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      } finally {
        if (!page.isClosed()) await page.goto('about:blank', { timeout: 5_000 }).catch(() => undefined);
        await page.request.delete('/api/files/delete', { headers, data: { path } });
      }
    });
  });
});
