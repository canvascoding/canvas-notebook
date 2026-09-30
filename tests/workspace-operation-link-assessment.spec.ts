import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import type { WorkspaceOperationReviewPublic } from '../app/lib/files/workspace-operation-review-contract';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const run = promisify(execFile);

test('real move reviews distinguish old warnings, affected blockers and stale plans, and undo safely', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
  let workspaceId: string | undefined;
  try {
    const session = await context.request.get('/api/auth/get-session');
    expect(session.ok()).toBeTruthy();
    const { user } = await session.json();
    const created = await context.request.post('/api/workspaces', {
      data: { type: 'personal', name: `E2E link review ${Date.now()}` },
    });
    expect(created.ok()).toBeTruthy();
    workspaceId = (await created.json()).workspace.id;
    const headers = { 'x-canvas-workspace-id': workspaceId! };
    const upload = (filePath: string, content: string) => uploadWorkspaceTextFile({
      request: context.request, workspaceId: workspaceId!, filePath, content,
    });
    const source = '05_content-engine/atelier-notes';
    const destination = '05_content-engine/channels/atelier-notes';
    const contentPlan = '_content-plan.md';
    const structure = '05_content-engine/CONTENT-STRUKTUR-VORSCHLAG.md';
    const strategy = '05_content-engine/strategy/Instagram-Reel-Content-Pipeline-Plan.md';
    const unrelated = 'archive/old.md';
    await upload(`${source}/${contentPlan}`, '# Content plan\n');
    await upload(structure, '[Content plan](atelier-notes/_content-plan.md)\n');
    await upload(strategy, '[Content plan](../atelier-notes/_content-plan.md)\n');
    await upload(unrelated, '[Old link](unavailable.md)\n');

    const submit = async (): Promise<WorkspaceOperationReviewPublic> => {
      const result = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
        'scripts/workspace-operation-link-review-e2e-fixture.ts', JSON.stringify({
          workspaceId, user: { id: user.id, email: user.email, role: user.role }, sourcePath: source, destinationPath: destination,
        })], { cwd: process.cwd(), env: process.env, timeout: 60_000 });
      const line = result.stdout.split('\n').find((value) => value.startsWith('REVIEW_FIXTURE:'));
      expect(line).toBeTruthy();
      const submission = JSON.parse(line!.slice('REVIEW_FIXTURE:'.length));
      const response = await context.request.get(`/api/files/operation-reviews/${submission.reviewId}`, { headers });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).review;
    };
    const read = async (filePath: string) => {
      const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).data.content as string;
    };
    await context.addInitScript((id) => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspaceId!);
    const page = await context.newPage();
    const panel = page.getByTestId('workspace-operation-review-center');
    const open = async (review: WorkspaceOperationReviewPublic) => {
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspaceOperationReview=${review.reviewId}`);
      await expect(panel).toBeVisible();
    };

    const ready = await submit();
    expect(ready.status).toBe('pending');
    expect(ready.preview.coverage.complete).toBe(false);
    expect('linkAssessment' in ready.preview && ready.preview.linkAssessment?.warnings).toHaveLength(1);
    await open(ready);
    await expect(panel.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
    await expect(panel).toContainText('Ready for approval');
    await panel.getByTestId('workspace-operation-link-warnings').locator('summary').click();
    await expect(panel.getByTestId('workspace-operation-link-warnings')).toContainText(unrelated);
    await page.screenshot({ path: testInfo.outputPath('warning-only-review.png'), animations: 'disabled' });
    await panel.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(panel).toContainText('Applied', { timeout: 60_000 });
    expect(await read(`${destination}/${contentPlan}`)).toBe('# Content plan\n');
    expect(await read(structure)).toBe('[Content plan](channels/atelier-notes/_content-plan.md)\n');
    expect(await read(strategy)).toBe('[Content plan](../channels/atelier-notes/_content-plan.md)\n');
    expect(await read(unrelated)).toBe('[Old link](unavailable.md)\n');
    const appliedResponse = await context.request.get(`/api/files/operation-reviews/${ready.reviewId}`, { headers });
    const applied = (await appliedResponse.json()).review as WorkspaceOperationReviewPublic;
    // The UI waits for asynchronous Yjs projection before offering the inverse.
    const undoButton = panel.getByRole('button', { name: 'Undo file action', exact: true });
    await expect(undoButton).toBeVisible({ timeout: 20_000 });
    const undoResponse = page.waitForResponse((response) => response.url().endsWith(`/api/files/operations/${applied.operationId}/undo`)
      && response.request().method() === 'POST');
    await undoButton.click();
    const undo = await undoResponse;
    expect(undo.ok()).toBeTruthy();
    expect((await undo.json()).undo.status).toBe('applied');
    await expect(panel).toContainText('The file action was undone.');
    expect(await read(`${source}/${contentPlan}`)).toBe('# Content plan\n');
    expect(await read(structure)).toBe('[Content plan](atelier-notes/_content-plan.md)\n');
    expect(await read(strategy)).toBe('[Content plan](../atelier-notes/_content-plan.md)\n');

    const affected = `${source}/maison-margiela-replica-alternative.md`;
    await upload(affected, '# Article\n[[The First 100 Collection]]\n');
    const blocked = await submit();
    expect(blocked.status).toBe('blocked');
    expect('linkAssessment' in blocked.preview && blocked.preview.linkAssessment?.blockers.some((blocker) =>
      blocker.sourcePath === affected && blocker.targetLiteral === 'The First 100 Collection')).toBe(true);
    await open(blocked);
    await expect(panel.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
    await expect(panel.getByTestId('workspace-operation-link-blockers')).toContainText(affected);
    await expect(panel.getByTestId('workspace-operation-link-blockers')).toContainText('The First 100 Collection');
    await page.screenshot({ path: testInfo.outputPath('affected-link-blocked-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(blocked);
    await expect(panel.getByRole('button', { name: 'Dismiss', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('affected-link-blocked-mobile.png'), animations: 'disabled' });
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    expect(await read(affected)).toBe('# Article\n[[The First 100 Collection]]\n');

    // Repair the target through the API; the original immutable blocked review stays blocked.
    await upload('The First 100 Collection.md', '# Collection\n');
    const repaired = await submit();
    expect(repaired.status).toBe('pending');
    expect(repaired.planId).not.toBe(blocked.planId);
    const oldReviewResponse = await context.request.get(`/api/files/operation-reviews/${blocked.reviewId}`, { headers });
    expect((await oldReviewResponse.json()).review.status).toBe('blocked');

    // A changed diagnostic changes the hashed plan and forces a new preview before any write.
    await upload('archive/new.md', '[Another old link](also-unavailable.md)\n');
    await page.setViewportSize({ width: 1440, height: 960 });
    await open(repaired);
    await panel.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(panel).toContainText('Stale', { timeout: 60_000 });
    expect(await read(`${source}/${contentPlan}`)).toBe('# Content plan\n');
  } finally {
    if (workspaceId) {
      const cleanup = await context.request.delete(`/api/workspaces/${workspaceId}`);
      expect(cleanup.ok()).toBeTruthy();
    }
    await context.close();
  }
});
