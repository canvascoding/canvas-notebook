import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import type { OwnedRestartRoomEvidence } from '../scripts/lib/owned-yjs-restart-room-read';
import { requireOwnedYjsQaTarget, type OwnedYjsReceipt } from '../scripts/lib/owned-yjs-authority-qa';
import { ownedNativeFileRoomReceiptIdentity } from '../scripts/lib/owned-yjs-native-file-room-target';
import { assertCompletedWorkspaceMarkdownCreate, createAuthenticatedContext } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { runOwnedNativeCommand } from './helpers/owned-native-command';

const selector = '.tiptap-editor-shell .ProseMirror';
type NativeSession = { success: boolean; provider: string; documentId: string; lifecycleGeneration: number;
  documentSequence: number; representation: string; stateProof: string; stateVector: string };

async function readNativeFileSession(request: APIRequestContext, workspaceId: string, path: string): Promise<NativeSession> {
  const response = await request.post('/api/files/collaboration/session', {
    headers: { 'x-canvas-workspace-id': workspaceId }, data: { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.ok()).toBe(true);
  const value = await response.json() as NativeSession;
  expect(value).toMatchObject({ success: true, provider: 'yjs', representation: 'tiptap_blocks' });
  expect(value.documentId).toBeTruthy(); expect(value.lifecycleGeneration).toBeGreaterThan(0);
  return value;
}

async function readNativeFileRoom(owned: OwnedYjsReceipt, workspaceId: string, path: string,
  session: NativeSession): Promise<OwnedRestartRoomEvidence> {
  // `owned` comes from the full original guard at the start of this case. Each
  // poll freshly proves its private target and actual read-only DB identity;
  // the supervisor and independent audits retain the full artifact checks.
  const input = Buffer.from(JSON.stringify({ version: 1,
    target: { nonce: owned.nonce, repo: owned.repo, head: owned.head, sourceFingerprint: owned.sourceFingerprint,
      buildFingerprint: owned.buildFingerprint, buildId: owned.buildId, receiptIdentity: ownedNativeFileRoomReceiptIdentity(owned) },
    room: { documentId: session.documentId, path, generation: session.lifecycleGeneration, expectedWorkspaceId: workspaceId },
    expectedSession: { documentSequence: session.documentSequence, stateProof: session.stateProof, stateVector: session.stateVector },
  })).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx',
    'scripts/owned-yjs-native-file-room-read.ts', input], { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(result.stdout) as OwnedRestartRoomEvidence;
}

async function openNativeFileActions(page: Page, path: string): Promise<void> {
  const row = page.locator(`[data-file-path="${path}"]`).first();
  await expect(row).toBeVisible({ timeout: 60_000 }); await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible();
}

async function settleNativeFileBatch(request: APIRequestContext, workspaceId: string,
  operation: WorkspacePathOperationPublic, status: 'applied' | 'undone'): Promise<void> {
  await expect.poll(async () => {
    const response = await request.get(`/api/files/operations/batches/${operation.batchId}`,
      { headers: { 'x-canvas-workspace-id': workspaceId } });
    expect(response.ok()).toBe(true);
    const current = (await response.json()).operation as WorkspacePathOperationPublic;
    expect(current).toMatchObject({ batchId: operation.batchId, planId: operation.planId, workspaceId });
    if (current.status === status) expect(current).toMatchObject({ phase: 'complete', completedActions: 1, totalActions: 1 });
    return current.status;
  }, { timeout: 90_000 }).toBe(status);
}

test.describe('native original Delete and Undo through the file browser', () => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the sealed owned native-document host.');
  test.setTimeout(240_000);
  for (const mobile of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'}: native edit, normal room release, Delete and toast Undo preserve the original document`, async ({ browser }, info) => {
      const owned = await requireOwnedYjsQaTarget();
      expect(owned.activeSpec).toBe('tests/workspace-operation-native-delete.spec.ts');
      const context = await createAuthenticatedContext(browser, { viewport: mobile ? { width: 390, height: 844 }
        : { width: 1440, height: 960 }, hasTouch: mobile, isMobile: mobile });
      let workspaceId: string | undefined;
      const path = `owned-yjs-restart-${randomUUID()}.md`;
      const text = 'Native document survives Delete and Undo: äöü ß 😀';
      let freshContext: BrowserContext | undefined;
      let primaryError: unknown, failed = false;
      try {
        const created = await context.request.post('/api/workspaces', { data: { type: 'personal',
          name: `Native lifecycle ${owned.nonce} ${mobile ? 'mobile' : 'desktop'}` } });
        expect(created.ok()).toBe(true);
        workspaceId = (await created.json()).workspace.id as string;
        const headers = { 'x-canvas-workspace-id': workspaceId };
        const availability = await context.request.get('/api/document-review/availability');
        expect(availability.ok()).toBe(true); expect((await availability.json()).data.documentReviewEnabled).toBe(false);
        await context.addInitScript(({ id, narrow }) => {
          localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
          localStorage.setItem('canvas-browser-mode', narrow ? 'list' : 'tree');
        }, { id: workspaceId, narrow: mobile });
        await waitForFileCreateBudget();
        const requestId = randomUUID();
        const create = await context.request.post('/api/files/create', { headers, data: { path, type: 'file', requestId } });
        await assertCompletedWorkspaceMarkdownCreate(create, { requestId, workspaceId, targetPath: path });
        const page = await context.newPage();
        await page.goto(`/en/notebook?workspaceId=${workspaceId}&path=${encodeURIComponent(path)}`);
        const editor = page.locator(selector);
        await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect(editor).toHaveText('');
        await editor.click(); await page.keyboard.insertText(text); await expect(editor).toHaveText(text);
        const candidate = await readNativeRichCandidate(page, selector);
        await expect.poll(async () => {
          const current = await readNativeFileSession(context.request, workspaceId!, path);
          return { stateProof: current.stateProof, stateVector: current.stateVector };
        }, { timeout: 40_000 }).toEqual({ stateProof: candidate.stateProof, stateVector: candidate.stateVector });
        const original = await readNativeFileSession(context.request, workspaceId, path);
        expect(original.documentSequence).toBeGreaterThan(0);
        const held = await readNativeFileRoom(owned, workspaceId, path, original);
        expect(held).toMatchObject({ ownerTupleCleared: false, ownerTupleComplete: true, advisoryLockHeld: true, released: false });
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
        await expect(editor).toHaveCount(0);
        await expect.poll(async () => (await readNativeFileRoom(owned, workspaceId!, path, original)).released,
          { timeout: 40_000, intervals: [500, 1_000, 2_000] }).toBe(true);
        const released = await readNativeFileRoom(owned, workspaceId, path, original);
        expect(released.version).toEqual(held.version);
        if (mobile) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
        else {
          const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
          if (await toggle.isVisible()) await toggle.click();
        }
        await openNativeFileActions(page, path);
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        const dialog = page.getByRole('alertdialog'); await expect(dialog).toContainText(path);
        const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/files/delete'
          && value.request().method() === 'DELETE', { timeout: 90_000 });
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        const deletion = await response; expect(deletion.ok()).toBe(true);
        const deleted = await deletion.json() as WorkspacePathOperationResponse;
        await expect(dialog).toBeHidden();
        const toast = page.locator('[data-sonner-toast]').filter({ has: page.getByRole('button', { name: 'Undo', exact: true }) });
        await expect(toast).toContainText('1 item was moved to trash.');
        await expect(page.locator(`[data-file-path="${path}"]`)).toHaveCount(0);
        // Use the real eight-second toast immediately. Slow diagnostics must
        // not consume the user's Undo window or change its configured lifetime.
        const undoResponse = page.waitForResponse(value => new URL(value.url()).pathname
          === `/api/files/operations/batches/${deleted.operation.batchId}` && value.request().method() === 'POST', { timeout: 90_000 });
        await toast.getByRole('button', { name: 'Undo', exact: true }).click();
        expect((await undoResponse).ok()).toBe(true);
        await settleNativeFileBatch(context.request, workspaceId, deleted.operation, 'undone');
        await expect(page.locator(`[data-file-path="${path}"]`)).toBeVisible({ timeout: 30_000 });
        const restored = await readNativeFileSession(context.request, workspaceId, path);
        expect(restored).toMatchObject({ documentId: original.documentId,
          lifecycleGeneration: original.lifecycleGeneration + 2, documentSequence: original.documentSequence,
          stateProof: original.stateProof, stateVector: original.stateVector });
        // A fresh page must render the restored native state without the old editor's cache.
        await page.close();
        freshContext = await browser.newContext({ baseURL: process.env.BASE_URL,
          storageState: { cookies: await context.cookies(), origins: [] }, viewport: mobile ? { width: 390, height: 844 }
            : { width: 1440, height: 960 }, hasTouch: mobile, isMobile: mobile });
        const fresh = await freshContext.newPage();
        await fresh.goto(`/en/notebook?workspaceId=${workspaceId}&path=${encodeURIComponent(path)}`);
        await expect(fresh.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect(fresh.locator(selector)).toHaveText(text);
        const after = await readNativeRichCandidate(fresh, selector);
        expect(after.document).toEqual(candidate.document); expect(after.stateProof).toBe(candidate.stateProof);
        expect(after.stateVector).toBe(candidate.stateVector);
        await fresh.screenshot({ path: info.outputPath('native-restored-document.png'), animations: 'disabled' });
        await fresh.getByRole('button', { name: 'Close preview', exact: true }).click();
        await expect(fresh.locator(selector)).toHaveCount(0);
        await expect.poll(async () => (await readNativeFileRoom(owned, workspaceId!, path, restored)).released,
          { timeout: 40_000, intervals: [500, 1_000, 2_000] }).toBe(true);
      } catch (error) {
        failed = true; primaryError = error;
      } finally {
        const cleanupErrors: unknown[] = [];
        try { await freshContext?.close(); } catch (error) { cleanupErrors.push(error); }
        try {
          if (workspaceId) {
            const cleanup = await context.request.delete(`/api/workspaces/${workspaceId}`);
            expect(cleanup.ok()).toBe(true);
          }
        } catch (error) { cleanupErrors.push(error); }
        try { await context.close(); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
          'Native lifecycle browser fixture cleanup failed.');
      }
      if (failed) throw primaryError;
    });
  }
});
