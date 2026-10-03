import { expect, test } from '@playwright/test';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

test.describe('mandatory file action notifications', () => {
  for (const mobile of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'} errors remain available with reviews disabled`, async ({ browser }, info) => {
      test.setTimeout(180_000);
      const runId = process.env.CANVAS_BATCH_E2E_RUN_ID;
      expect(process.env.E2E_EXTERNAL_SERVER).toBe('1'); expect(runId).toBeTruthy();
      const context = await createAuthenticatedContext(browser, {
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
        isMobile: mobile, hasTouch: mobile,
      });
      const created = await context.request.post('/api/workspaces', {
        data: { type: 'personal', name: `E2E batch review ${runId} errors-${mobile ? 'm' : 'd'}` },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      const workspaceId = (await created.json()).workspace.id as string;
      const headers = { 'x-canvas-workspace-id': workspaceId };
      try {
        expect((await (await context.request.get('/api/document-review/availability')).json()).data.documentReviewEnabled).toBe(false);
        for (const [filePath, content] of [['target.md', '# Target\n'], ['occupied.md', '# Occupied\n'], ['links.md', '[Target](target.md)\n']]) {
          await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content });
        }
        const blocked = await context.request.post('/api/files/rename', { headers,
          data: { oldPath: 'target.md', newPath: 'occupied.md' } });
        expect(blocked.status()).toBe(409);
        const blockedResult = await blocked.json();
        expect(blockedResult.operation.status).toBe('blocked');
        const directory = await context.request.post('/api/files/create', { headers, data: { path: 'folder', type: 'directory' } });
        expect(directory.ok()).toBeTruthy();
        const early = await context.request.post('/api/files/rename', { headers,
          data: { oldPath: 'target.md', newPath: 'folder', overwrite: true } });
        expect(early.status()).toBe(409); expect((await early.json()).code).toBe('BATCH_OVERWRITE_REQUIRES_FILES');
        let notices: Array<{ id: string; target: { kind: string; batchId?: string; problemId?: string }; workspaceId: string }> = [];
        await expect.poll(async () => {
          const response = await context.request.get('/api/notifications/summary?todoMode=lifecycle');
          expect(response.ok()).toBeTruthy();
          const summary = (await response.json()).data;
          notices = summary.sections.notifications.filter((item: { workspaceId: string; target: { kind: string } }) =>
            item.workspaceId === workspaceId && item.target.kind === 'file_path_operation');
          return notices.length;
        }).toBe(2);
        const batchNotice = notices.find((item) => item.target.batchId === blockedResult.operation.batchId)!;
        const problemNotice = notices.find((item) => item.target.problemId)!;
        expect(batchNotice).toBeTruthy(); expect(problemNotice).toBeTruthy();
        for (const filePath of ['target.md', 'occupied.md', 'links.md']) {
          const response = await context.request.get(`/api/files/read?path=${filePath}`, { headers });
          expect(response.ok()).toBeTruthy();
          expect((await response.json()).data.content).toBe(filePath === 'target.md' ? '# Target\n'
            : filePath === 'occupied.md' ? '# Occupied\n' : '[Target](target.md)\n');
        }
        await context.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
        const page = await context.newPage();
        await page.goto(`/en/notebook?workspaceId=${workspaceId}`);
        await page.getByTestId('notification-bell').click({ timeout: 60_000 });
        await page.locator(`[data-notification-id="${batchNotice.id}"]`).click();
        const dialog = page.getByTestId('workspace-path-operation-status');
        await expect(dialog).toBeVisible(); await expect(dialog).toContainText('target.md');
        await expect(dialog).not.toContainText('workspacePathOperationStatus.');
        await expect(page.getByTestId('workspace-path-operation-resume')).toHaveCount(0);
        await expect(page.getByTestId('workspace-operation-review-center')).toHaveCount(0);
        if (mobile) {
          const box = (await dialog.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(391);
        }
        await page.screenshot({ path: info.outputPath('blocked-file-action.png'), animations: 'disabled' });
        await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
        await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspacePathProblem=${problemNotice.target.problemId}`);
        await expect(dialog).toBeVisible({ timeout: 60_000 });
        await expect(dialog).not.toContainText('workspacePathOperationStatus.');
        await expect(dialog).toContainText('BATCH_OVERWRITE_REQUIRES_FILES');
        await expect(dialog).toContainText('target.md');
        await expect(dialog).not.toContainText('/var/folders/');
        await expect(page.getByTestId('workspace-operation-review-center')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('early-file-action-problem.png'), animations: 'disabled' });
        await context.request.patch('/api/notifications/summary?todoMode=lifecycle', {
          data: { action: 'mark_item_read', itemId: problemNotice.id, workspaceId },
        });
        const summaryAfterRead = (await (await context.request.get('/api/notifications/summary?todoMode=lifecycle')).json()).data;
        const stillVisible = summaryAfterRead.sections.notifications.find((item: { id: string }) => item.id === problemNotice.id);
        expect(stillVisible).toBeTruthy(); expect(stillVisible.unread).toBe(false);
      } finally {
        await context.request.delete(`/api/workspaces/${workspaceId}`);
        await context.close();
      }
    });
  }
});
