import { expect, test } from '@playwright/test';
import type { WorkspaceOperationReviewPublic } from '../app/lib/files/workspace-operation-review-contract';
import type { NotificationItem, NotificationSummary } from '../app/components/notifications/notification-summary';
import { createAuthenticatedContext } from './helpers/managed-test-context';

test('file-action notifications retain blocked reviews and open actionable guidance', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
  try {
    const response = await context.request.get('/api/workspaces');
    expect(response.ok()).toBeTruthy();
    const workspaces = (await response.json()).workspaces as Array<{ id: string; permissions: { canRead: boolean; canWrite: boolean } }>;
    const workspaceId = workspaces.find((workspace) => workspace.permissions.canRead && workspace.permissions.canWrite)!.id;
    const startingWorkspaceId = workspaces.find((workspace) => workspace.id !== workspaceId && workspace.permissions.canRead)?.id ?? workspaceId;
    const liveSummary = await context.request.get('/api/notifications/summary');
    expect(liveSummary.ok()).toBeTruthy();
    expect((await liveSummary.json()).data.sources.fileOperations.available).toBe(true);
    const reviewId = 'notification-ui-fixture';
    let status: WorkspaceOperationReviewPublic['status'] = 'blocked';
    let unread = true;
    let decisions = 0;
    const review = (): WorkspaceOperationReviewPublic => ({
      reviewId, planId: 'a'.repeat(64), kind: 'copy',
      selections: [{ sourcePath: 'Skills/SKILL.md', destinationPath: 'Content/SKILL.md' }],
      sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId,
      status, actor: { type: 'agent', id: 'agent-fixture' }, reasonCodes: ['INCOMPLETE_PREVIEW'],
      preview: { contractVersion: 1, planId: 'a'.repeat(64), kind: 'copy', status: 'planned', readiness: 'blocked',
        pathMappings: [{ sourceWorkspaceId: workspaceId, sourcePath: 'Skills/SKILL.md',
          destinationWorkspaceId: workspaceId, destinationPath: 'Content/SKILL.md', sourceIdentity: 'fixture' }],
        linkEdits: [], collisions: [], expectedPathState: [], recoveryReady: false,
        coverage: { complete: false, omittedSources: [], unresolvedLinks: [{ sourcePath: '00_dashboard/STRATEGIE.md',
          targetLiteral: '../../../04_launches/BATCH.md', status: 'outside-workspace' }] },
        issues: [{ code: 'incomplete-index', workspaceId, path: '', detail: 'Some source links were not fully evaluated.' }] },
      createdAt: Date.now(), updatedAt: Date.now(), operationId: null, errorCode: null, trashEntryIds: [],
    });
    const item = (): NotificationItem => ({
      id: `file-operation:${reviewId}`, type: 'file.operation_review_required', title: 'Fixture', detail: 'Skills/SKILL.md',
      occurredAt: new Date().toISOString(), unread, priority: 'high', workspaceId, workspaceName: 'Review workspace',
      target: { kind: 'file_operation', workspaceId, reviewId, operationKind: 'copy', status: 'blocked' },
    });
    await context.route('**/api/notifications/summary*', async (route) => {
      if (route.request().method() === 'PATCH') {
        unread = false;
        await route.fulfill({ json: { success: true } });
        return;
      }
      const items = status === 'rejected' ? [] : [item()];
      const summary: NotificationSummary = { unreadCount: unread ? items.length : 0,
        counts: { unread: unread ? items.length : 0, chat: 0, todos: 0, todoUnread: 0, todoAttention: 0,
          emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 }, items,
        sections: { notifications: items, todos: [], todoUnread: [], todoAttention: [], emailAttention: [] } };
      await route.fulfill({ json: { success: true, data: summary } });
    });
    await context.route(`**/api/files/operation-reviews/${reviewId}`, async (route) => {
      expect(route.request().headers()['x-canvas-workspace-id']).toBe(workspaceId);
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ action: 'reject', planId: 'a'.repeat(64) });
        decisions += 1;
        status = 'rejected';
      }
      await route.fulfill({ json: { success: true, review: review() } });
    });
    await context.addInitScript((id) => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, startingWorkspaceId);
    const page = await context.newPage();
    await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(startingWorkspaceId)}`);
    const bell = page.getByTestId('notification-bell').first();
    await bell.click();
    const notification = page.locator(`[data-notification-id="file-operation:${reviewId}"]`);
    await expect(notification).toContainText('Copy: action blocked');
    await expect(notification).toContainText('Resolve the issues');
    await page.screenshot({ path: testInfo.outputPath('file-action-notification.png'), animations: 'disabled' });
    await notification.click();
    const panel = page.getByTestId('workspace-operation-review-center');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Correct the listed missing targets');
    await expect(panel).toContainText('This action has not been executed');
    await expect(panel.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('blocked-review-desktop.png'), animations: 'disabled' });
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click();
    await bell.click();
    await expect(notification).toBeVisible();
    expect(unread).toBe(false);
    expect(decisions).toBe(0);
    await notification.click();
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click();

    await page.goto('/en');
    const homeLink = page.getByRole('link', { name: /Copy: action blocked/u }).first();
    await expect(homeLink).toBeVisible();
    await homeLink.click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click();

    // Deep links must select the review, including on a narrow display.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&workspaceOperationReview=${reviewId}`);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Dismiss', exact: true })).toBeInViewport();
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    await page.screenshot({ path: testInfo.outputPath('blocked-review-mobile.png'), animations: 'disabled' });
    await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(panel).toContainText('Rejected');
    expect(decisions).toBe(1);
    await panel.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.setViewportSize({ width: 1440, height: 960 });
    await bell.click();
    await expect(notification).toHaveCount(0);
  } finally {
    await context.close();
  }
});
