import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { assertCompletedWorkspaceMarkdownCreate, createAuthenticatedContext } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';

test.describe('file-action Undo is explicitly disabled while Delete remains available', () => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the sealed owned native-document host.');
  test.setTimeout(240_000);
  for (const mobile of [false, true]) {
    test(`${mobile ? 'mobile web' : 'desktop'}: delete Markdown and ordinary files, omit Undo, refuse stale API actions`, async ({ browser }, info) => {
      const owned = await requireOwnedYjsQaTarget();
      expect(owned.activeSpec).toBe('tests/workspace-file-undo-disabled.spec.ts');
      const context = await createAuthenticatedContext(browser, { viewport: mobile ? { width: 390, height: 844 }
        : { width: 1440, height: 960 }, hasTouch: mobile, isMobile: mobile });
      let workspaceId: string | undefined;
      let failed = false, primaryError: unknown;
      try {
        const created = await context.request.post('/api/workspaces', { data: { type: 'personal',
          name: `Undo disabled ${mobile ? 'mobile' : 'desktop'} ${randomUUID()}` } });
        expect(created.status()).toBe(201);
        const workspace = await created.json();
        workspaceId = workspace.workspace.id as string;
        expect(workspace.starterDocumentInitialization.status).toBe('completed');
        const headers = { 'x-canvas-workspace-id': workspaceId };
        const availability = await context.request.get('/api/document-review/availability');
        expect(availability.status()).toBe(200);
        expect((await availability.json()).data.documentReviewEnabled).toBe(false);
        const paths = [`undo-disabled-${randomUUID()}.md`, `undo-disabled-${randomUUID()}.txt`];
        for (const path of paths) {
          await waitForFileCreateBudget();
          const requestId = randomUUID();
          const result = await context.request.post('/api/files/create', { headers, data: { path, type: 'file', requestId } });
          if (path.endsWith('.md')) await assertCompletedWorkspaceMarkdownCreate(result, { requestId, workspaceId, targetPath: path });
          else expect(result.ok()).toBe(true);
        }
        await context.addInitScript(({ id, narrow }) => {
          localStorage.setItem('canvas.activeWorkspaceId', id);
          localStorage.setItem('canvas.notebook.chatVisible', 'false');
          localStorage.setItem('canvas-browser-mode', narrow ? 'list' : 'tree');
        }, { id: workspaceId, narrow: mobile });
        const page = await context.newPage();
        await page.goto(`/en/notebook?workspaceId=${workspaceId}`);
        if (mobile) await page.getByRole('button', { name: 'Files', exact: true }).click();
        else {
          const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
          if (await toggle.isVisible()) await toggle.click();
        }
        for (const path of paths) {
          const row = page.locator(`[data-file-path="${path}"]`);
          await expect(row).toBeVisible({ timeout: 60_000 });
          await row.hover();
          await row.getByRole('button', { name: /^More actions for /u }).click();
          await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
          const dialog = page.getByRole('alertdialog');
          await expect(dialog).toContainText(path);
          const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/files/delete'
            && value.request().method() === 'DELETE', { timeout: 90_000 });
          await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
          const deletion = await response;
          expect(deletion.status()).toBe(200);
          const deleted = await deletion.json() as WorkspacePathOperationResponse;
          expect(deleted.operation).toMatchObject({ workspaceId, status: 'applied', phase: 'complete',
            completedActions: 1, totalActions: 1, errorCode: null });
          expect(deleted.deleted).toEqual([path]);
          await expect(dialog).toBeHidden();
          await expect(row).toHaveCount(0);
          const toast = page.locator('[data-sonner-toast]').filter({ hasText: '1 item was moved to trash.' }).last();
          await expect(toast).toBeVisible();
          await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
          const batchUrl = `/api/files/operations/batches/${deleted.operation.batchId}`;
          const status = await context.request.get(batchUrl, { headers });
          expect(status.status()).toBe(200);
          expect((await status.json()).recovery).toEqual({ canResume: false, canUndo: false });
          const legacyCapability = await context.request.get(`/api/files/operations/${deleted.operation.batchId}/undo`, { headers });
          expect(legacyCapability.status()).toBe(200);
          expect((await legacyCapability.json()).undo).toMatchObject({ available: false,
            reasonCode: 'FILE_OPERATION_UNDO_DISABLED', undoOperationId: null });
          const trash = deleted.trashEntries?.find(entry => entry.originalPath === path);
          expect(trash?.id).toBeTruthy();
          for (const [url, data] of [
            [batchUrl, { action: 'undo', planId: deleted.operation.planId }],
            [`/api/files/operation-reviews/batches/${deleted.operation.batchId}`, { action: 'undo', planId: deleted.operation.planId }],
            [`/api/files/operations/${deleted.operation.batchId}/undo`, {}],
            [`/api/files/trash/${trash!.id}/restore`, {}],
          ] as const) {
            const refusal = await context.request.post(url, { headers, data });
            expect(refusal.status(), url).toBe(409);
            expect((await refusal.json()).code, url).toBe('FILE_OPERATION_UNDO_DISABLED');
          }
          const after = await context.request.get(batchUrl, { headers });
          expect(after.status()).toBe(200);
          expect((await after.json()).operation).toMatchObject({ batchId: deleted.operation.batchId,
            status: 'applied', errorCode: null, completedActions: 1, phase: 'complete' });
          const absent = await context.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers });
          expect(absent.status()).toBe(404);
        }
        await page.screenshot({ path: info.outputPath('delete-with-undo-disabled.png'), animations: 'disabled' });
      } catch (error) { failed = true; primaryError = error; }
      finally {
        const errors: unknown[] = [];
        try {
          if (workspaceId) expect((await context.request.delete(`/api/workspaces/${workspaceId}`)).ok()).toBe(true);
        } catch (error) { errors.push(error); }
        try { await context.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(failed ? [primaryError, ...errors] : errors, 'Undo-disabled browser cleanup failed.');
      }
      if (failed) throw primaryError;
    });
  }
});
