import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES, COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import type { OwnedRestartRoomEvidence } from '../scripts/lib/owned-yjs-restart-room-read';
import { requireOwnedYjsQaTarget, type OwnedYjsReceipt } from '../scripts/lib/owned-yjs-authority-qa';
import { ownedNativeFileRoomReceiptIdentity } from '../scripts/lib/owned-yjs-native-delete-links-room-target';
import { assertCompletedWorkspaceMarkdownCreate, createAuthenticatedContext } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { runOwnedNativeCommand } from './helpers/owned-native-command';

const selector = '.tiptap-editor-shell .ProseMirror';
const importTitle = 'Insert Markdown…';
type NativeSession = { success: boolean; provider: string; documentId: string; lifecycleGeneration: number;
  documentSequence: number; representation: string; schemaVersion: number; richTextSchemaVersion: number;
  blockTreeFormatVersion: number; stateProof: string; stateVector: string; degraded: boolean };

async function readNativeFileSession(request: APIRequestContext, workspaceId: string, path: string): Promise<NativeSession> {
  const response = await request.post('/api/files/collaboration/session', {
    headers: { 'x-canvas-workspace-id': workspaceId }, data: { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.ok()).toBe(true);
  const value = await response.json() as NativeSession;
  expect(value).toMatchObject({ success: true, provider: 'yjs', representation: 'tiptap_blocks', degraded: false,
    schemaVersion: COLLABORATION_SCHEMA_VERSION, richTextSchemaVersion: COLLABORATION_CLIENT_CAPABILITIES.richTextSchemaVersion,
    blockTreeFormatVersion: COLLABORATION_CLIENT_CAPABILITIES.blockTreeFormatVersion });
  expect(value.documentId).toBeTruthy(); expect(value.lifecycleGeneration).toBeGreaterThan(0);
  expect(value.stateProof).toMatch(/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u); expect(value.stateVector).toBeTruthy();
  return value;
}

async function readNativeFileRoom(owned: OwnedYjsReceipt, workspaceId: string, path: string,
  session: NativeSession): Promise<OwnedRestartRoomEvidence> {
  // The full original guard ran once at the beginning of this case. Every
  // original narrow room read independently verifies its exact owned target
  // and actual read-only PG identity. No supervisor/adapter guard is replaced.
  const input = Buffer.from(JSON.stringify({ version: 1,
    target: { nonce: owned.nonce, repo: owned.repo, head: owned.head, sourceFingerprint: owned.sourceFingerprint,
      buildFingerprint: owned.buildFingerprint, buildId: owned.buildId, receiptIdentity: ownedNativeFileRoomReceiptIdentity(owned) },
    room: { documentId: session.documentId, path, generation: session.lifecycleGeneration, expectedWorkspaceId: workspaceId },
    expectedSession: { documentSequence: session.documentSequence, stateProof: session.stateProof, stateVector: session.stateVector },
  })).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx',
    'scripts/owned-yjs-native-delete-links-room-read.ts', input], { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(result.stdout) as OwnedRestartRoomEvidence;
}

/** Derive the complete expected PM document from the actual bound candidate.
 * Remove only the one authored target link mark; preserve every other mark,
 * node ID, attribute, table cell, heading, label and independent link. */
function withoutTargetLink(document: JSONContent, targetHref: string): { document: JSONContent; removed: number } {
  const expected = structuredClone(document); let removed = 0;
  const visit = (node: JSONContent) => {
    if (node.marks) {
      const marks = node.marks.filter(mark => {
        if (mark.type === 'link' && mark.attrs?.href === targetHref) { removed++; return false; }
        return true;
      });
      if (marks.length) node.marks = marks; else delete node.marks;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(expected); return { document: expected, removed };
}

async function closeAndRelease(page: Page, owned: OwnedYjsReceipt, workspaceId: string,
  path: string, session: NativeSession): Promise<OwnedRestartRoomEvidence> {
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(page.locator(selector)).toHaveCount(0);
  await expect.poll(async () => (await readNativeFileRoom(owned, workspaceId, path, session)).released,
    { timeout: 40_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  const released = await readNativeFileRoom(owned, workspaceId, path, session);
  expect(released).toMatchObject({ ownerTupleCleared: true, ownerTupleComplete: false,
    advisoryLockHeld: false, releaseReceiptValid: true, admissionPending: false, released: true });
  return released;
}

async function settleNativeFileBatch(request: APIRequestContext, workspaceId: string,
  operation: WorkspacePathOperationPublic, sourcePath: string): Promise<void> {
  await expect.poll(async () => {
    const response = await request.get(`/api/files/operations/batches/${operation.batchId}`,
      { headers: { 'x-canvas-workspace-id': workspaceId } });
    expect(response.ok()).toBe(true);
    const value = await response.json();
    const current = value.operation as WorkspacePathOperationPublic;
    expect(current).toMatchObject({ batchId: operation.batchId, planId: operation.planId, workspaceId });
    if (current.status === 'applied') {
      expect(current).toMatchObject({ phase: 'complete', completedActions: 2, totalActions: 2, errorCode: null });
      expect(value.recovery).toEqual({ canResume: false, canUndo: false });
      expect(value.linkStatus).toBe('complete');
      expect(value.linkUpdates).toEqual({ updatedFiles: [sourcePath], updatedLinks: 1, warnings: [] });
      expect(value.deleted).toEqual([operation.selections[0].sourcePath]);
      expect(value.failed).toEqual([]);
    }
    return current.status;
  }, { timeout: 90_000 }).toBe('applied');
}

test.describe('native Delete atomically removes incoming link marks and preserves rich source content', () => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the sealed owned native-document host.');
  test.setTimeout(240_000);
  for (const mobile of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'}: real Markdown insertion, released source room, Delete, native link receipt and fresh reopen`, async ({ browser }, info) => {
      const owned = await requireOwnedYjsQaTarget();
      expect(owned.activeSpec).toBe('tests/workspace-operation-native-delete-links.spec.ts');
      const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 };
      const context = await createAuthenticatedContext(browser, { viewport, hasTouch: mobile, isMobile: mobile });
      let freshContext: BrowserContext | undefined, workspaceId: string | undefined;
      let failed = false, primaryError: unknown;
      const sourcePath = `owned-yjs-restart-${randomUUID()}.md`, targetPath = `owned-yjs-restart-${randomUUID()}.md`;
      const keepPath = `owned-yjs-restart-${randomUUID()}.md`;
      const heading = 'Native links äöü ß 😀', targetLabel = 'Target label äöü 😀', keepLabel = 'Keep label';
      const markdown = `# ${heading}\n\nDelete [**${targetLabel}**](${targetPath}) and preserve [${keepLabel}](${keepPath}).\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n`;
      try {
        const created = await context.request.post('/api/workspaces', { data: { type: 'personal',
          name: `Native incoming links ${owned.nonce} ${mobile ? 'mobile' : 'desktop'}` } });
        expect(created.status()).toBe(201);
        const workspace = await created.json(); workspaceId = workspace.workspace.id as string;
        expect(workspace.starterDocumentInitialization.status).toBe('completed');
        const headers = { 'x-canvas-workspace-id': workspaceId };
        const availability = await context.request.get('/api/document-review/availability');
        expect(availability.ok()).toBe(true); expect((await availability.json()).data.documentReviewEnabled).toBe(false);
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await context.addInitScript(({ id, narrow }) => {
          localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
          localStorage.setItem('canvas-browser-mode', narrow ? 'list' : 'tree');
        }, { id: workspaceId, narrow: mobile });
        for (const path of [sourcePath, targetPath, keepPath]) {
          await waitForFileCreateBudget(); const requestId = randomUUID();
          const response = await context.request.post('/api/files/create', { headers, data: { path, type: 'file', requestId } });
          await assertCompletedWorkspaceMarkdownCreate(response, { requestId, workspaceId, targetPath: path });
        }
        // Fresh empty documents are genuine initialized native files. Only the
        // source is opened into a room; no synthetic SQL seed is used.
        const initialSource = await readNativeFileSession(context.request, workspaceId, sourcePath);
        const initialTarget = await readNativeFileSession(context.request, workspaceId, targetPath);
        const initialKeep = await readNativeFileSession(context.request, workspaceId, keepPath);
        expect(new Set([initialSource.documentId, initialTarget.documentId, initialKeep.documentId]).size).toBe(3);
        for (const session of [initialSource, initialTarget, initialKeep]) expect(session.documentSequence).toBe(0);
        const page = await context.newPage();
        await page.goto(`/en/notebook?workspaceId=${workspaceId}&path=${encodeURIComponent(sourcePath)}`);
        const editor = page.locator(selector);
        await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 }); await expect(editor).toHaveText('');
        await page.getByTestId('markdown-toolbar-insert').click();
        await page.getByRole('menuitem', { name: importTitle, exact: true }).click();
        const insertion = page.getByRole('dialog', { name: importTitle, exact: true }); await expect(insertion).toBeVisible();
        const markdownInput = insertion.getByRole('textbox', { name: 'Markdown', exact: true });
        await markdownInput.focus(); await page.evaluate(value => navigator.clipboard.writeText(value), markdown);
        await page.keyboard.press('ControlOrMeta+v'); await expect(markdownInput).toHaveValue(markdown);
        await insertion.getByRole('button', { name: 'Insert', exact: true }).click(); await expect(insertion).toHaveCount(0);
        await expect(editor.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await expect(editor.locator('table')).toContainText('Alpha'); await expect(editor.locator('table')).toContainText('Beta');
        await expect(editor.locator(`a[href="${targetPath}"]`)).toHaveText(targetLabel);
        await expect(editor.locator(`a[href="${keepPath}"]`)).toHaveText(keepLabel);
        const before = await readNativeRichCandidate(page, selector), expected = withoutTargetLink(before.document, targetPath);
        expect(expected.removed).toBe(1);
        await expect.poll(async () => {
          const current = await readNativeFileSession(context.request, workspaceId!, sourcePath);
          return { documentId: current.documentId, lifecycleGeneration: current.lifecycleGeneration,
            stateProof: current.stateProof, stateVector: current.stateVector };
        }, { timeout: 40_000 }).toEqual({ documentId: initialSource.documentId, lifecycleGeneration: initialSource.lifecycleGeneration,
          stateProof: before.stateProof, stateVector: before.stateVector });
        const original = await readNativeFileSession(context.request, workspaceId, sourcePath);
        expect(original.documentSequence).toBeGreaterThan(0);
        const held = await readNativeFileRoom(owned, workspaceId, sourcePath, original);
        expect(held).toMatchObject({ ownerTupleCleared: false, ownerTupleComplete: true, advisoryLockHeld: true, released: false });
        const released = await closeAndRelease(page, owned, workspaceId, sourcePath, original); expect(released.version).toEqual(held.version);
        if (mobile) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
        else {
          const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true }); if (await toggle.isVisible()) await toggle.click();
        }
        const targetRow = page.locator(`[data-file-path="${targetPath}"]`).first();
        await expect(targetRow).toBeVisible({ timeout: 60_000 }); await targetRow.hover();
        await targetRow.getByRole('button', { name: /^More actions for /u }).click();
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        const deletionDialog = page.getByRole('alertdialog'); await expect(deletionDialog).toContainText(targetPath);
        const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/files/delete'
          && value.request().method() === 'DELETE', { timeout: 90_000 });
        await deletionDialog.getByRole('button', { name: 'Delete', exact: true }).click();
        const deletion = await response; expect(deletion.status()).toBe(200);
        const deleted = await deletion.json() as WorkspacePathOperationResponse;
        expect(deleted.operation).toMatchObject({ workspaceId, status: 'applied', phase: 'complete', completedActions: 2, totalActions: 2, errorCode: null });
        expect(deleted.deleted).toEqual([targetPath]); expect(deleted.failed).toEqual([]); expect(deleted.linkStatus).toBe('complete');
        expect(deleted.linkUpdates).toEqual({ updatedFiles: [sourcePath], updatedLinks: 1, warnings: [] });
        expect(deleted.trashEntries).toEqual([expect.objectContaining({ originalPath: targetPath, itemType: 'file' })]);
        await expect(deletionDialog).toBeHidden(); await expect(page.locator(`[data-file-path="${targetPath}"]`)).toHaveCount(0);
        const toast = page.locator('[data-sonner-toast]').filter({ hasText: '1 item was moved to trash.' }).last();
        await expect(toast).toBeVisible(); await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
        await settleNativeFileBatch(context.request, workspaceId, deleted.operation, sourcePath);
        const absent = await context.request.get(`/api/files/read?path=${encodeURIComponent(targetPath)}`, { headers }); expect(absent.status()).toBe(404);
        const afterDelete = await readNativeFileSession(context.request, workspaceId, sourcePath);
        expect(afterDelete).toMatchObject({ documentId: original.documentId, lifecycleGeneration: original.lifecycleGeneration,
          documentSequence: original.documentSequence + 1 }); expect(afterDelete.stateProof).not.toBe(original.stateProof);
        const unchangedKeep = await readNativeFileSession(context.request, workspaceId, keepPath);
        expect(unchangedKeep).toMatchObject({ documentId: initialKeep.documentId, lifecycleGeneration: initialKeep.lifecycleGeneration,
          documentSequence: initialKeep.documentSequence, stateProof: initialKeep.stateProof, stateVector: initialKeep.stateVector });
        await page.close();
        // Cookies alone carry authentication. Empty origins remove the old
        // editor's local caches from this separate browser context.
        freshContext = await browser.newContext({ baseURL: process.env.BASE_URL, storageState: { cookies: await context.cookies(), origins: [] },
          viewport, hasTouch: mobile, isMobile: mobile });
        const fresh = await freshContext.newPage();
        await fresh.goto(`/en/notebook?workspaceId=${workspaceId}&path=${encodeURIComponent(sourcePath)}`);
        const reopened = fresh.locator(selector); await expect(reopened).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect(reopened.getByRole('heading', { name: heading, exact: true })).toBeVisible();
        await expect(reopened.locator('table')).toContainText('Alpha'); await expect(reopened.locator('table')).toContainText('Beta');
        await expect(reopened).toContainText(targetLabel); await expect(reopened.locator('strong')).toHaveText(targetLabel);
        await expect(reopened.locator(`a[href="${targetPath}"]`)).toHaveCount(0);
        await expect(reopened.locator(`a[href="${keepPath}"]`)).toHaveText(keepLabel);
        const after = await readNativeRichCandidate(fresh, selector); expect(after.document).toEqual(expected.document);
        expect(after.stateProof).toBe(afterDelete.stateProof); expect(after.stateVector).toBe(afterDelete.stateVector);
        const persisted = await readNativeFileSession(freshContext.request, workspaceId, sourcePath);
        expect(persisted).toMatchObject({ documentId: original.documentId, lifecycleGeneration: original.lifecycleGeneration,
          documentSequence: afterDelete.documentSequence, stateProof: after.stateProof, stateVector: after.stateVector });
        const freshHeld = await readNativeFileRoom(owned, workspaceId, sourcePath, persisted);
        expect(freshHeld).toMatchObject({ ownerTupleCleared: false, ownerTupleComplete: true, advisoryLockHeld: true, released: false });
        expect(freshHeld.ownerEpoch).toBeGreaterThan(released.ownerEpoch);
        await fresh.screenshot({ path: info.outputPath('native-delete-incoming-link-source.png'), animations: 'disabled' });
        const freshReleased = await closeAndRelease(fresh, owned, workspaceId, sourcePath, persisted);
        expect(freshReleased.version).toEqual(freshHeld.version);
        info.annotations.push({ type: 'acceptance-scope', description: 'Real Chromium clipboard/Markdown insertion, desktop/mobile-web Delete, receipt-derived native unlink and fresh native PM equality; no native-device clipboard or file Undo claim.' });
      } catch (error) { failed = true; primaryError = error; }
      finally {
        const errors: unknown[] = [];
        try { await freshContext?.close(); } catch (error) { errors.push(error); }
        try { if (workspaceId) expect((await context.request.delete(`/api/workspaces/${workspaceId}`)).ok()).toBe(true); }
        catch (error) { errors.push(error); }
        try { await context.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(failed ? [primaryError, ...errors] : errors, 'Native incoming-link browser fixture cleanup failed.');
      }
      if (failed) throw primaryError;
    });
  }
});
