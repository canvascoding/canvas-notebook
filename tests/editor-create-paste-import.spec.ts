import { randomUUID } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { expect, request as playwrightRequest, test, type Dialog, type Locator, type Page, type Response } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES, COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import { assertCompletedWorkspaceMarkdownCreate, authenticateManagedTestPage } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { nativeRichParagraph } from './helpers/native-rich-paragraph';
import { installPassiveNativeRichObservation } from './helpers/passive-native-rich-observation';
import { installPassiveWebSocketObservation, type PassiveWebSocketObservation, type PassiveWebSocketSnapshot } from './helpers/passive-ws-observation';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { observeNativeDurabilityAcknowledgements } from './helpers/native-durability-ack';
import { installOwnedCollaborationOutage } from './helpers/owned-collaboration-outage';
import { readNativeRichLocalRecovery } from './helpers/native-rich-local-recovery';
import { installPassiveEditorFocusObservation, type PassiveEditorFocusObservation, type PassiveEditorFocusSnapshot } from './helpers/passive-editor-focus-observation';

const editorSelector = '.tiptap-editor-shell .ProseMirror';
const importTitle = 'Insert Markdown…';
const plainText = 'First paste: äöü ß 😀\nSecond line preserves plain text.\n\nLast paragraph.';
const markdownBody = '# Imported heading\n\nA **bold** paragraph with a [link](https://example.test/docs).\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n\n```javascript\nconsole.log("hello");\n```\n';

type Workspace = { id: string; headers: Record<string, string> };
type NativeCandidate = Awaited<ReturnType<typeof readNativeRichCandidate>>;
type TestSession = { documentId: string; lifecycleGeneration: number; representation: string; documentSequence: number;
  success: boolean; provider: string; schemaVersion: number; richTextSchemaVersion: number; blockTreeFormatVersion: number;
  stateProof: string; stateVector: string; degraded: boolean };

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

async function createInUi(page: Page, workspace: Workspace, path: string, entry: 'home' | 'file-browser', folders: readonly string[] = []) {
  await page.goto(entry === 'home' ? '/en' : `/en/files?workspaceId=${workspace.id}`);
  let dialog: Locator;
  const name = folders.length ? path.split('/').at(-1)! : path;
  if (entry === 'home') {
    await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'New note', exact: true });
    await dialog.getByLabel('Note name', { exact: true }).fill(name);
    if (folders.length) await dialog.getByText('Choose another folder', { exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Create new file', exact: true });
    await dialog.getByLabel('File name', { exact: true }).fill(name);
  }
  let parent = '';
  for (const folder of folders) {
    parent = parent ? `${parent}/${folder}` : folder;
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
    await dialog.getByLabel('New folder name', { exact: true }).fill(folder);
    await waitForFileCreateBudget();
    const createdFolder = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
      && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id
      && response.request().postDataJSON()?.path === parent && response.request().postDataJSON()?.type === 'directory');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    expect((await createdFolder).status()).toBe(200);
    await expect(dialog.getByLabel('New folder name', { exact: true })).toBeHidden();
    await expect(dialog.getByRole('button', { name: folder, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await waitForFileCreateBudget();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
    && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id
    && response.request().postDataJSON()?.path === path);
  await dialog.getByRole('button', { name: entry === 'home' ? 'Create and open' : 'Create file', exact: true }).click();
  const response = await created;
  await assertCompletedWorkspaceMarkdownCreate(response, {
    requestId: response.request().postDataJSON().requestId, workspaceId: workspace.id, targetPath: path,
  });
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
  return nativeRichParagraph(page, editorSelector, text);
}

async function readText(page: Page, workspace: Workspace, path: string): Promise<string> {
  const response = await page.request.get('/api/files/read', { headers: workspace.headers, params: { path } });
  expect(response.ok()).toBe(true);
  return (await response.json()).data.content;
}

async function session(page: Pick<Page, 'request'>, workspace: Workspace, path: string) {
  const response = await page.request.post('/api/files/collaboration/session', {
    headers: workspace.headers, data: { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.ok()).toBe(true);
  const value = await response.json();
  expect(value.documentId).toBeTruthy();
  expect(value.lifecycleGeneration).toBeGreaterThan(0);
  return value as TestSession;
}

/** SessionPOST derives this proof from persisted native bytes, not a live text
 * read or a merely older successful save. Never force a checkpoint here. */
async function waitForPersistedNativeCandidate(page: Pick<Page, 'request'>, workspace: Workspace, path: string,
  identity: { documentId: string; lifecycleGeneration: number }, candidate: NativeCandidate): Promise<TestSession> {
  let latest: TestSession | undefined;
  await expect.poll(async () => {
    latest = await session(page, workspace, path);
    return { success: latest.success, provider: latest.provider, documentId: latest.documentId,
      lifecycleGeneration: latest.lifecycleGeneration, representation: latest.representation,
      schemaVersion: latest.schemaVersion, richTextSchemaVersion: latest.richTextSchemaVersion,
      blockTreeFormatVersion: latest.blockTreeFormatVersion, stateProof: latest.stateProof,
      stateVector: latest.stateVector, degraded: latest.degraded };
  }, { timeout: 20_000 }).toEqual({ success: true, provider: 'yjs', documentId: identity.documentId,
    lifecycleGeneration: identity.lifecycleGeneration, representation: 'tiptap_blocks',
    schemaVersion: COLLABORATION_SCHEMA_VERSION, richTextSchemaVersion: COLLABORATION_CLIENT_CAPABILITIES.richTextSchemaVersion,
    blockTreeFormatVersion: COLLABORATION_CLIENT_CAPABILITIES.blockTreeFormatVersion,
    stateProof: candidate.stateProof, stateVector: candidate.stateVector, degraded: false });
  if (!latest) throw new Error('The exact native candidate has no persisted session witness.');
  return latest;
}

function observeInitialUiSession(page: Page, workspace: Workspace, path: string) {
  let firstResponse: Response | undefined;
  let requestMatches = false;
  let pageClosed = page.isClosed();
  const dispose = () => {
    page.off('response', onResponse);
    page.off('close', onClose);
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    if (firstResponse || new URL(response.url()).pathname !== '/api/files/collaboration/session'
      || request.method() !== 'POST' || request.headers()['x-canvas-workspace-id'] !== workspace.id) return;
    let body: unknown;
    try { body = request.postDataJSON(); } catch { return; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Reflect.get(body, 'path') !== path) return;
    // Select the first scoped response even if its status or capabilities are wrong.
    firstResponse = response;
    const expected = { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES };
    requestMatches = Object.keys(body).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => Reflect.get(body, key) === value);
    dispose();
  };
  const onClose = () => { pageClosed = true; dispose(); };
  if (!pageClosed) {
    page.on('response', onResponse);
    page.on('close', onClose);
  }
  return {
    dispose,
    async read() {
      if (pageClosed || page.isClosed()) throw new Error('The page closed before its opening session was inspected.');
      if (!firstResponse) throw new Error('The ready editor did not expose its scoped opening session response.');
      expect(requestMatches, 'The opening request must use the exact auto/Yjs capabilities.').toBe(true);
      expect(firstResponse.status(), 'The first scoped UI opening session must succeed.').toBe(200);
      const value: unknown = await firstResponse.json().catch(() => null);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The UI opening session is not a JSON object.');
      expect(Reflect.get(value, 'success') === true, 'The UI opening session must report success.').toBe(true);
      expect(Reflect.get(value, 'provider') === 'yjs', 'The UI opening session must use Yjs.').toBe(true);
      expect(Reflect.get(value, 'representation') === 'tiptap_blocks', 'The UI opening session must use the final rich representation.').toBe(true);
      expect(Reflect.get(value, 'schemaVersion') === COLLABORATION_SCHEMA_VERSION, 'The UI opening session schema must match.').toBe(true);
      expect(Reflect.get(value, 'richTextSchemaVersion') === COLLABORATION_CLIENT_CAPABILITIES.richTextSchemaVersion,
        'The UI opening rich text schema must match.').toBe(true);
      expect(Reflect.get(value, 'blockTreeFormatVersion') === COLLABORATION_CLIENT_CAPABILITIES.blockTreeFormatVersion,
        'The UI opening block tree format must match.').toBe(true);
      const documentId: unknown = Reflect.get(value, 'documentId');
      const lifecycleGeneration: unknown = Reflect.get(value, 'lifecycleGeneration');
      const documentSequence: unknown = Reflect.get(value, 'documentSequence');
      if (typeof documentId !== 'string' || !documentId.trim()) throw new Error('The UI opening session has no document identity.');
      if (typeof lifecycleGeneration !== 'number' || !Number.isSafeInteger(lifecycleGeneration) || lifecycleGeneration <= 0) {
        throw new Error('The UI opening session has no positive safe lifecycle generation.');
      }
      if (typeof documentSequence !== 'number' || !Number.isSafeInteger(documentSequence) || documentSequence < 0) {
        throw new Error('The UI opening session has no safe document sequence.');
      }
      return { documentId, lifecycleGeneration, representation: 'tiptap_blocks' as const, documentSequence };
    },
  };
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
      const acknowledgements = observeNativeDurabilityAcknowledgements(page);
      const departureDialogs: string[] = [];
      const preventPendingDeparture = async (dialog: Dialog) => {
        departureDialogs.push(dialog.type());
        await dialog.dismiss();
      };
      page.on('dialog', preventPendingDeparture);
      const openingSession = observeInitialUiSession(page, workspace, path);
      const nativeObservations: Awaited<ReturnType<typeof installPassiveNativeRichObservation>>[] = [];
      const wsObservers: Array<{ role: 'owner' | 'peer'; observer?: PassiveWebSocketObservation;
        issues: Array<'install_failed' | 'dispose_failed' | 'collect_failed'> }> = [];
      const wsWarning = () => { try { console.warn('[I07 passive WebSocket observation] Optional diagnostic unavailable.'); } catch { /* Diagnostics never fail the test. */ } };
      const observeWs = async (target: Page, role: 'owner' | 'peer') => {
        const item: (typeof wsObservers)[number] = { role, issues: [] }; wsObservers.push(item);
        try {
          item.observer = await installPassiveWebSocketObservation(target);
          if (!item.observer.snapshot().available) wsWarning();
        } catch { item.issues.push('install_failed'); wsWarning(); }
      };
      let wsFinished: Promise<void> | undefined;
      const finishWs = () => {
        wsFinished ??= (async () => {
          const observations: Array<{ role: 'owner' | 'peer'; issues: string[]; snapshot: PassiveWebSocketSnapshot | null }> = [];
          for (const item of wsObservers) {
            try { await item.observer?.dispose(); }
            catch { item.issues.push('dispose_failed'); wsWarning(); }
            let snapshot: PassiveWebSocketSnapshot | null = null;
            try { snapshot = item.observer?.snapshot() ?? null; }
            catch { item.issues.push('collect_failed'); wsWarning(); }
            if (snapshot?.observerIssues.length) wsWarning();
            observations.push({ role: item.role, issues: [...item.issues], snapshot });
          }
          try {
            const artifact = info.outputPath('passive-websocket-observation.json');
            await writeFile(artifact, `${JSON.stringify({ observations }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
            await info.attach('passive-websocket-observation', { path: artifact, contentType: 'application/json' });
            const attachment = info.attachments.find(item => item.name === 'passive-websocket-observation');
            if (attachment?.path) await chmod(attachment.path, 0o600);
          } catch { wsWarning(); }
        })().catch(() => { wsWarning(); });
        return wsFinished;
      };
      try {
        await createInUi(page, workspace, path, entry);
        const identity = await openingSession.read();
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
        nativeObservations.push(await installPassiveNativeRichObservation(page, editorSelector, 'owner'));
        await observeWs(page, 'owner');
        expect(await login(peer, true)).toEqual(workspace);
        const users = await Promise.all([page, peer].map(async target =>
          (await (await target.request.get('/api/auth/get-session')).json()).user.id as string));
        expect(users[0]).not.toBe(users[1]);
        await open(peer, workspace, path);
        nativeObservations.push(await installPassiveNativeRichObservation(peer, editorSelector, 'peer'));
        await observeWs(peer, 'peer');
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
        const beforeUndo = await readNativeRichCandidate(page, editorSelector);
        // The peer must actually receive the intermediate insertion. A later
        // PM-only equality could otherwise pass against its untouched old doc.
        await expect.poll(async () => {
          const candidate = await readNativeRichCandidate(peer, editorSelector);
          return { document: candidate.document, stateProof: candidate.stateProof, stateVector: candidate.stateVector };
        }).toEqual({ document: beforeUndo.document, stateProof: beforeUndo.stateProof, stateVector: beforeUndo.stateVector });
        await page.keyboard.press('ControlOrMeta+z');
        await expect(page.locator(editorSelector)).not.toContainText('Own edit.');
        await expect(page.locator(editorSelector)).toContainText('Peer keeps this.');
        const finalCandidate = await readNativeRichCandidate(page, editorSelector);
        expect(finalCandidate.guid).toBe(beforeUndo.guid);
        expect(finalCandidate.stateVector).toBe(beforeUndo.stateVector);
        expect(finalCandidate.stateProof).not.toBe(beforeUndo.stateProof);
        const final = finalCandidate.document;
        await expect.poll(() => tree(peer)).toEqual(final);
        await expect.poll(async () => (await readNativeRichCandidate(peer, editorSelector)).stateProof).toBe(finalCandidate.stateProof);
        await expect.poll(() => readText(page, workspace, path), { timeout: 20_000 }).toContain('Peer keeps this.');
        const persisted = await waitForPersistedNativeCandidate(page, workspace, path, identity, finalCandidate);
        expect(persisted.documentId).toBe(identity.documentId);
        expect(persisted.lifecycleGeneration).toBe(identity.lifecycleGeneration);
        expect(persisted.documentSequence).toBeGreaterThan(identity.documentSequence);
        await expect.poll(() => acknowledgements.hasAcknowledged(identity, finalCandidate)).toBe(true);
        expect(await readNativeRichCandidate(page, editorSelector)).toEqual(finalCandidate);
        await info.attach('final-undo-durability', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
          documentId: identity.documentId, generation: identity.lifecycleGeneration, sequence: persisted.documentSequence,
          beforeUndoProof: beforeUndo.stateProof, stateProof: finalCandidate.stateProof,
          stateVector: finalCandidate.stateVector, clientAcknowledged: true,
        })) });
        await page.screenshot({ path: info.outputPath(`manual-${entry}-paste.png`), animations: 'disabled' });
        await Promise.allSettled(nativeObservations.map(observation => observation.finish(info)));
        await finishWs();
        await peerContext.close();
        await page.goto('about:blank');
        expect(departureDialogs, 'A saved departure must not silently accept a pending warning.').toEqual([]);
        const freshContext = await browser.newContext({ baseURL: process.env.BASE_URL });
        try {
          const fresh = await freshContext.newPage();
          expect(await login(fresh)).toEqual(workspace);
          await open(fresh, workspace, path);
          await expect.poll(() => tree(fresh)).toEqual(final);
          await expect.poll(async () => (await readNativeRichCandidate(fresh, editorSelector)).stateProof).toBe(finalCandidate.stateProof);
          await fresh.reload();
          await expect.poll(() => tree(fresh)).toEqual(final);
          await expect.poll(async () => (await readNativeRichCandidate(fresh, editorSelector)).stateProof).toBe(finalCandidate.stateProof);
        } finally { await freshContext.close(); }
      } finally {
        await Promise.allSettled(nativeObservations.map(observation => observation.finish(info)));
        await finishWs();
        acknowledgements.dispose();
        page.off('dialog', preventPendingDeparture);
        openingSession.dispose();
        await peerContext.close();
        await page.goto('about:blank').catch(() => undefined);
        await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
      }
    });
  }

  for (const departure of ['stay', 'leave'] as const) {
    test(`pending undo: ${departure === 'stay' ? 'stay keeps the live document' : 'explicit leave restores committed local recovery'} before reconnect`,
      async ({ page, context }, info) => {
        info.annotations.push({ type: 'recovery-scope', description:
          'A real blocked WebSocket and offline browser; committed IndexedDB recovery is verified before explicit departure. No immediate crash-durability claim.' });
        const outage = await installOwnedCollaborationOutage(context);
        let remote: Awaited<ReturnType<typeof playwrightRequest.newContext>> | undefined;
        let workspace: Workspace | undefined;
        let active = page;
        const path = `manual-pending-undo-${departure}-${randomUUID()}.md`;
        try {
          workspace = await login(page);
          remote = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL,
            storageState: { cookies: await context.cookies(), origins: [] } });
          const server = { request: remote };
          await createInUi(page, workspace, path, 'home');
          const identity = await session(server, workspace, path);
          await clipboardPaste(page, page.locator(editorSelector), 'Pending undo baseline.');
          await expect(page.locator(editorSelector)).toHaveText('Pending undo baseline.');
          const baseline = await readNativeRichCandidate(page, editorSelector);
          const savedBaseline = await waitForPersistedNativeCandidate(server, workspace, path, identity, baseline);
          const remoteBaseline = { documentId: identity.documentId, generation: identity.lifecycleGeneration,
            sequence: savedBaseline.documentSequence, proof: baseline.stateProof, vector: baseline.stateVector };
          await outage.block();
          await context.setOffline(true);
          await (await nativeParagraph(page, 'Pending undo baseline.')).click();
          await page.keyboard.press('End');
          await page.keyboard.insertText(' Pending own edit.');
          await expect(page.locator(editorSelector)).toHaveText('Pending undo baseline. Pending own edit.');
          const inserted = await readNativeRichCandidate(page, editorSelector);
          await page.keyboard.press('ControlOrMeta+z');
          await expect(page.locator(editorSelector)).toHaveText('Pending undo baseline.');
          const candidate = await readNativeRichCandidate(page, editorSelector);
          expect(candidate.guid).toBe(baseline.guid);
          expect(candidate.document).toEqual(baseline.document);
          expect(candidate.stateVector).toBe(inserted.stateVector);
          expect(candidate.stateVector).not.toBe(baseline.stateVector);
          expect(candidate.stateProof).not.toBe(inserted.stateProof);
          expect(candidate.stateProof).not.toBe(baseline.stateProof);
          const expected = { document: candidate.document, stateProof: candidate.stateProof, stateVector: candidate.stateVector };
          // A transaction-complete read of the actual local log must include
          // the deletion. PM equality with the baseline cannot prove recovery.
          await expect.poll(() => readNativeRichLocalRecovery(page, identity), { timeout: 20_000 }).toEqual(expected);
          const stillRemote = await session(server, workspace, path);
          expect({ documentId: stillRemote.documentId, generation: stillRemote.lifecycleGeneration,
            sequence: stillRemote.documentSequence, proof: stillRemote.stateProof, vector: stillRemote.stateVector })
            .toEqual(remoteBaseline);

          // Installing the listener makes the decision explicit. Playwright's
          // default beforeunload acceptance must never stand in for saved close.
          const originalUrl = page.url();
          const shown = page.waitForEvent('dialog');
          const closing = page.close({ runBeforeUnload: true });
          const dialog = await shown;
          expect(dialog.type()).toBe('beforeunload');
          if (departure === 'stay') {
            await dialog.dismiss();
            await closing;
            expect(page.isClosed()).toBe(false);
            expect(page.url()).toBe(originalUrl);
            expect(await readNativeRichCandidate(page, editorSelector)).toEqual(candidate);
          } else {
            const closed = page.waitForEvent('close');
            await dialog.accept();
            await closing;
            await closed;
            await context.setOffline(false);
            active = await context.newPage();
            await open(active, workspace, path);
            await expect.poll(async () => {
              const restored = await readNativeRichCandidate(active, editorSelector);
              return { document: restored.document, stateProof: restored.stateProof, stateVector: restored.stateVector };
            }, { timeout: 20_000 }).toEqual(expected);
            // HTTP is online, but all collaboration reconnects remain gated.
            // The recovered document cannot be mistaken for a remote save.
          }
          const afterDecision = await session(server, workspace, path);
          expect({ documentId: afterDecision.documentId, generation: afterDecision.lifecycleGeneration,
            sequence: afterDecision.documentSequence, proof: afterDecision.stateProof, vector: afterDecision.stateVector })
            .toEqual(remoteBaseline);
          outage.restore();
          await context.setOffline(false);
          const saved = await waitForPersistedNativeCandidate(server, workspace, path, identity, candidate);
          expect(saved.documentSequence).toBeGreaterThan(savedBaseline.documentSequence);
          await expect.poll(() => tree(active)).toEqual(candidate.document);
          await info.attach(`pending-undo-${departure}`, { contentType: 'application/json', body: Buffer.from(JSON.stringify({
            documentId: identity.documentId, generation: identity.lifecycleGeneration, departure,
            baselineSequence: savedBaseline.documentSequence, recoveredSequence: saved.documentSequence,
            baselineProof: baseline.stateProof, candidateProof: candidate.stateProof,
            committedLocalRecovery: true, explicitBeforeUnloadDecision: true,
          })) });
        } finally {
          await context.setOffline(false);
          try { await outage.dispose(); }
          finally {
            await Promise.allSettled(context.pages().map(target => target.goto('about:blank')));
            try {
              if (remote && workspace) await remote.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
            } finally { await remote?.dispose(); }
          }
        }
      });
  }

  test('manual empty document imports a Markdown body and retains rejected full-document drafts', async ({ page }, info) => {
    const workspace = await login(page);
    const path = `manual-markdown-${randomUUID()}.md`;
    let focusObservation: PassiveEditorFocusObservation | undefined;
    try {
      await createInUi(page, workspace, path, 'home');
      const identity = await session(page, workspace, path);
      focusObservation = await installPassiveEditorFocusObservation(page, editorSelector);
      let dialog = await insertDialog(page);
      await clipboardPaste(page, dialog.getByRole('textbox', { name: 'Markdown', exact: true }), markdownBody);
      await expect(dialog.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(markdownBody);
      await focusObservation.snapshot('before_insert');
      await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
      await focusObservation.snapshot('after_insert');
      const editor = page.locator(editorSelector);
      await expect(dialog).toHaveCount(0);
      try { await expect(editor).toBeFocused(); }
      catch (error) {
        let diagnostic: PassiveEditorFocusSnapshot | { version: 1; observationUnavailable: true } = { version: 1, observationUnavailable: true };
        try {
          await focusObservation.snapshot('focus_assertion_failed');
          diagnostic = await focusObservation.read();
        } catch { /* Retain the original focus assertion if observation is unavailable. */ }
        try {
          await info.attach('passive-editor-focus-observation', {
            contentType: 'application/json', body: Buffer.from(JSON.stringify(diagnostic)),
          });
        } catch { /* Artifact collection must not replace the original assertion. */ }
        throw error;
      }
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
      await focusObservation?.dispose().catch(() => undefined);
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

const firstPasteProfiles = [
  { name: 'desktop', viewport: { width: 1440, height: 960 }, mobile: false },
  { name: 'mobile-web', viewport: { width: 390, height: 844 }, mobile: true },
] as const;

function descendants(document: JSONContent): JSONContent[] {
  return [document, ...(document.content ?? []).flatMap(descendants)];
}

for (const profile of firstPasteProfiles) {
  test.describe(`${profile.name}: nested creation and ordinary Markdown clipboard`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1',
      'Requires the explicitly owned compiled native-document acceptance target.');
    test.use({ viewport: profile.viewport, isMobile: profile.mobile, hasTouch: profile.mobile });
    test.setTimeout(150_000);
    test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

    for (const entry of ['home', 'file-browser'] as const) {
      test(`${entry}: create two nested folders, first ordinary Markdown paste follows paragraph and inline rules`, async ({ page }, info) => {
        const workspace = await login(page);
        const parent = `first-markdown-${randomUUID()}`;
        const path = `${parent}/Notes/First paste.md`;
        const clipboard = '# Ordinary heading\n\n**bold** and *italic* with [[Missing note|Wiki label]] and @{Clipboard member|clipboard-member}.\n\n- List syntax stays a paragraph\n\nhttps://example.test/ordinary-paste';
        try {
          await createInUi(page, workspace, path, entry, [parent, 'Notes']);
          const original = await session(page, workspace, path);
          await clipboardPaste(page, page.locator(editorSelector), clipboard);
          const editor = page.locator(editorSelector);
          await expect(editor).toContainText('# Ordinary heading');
          await expect(editor).toContainText('- List syntax stays a paragraph');
          await expect(editor.locator('strong')).toHaveText('bold');
          await expect(editor.locator('em')).toHaveText('italic');
          await expect(editor.locator('a[href="https://example.test/ordinary-paste"]')).toHaveText('https://example.test/ordinary-paste');
          const pasted = await tree(page);
          expect(pasted.content?.map(node => node.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
          expect(descendants(pasted)).toContainEqual(expect.objectContaining({ type: 'obsidianWikiLink', attrs: expect.objectContaining({ target: 'Missing note|Wiki label' }) }));
          expect(descendants(pasted)).toContainEqual(expect.objectContaining({ type: 'markdownMention', attrs: expect.objectContaining({ label: 'Clipboard member', userId: 'clipboard-member' }) }));
          await expect(editor.locator('h1, h2, ul, ol, pre, table')).toHaveCount(0);
          await expect(page.getByRole('dialog', { name: importTitle, exact: true })).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
          await page.keyboard.press('ControlOrMeta+z'); await expect(editor).toHaveText('');
          await page.keyboard.press('ControlOrMeta+Shift+z'); await expect.poll(() => tree(page)).toEqual(pasted);
          await expect.poll(() => readText(page, workspace, path), { timeout: 20_000 }).toContain('[[Missing note|Wiki label]]');
          await page.reload(); await expect.poll(() => tree(page)).toEqual(pasted);
          const reopened = await session(page, workspace, path);
          expect(reopened.documentId).toBe(original.documentId);
          expect(reopened.lifecycleGeneration).toBe(original.lifecycleGeneration);
          await page.screenshot({ path: info.outputPath(`${profile.name}-${entry}-nested-first-markdown-paste.png`), animations: 'disabled' });
          info.annotations.push({ type: 'acceptance-scope', description: 'Real Chromium clipboard and desktop/mobile-web UI; ordinary paste applies existing inline/wiki/mention/URL rules, with no full Markdown parsing or native-device clipboard claim.' });
        } finally {
          await page.goto('about:blank').catch(() => undefined);
          await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path: parent } });
        }
      });
    }
  });
}

test.describe('Explicit insertion cancellation and original-byte chunk import', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1',
    'Requires the explicitly owned compiled native-document acceptance target.');
  test.setTimeout(150_000);
  test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

  test('cancel a valid Markdown insertion preserves native content, sequence and the next edit', async ({ page }, info) => {
    const workspace = await login(page), path = `cancel-markdown-${randomUUID()}.md`;
    try {
      await createInUi(page, workspace, path, 'home');
      await clipboardPaste(page, page.locator(editorSelector), 'Keep this original paragraph.');
      await expect.poll(() => readText(page, workspace, path), { timeout: 20_000 }).toContain('Keep this original paragraph.');
      const before = await tree(page), identity = await session(page, workspace, path);
      const dialog = await insertDialog(page);
      await clipboardPaste(page, dialog.getByRole('textbox', { name: 'Markdown', exact: true }), markdownBody);
      await expect(dialog.getByRole('button', { name: 'Insert', exact: true })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(await tree(page)).toEqual(before);
      expect((await session(page, workspace, path)).documentSequence).toBe(identity.documentSequence);
      await page.locator(editorSelector).locator('p').click();
      await page.keyboard.press('End'); await page.keyboard.insertText(' Continued.');
      await expect(page.locator(editorSelector)).toContainText('Keep this original paragraph. Continued.');
      await page.keyboard.press('ControlOrMeta+z'); await expect.poll(() => tree(page)).toEqual(before);
      await page.screenshot({ path: info.outputPath('cancel-valid-markdown-preserves-document.png'), animations: 'disabled' });
    } finally {
      await page.goto('about:blank').catch(() => undefined);
      await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
    }
  });

  for (const profile of [
    { name: 'rich-frontmatter-bom-crlf', content: '\uFEFF---\r\ntitle: Complete file\r\n---\r\n\r\n# Heading\r\n', representation: 'tiptap_blocks' },
    { name: 'source-fallback-bom-crlf', content: '\uFEFF<div data-future="preserve">text</div>\r\nA\tB😀\r\n', representation: 'plain_text' },
  ] as const) {
    test(`${profile.name}: genuine chunk import, edit and undo preserve original exported bytes after reload`, async ({ page }, info) => {
      const workspace = await login(page), path = `byte-profile-${profile.name}-${randomUUID()}.md`;
      const bytes = Buffer.from(profile.content);
      const exported = async () => {
        const response = await page.request.get('/api/files/download', { headers: workspace.headers, params: { path } });
        expect(response.status()).toBe(200);
        return response.body();
      };
      try {
        await page.goto('/en');
        await page.getByTestId('home-files').getByRole('button', { name: 'Import files', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
        const completed = page.waitForResponse(response => /^\/api\/files\/uploads\/[^/]+\/complete$/u.test(new URL(response.url()).pathname)
          && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id);
        await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: path, mimeType: 'text/markdown', buffer: bytes });
        let response = await completed;
        const endpoint = new URL(response.url()).pathname;
        const uploadId = endpoint.split('/')[4], fileId = response.request().postDataJSON().fileId;
        let payload = await response.json();
        if (response.status() === 202) {
          // A pending import retains its source; only a real user action may
          // check the same attempt again. It is not a completed byte import.
          expect(['projection_pending', 'recovery_required']).toContain(payload.completion?.status);
          expect(payload.success).toBe(true);
          expect(payload.completion).toEqual({ status: payload.completion.status, uploadId, fileId, targetPath: path,
            code: payload.completion.status === 'projection_pending' ? 'MARKDOWN_UPLOAD_PROJECTION_PENDING' : 'MARKDOWN_UPLOAD_RECOVERY_REQUIRED' });
          await expect(dialog.getByRole('status').filter({ hasText: path })).toContainText(
            'The import has not been confirmed yet. Its upload source is retained for the same attempt.');
          await expect.poll(() => page.evaluate(expected => Object.keys(localStorage)
            .filter(key => key.startsWith('canvas-markdown-upload-resumes:v1:'))
            .some(key => JSON.parse(localStorage.getItem(key)!).locators.some((locator: Record<string, unknown>) =>
              Object.entries(expected).every(([name, value]) => locator[name] === value))),
          { workspaceId: workspace.id, uploadId, fileId, targetPath: path, status: payload.completion.status })).toBe(true);
          const checked = page.waitForResponse(candidate => new URL(candidate.url()).pathname === endpoint
            && candidate.request().method() === 'POST'
            && candidate.request().headers()['x-canvas-workspace-id'] === workspace.id
            && candidate.request().postDataJSON()?.fileId === fileId);
          await dialog.getByRole('button', { name: 'Check completion again', exact: true }).click();
          response = await checked;
          payload = await response.json();
          expect(response.status()).toBe(200);
          expect(payload.completion).toEqual({ status: 'completed', uploadId, fileId, targetPath: path });
          await expect(dialog.getByRole('button', { name: 'Check completion again', exact: true })).toHaveCount(0);
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
          info.annotations.push({ type: 'import-completion', description: 'Initial pending response; retained locator and one explicit UI check completed the same upload. No automatic test retry.' });
        }
        expect(response.status()).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.completion).toEqual({ status: 'completed', uploadId, fileId, targetPath: path });
        await expect(dialog).toHaveCount(0);
        expect(await exported()).toEqual(bytes);
        await page.goto(`/en/notebook?path=${encodeURIComponent(path)}&workspaceId=${workspace.id}`);
        const identity = await session(page, workspace, path);
        expect(identity.representation).toBe(profile.representation);
        if (profile.representation === 'tiptap_blocks') {
          const heading = page.locator(editorSelector).getByRole('heading', { name: 'Heading', exact: true });
          await expect(heading).toBeVisible(); await heading.click();
        } else {
          await expect(page.locator('.markdown-source-shell .cm-content')).toHaveAttribute('contenteditable', 'true');
          await page.locator('.cm-line').filter({ hasText: 'A\tB😀' }).click();
        }
        await page.keyboard.press('End'); await page.keyboard.insertText(' Edited');
        await expect.poll(exported, { timeout: 20_000 }).toEqual(Buffer.from(profile.content.replace(profile.representation === 'tiptap_blocks' ? '# Heading' : 'A\tB😀',
          profile.representation === 'tiptap_blocks' ? '# Heading Edited' : 'A\tB😀 Edited')));
        await page.keyboard.press('ControlOrMeta+z'); await expect.poll(exported, { timeout: 20_000 }).toEqual(bytes);
        await page.reload();
        if (profile.representation === 'tiptap_blocks') {
          await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true');
          await expect(page.locator(editorSelector).getByRole('heading', { name: 'Heading', exact: true })).toBeVisible();
        } else {
          await expect(page.locator('.markdown-source-shell .cm-content')).toHaveAttribute('contenteditable', 'true');
          await expect(page.locator('.cm-line').filter({ hasText: '<div data-future="preserve">text</div>' })).toBeVisible();
        }
        await expect.poll(exported).toEqual(bytes);
        const reopened = await session(page, workspace, path);
        expect(reopened.documentId).toBe(identity.documentId); expect(reopened.lifecycleGeneration).toBe(identity.lifecycleGeneration);
        await page.screenshot({ path: info.outputPath(`${profile.name}-native-import.png`), animations: 'disabled' });
      } finally {
        await page.goto('about:blank').catch(() => undefined);
        await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
      }
    });
  }
});
