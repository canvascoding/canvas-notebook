import { randomUUID } from 'node:crypto';
import { chromium, expect, test, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { runOwnedNativeCommand } from './helpers/owned-native-command';
import { restartOwnedYjsAuthorityHost } from './helpers/owned-yjs-authority-runtime';
import { nativeRichParagraph } from './helpers/native-rich-paragraph';
import type { OwnedRestartRoomEvidence, OwnedRestartRoomInput } from '../scripts/lib/owned-yjs-restart-room-read';

const selector = '.tiptap-editor-shell .ProseMirror';
type Workspace = { id: string; headers: Record<string, string> };
type Identity = { documentId: string; lifecycleGeneration: number; representation: string };
type Durable = { documentId: string; generation: number; sequence: number; stateProof: string;
  content: { kind: 'rich_text'; document: JSONContent } };

async function login(page: Page, secondary = false): Promise<Workspace> {
  await authenticateManagedTestPage(page, secondary ? {
    email: process.env.TEST_SECONDARY_EMAIL, password: process.env.TEST_SECONDARY_PASSWORD,
  } : undefined);
  const response = await page.request.get('/api/workspaces'); expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspaces.find((entry: { id: string; name: string; permissions?: { canWrite: boolean } }) =>
    entry.name === 'Shared Test Workspace' && entry.permissions?.canWrite);
  expect(workspace?.id).toBeTruthy();
  await page.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  return { id: workspace.id, headers: { 'x-canvas-workspace-id': workspace.id } };
}

async function tree(page: Page): Promise<JSONContent> {
  return page.locator(selector).evaluate(element =>
    (element as HTMLElement & { editor: { getJSON(): JSONContent } }).editor.getJSON());
}

async function identity(page: Page, workspace: Workspace, path: string): Promise<Identity> {
  const response = await page.request.post('/api/files/collaboration/session', {
    headers: workspace.headers, data: { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.ok()).toBe(true); const result = await response.json();
  expect(result.representation).toBe('tiptap_blocks');
  return { documentId: result.documentId, lifecycleGeneration: result.lifecycleGeneration, representation: result.representation };
}

async function durable(workspace: Workspace, path: string, state: Identity): Promise<Durable> {
  const input = Buffer.from(JSON.stringify({ documentId: state.documentId, workspaceId: workspace.id, path, generation: state.lifecycleGeneration })).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx', '--import', './scripts/helpers/owned-application-esm-driver.mjs', 'scripts/owned-yjs-authority-storage-read.ts', input],
    { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

async function roomEvidence(path: string, state: Identity,
  expected: Pick<OwnedRestartRoomInput, 'expectedWorkspaceId' | 'expectedOwnerEpoch' | 'expectedScopeProof'> = {}): Promise<OwnedRestartRoomEvidence> {
  const input = Buffer.from(JSON.stringify({ documentId: state.documentId, path, generation: state.lifecycleGeneration, ...expected })).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx', 'scripts/owned-yjs-restart-room-read.ts', input],
    { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(result.stdout);
}

test.describe('Owned host restart and fresh browser durability', () => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the explicitly coordinated, sealed owned production host.');
  test.setTimeout(240_000);
  for (const mode of ['graceful', 'crash'] as const) {
    test(`${mode}: manual new document, real first paste and peer edit survive without the prior browser cache`, async ({ browser }, info) => {
      const ownerContext = await browser.newContext({ baseURL: process.env.BASE_URL, permissions: ['clipboard-read', 'clipboard-write'] });
      const peerContext = await browser.newContext({ baseURL: process.env.BASE_URL });
      const page = await ownerContext.newPage(), peer = await peerContext.newPage();
      const path = `owned-yjs-restart-${randomUUID()}.md`;
      let workspace: Workspace | undefined;
      let freshBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        workspace = await login(page); expect(await login(peer, true)).toEqual(workspace);
        await page.goto('/en');
        await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'New note', exact: true });
        await dialog.getByLabel('Note name', { exact: true }).fill(path); await waitForFileCreateBudget();
        const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
          && response.request().method() === 'POST' && response.request().postDataJSON()?.path === path);
        await dialog.getByRole('button', { name: 'Create and open', exact: true }).click(); expect((await created).ok()).toBe(true);
        const editor = page.locator(selector);
        await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 }); await expect(editor).toHaveText('');
        const initial = await identity(page, workspace, path);
        await editor.focus();
        await page.evaluate(text => navigator.clipboard.writeText(text), 'First durable paste: äöü 😀\n\nPeer paragraph.');
        await page.keyboard.press('ControlOrMeta+v');
        await expect(editor).toContainText('First durable paste: äöü 😀');
        await peer.goto(`/en/notebook?path=${encodeURIComponent(path)}&workspaceId=${workspace.id}`);
        await expect(peer.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect.poll(() => tree(peer)).toEqual(await tree(page));
        await (await nativeRichParagraph(peer, selector, 'Peer paragraph.')).click();
        await peer.keyboard.press('End'); await peer.keyboard.insertText(' Peer persisted.');
        await expect(editor).toContainText('Peer paragraph. Peer persisted.');
        const final = await tree(page); await expect.poll(() => tree(peer)).toEqual(final);
        // A live room response or a Markdown file alone cannot prove crash safety.
        await expect.poll(async () => (await durable(workspace!, path, initial)).content,
          { timeout: 40_000, intervals: [500, 1_000, 2_000] }).toMatchObject({ kind: 'rich_text', document: final });
        const saved = await durable(workspace, path, initial);
        expect(saved.sequence).toBeGreaterThan(0); expect(saved.stateProof).toBeTruthy();
        await ownerContext.close(); await peerContext.close();
        await restartOwnedYjsAuthorityHost(mode);
        // A separate browser process proves the old context/IndexedDB cannot repair the host.
        freshBrowser = await chromium.launch({ headless: true });
        const freshContext = await freshBrowser.newContext({ baseURL: process.env.BASE_URL });
        const fresh = await freshContext.newPage(); expect(await login(fresh)).toEqual(workspace);
        await fresh.goto('/en');
        expect((await fresh.evaluate(async () => (await indexedDB.databases()).map(entry => entry.name))).filter(name =>
          name?.startsWith(`canvas:${initial.documentId}:`))).toEqual([]);
        await fresh.goto(`/en/notebook?path=${encodeURIComponent(path)}&workspaceId=${workspace.id}`);
        await expect(fresh.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect.poll(() => tree(fresh)).toEqual(final);
        expect(await identity(fresh, workspace, path)).toEqual(initial);
        expect((await durable(workspace, path, initial)).content).toEqual(saved.content);
        await fresh.reload(); await expect.poll(() => tree(fresh)).toEqual(final);
        await fresh.screenshot({ path: info.outputPath(`${mode}-fresh-browser.png`), animations: 'disabled' });
        // Prove the exact normal UI close released its native owner. An active
        // Delete would deliberately use the separate coordinated drain contract.
        const ownedBefore = await roomEvidence(path, initial);
        expect(ownedBefore).toMatchObject({ ownerTupleCleared: false, ownerTupleComplete: true, advisoryLockHeld: true, released: false });
        expect(ownedBefore.version.stateProof).toBe(saved.stateProof); expect(ownedBefore.version.sequence).toBe(saved.sequence);
        // The scope proof binds the observed workspace, organization, path,
        // generation, representation, schema and lineage as well as this ID.
        const expectedRoom = { expectedOwnerEpoch: ownedBefore.ownerEpoch, expectedScopeProof: ownedBefore.scopeProof };
        await fresh.getByRole('button', { name: 'Close preview', exact: true }).click();
        await expect(fresh.locator(selector)).toHaveCount(0);
        await expect.poll(async () => (await roomEvidence(path, initial, expectedRoom)).released,
          { timeout: 40_000, intervals: [500, 1_000, 2_000] }).toBe(true);
        const released = await roomEvidence(path, initial, expectedRoom);
        expect(released).toMatchObject({ ownerTupleCleared: true, advisoryLockHeld: false, releaseReceiptValid: true, admissionPending: false, released: true });
        expect(released.version).toEqual(ownedBefore.version);
        const deleted = await fresh.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
        expect(deleted.ok()).toBe(true);
        await freshContext.close();
      } finally {
        await freshBrowser?.close(); await ownerContext.close(); await peerContext.close();
        // Failure keeps the document and private fixture for diagnosis; the
        // supervisor preserves its DB/DATA rather than adopting another target.
      }
    });
  }
});
