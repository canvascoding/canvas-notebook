import { expect, test } from '@playwright/test';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

for (const [label, viewport] of [['desktop', { width: 1440, height: 960 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test(`administrator Review Center toggle preserves automatic links and original requests on ${label}`, async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const context = await createAuthenticatedContext(browser, { viewport });
    let workspaceId: string | undefined;
    try {
      const created = await context.request.post('/api/workspaces', {
        data: { type: 'personal', name: `E2E batch review toggle ${label} ${Date.now()}` },
      });
      expect(created.ok()).toBeTruthy();
      workspaceId = (await created.json()).workspace.id;
      const headers = { 'x-canvas-workspace-id': workspaceId! };
      for (const [filePath, content] of [['approved.md', '# Approved\n'], ['pending.md', '# Pending\n'], ['automatic.md', '# Automatic\n'],
        ['approved-links.md', '[Approved](approved.md)\n'], ['pending-links.md', '[Pending](pending.md)\n'], ['automatic-links.md', '[Automatic](automatic.md)\n']]) {
        await uploadWorkspaceTextFile({ request: context.request, workspaceId: workspaceId!, filePath, content });
      }
      const read = async (filePath: string) => {
        const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
        expect(response.ok()).toBeTruthy();
        return (await response.json()).data.content as string;
      };
      const remove = (filePath: string, idempotencyKey: string) => context.request.delete('/api/files/delete', {
        headers, data: { path: filePath, idempotencyKey },
      });
      const page = await context.newPage();
      await page.goto('/en/settings?tab=experimental');
      const toggle = page.locator('#document-review-enabled');
      await expect(toggle).toBeVisible();
      await expect(toggle).toBeEnabled();
      if (await toggle.getAttribute('aria-checked') === 'false') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect.poll(async () => (await (await context.request.get('/api/document-review/availability')).json()).data.documentReviewEnabled).toBe(true);
      const approved = await remove('approved.md', 'approved-delete');
      expect(approved.ok()).toBeTruthy();
      const approvedReview = (await approved.json()).reviewRequired;
      expect(approvedReview.status).toBe('pending');
      const preview = await context.request.post('/api/files/operation-reviews/batches', {
        headers, data: { action: 'preview', reviewIds: [approvedReview.reviewId] },
      });
      expect(preview.ok()).toBeTruthy();
      const batch = (await preview.json()).batch;
      const accepted = await context.request.post('/api/files/operation-reviews/batches', {
        headers, data: { action: 'accept', batchId: batch.batchId, planId: batch.planId },
      });
      expect(accepted.ok()).toBeTruthy();
      await expect.poll(async () => (await (await context.request.get(`/api/files/operations/batches/${batch.batchId}`)).json()).operation.status,
        { timeout: 60_000 }).toBe('applied');
      expect(await read('approved-links.md')).toBe('Approved\n');
      const pending = await remove('pending.md', 'pending-delete');
      expect(pending.ok()).toBeTruthy();
      const pendingReview = (await pending.json()).reviewRequired;
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspaceOperationReview=${pendingReview.reviewId}`);
      await expect(page.getByTestId('workspace-operation-review-center')).toBeVisible();
      await page.getByTestId('workspace-operation-review-center').getByRole('button', { name: 'Close', exact: true }).first().click();
      await page.goto('/en/settings?tab=experimental');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect.poll(async () => (await (await context.request.get('/api/document-review/availability')).json()).data.documentReviewEnabled).toBe(false);
      await expect(page.getByText(/automatically.*links|links.*automatically/iu).first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('review-center-disabled-settings.png'), animations: 'disabled' });
      const pendingRetry = await remove('pending.md', 'pending-delete');
      expect(pendingRetry.ok()).toBeTruthy();
      expect((await pendingRetry.json()).reviewRequired).toEqual(pendingReview);
      expect(await read('pending.md')).toBe('# Pending\n');
      expect(await read('pending-links.md')).toBe('[Pending](pending.md)\n');
      const disabledAccept = await context.request.post(`/api/files/operation-reviews/${pendingReview.reviewId}`, {
        headers, data: { action: 'accept', planId: pendingReview.planId },
      });
      expect(disabledAccept.status()).toBe(409);
      expect((await disabledAccept.json()).code).toBe('DOCUMENT_REVIEW_DISABLED');
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspaceOperationReview=${pendingReview.reviewId}`);
      const status = page.getByTestId('workspace-path-operation-status');
      await expect(status).toBeVisible();
      await expect(page.getByTestId('workspace-operation-review-center')).toHaveCount(0);
      await expect(status.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
      await expect(status).toContainText(/disabled|paused/iu);
      await page.screenshot({ path: testInfo.outputPath('paused-review-outside-center.png'), animations: 'disabled' });
      await status.getByRole('button', { name: 'Close', exact: true }).first().click();
      const automatic = await remove('automatic.md', 'automatic-delete');
      expect(automatic.ok()).toBeTruthy();
      const automaticResult = await automatic.json();
      expect(automaticResult.operation.status).toBe('applied');
      expect(automaticResult.reviewRequired).toBeUndefined();
      expect(await read('automatic-links.md')).toBe('Automatic\n');
      const recovery = await context.request.get(`/api/files/operations/batches/${batch.batchId}`);
      expect(recovery.ok()).toBeTruthy();
      expect((await recovery.json()).recovery.canUndo).toBe(true);
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspacePathBatch=${batch.batchId}`);
      await expect(status).toBeVisible();
      await expect(status.getByTestId('workspace-path-operation-undo')).toBeEnabled();
      await status.getByTestId('workspace-path-operation-undo').click();
      await expect(status).toContainText('Action undone', { timeout: 60_000 });
      expect(await read('approved.md')).toBe('# Approved\n');
      expect(await read('approved-links.md')).toBe('[Approved](approved.md)\n');
      await expect(page.getByTestId('workspace-operation-review-center')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('undo-with-review-center-disabled.png'), animations: 'disabled' });
    } finally {
      if (workspaceId) await context.request.delete(`/api/workspaces/${workspaceId}`);
      await context.close();
    }
  });
}
