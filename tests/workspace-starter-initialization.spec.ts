import { randomUUID } from 'node:crypto';
import { expect, test, type Request } from '@playwright/test';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import type { WorkspaceStarterInitializationResult } from '../app/lib/workspaces/starter-document-initialization-contract';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { createAuthenticatedContext } from './helpers/managed-test-context';

const starterPath = 'Erste Schritte.md';
const editorSelector = '.tiptap-editor-shell .ProseMirror';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
type InitializationPayload = { success: boolean; starterDocumentInitialization: WorkspaceStarterInitializationResult };
type NativeMetadataTarget = { version: number; kind: string; workspaceId: string; path: string;
  documentId: string; lifecycleGeneration: number };

test.describe('new workspace starter completes through the real creation dialog', () => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the sealed owned native-document host.');
  test.setTimeout(240_000);
  for (const mobile of [false, true]) {
    test(`${mobile ? 'mobile web' : 'desktop'}: one workspace creation, stable starter attempt and immediately editable welcome document`, async ({ browser }, info) => {
      // The complete original target/build guard remains the first actual action.
      const owned = await requireOwnedYjsQaTarget();
      expect(owned.activeSpec).toBe('tests/workspace-starter-initialization.spec.ts');
      expect(process.env.E2E_EXTERNAL_SERVER).toBe('1');
      const context = await createAuthenticatedContext(browser, { viewport: mobile ? { width: 390, height: 844 }
        : { width: 1440, height: 960 }, hasTouch: mobile, isMobile: mobile });
      let workspaceId: string | undefined;
      let failed = false, primaryError: unknown;
      try {
        await context.addInitScript(narrow => {
          localStorage.setItem('canvas.notebook.chatVisible', 'false');
          localStorage.setItem('canvas-browser-mode', narrow ? 'list' : 'tree');
        }, mobile);
        const before = await context.request.get('/api/workspaces');
        expect(before.status()).toBe(200);
        const initialWorkspaces = (await before.json()).workspaces as ClientWorkspaceSummary[];
        expect(Array.isArray(initialWorkspaces)).toBe(true);
        const initialIds = new Set(initialWorkspaces.map(workspace => workspace.id));
        const name = `Starter ${mobile ? 'mobile' : 'desktop'} ${randomUUID()}`;
        const page = await context.newPage();
        const creates: Request[] = [];
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/workspaces') creates.push(request);
        });
        // Home exposes the existing WorkspaceSwitcher on both viewport sizes;
        // its Create action opens the same real CreateWorkspaceDialog.
        await page.goto('/en');
        const switcher = page.locator('header').getByTestId('workspace-switcher');
        await expect(switcher).toBeVisible({ timeout: 45_000 });
        await expect(switcher).toBeEnabled();
        await switcher.click();
        await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Create workspace', exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('Name', { exact: true }).fill(name);
        await expect(dialog.getByLabel('Type', { exact: true })).toHaveValue('personal');
        const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaces'
          && response.request().method() === 'POST', { timeout: 90_000 });
        await dialog.getByRole('button', { name: 'Create new workspace', exact: true }).click();
        const created = await createdResponse;
        const payload = await created.json() as InitializationPayload & { workspace: ClientWorkspaceSummary };
        // Retain the genuine committed ID before assertions so failure cleanup
        // can still remove this one owned workspace after a partial UI result.
        if (typeof payload.workspace?.id === 'string' && payload.workspace.id) workspaceId = payload.workspace.id;
        expect(created.status()).toBe(201); expect(payload.success).toBe(true);
        expect(workspaceId).toBeTruthy();
        expect(payload.workspace).toMatchObject({ id: workspaceId, name, type: 'personal', status: 'active' });
        const completed = payload.starterDocumentInitialization;
        expect(completed).toMatchObject({ version: 1, workspaceId, status: 'completed' });
        expect(completed.operationId).toMatch(uuid); expect(completed.requestId).toMatch(uuid);
        expect(completed.operationId).not.toBe(completed.requestId);
        await expect(page.getByRole('dialog', { name: `${name} has been created`, exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Check status', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Resume setup', exact: true })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('workspace-created-starter-completed.png'), animations: 'disabled' });
        await page.getByRole('dialog', { name: `${name} has been created`, exact: true })
          .getByRole('button', { name: 'Done', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(switcher).toHaveAttribute('data-active-workspace-id', workspaceId!);

        const headers = { 'x-canvas-workspace-id': workspaceId! };
        const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId!)}/starter-document-initialization`;
        const originalInfo = await context.request.get(`/api/files/info?path=${encodeURIComponent(starterPath)}`, { headers });
        expect(originalInfo.status()).toBe(200);
        const originalTarget = (await originalInfo.json()).data.metadataTarget as NativeMetadataTarget;
        expect(originalTarget).toMatchObject({ version: 1, kind: 'native_file', workspaceId, path: starterPath, lifecycleGeneration: 1 });
        expect(originalTarget.documentId).toBeTruthy();
        // These are the real dedicated endpoints, with no interception or new
        // IDs/bytes supplied by the test. GET observes; POST resumes the saved attempt.
        const observed = await context.request.get(endpoint, { headers });
        expect(observed.status()).toBe(200);
        expect(await observed.json()).toMatchObject({ success: true, starterDocumentInitialization: completed });
        const resumed = await context.request.post(endpoint, { headers });
        expect(resumed.status()).toBe(200);
        expect(await resumed.json()).toMatchObject({ success: true, starterDocumentInitialization: completed });
        const observedAgain = await context.request.get(endpoint, { headers });
        expect(observedAgain.status()).toBe(200);
        expect(await observedAgain.json()).toMatchObject({ success: true, starterDocumentInitialization: completed });
        const afterInfo = await context.request.get(`/api/files/info?path=${encodeURIComponent(starterPath)}`, { headers });
        expect(afterInfo.status()).toBe(200); expect((await afterInfo.json()).data.metadataTarget).toEqual(originalTarget);
        const listing = await context.request.get('/api/workspaces'); expect(listing.status()).toBe(200);
        const workspaces = (await listing.json()).workspaces as ClientWorkspaceSummary[];
        expect(workspaces.filter(workspace => !initialIds.has(workspace.id)).map(workspace => workspace.id)).toEqual([workspaceId]);
        expect(workspaces.filter(workspace => workspace.name === name).map(workspace => workspace.id)).toEqual([workspaceId]);
        const tree = await context.request.get('/api/files/tree?noCache=1', { headers }); expect(tree.status()).toBe(200);
        const entries = (await tree.json()).data as Array<{ path: string; type: string }>;
        expect(entries.filter(entry => entry.path === starterPath)).toHaveLength(1);
        expect(entries.find(entry => entry.path === starterPath)?.type).toBe('file');
        expect(creates).toHaveLength(1);
        expect(creates[0].postDataJSON()).toMatchObject({ name, type: 'personal' });

        // Open the actual starter via the existing notebook/file-browser UI.
        // No session bootstrap or document read in this test admits it first.
        await page.getByTestId('home-files').getByRole('link', { name: 'Open notebook', exact: true }).click();
        await expect(page).toHaveURL(url => url.pathname === '/en/notebook' && url.searchParams.get('workspaceId') === workspaceId);
        if (mobile) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
        else {
          const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
          if (await toggle.isVisible()) await toggle.click();
        }
        const row = page.locator(`[data-file-path="${starterPath}"]:visible`).first();
        await expect(row).toBeVisible({ timeout: 45_000 }); await row.click();
        const editor = page.locator(editorSelector);
        await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect(editor.getByRole('heading', { name: 'Willkommen bei Canvas Notebook 👋', exact: true })).toBeVisible();
        await expect(page.getByTestId('document-header')).toContainText(starterPath);
        await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
        expect(creates).toHaveLength(1);
        await page.screenshot({ path: info.outputPath('starter-immediately-editable.png'), animations: 'disabled' });
        // Normal application close runs its existing transition/durability
        // guard. This asserts UI closure, not a new room-owner SQL proof.
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
        await expect(editor).toHaveCount(0);
        await page.goto('/en');
      } catch (error) { failed = true; primaryError = error; }
      finally {
        const cleanupErrors: unknown[] = [];
        try {
          if (workspaceId) {
            const cleanup = await context.request.delete(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
            expect(cleanup.ok()).toBe(true);
          }
        } catch (error) { cleanupErrors.push(error); }
        try { await context.close(); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
          'Workspace starter browser fixture cleanup failed.');
      }
      if (failed) throw primaryError;
    });
  }
});
