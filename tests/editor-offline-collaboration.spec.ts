import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { COLLABORATION_CLIENT_CAPABILITIES, type CollaborationSessionResponse } from '../app/lib/collaboration/types';

const baseURL = process.env.BASE_URL || '';
const selector = '.tiptap-editor-shell .ProseMirror';
const content = '# Offline document\n\nAlpha paragraph.\n\nRemove this block.\n\n- **One** two\n- Three\n\n| Name | Value |\n| --- | --- |\n| A | B |';

async function login(page: Page) {
  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: baseURL }, data: { email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD },
  })).ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((candidate: { name: string; permissions?: { canWrite: boolean } }) =>
    candidate.name === 'Shared Test Workspace' && candidate.permissions?.canWrite);
  expect(workspace?.id).toBeTruthy();
  await page.context().addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  return { 'x-canvas-workspace-id': workspace.id as string };
}

async function upload(page: Page, headers: Record<string, string>, filePath: string, text: string) {
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: filePath, mimeType: filePath.endsWith('.md') ? 'text/markdown' : 'text/plain', buffer: Buffer.from(text),
  } } })).ok()).toBe(true);
}

async function openRich(page: Page, filePath: string) {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
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

async function sessionFor(page: Page, headers: Record<string, string>, filePath: string): Promise<CollaborationSessionResponse> {
  const response = await page.request.post('/api/files/collaboration/session', {
    headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.ok()).toBe(true);
  const session = await response.json() as CollaborationSessionResponse;
  expect(session.success).toBe(true);
  return session;
}

/** Read the browser's actual committed Yjs log; never replace IndexedDB or transport responses. */
async function localSnapshot(page: Page, session: CollaborationSessionResponse): Promise<JSONContent | string | null> {
  const name = `canvas:${session.documentId}:${session.lifecycleGeneration}:${session.representation}`;
  const updates = await page.evaluate(async (databaseName) => {
    if (!(await indexedDB.databases()).some((database) => database.name === databaseName)) return null;
    return new Promise<number[][]>((resolve, reject) => {
      const open = indexedDB.open(databaseName);
      open.onerror = () => reject(new Error('Could not open local Yjs database'));
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('updates', 'readonly');
        const request = transaction.objectStore('updates').getAll();
        transaction.onerror = () => { db.close(); reject(new Error('Could not read committed Yjs updates')); };
        transaction.oncomplete = () => {
          const result = (request.result as Uint8Array[]).map((update) => Array.from(update));
          db.close(); resolve(result);
        };
      };
    });
  }, name);
  if (!updates) return null;
  const doc = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(doc, Uint8Array.from(update));
    return session.representation === 'plain_text' ? doc.getText('content').toString() : readRichDocumentJson(doc);
  } finally { doc.destroy(); }
}

async function deleteBoldWord(page: Page) {
  const bold = page.locator(`${selector} strong`).filter({ hasText: /^One$/ });
  await bold.click();
  await bold.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('Backspace');
  await expect(page.locator(`${selector} li`).first()).toHaveText(' two');
}

async function editRichOffline(page: Page) {
  const initial = await richTree(page);
  await deleteBoldWord(page);
  const deleted = await richTree(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => richTree(page)).toEqual(initial);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => richTree(page)).toEqual(deleted);
  await page.locator(selector).getByText('Alpha paragraph.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Offline suffix.');
  await expect(page.locator(selector).getByText('Alpha paragraph. Offline suffix.', { exact: true })).toBeVisible();
  return richTree(page);
}

async function waitForProjectedText(page: Page, headers: Record<string, string>, filePath: string, marker: string) {
  await expect.poll(async () => (await (await page.request.get('/api/files/read', {
    headers, params: { path: filePath },
  })).json()).data?.content, { timeout: 30_000 }).toContain(marker);
}

async function cleanFiles(context: BrowserContext, headers: Record<string, string>, paths: string[]) {
  await context.setOffline(false);
  await Promise.all(context.pages().map((page) => page.close()));
  await context.request.delete('/api/files/delete', { headers, data: { path: paths } });
}

test.describe('Real local Yjs recovery through browser lifecycles', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the approved managed local stack.');
  test.beforeAll(() => expect(baseURL).toBe('http://127.0.0.1:3100'));
  test.setTimeout(120_000);

  test('offline rich edits survive Read/Source, another document, reopen and reconnect', async ({ page }, info) => {
    const headers = await login(page);
    const filePath = `offline-rich-${randomUUID()}.md`;
    const otherPath = `offline-other-${randomUUID()}.md`;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    await upload(page, headers, filePath, content);
    await upload(page, headers, otherPath, 'Other local document.');
    try {
      await openRich(page, filePath);
      const session = await sessionFor(page, headers, filePath);
      await openRich(page, otherPath);
      await page.getByRole('tab', { name: filePath, exact: true }).click();
      // The selected tab changes before its asynchronous file/session load. Wait
      // for this document's contents before acting on its editor controls.
      await expect(page.getByRole('tabpanel', { name: filePath }).getByText('Alpha paragraph.', { exact: true }))
        .toBeVisible({ timeout: 30_000 });
      await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true');
      await page.context().setOffline(true);
      const changed = await editRichOffline(page);
      await expect.poll(() => localSnapshot(page, session)).toEqual(changed);
      expect((await sessionFor(page, headers, filePath)).stateProof).toBe(session.stateProof);
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.getByText('Alpha paragraph. Offline suffix.', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await expect(page.locator('.cm-content')).toContainText('Offline suffix.');
      await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect.poll(() => richTree(page)).toEqual(changed);
      await page.screenshot({ path: info.outputPath('offline-before-document-switch.png') });
      await page.getByRole('tab', { name: otherPath, exact: true }).click();
      await expect(page.getByText('Other local document.', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: filePath, exact: true }).click();
      await expect.poll(() => richTree(page)).toEqual(changed);
      await page.context().setOffline(false);
      await waitForProjectedText(page, headers, filePath, 'Offline suffix.');
      await page.reload({ waitUntil: 'domcontentloaded' });
      // Reload honors the explicit path in the URL, which opened the other
      // document earlier. Reopen the document under test through its retained tab.
      await page.getByRole('tab', { name: filePath, exact: true }).click();
      await expect(page.getByRole('tabpanel', { name: filePath })).toBeVisible();
      await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
      await expect.poll(() => richTree(page)).toEqual(changed);
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await cleanFiles(page.context(), headers, [filePath, otherPath]); }
  });

  test('plain-text source deletes, undo/redo and reconnect preserve committed local Yjs', async ({ page }) => {
    const headers = await login(page);
    const filePath = `offline-source-${randomUUID()}.txt`;
    await upload(page, headers, filePath, 'First\nMiddle\nLast');
    try {
      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      const editor = page.locator('.cm-content[contenteditable="true"]');
      await expect(editor).toBeVisible({ timeout: 30_000 });
      const session = await sessionFor(page, headers, filePath);
      expect(session.representation).toBe('plain_text');
      await page.context().setOffline(true);
      await editor.click(); await page.keyboard.press('ControlOrMeta+Home');
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End'); await page.keyboard.press('Delete'); await page.keyboard.press('Delete');
      await expect.poll(() => localSnapshot(page, session)).toBe('First\nLast');
      await page.keyboard.press('ControlOrMeta+z');
      // CodeMirror may group the two adjacent deletions; redo must return exactly to the committed edit.
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(() => localSnapshot(page, session)).toBe('First\nLast');
      await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('\nOffline source');
      await expect.poll(() => localSnapshot(page, session)).toBe('First\nLast\nOffline source');
      await page.context().setOffline(false);
      await waitForProjectedText(page, headers, filePath, 'First\nLast\nOffline source');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editor).toContainText('Offline source');
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
    } finally { await cleanFiles(page.context(), headers, [filePath]); }
  });

  test('diagnostic: offline document switching after Source was loaded online', async ({ page }, info) => {
    info.annotations.push({ type: 'diagnostic', description: 'Preloads Source online to isolate document reopening from first-use chunk availability. The cold-Source acceptance case above remains separate.' });
    const headers = await login(page);
    const filePath = `offline-warm-rich-${randomUUID()}.md`;
    const otherPath = `offline-warm-other-${randomUUID()}.md`;
    await upload(page, headers, filePath, content);
    await upload(page, headers, otherPath, 'Other local document.');
    try {
      await openRich(page, filePath);
      const session = await sessionFor(page, headers, filePath);
      await openRich(page, otherPath);
      await page.getByRole('tab', { name: filePath, exact: true }).click();
      await expect(page.getByRole('tabpanel', { name: filePath }).getByText('Alpha paragraph.', { exact: true }))
        .toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true');
      await page.context().setOffline(true);
      const changed = await editRichOffline(page);
      await expect.poll(() => localSnapshot(page, session)).toEqual(changed);
      expect((await sessionFor(page, headers, filePath)).stateProof).toBe(session.stateProof);
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await expect(page.locator('.cm-content')).toContainText('Offline suffix.');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect.poll(() => richTree(page)).toEqual(changed);
      await page.getByRole('tab', { name: otherPath, exact: true }).click();
      await expect(page.getByText('Other local document.', { exact: true })).toBeVisible({ timeout: 10_000 });
      await page.getByRole('tab', { name: filePath, exact: true }).click();
      await expect.poll(() => richTree(page)).toEqual(changed);
    } finally { await cleanFiles(page.context(), headers, [filePath, otherPath]); }
  });

  test('a new browser process restores the retained profile before collaboration reconnects', async ({ playwright, browserName }, info) => {
    const profile = info.outputPath('retained-browser-profile');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const browserType = playwright[browserName];
    let context = await browserType.launchPersistentContext(profile, { headless: true, baseURL, viewport: { width: 1280, height: 720 } });
    let page = context.pages()[0] ?? await context.newPage();
    const headers = await login(page);
    const filePath = `offline-profile-${randomUUID()}.md`;
    await upload(page, headers, filePath, content);
    try {
      await openRich(page, filePath);
      const session = await sessionFor(page, headers, filePath);
      await context.setOffline(true);
      const changed = await editRichOffline(page);
      await expect.poll(() => localSnapshot(page, session)).toEqual(changed);
      expect((await sessionFor(page, headers, filePath)).stateProof).toBe(session.stateProof);
      await context.close(); // Closes this persistent browser process, retaining its on-disk profile.
      context = await browserType.launchPersistentContext(profile, { headless: true, baseURL, viewport: { width: 1280, height: 720 } });
      let reconnect = false;
      await context.routeWebSocket(/\/ws\/collaboration(?:[/?]|$)/, (socket) => {
        if (reconnect) socket.connectToServer();
        else socket.close({ code: 1013, reason: 'Acceptance test: reconnect withheld' });
      });
      page = context.pages()[0] ?? await context.newPage();
      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      // HTTP serves the real application. Only its collaboration transport is interrupted;
      // no authentication, file, Yjs, or IndexedDB response is mocked.
      await expect.poll(() => localSnapshot(page, session)).toEqual(changed);
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.getByText('Alpha paragraph. Offline suffix.', { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('profile-restored-before-reconnect.png') });
      reconnect = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect.poll(() => richTree(page), { timeout: 30_000 }).toEqual(changed);
      await waitForProjectedText(page, headers, filePath, 'Offline suffix.');
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      info.annotations.push({ type: 'scope', description: 'Actual browser process/profile restart after committed IndexedDB; not an OS crash or disk-loss simulation.' });
    } finally {
      await cleanFiles(context, headers, [filePath]).catch(() => undefined);
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
});

// The pre-fix causal trace records six open SSE requests, a five-second queued
// fetch, and release 124ms after closing a tab. This regression now asserts the
// supported multi-tab behavior through the actual replacement transport.
test('same-browser tabs keep ordinary HTTP requests and document locations available', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local stack.');
  expect(baseURL).toBe('http://127.0.0.1:3100');
  test.setTimeout(90_000);
  const headers = await login(page);
  const filePath = `offline-http-pool-${randomUUID()}.md`;
  const movedPath = filePath.replace('.md', '-moved.md');
  await upload(page, headers, filePath, 'HTTP connection pool fixture.');
  const second = await page.context().newPage();
  const third = await page.context().newPage();
  const pages = [page, second, third];
  const liveSubscriptions = pages.map(() => new Set<string>());
  const syncStatuses: number[] = [];
  const eventSources: string[] = [];
  const errors: string[] = [];
  pages.forEach((candidate, index) => {
    candidate.on('pageerror', error => errors.push(error.name));
    candidate.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.request().method() === 'POST' && path === '/api/files/watch') syncStatuses.push(response.status());
      if (response.request().method() === 'GET' && ['/api/files/watch', '/api/files/presence', '/api/terminal/availability'].includes(path)) eventSources.push(path);
    });
    candidate.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/ws/live-events') return;
      socket.on('framereceived', event => {
        const message = JSON.parse(typeof event.payload === 'string' ? event.payload : event.payload.toString());
        if (message.type === 'open' && typeof message.id === 'string') liveSubscriptions[index].add(message.id);
      });
    });
  });
  const readable = async (candidate: Page) => {
    await expect(candidate.getByText('HTTP connection pool fixture.', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await candidate.evaluate(async () => (await fetch('/api/health?multitab-probe=1', {
      cache: 'no-store', signal: AbortSignal.timeout(5000),
    })).status)).toBe(200);
  };
  try {
    for (const candidate of pages) {
      await candidate.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await readable(candidate);
    }
    await expect.poll(() => liveSubscriptions.map(entries => entries.size)).toEqual([3, 3, 3]);
    await expect.poll(() => syncStatuses.filter(status => status === 200).length).toBeGreaterThanOrEqual(3);
    expect(eventSources).toEqual([]);
    expect(syncStatuses.every(status => status === 200)).toBe(true);
    expect((await page.request.post('/api/files/rename', { headers, data: { oldPath: filePath, newPath: movedPath, updateLinks: false } })).ok()).toBe(true);
    for (const candidate of pages) {
      await expect.poll(() => new URL(candidate.url()).searchParams.get('path'), { timeout: 30_000 }).toBe(movedPath);
      await readable(candidate);
    }
    await page.screenshot({ path: info.outputPath('same-browser-live-events-multitab.png') });
    await page.close();
    await readable(second); await readable(third);
    expect(errors).toEqual([]);
    await info.attach('live-events-multitab', { body: JSON.stringify({ pages: 3, subscriptions: liveSubscriptions.map(entries => entries.size),
      syncStatuses, legacyEventSources: eventSources.length, renamed: true, survivingTabs: 2 }), contentType: 'application/json' });
  } finally { await cleanFiles(second.context(), headers, [filePath, movedPath]); }
});


test('a native fixture file event invalidates the actual HTTP tree and reference caches', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local stack.');
  expect(baseURL).toBe('http://127.0.0.1:3100');
  test.setTimeout(90_000);
  const headers = await login(page);
  const workspaceId = headers['x-canvas-workspace-id'];
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { id: string }) => entry.id === workspaceId);
  const relativeRoot = workspace?.rootRelativePath;
  expect(typeof relativeRoot).toBe('string');
  expect(nodePath.isAbsolute(relativeRoot)).toBe(false);
  expect(relativeRoot.split(/[\\/]/).includes('..')).toBe(false);
  const dataRoot = process.env.DATA;
  expect(dataRoot && nodePath.isAbsolute(dataRoot)).toBe(true);
  const folder = `native-live-cache-${randomUUID()}`;
  const nativeRelative = `${folder}/native-created.md`;
  const fixtureRoot = nodePath.join(dataRoot!, relativeRoot, folder);
  expect((await page.request.post('/api/files/create', { headers, data: { path: folder, type: 'directory' } })).ok()).toBe(true);
  expect((await page.request.post('/api/files/upload', { headers, multipart: { path: folder, files: {
    name: 'seed.md', mimeType: 'text/markdown', buffer: Buffer.from('Synthetic cache seed.'),
  } } })).ok()).toBe(true);
  type ProbeWindow = Window & { __cacheProbe?: { socket: WebSocket; events: Array<{ relativePath?: string }> } };
  try {
    // Verify the exact host/container mount using the fixture we just created;
    // no pre-existing workspace document is read or modified by the native write.
    expect(await readFile(nodePath.join(fixtureRoot, 'seed.md'), 'utf8')).toBe('Synthetic cache seed.');
    await page.goto('/api/health', { waitUntil: 'domcontentloaded' });
    const clientId = await page.evaluate(async ({ workspaceId }) => new Promise<string>((resolve, reject) => {
      const url = new URL('/ws/live-events', window.location.href); url.protocol = 'ws:';
      const socket = new WebSocket(url, 'canvas-live-events-v1');
      const state = { socket, events: [] as Array<{ relativePath?: string }> };
      (window as ProbeWindow).__cacheProbe = state;
      socket.onerror = () => reject(new Error('Fixture watcher connection failed.'));
      socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe', id: 'native-cache', channel: 'files', workspaceId }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'error') { reject(new Error(`Fixture watcher returned status ${message.status}`)); return; }
        if (message.type !== 'event') return;
        const value = JSON.parse(message.event.data);
        if (message.event.event === 'connected') resolve(value.clientId);
        else if (message.event.event === 'filechange') state.events.push(value);
      };
    }), { workspaceId });
    expect((await page.request.post('/api/files/watch', { headers, data: { clientId, dirs: [folder] } })).ok()).toBe(true);
    const getTree = async () => {
      const response = await page.request.get('/api/files/tree', { headers, params: { path: folder, depth: '0' } });
      expect(response.ok()).toBe(true); return (await response.json()).data as Array<{ path: string }>;
    };
    const getReferences = async () => {
      const response = await page.request.get('/api/files/list', { headers, params: { q: folder, limit: '50' } });
      expect(response.ok()).toBe(true); return (await response.json()).files as Array<{ path: string }>;
    };
    expect((await getTree()).some(entry => entry.path === `${folder}/seed.md`)).toBe(true);
    expect((await getReferences()).some(entry => entry.path === `${folder}/seed.md`)).toBe(true);
    await writeFile(nodePath.join(fixtureRoot, 'native-created.md'), 'Native synthetic fixture.', { flag: 'wx' });
    await expect.poll(() => page.evaluate(relative => (window as ProbeWindow).__cacheProbe?.events.some(event => event.relativePath === relative), nativeRelative),
      { timeout: 10_000 }).toBe(true);
    // This page has no Notebook UI. Therefore no background noCache=true tree
    // refresh can hide a missed invalidation in the actual HTTP route bundle.
    const treeContains = (await getTree()).some(entry => entry.path === nativeRelative);
    const referencesContain = (await getReferences()).some(entry => entry.path === nativeRelative);
    const nativeRead = await page.request.get('/api/files/read', { headers, params: { path: nativeRelative } });
    expect(nativeRead.ok()).toBe(true);
    expect((await nativeRead.json()).data.content).toBe('Native synthetic fixture.');
    await info.attach('native-cache-invalidation', { body: JSON.stringify({ eventReceived: true, treeContains, referencesContain, nativeRead: true }), contentType: 'application/json' });
    expect.soft(treeContains, 'The native watcher must invalidate the HTTP tree cache immediately.').toBe(true);
    expect.soft(referencesContain, 'The native watcher must invalidate the HTTP file-reference cache immediately.').toBe(true);
  } finally {
    await page.evaluate(() => (window as ProbeWindow).__cacheProbe?.socket.close()).catch(() => undefined);
    await cleanFiles(page.context(), headers, [folder]);
  }
});
