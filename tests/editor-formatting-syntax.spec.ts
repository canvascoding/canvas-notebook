import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { getSchema, type JSONContent } from '@tiptap/core';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { COLLABORATION_CLIENT_CAPABILITIES, type CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { analyzeMarkdownRichMode, createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100';
const selector = '.tiptap-editor-shell .ProseMirror';
const execFileAsync = promisify(execFile);
type Workspace = { id: string; name: string; rootRelativePath: string; permissions: { canWrite: boolean } };
type Storage = { richJson: JSONContent; validationCode: string | null; canonicalContent: string | null;
  documentSequence: number; checkpointSequence: number; degraded: boolean; binaryHash: string };

async function fixtureContext(browser: Browser): Promise<BrowserContext> {
  const { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = test.info().project.use;
  return browser.newContext({ baseURL: baseURL || BASE_URL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor });
}

async function login(page: Page, secondary = false): Promise<Workspace> {
  const email = secondary ? process.env.TEST_SECONDARY_EMAIL : process.env.TEST_LOGIN_EMAIL;
  const password = secondary ? process.env.TEST_SECONDARY_PASSWORD : process.env.TEST_LOGIN_PASSWORD;
  expect(Boolean(email && password)).toBe(true);
  expect((await page.request.post('/api/auth/sign-in/email', { headers: { Origin: BASE_URL }, data: { email, password } })).ok()).toBe(true);
  const response = await page.request.get('/api/workspaces');
  expect(response.ok()).toBe(true);
  const workspace = ((await response.json()).workspaces as Workspace[])
    .find((item) => item.name === 'Shared Test Workspace' && item.permissions.canWrite);
  expect(workspace).toBeTruthy();
  await page.context().addInitScript((id) => {
    if (window !== window.top) return;
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace!.id);
  return workspace!;
}

const headers = (workspace: Workspace) => ({ 'x-canvas-workspace-id': workspace.id, Origin: BASE_URL });
async function upload(page: Page, workspace: Workspace, filePath: string, content: string) {
  expect((await page.request.post('/api/files/upload', { headers: headers(workspace), multipart: { path: '.',
    files: { name: filePath, mimeType: 'text/markdown', buffer: Buffer.from(content) } } })).ok()).toBe(true);
}

async function mode(page: Page, name: RegExp) {
  await page.getByRole('group', { name: /Document view|Dokumentansicht/u }).getByRole('button', { name }).click();
}

async function openRich(page: Page, filePath: string) {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  await mode(page, /^(Edit|Bearbeiten)$/u);
  await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
}

async function richTree(page: Page): Promise<JSONContent> {
  const snapshot = await page.waitForFunction((selector) => {
    const editor = (document.querySelector(selector) as HTMLElement & {
      editor?: { isDestroyed: boolean; getJSON(): JSONContent } } | null)?.editor;
    return editor && !editor.isDestroyed ? editor.getJSON() : null;
  }, selector);
  try { return await snapshot.jsonValue() as JSONContent; }
  finally { await snapshot.dispose(); }
}

/** DOM selection only; all content changes use actual keyboard input or visible editor buttons. */
async function selectContent(locator: Locator, end = false) {
  await locator.click();
  await locator.evaluate((element, collapse) => {
    const range = document.createRange(); range.selectNodeContents(element);
    if (collapse) range.collapse(false);
    const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }, end);
}

function diskPath(workspace: Workspace, filePath: string) {
  expect(filePath).toMatch(/^editor-formatting-[a-f0-9-]+\.md$/u);
  expect(path.isAbsolute(workspace.rootRelativePath)).toBe(false);
  expect(workspace.rootRelativePath.split(/[\\/]/u)).not.toContain('..');
  expect(process.env.DATA).toBeTruthy();
  return path.resolve(process.env.DATA!, workspace.rootRelativePath, filePath);
}

async function assertProjected(workspace: Workspace, filePath: string, expected: JSONContent) {
  const manager = createRichMarkdownManager();
  const schema = getSchema(richMarkdownCodecExtensions());
  await expect.poll(async () => {
    const markdown = await readFile(diskPath(workspace, filePath), 'utf8');
    return equivalentRichDocument(expected, schema.nodeFromJSON(manager.parse(markdown)).toJSON());
  }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe(true);
}

async function session(page: Page, workspace: Workspace, filePath: string) {
  const response = await page.request.post('/api/files/collaboration/session', { headers: headers(workspace),
    data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES } });
  expect(response.ok()).toBe(true);
  return await response.json() as CollaborationSessionResponse;
}

async function storage(workspace: Workspace, filePath: string, identity: CollaborationSessionResponse): Promise<Storage> {
  const input = { documentId: identity.documentId, workspaceId: workspace.id, path: filePath, includeRichJson: true };
  const { stdout } = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
    ['--conditions', 'react-server', 'scripts/collaboration-e2e-storage-read.ts', Buffer.from(JSON.stringify(input)).toString('base64url')],
    { env: process.env, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout) as Storage;
}

async function localRichTree(page: Page, identity: CollaborationSessionResponse): Promise<JSONContent | null> {
  const updates = await page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return null;
    return new Promise<number[][]>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(new Error('Could not read local Yjs document'));
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('updates', 'readonly');
        const stored = transaction.objectStore('updates').getAll();
        transaction.onerror = () => { database.close(); reject(new Error('Could not read committed Yjs log')); };
        transaction.oncomplete = () => {
          const result = (stored.result as Uint8Array[]).map((update) => Array.from(update));
          database.close(); resolve(result);
        };
      };
    });
  }, `canvas:${identity.documentId}:${identity.lifecycleGeneration}:${identity.representation}`);
  if (!updates) return null;
  const doc = new Y.Doc();
  try { for (const update of updates) Y.applyUpdate(doc, Uint8Array.from(update)); return readRichDocumentJson(doc); }
  finally { doc.destroy(); }
}

async function remove(page: Page, workspace: Workspace | undefined, filePath: string) {
  if (!workspace) return;
  const result = await page.request.delete('/api/files/delete', { headers: headers(workspace), data: { path: filePath } });
  expect(result.ok(), 'Only the synthetic document is deleted during cleanup.').toBe(true);
}

test.describe('formatting preserves Markdown meaning', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the explicitly authorized managed local stack.');
  test.beforeEach(() => { expect(new URL(BASE_URL).origin).toBe('http://127.0.0.1:3100'); });
  test.setTimeout(180_000);

  test('typed input rules, literal delimiters and breaks survive projection, modes and reopen', async ({ browser }, info) => {
    const context = await fixtureContext(browser); const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.name));
    const filePath = `editor-formatting-${randomUUID()}.md`;
    let workspace: Workspace | undefined;
    const rules = [
      { seed: 'Heading seed', prefix: '## ', text: 'Heading # literal', type: 'heading' },
      { seed: 'Bullet seed', prefix: '- ', text: 'List item', type: 'bulletList' },
      { seed: 'Ordered seed', prefix: '1. ', text: 'Numbered item', type: 'orderedList' },
      { seed: 'Quote seed', prefix: '> ', text: 'Quoted text', type: 'blockquote' },
      { seed: 'Code seed', prefix: '```ts ', text: 'const fence = "```"; // \\ | * _', type: 'codeBlock' },
      { seed: 'Task seed', prefix: '[ ] ', text: 'Unchecked task', type: 'taskList' },
    ];
    try {
      workspace = await login(page);
      await upload(page, workspace, filePath, `${rules.map((rule) => rule.seed).join('\n\n')}\n\nSoft\nline\n\nLiteral seed\n\n| First | Second |\n| --- | --- |\n| Table seed | Neighbor |`);
      await openRich(page, filePath);
      for (const rule of rules) {
        await selectContent(page.locator(selector).locator('p').filter({ hasText: new RegExp(`^${rule.seed}$`, 'u') }));
        await page.keyboard.press('Backspace');
        await page.keyboard.type(rule.prefix); // Real input events trigger the installed InputRules.
        await page.keyboard.insertText(rule.text);
      }
      expect((await richTree(page)).content!.slice(0, rules.length).map((node) => node.type)).toEqual(rules.map((rule) => rule.type));
      await selectContent(page.locator(selector).locator('p').filter({ hasText: /^Literal seed$/u }));
      await page.keyboard.insertText('Literal: * _ # > ` \\ |');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.insertText('After  two spaces');
      const cell = page.locator(selector).locator('td p').filter({ hasText: /^Table seed$/u });
      await selectContent(cell);
      await page.keyboard.insertText('Table: * _ # > ` \\ |');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.insertText('Cell  spaces');
      const expected = await richTree(page);
      expect(expected.content?.find((node) => node.type === 'paragraph')?.content?.[0].text).toBe('Soft\nline');
      const literal = expected.content?.find((node) => node.content?.[0].text?.startsWith('Literal:'));
      expect(literal?.content?.map((node) => node.type)).toEqual(['text', 'hardBreak', 'text']);
      await assertProjected(workspace, filePath, expected);
      await mode(page, /^(Source|Quelle)$/u);
      await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
      await mode(page, /^(Read|Lesen)$/u);
      await expect(page.getByRole('heading', { name: 'Heading # literal', exact: true })).toBeVisible();
      await expect(page.locator('.canvas-document-reading')).toContainText('Literal: * _ # > ` \\ |');
      await mode(page, /^(Edit|Bearbeiten)$/u);
      await expect.poll(() => richTree(page)).toEqual(expected);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await mode(page, /^(Edit|Bearbeiten)$/u);
      await expect.poll(() => richTree(page)).toEqual(expected);
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      await assertProjected(workspace, filePath, expected);
      await page.screenshot({ path: info.outputPath('formatting-reopened.png') });
      expect(errors).toEqual([]);
    } finally { try { await remove(page, workspace, filePath); } finally { await context.close(); } }
  });

  test('unrepresentable table code stays live and durable without a lossy Markdown write, then recovers automatically', async ({ browser }, info) => {
    const context = await fixtureContext(browser); let peerContext = await fixtureContext(browser);
    const page = await context.newPage(); let peer = await peerContext.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name)); peer.on('pageerror', (error) => errors.push(error.name));
    const filePath = `editor-formatting-${randomUUID()}.md`;
    let workspace: Workspace | undefined;
    const failures: Array<{ documentId: string; code: string }> = [];
    page.on('websocket', (socket) => {
      if (!new URL(socket.url()).pathname.startsWith('/ws/collaboration')) return;
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string') return;
        try {
          const decoder = decoding.createDecoder(new Uint8Array(payload)); decoding.readVarString(decoder);
          if (![5, 6].includes(decoding.readVarUint(decoder))) return;
          const message = JSON.parse(decoding.readVarString(decoder));
          if (message.type === 'projection_failed') failures.push({ documentId: message.documentId, code: message.code });
        } catch { /* Unrelated protocol frames are not retained. */ }
      });
    });
    try {
      workspace = await login(page); expect((await login(peer, true)).id).toBe(workspace.id);
      await upload(page, workspace, filePath, '| First | Second |\n| --- | --- |\n| Seed | Neighbor |\n\nPeer paragraph');
      await openRich(page, filePath); await openRich(peer, filePath);
      const identity = await session(page, workspace, filePath);
      const cell = page.locator(selector).locator('td p').first();
      await selectContent(cell); await page.keyboard.insertText('odd\\|pipe');
      await assertProjected(workspace, filePath, await richTree(page));
      const safeMarkdown = await readFile(diskPath(workspace, filePath), 'utf8');
      await selectContent(cell);
      await page.getByTestId('markdown-selection-menu').getByRole('button', { name: /^(Inline code|Inline-Code)$/u }).click();
      await expect(cell.locator('code')).toHaveText('odd\\|pipe');
      const invalid = await richTree(page);
      await expect.poll(() => richTree(peer)).toEqual(invalid);
      await expect.poll(() => failures.some((failure) => failure.documentId === identity.documentId
        && failure.code === COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable),
        { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => (await storage(workspace!, filePath, identity)).richJson,
        { timeout: 30_000, intervals: [1_000, 2_000] }).toEqual(invalid);
      const evidence = await storage(workspace, filePath, identity);
      expect(evidence).toMatchObject({ degraded: false, validationCode: 'roundtrip_unstable', canonicalContent: null });
      expect(evidence.documentSequence).toBeGreaterThan(evidence.checkpointSequence);
      await expect.poll(() => localRichTree(page, identity)).toEqual(invalid);
      expect(await readFile(diskPath(workspace, filePath), 'utf8')).toBe(safeMarkdown);
      await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true');
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      await mode(page, /^(Source|Quelle)$/u);
      await expect(page.getByText('The text view is currently unavailable. You can still open the document in Edit.', { exact: true })).toBeVisible();
      await expect(page.locator('.cm-editor')).toHaveCount(0);
      await expect.poll(() => localRichTree(page, identity)).toEqual(invalid);
      expect(await readFile(diskPath(workspace, filePath), 'utf8')).toBe(safeMarkdown);
      await mode(page, /^(Read|Lesen)$/u);
      await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'false');
      await expect.poll(() => richTree(page)).toEqual(invalid);
      await mode(page, /^(Edit|Bearbeiten)$/u);
      await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true');
      await expect.poll(() => richTree(page)).toEqual(invalid);
      await selectContent(peer.locator(selector).locator('p').filter({ hasText: /^Peer paragraph$/u }), true);
      await peer.keyboard.insertText(' while projection is unavailable');
      const updated = await richTree(peer);
      await expect.poll(() => richTree(page)).toEqual(updated);
      await expect.poll(async () => (await storage(workspace!, filePath, identity)).richJson,
        { timeout: 30_000, intervals: [1_000, 2_000] }).toEqual(updated);
      await page.screenshot({ path: info.outputPath('table-code-live-while-projection-rejected.png') });
      expect(await readFile(diskPath(workspace, filePath), 'utf8')).toBe(safeMarkdown);
      await peerContext.close();
      peerContext = await fixtureContext(browser); peer = await peerContext.newPage();
      peer.on('pageerror', (error) => errors.push(error.name));
      expect((await login(peer, true)).id).toBe(workspace.id);
      await openRich(peer, filePath);
      await expect.poll(() => richTree(peer)).toEqual(updated);
      await expect.poll(() => localRichTree(peer, identity)).toEqual(updated);
      await expect(peer.getByTestId('markdown-save-state')).toHaveCount(0);
      await selectContent(cell);
      await page.getByTestId('markdown-selection-menu').getByRole('button', { name: /^(Inline code|Inline-Code)$/u }).click();
      await expect(cell.locator('code')).toHaveCount(0);
      const recovered = await richTree(page);
      await expect.poll(() => richTree(peer)).toEqual(recovered);
      // The supported correction schedules normal projection; no retry button or API forces it.
      await assertProjected(workspace, filePath, recovered);
      await expect.poll(async () => (await storage(workspace!, filePath, identity)).validationCode).toBe(null);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await mode(page, /^(Edit|Bearbeiten)$/u);
      await expect.poll(() => richTree(page)).toEqual(recovered);
      expect(JSON.stringify(recovered)).toContain('odd\\\\|pipe');
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      try { await peerContext.close(); await remove(page, workspace, filePath); }
      finally { await context.close(); }
    }
  });

  test('source-required presentation syntax stays exact through typing, Read and reopen', async ({ browser }, info) => {
    const context = await fixtureContext(browser); const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.name));
    let unexpectedMigrations = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/files/collaboration/session'
        && request.postDataJSON()?.allowRichMigration === true) unexpectedMigrations++;
    });
    const filePath = `editor-formatting-${randomUUID()}.md`;
    let workspace: Workspace | undefined;
    const original = await readFile(path.join(process.cwd(), 'tests/fixtures/markdown-roundtrip/marp-directive-source-only.md'), 'utf8');
    const suffix = '\nLiteral * _ # > ` \\ | and  spaces\n';
    expect(analyzeMarkdownRichMode(original)).toMatchObject({ mode: 'source', reason: 'unsupported_marp_directive' });
    try {
      workspace = await login(page); await upload(page, workspace, filePath, original);
      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Markdown', exact: true }).click();
      await mode(page, /^(Edit|Bearbeiten)$/u);
      const source = page.locator('.cm-content');
      await expect(source).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect(page.getByTestId('markdown-source-preservation-warning')).toBeVisible();
      await expect.poll(async () => (await source.locator('.cm-line').allTextContents()).join('\n')).toBe(original);
      await source.click(); await page.keyboard.press('ControlOrMeta+End');
      await expect.poll(() => source.evaluate((element) => {
        const selection = (element as HTMLElement & { cmTile: { root: { view: {
          state: { selection: { main: { from: number; to: number } } } } } } }).cmTile.root.view.state.selection.main;
        return [selection.from, selection.to];
      })).toEqual([original.length, original.length]);
      await page.keyboard.press('Enter'); await page.keyboard.insertText(suffix.slice(1, -1)); await page.keyboard.press('Enter');
      await expect.poll(async () => (await source.locator('.cm-line').allTextContents()).join('\n')).toBe(original + suffix);
      await expect.poll(() => readFile(diskPath(workspace!, filePath), 'utf8'), { timeout: 30_000 }).toBe(original + suffix);
      await mode(page, /^(Read|Lesen)$/u);
      expect(await readFile(diskPath(workspace, filePath), 'utf8')).toBe(original + suffix);
      await mode(page, /^(Edit|Bearbeiten)$/u);
      await expect(source).toHaveAttribute('contenteditable', 'true');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Markdown', exact: true }).click();
      await mode(page, /^(Edit|Bearbeiten)$/u);
      await expect(source).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect(page.getByTestId('markdown-source-preservation-warning')).toBeVisible();
      await expect.poll(async () => (await source.locator('.cm-line').allTextContents()).join('\n')).toBe(original + suffix);
      expect((await session(page, workspace, filePath)).representation).toBe('plain_text');
      expect(await readFile(diskPath(workspace, filePath), 'utf8')).toBe(original + suffix);
      expect(unexpectedMigrations, 'source-required syntax must never start a rich migration from an empty startup preview').toBe(0);
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('source-required-syntax-reopened.png') });
      expect(errors).toEqual([]);
    } finally { try { await remove(page, workspace, filePath); } finally { await context.close(); } }
  });
});
