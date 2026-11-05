import { expect, test, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CurrentFile } from '../app/lib/files/types';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { withOwnedTestCleanup } from './helpers/owned-test-cleanup';

const source = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/markdown-roundtrip/mailto-task-list.md'), 'utf8');
const normalized = '# Mail contact\n\n**Canvas [team@example.test](mailto:team@example.test)**\n\n'
  + '- [x] Keep the completed task.\n- [ ] Keep the unfinished task.\n\n- Keep the ordinary list item.\n\n'
  + 'Use [Support](mailto:support@example.test?subject=Hello%20world) for questions.\n';

async function readDocument(request: APIRequestContext, workspaceId: string, filePath: string): Promise<CurrentFile> {
  const response = await request.get('/api/files/read?path=' + encodeURIComponent(filePath), {
    headers: { 'x-canvas-workspace-id': workspaceId },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).data as CurrentFile;
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'}: mailto source offers a guarded rich upgrade and survives reload`, async ({ browser }, info) => {
    test.setTimeout(120_000);
    const context = await createAuthenticatedContext(browser, {
      locale: 'en-US', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: mobile, hasTouch: mobile,
    });
    const page = await context.newPage();
    const filePath = `mailto-normalization-${randomUUID()}.md`;
    let workspaceId: string | undefined;
    await withOwnedTestCleanup(async () => {
      const created = await context.request.post('/api/workspaces', {
        data: { type: 'personal', name: `Mailto normalization ${randomUUID()}` },
      });
      expect(created.status()).toBe(201);
      workspaceId = (await created.json()).workspace.id as string;
      await context.addInitScript(id => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: source });
      const before = await readDocument(context.request, workspaceId, filePath);
      expect(before.content).toBe(source);
      const documentId = before.collaboration?.document?.id;
      expect(documentId).toEqual(expect.any(String));

      await page.goto(`/notebook?workspaceId=${workspaceId}&path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      const prepare = page.getByRole('button', { name: 'Prepare formatted editing', exact: true });
      await expect(prepare).toBeEnabled({ timeout: 30_000 });
      expect((await readDocument(context.request, workspaceId, filePath)).content).toBe(source);
      await expect(page.getByTestId('markdown-source-preservation-warning')).toHaveCount(0);
      await prepare.click();

      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect(editor.locator('a[href="mailto:team@example.test"]')).toHaveText('team@example.test');
      await expect(editor.locator('a[href="mailto:support@example.test?subject=Hello%20world"]')).toHaveText('Support');
      const checks = editor.locator('input[type="checkbox"]');
      await expect(checks).toHaveCount(2);
      await expect(checks.nth(0)).toBeChecked();
      await expect(checks.nth(1)).not.toBeChecked();
      await expect(editor.getByText('Keep the ordinary list item.', { exact: true })).toBeVisible();
      await expect.poll(async () => (await readDocument(context.request, workspaceId!, filePath)).content, { timeout: 20_000 }).toBe(normalized);
      expect((await readDocument(context.request, workspaceId, filePath)).collaboration?.document?.id).toBe(documentId);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect(editor.locator('a[href="mailto:team@example.test"]')).toHaveText('team@example.test');
      expect((await readDocument(context.request, workspaceId, filePath)).content).toBe(normalized);
      await editor.locator('a[href="mailto:team@example.test"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('mailto-rich-upgrade.png'), fullPage: true });
    }, [
      { label: 'own mailto page', run: () => page.close() },
      { label: 'own mailto workspace', run: async () => {
        if (workspaceId) expect((await context.request.delete(`/api/workspaces/${workspaceId}`)).status()).toBe(200);
      } },
      { label: 'own mailto context', run: () => context.close() },
    ]);
  });
}
