import { expect, test, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CurrentFile } from '../app/lib/files/types';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { withOwnedTestCleanup } from './helpers/owned-test-cleanup';

const source = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/markdown-roundtrip/mailto-task-list.md'), 'utf8');

async function readDocument(request: APIRequestContext, workspaceId: string, filePath: string): Promise<CurrentFile> {
  const response = await request.get('/api/files/read?path=' + encodeURIComponent(filePath), {
    headers: { 'x-canvas-workspace-id': workspaceId },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).data as CurrentFile;
}

// Only the named migration response is fault-injected. Authentication, upload,
// checkpoint, source editor and subsequent successful migration use the server.
// This tests client feedback and recovery, not server-side failure admission.
for (const locale of ['en', 'de'] as const) {
  test(`${locale}: unavailable rich migration preserves source and permits a real retry`, async ({ browser }, info) => {
    test.setTimeout(120_000);
    const mobile = locale === 'de';
    const messages = (mobile ? de : en).notebook.editorModes;
    const context = await createAuthenticatedContext(browser, {
      locale: mobile ? 'de-DE' : 'en-US', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: mobile, hasTouch: mobile,
    });
    const page = await context.newPage();
    const filePath = `migration-feedback-${randomUUID()}.md`;
    let workspaceId: string | undefined;
    let injectedRequestId: string | undefined;
    let injected = 0;
    await withOwnedTestCleanup(async () => {
      const created = await context.request.post('/api/workspaces', {
        data: { type: 'personal', name: `Migration feedback ${randomUUID()}` },
      });
      expect(created.status()).toBe(201);
      workspaceId = (await created.json()).workspace.id as string;
      await context.addInitScript(id => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: source });
      const before = await readDocument(context.request, workspaceId, filePath);
      const documentId = before.collaboration?.document?.id;
      expect(documentId).toEqual(expect.any(String));
      await page.route('**/api/files/collaboration/session', async route => {
        const request = route.request();
        const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
        if (injected || body?.path !== filePath || !body.migration) return route.continue();
        injected += 1;
        injectedRequestId = body.migration.requestId;
        expect(body.migration.expectedDocumentId).toBe(documentId);
        expect(body.migration.stateProof).toMatch(/^yjs-snapshot-sha256-v1:/u);
        return route.fulfill({ status: 200, json: { success: true, migration: {
          requestId: injectedRequestId, documentId,
          lifecycleGeneration: body.migration.expectedLifecycleGeneration,
          status: 'blocked', reason: 'runtime_unavailable',
        } } });
      });
      await page.goto(`/${locale}/notebook?workspaceId=${workspaceId}&path=${encodeURIComponent(filePath)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByRole('status').filter({ hasText: messages.migrationUnavailable })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(messages.migrationBlocked, { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-editor-mode="source"]')).toBeVisible();
      expect(injected).toBe(1);
      const retained = await readDocument(context.request, workspaceId, filePath);
      expect(retained.content).toBe(source);
      expect(retained.collaboration?.document?.id).toBe(documentId);
      await page.screenshot({ path: info.outputPath(`${locale}-migration-unavailable.png`), fullPage: true });

      const migrated = page.waitForResponse(response => {
        if (!response.url().endsWith('/api/files/collaboration/session') || response.request().method() !== 'POST') return false;
        const body = response.request().postDataJSON();
        return body.path === filePath && Boolean(body.migration) && body.migration.requestId !== injectedRequestId;
      }, { timeout: 30_000 });
      await page.getByRole('button', { name: messages.migration, exact: true }).click();
      const receipt = await migrated;
      expect(receipt.status()).toBe(200);
      expect(await receipt.json()).toMatchObject({ success: true, representation: 'tiptap_blocks',
        migration: { requestId: receipt.request().postDataJSON().migration.requestId, documentId, status: 'migrated' } });
      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect(editor.locator('a[href="mailto:team@example.test"]')).toHaveText('team@example.test');
      await expect(page.getByText(messages.migrationUnavailable, { exact: true })).toHaveCount(0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      expect((await readDocument(context.request, workspaceId, filePath)).collaboration?.document?.id).toBe(documentId);
    }, [
      { label: 'own migration feedback page', run: () => page.close() },
      { label: 'own migration feedback workspace', run: async () => {
        if (workspaceId) expect((await context.request.delete(`/api/workspaces/${workspaceId}`)).status()).toBe(200);
      } },
      { label: 'own migration feedback context', run: () => context.close() },
    ]);
  });
}
