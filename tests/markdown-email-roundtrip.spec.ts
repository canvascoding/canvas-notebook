import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import {
  createAuthenticatedContext,
  enterMarkdownEditMode,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const FIXTURE = fs.readFileSync(
  path.join(process.cwd(), 'tests', 'fixtures', 'markdown-roundtrip', 'koenenstrasse-email-roundtrip.md'),
  'utf8',
);

type WorkspacePayload = {
  workspaces?: Array<{
    id: string;
    permissions: { canWrite: boolean };
  }>;
  error?: string;
};

async function writableWorkspace(request: APIRequestContext) {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as WorkspacePayload;
  expect(response.ok(), payload.error || 'Could not load workspaces').toBeTruthy();
  const workspace = payload.workspaces?.find((candidate) => candidate.permissions.canWrite);
  expect(workspace, 'A writable workspace is required').toBeTruthy();
  return workspace!.id;
}

async function useWorkspace(context: BrowserContext, workspaceId: string) {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function readWorkspaceFile(page: Page, workspaceId: string, filePath: string) {
  const response = await page.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
  });
  const payload = await response.json() as { data?: { content?: string; stats?: { sha256?: string } } };
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  return payload.data;
}

test.describe('Markdown email round trips', () => {
  test('opens and reloads the Koenenstraße document in rich mode without escaped emails', async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const filePath = `koenenstrasse-email-roundtrip-${Date.now()}.md`;
    const browserErrors: string[] = [];
    let workspaceId: string | null = null;

    page.on('pageerror', (error) => browserErrors.push(error.message));

    try {
      workspaceId = await writableWorkspace(page.request);
      await useWorkspace(context, workspaceId);

      await uploadWorkspaceTextFile({
        request: page.request,
        workspaceId,
        filePath,
        content: FIXTURE,
      });

      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await enterMarkdownEditMode(page);
      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      const normalizeButton = page.getByRole('button', {
        name: /Normalize and open|Normalisieren und öffnen/i,
      });
      await expect(editor.or(normalizeButton)).toBeVisible({ timeout: 30_000 });
      if (await normalizeButton.isVisible()) {
        await expect(page.locator('.cm-content')).toBeVisible();

        const normalizationScreenshotPath = testInfo.outputPath('markdown-email-normalization-prompt.png');
        await page.screenshot({ path: normalizationScreenshotPath, type: 'png' });
        await testInfo.attach('Markdown email normalization prompt', {
          path: normalizationScreenshotPath,
          contentType: 'image/png',
        });

        await normalizeButton.click();
      }
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.cm-content')).toHaveCount(0);

      const istaAddress = editor.locator('p').filter({ hasText: 'online.vertrieb@ista.de' }).first();
      const techemAddress = editor.locator('p').filter({ hasText: 'sven.friedemann@techem.de' }).first();
      await expect(istaAddress).toBeVisible();
      await expect(techemAddress).toBeAttached();
      await expect(istaAddress).toContainText('online.vertrieb@ista.de');
      await expect(techemAddress).toContainText('sven.friedemann@techem.de');
      await expect(editor.locator('a[href^="mailto:"]')).toHaveCount(0);
      await expect(editor.locator('hr')).toHaveCount(2);

      await expect.poll(async () => (await readWorkspaceFile(page, workspaceId!, filePath))?.content, {
        timeout: 20_000,
      }).toContain('online.vertrieb@ista.de  \n**Betreff:**');

      const normalizedContent = (await readWorkspaceFile(page, workspaceId, filePath))?.content || '';
      expect(normalizedContent).not.toContain('\\@');
      expect(normalizedContent).toContain('sven.friedemann@techem.de  \n**Betreff:**');
      expect(normalizedContent).toMatch(/\\---\n?$/u);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.cm-content')).toHaveCount(0);
      await expect(editor.locator('p').filter({ hasText: 'online.vertrieb@ista.de' }).first()).toBeVisible();

      await editor.locator('p').filter({ hasText: 'online.vertrieb@ista.de' }).first().scrollIntoViewIfNeeded();
      const screenshotPath = testInfo.outputPath('markdown-email-rich-mode.png');
      await page.screenshot({ path: screenshotPath, type: 'png' });
      await testInfo.attach('Markdown email rich mode', {
        path: screenshotPath,
        contentType: 'image/png',
      });

      const editorBounds = await editor.evaluate((element) => {
        const rect = element.closest('.tiptap-editor-shell')?.getBoundingClientRect();
        return {
          left: rect?.left ?? -1,
          right: rect?.right ?? Number.POSITIVE_INFINITY,
          viewportWidth: window.innerWidth,
        };
      });
      expect(editorBounds.left).toBeGreaterThanOrEqual(0);
      expect(editorBounds.right).toBeLessThanOrEqual(editorBounds.viewportWidth);
      expect(browserErrors, 'Rich Markdown email flow must not emit browser errors.').toEqual([]);
    } finally {
      await page.close().catch(() => undefined);
      if (workspaceId) {
        await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { path: filePath },
        }).catch(() => undefined);
      }
      await context.close();
    }
  });
});
