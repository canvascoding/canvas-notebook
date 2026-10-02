import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import type { WorkspaceOperationBatchPublic } from '../app/lib/files/workspace-operation-batch-public';
import type { WorkspaceOperationCheckResponse } from '../app/lib/files/workspace-operation-check-contract';
import type { WorkspaceOperationReviewPublic } from '../app/lib/files/workspace-operation-review-contract';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const run = promisify(execFile);

test('real move reviews distinguish old warnings, affected blockers and stale plans, and undo safely', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
  const cleanupRequest = await request.newContext({ baseURL: process.env.BASE_URL,
    storageState: await context.storageState(), timeout: 5_000 });
  const workspaceName = `E2E link review ${randomUUID()}`;
  let workspaceId: string | undefined;
  let ownerUserId: string | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  const cleanupOwnedWorkspace = async (api: APIRequestContext) => {
    if (!workspaceId) return;
    if (!ownerUserId) throw new Error('Owned workspace cleanup has no verified actor.');
    const session = await api.get('/api/auth/get-session');
    expect(session.status(), 'Independent cleanup authentication').toBe(200);
    expect((await session.json()).user.id).toBe(ownerUserId);
    const listing = await api.get('/api/workspaces');
    expect(listing.status(), 'Owned workspace cleanup listing').toBe(200);
    const owned = (await listing.json()).workspaces.find((item: { id: string }) => item.id === workspaceId);
    expect(owned).toMatchObject({ id: workspaceId, name: workspaceName,
      ownerUserId, type: 'personal', status: 'active' });
    const deleted = await api.delete(`/api/workspaces/${workspaceId}`);
    expect(deleted.status(), 'Exact owned workspace cleanup').toBe(200);
    expect(await deleted.json()).toEqual({ success: true });
    const after = await api.get('/api/workspaces');
    expect(after.status(), 'Owned workspace cleanup verification').toBe(200);
    expect((await after.json()).workspaces.some((item: { id: string }) => item.id === workspaceId)).toBe(false);
  };
  try {
    const session = await context.request.get('/api/auth/get-session');
    expect(session.ok()).toBeTruthy();
    const { user } = await session.json();
    ownerUserId = user.id;
    const created = await context.request.post('/api/workspaces', {
      data: { type: 'personal', name: workspaceName }, timeout: 15_000,
    });
    const receipt = (await created.json()).workspace;
    if (typeof receipt?.id === 'string' && receipt.id) workspaceId = receipt.id;
    expect(created.status()).toBe(201);
    expect(receipt).toMatchObject({ id: workspaceId, name: workspaceName, ownerUserId: user.id, type: 'personal' });
    expect(workspaceId).toEqual(expect.any(String));
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
    // CSV uses the normal revision-checked upload contract. An existing Yjs
    // Markdown document must be edited through collaboration instead of upload.
    const asset = `${source}/revision-fence.csv`;
    const originalAsset = 'revision,value\n1,original\n';
    await upload(`${source}/${contentPlan}`, '# Content plan\n');
    await upload(structure, '[Content plan](atelier-notes/_content-plan.md)\n');
    await upload(strategy, '[Content plan](../atelier-notes/_content-plan.md)\n');
    await upload(unrelated, '[Old link](unavailable.md)\n');
    await upload(asset, originalAsset);

    const submit = async (sourcePath = source, destinationPath = destination): Promise<WorkspaceOperationReviewPublic> => {
      const result = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
        'scripts/workspace-operation-link-review-e2e-fixture.ts', JSON.stringify({
          workspaceId, user: { id: user.id, email: user.email, role: user.role }, sourcePath, destinationPath,
        })], { cwd: process.cwd(), env: process.env, timeout: 60_000 });
      const line = result.stdout.split('\n').find((value) => value.startsWith('REVIEW_FIXTURE:'));
      expect(line).toBeTruthy();
      const submission = JSON.parse(line!.slice('REVIEW_FIXTURE:'.length));
      const response = await context.request.get(`/api/files/operation-reviews/${submission.reviewId}`, { headers });
      expect(response.ok()).toBeTruthy();
      const review = (await response.json()).review as WorkspaceOperationReviewPublic;
      expect(review).toMatchObject({ reviewId: submission.reviewId, sourceWorkspaceId: workspaceId,
        destinationWorkspaceId: workspaceId });
      return review;
    };
    const readEvidence = async (filePath: string) => {
      const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers, timeout: 5_000 });
      expect(response.status(), `Read own fixture ${filePath}`).toBe(200);
      const payload = await response.json() as { success: boolean; data: { path: string; content: string;
        stats: { sha256: string; fileVersion: string }; revision: { id: string } | null } };
      expect(payload.success).toBe(true);
      expect(payload.data.path).toBe(filePath);
      return payload.data;
    };
    const read = async (filePath: string) => (await readEvidence(filePath)).content;
    await context.addInitScript((id) => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspaceId!);
    const page = await context.newPage();
    const panel = page.getByTestId('workspace-operation-review-center');
    const open = async (review: WorkspaceOperationReviewPublic) => {
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspaceOperationReview=${review.reviewId}`);
      await expect(panel).toBeVisible({ timeout: 30_000 });
    };
    const readBatch = async (expected: WorkspaceOperationBatchPublic) => {
      const response = await context.request.get(`/api/files/operation-reviews/batches/${expected.batchId}`, { headers, timeout: 5_000 });
      expect(response.status(), 'Read exact owned batch').toBe(200);
      const payload = await response.json() as { success: boolean; batch: WorkspaceOperationBatchPublic };
      expect(payload.success).toBe(true);
      expect(payload.batch).toMatchObject({ batchId: expected.batchId, planId: expected.planId,
        workspaceId, reviewIds: expected.reviewIds });
      expect(payload.batch.preview.planId).toBe(expected.planId);
      return payload.batch;
    };
    const waitForBatchStatus = async (expected: WorkspaceOperationBatchPublic, status: 'applied' | 'undone') => {
      let current = expected;
      await expect.poll(async () => {
        current = await readBatch(expected);
        if (['failed', 'needs_review', 'needs_recovery', 'blocked'].includes(current.status)) {
          throw new Error(`Owned batch reached ${current.status} (${current.errorCode ?? 'no error code'}).`);
        }
        return current.status;
      }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toBe(status);
      expect(current.errorCode).toBeNull();
      expect(current.completedActions).toBe(current.totalActions);
      expect(current.preview).toEqual(expected.preview);
      return current;
    };
    const captureUiBatch = async (review: WorkspaceOperationReviewPublic, status: 'ready' | 'blocked') => {
      // Observe the actual UI request before navigation; observe its rejection
      // immediately as well if navigation fails before a check can be queued.
      const queued = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/files/operation-reviews/checks'
        && response.request().method() === 'POST'
        && JSON.stringify(response.request().postDataJSON().reviewIds) === JSON.stringify([review.reviewId]),
      { timeout: 60_000 }).then((response) => ({ response }), (error: unknown) => ({ error }));
      await open(review);
      const observed = await queued;
      if ('error' in observed) throw observed.error;
      expect(observed.response.status(), 'UI enqueues the owned background check').toBe(202);
      const { check } = await observed.response.json() as WorkspaceOperationCheckResponse;
      expect(check).toMatchObject({ workspaceId, reviewIds: [review.reviewId] });
      let result: WorkspaceOperationCheckResponse | undefined;
      await expect.poll(async () => {
        const response = await context.request.get(`/api/files/operation-reviews/checks/${check.checkId}`, { headers, timeout: 5_000 });
        expect(response.status(), 'Read exact owned UI check').toBe(200);
        result = await response.json() as WorkspaceOperationCheckResponse;
        expect(result.check).toMatchObject({ checkId: check.checkId, workspaceId, reviewIds: [review.reviewId] });
        if (result.check.status === 'failed') throw new Error(`Owned check failed (${result.check.errorCode ?? 'no error code'}).`);
        return result.check.status;
      }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toBe(status);
      const batch = result!.batch!;
      expect(batch).toMatchObject({ batchId: result!.check.batchId, workspaceId, reviewIds: [review.reviewId],
        status: status === 'ready' ? 'preview' : 'blocked' });
      expect(batch.planId).toMatch(/^[a-f0-9]{64}$/u);
      expect(batch.preview.planId).toBe(batch.planId);
      await expect(panel.getByTestId('workspace-operation-plan-id')).toHaveText(batch.planId, { timeout: 30_000 });
      return batch;
    };

    const ready = await submit();
    expect(ready.status).toBe('pending');
    expect(ready.preview.coverage.complete).toBe(false);
    expect('linkAssessment' in ready.preview && ready.preview.linkAssessment?.warnings).toHaveLength(1);
    const readyBatch = await captureUiBatch(ready, 'ready');
    const acceptButton = panel.getByTestId('workspace-operation-batch-accept');
    await expect(acceptButton).toHaveAccessibleName('Accept these actions');
    await expect(acceptButton).toBeEnabled();
    await expect(panel).toContainText('Ready for approval');
    await panel.getByTestId('workspace-operation-technical-details').locator('summary').first().click();
    await panel.getByTestId('workspace-operation-link-warnings').locator('summary').click();
    await expect(panel.getByTestId('workspace-operation-link-warnings')).toContainText(unrelated);
    await page.screenshot({ path: testInfo.outputPath('warning-only-review.png'), animations: 'disabled' });
    const [accepted] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/files/operation-reviews/batches'
        && response.request().method() === 'POST' && response.request().postDataJSON().action === 'accept'),
      acceptButton.click(),
    ]);
    expect(accepted.request().postDataJSON()).toEqual({ action: 'accept', batchId: readyBatch.batchId, planId: readyBatch.planId });
    expect(accepted.status()).toBe(202);
    expect((await accepted.json()).batch).toMatchObject({ batchId: readyBatch.batchId, planId: readyBatch.planId, workspaceId });
    await waitForBatchStatus(readyBatch, 'applied');
    await expect(panel).toContainText('File actions completed', { timeout: 30_000 });
    expect(await read(`${destination}/${contentPlan}`)).toBe('# Content plan\n');
    expect(await read(structure)).toBe('[Content plan](channels/atelier-notes/_content-plan.md)\n');
    expect(await read(strategy)).toBe('[Content plan](../channels/atelier-notes/_content-plan.md)\n');
    expect(await read(unrelated)).toBe('[Old link](unavailable.md)\n');
    expect(await read(`${destination}/revision-fence.csv`)).toBe(originalAsset);
    const appliedResponse = await context.request.get(`/api/files/operation-reviews/${ready.reviewId}`, { headers });
    const applied = (await appliedResponse.json()).review as WorkspaceOperationReviewPublic;
    expect(applied).toMatchObject({ reviewId: ready.reviewId, status: 'applied', batchId: readyBatch.batchId });
    const undoButton = panel.getByRole('button', { name: 'Undo file action', exact: true });
    await expect(undoButton).toBeVisible({ timeout: 30_000 });
    const [undo] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/files/operation-reviews/batches/${readyBatch.batchId}`
        && response.request().method() === 'POST'),
      undoButton.click(),
    ]);
    expect(undo.request().postDataJSON()).toEqual({ action: 'undo', planId: readyBatch.planId });
    expect(undo.status()).toBe(202);
    expect((await undo.json()).batch).toMatchObject({ batchId: readyBatch.batchId, planId: readyBatch.planId, workspaceId });
    await waitForBatchStatus(readyBatch, 'undone');
    await expect(panel).toContainText('File actions undone', { timeout: 30_000 });
    expect(await read(`${source}/${contentPlan}`)).toBe('# Content plan\n');
    expect(await read(structure)).toBe('[Content plan](atelier-notes/_content-plan.md)\n');
    expect(await read(strategy)).toBe('[Content plan](../atelier-notes/_content-plan.md)\n');
    expect(await read(asset)).toBe(originalAsset);
    expect(await read(unrelated)).toBe('[Old link](unavailable.md)\n');
    const absent = await context.request.get(`/api/files/read?path=${encodeURIComponent(`${destination}/${contentPlan}`)}`, { headers, timeout: 5_000 });
    expect(absent.status()).toBe(404);

    const affected = 'notes/maison-margiela-replica-alternative.md';
    const selectedCollection = `${source}/The First 100 Collection.md`;
    const otherCollection = 'library/The First 100 Collection.md';
    const renamedCollection = `${source}/collection-renamed.md`;
    await upload(selectedCollection, '# Selected collection\n');
    await upload(otherCollection, '# Other collection\n');
    await upload(affected, '# Article\n[[The First 100 Collection]]\n');
    // Renaming one ambiguous candidate would bind the existing Wiki link to
    // the other document. This is a real blocker, unlike an unchanged missing name.
    const blocked = await submit(selectedCollection, renamedCollection);
    expect(blocked.status).toBe('blocked');
    const blockedBatch = await captureUiBatch(blocked, 'blocked');
    expect(blockedBatch.preview.readiness).toBe('blocked');
    expect(blockedBatch.completedActions).toBe(0);
    expect(blockedBatch.preview.linkAssessment.blockers.some((blocker) => blocker.sourcePath === affected
      && blocker.targetLiteral === 'The First 100 Collection' && blocker.reason === 'resolution-changed'
      && blocker.status === 'resolved')).toBe(true);
    await expect(acceptButton).toHaveCount(0);
    await expect(panel.getByTestId('workspace-operation-link-blockers')).toContainText(affected);
    await expect(panel.getByTestId('workspace-operation-link-blockers')).toContainText('The First 100 Collection');
    await page.screenshot({ path: testInfo.outputPath('affected-link-blocked-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(blocked);
    await expect(panel.getByTestId('workspace-operation-link-blockers')).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByRole('button', { name: 'Dismiss', exact: true })).toBeInViewport({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('affected-link-blocked-mobile.png'), animations: 'disabled' });
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    expect(await read(affected)).toBe('# Article\n[[The First 100 Collection]]\n');

    // Repair the target through the API; the earlier proposal and blocked batch
    // retain their exact original preview instead of silently approving it.
    await upload('The First 100 Collection.md', '# Collection\n');
    const repaired = await submit(selectedCollection, renamedCollection);
    expect(repaired.status).toBe('pending');
    expect(repaired.planId).not.toBe(blocked.planId);
    const oldReviewResponse = await context.request.get(`/api/files/operation-reviews/${blocked.reviewId}`, { headers });
    expect(oldReviewResponse.status()).toBe(200);
    const oldReview = (await oldReviewResponse.json()).review as WorkspaceOperationReviewPublic;
    expect(oldReview).toMatchObject({ reviewId: blocked.reviewId, planId: blocked.planId, status: 'blocked',
      sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId });
    expect(oldReview.preview).toEqual(blocked.preview);
    const retainedBlockedBatch = await readBatch(blockedBatch);
    expect(retainedBlockedBatch.status).toBe('blocked');
    expect(retainedBlockedBatch.completedActions).toBe(0);
    expect(retainedBlockedBatch.preview).toEqual(blockedBatch.preview);
    const repairedBatch = await captureUiBatch(repaired, 'ready');
    expect(repairedBatch.preview.linkAssessment.blockers).toHaveLength(0);
    expect(repairedBatch.completedActions).toBe(0);
    expect(await read(selectedCollection)).toBe('# Selected collection\n');
    expect(await read(otherCollection)).toBe('# Other collection\n');

    // Independent old warnings remain nonblocking. Capture the exact checked
    // batch before a normal upload changes a file inside the approved move.
    await upload('archive/new.md', '[Another old link](also-unavailable.md)\n');
    await page.setViewportSize({ width: 1440, height: 960 });
    const folderReview = await submit();
    expect(folderReview.status).toBe('pending');
    const staleBatch = await captureUiBatch(folderReview, 'ready');
    expect(staleBatch.preview.linkAssessment.warnings).toHaveLength(2);
    expect(staleBatch.preview.linkAssessment.blockers).toHaveLength(0);
    const immutablePreview = structuredClone(staleBatch.preview);
    const before = await readEvidence(asset);
    expect(before.content).toBe(originalAsset);
    expect(before.revision?.id).toEqual(expect.any(String));
    expect(staleBatch.preview.expectedPathState.find((entry) => entry.path === asset)?.identity).toBe(before.stats.fileVersion);
    const changedAsset = 'revision,value\n2,newer-owned-upload\n';
    await upload(asset, changedAsset);
    const changed = await readEvidence(asset);
    expect(changed.content).toBe(changedAsset);
    expect(changed.stats.sha256).not.toBe(before.stats.sha256);
    expect(changed.stats.fileVersion).not.toBe(before.stats.fileVersion);
    expect(changed.revision?.id).toEqual(expect.any(String));
    expect(changed.revision?.id).not.toBe(before.revision?.id);
    expect((await readBatch(staleBatch)).preview).toEqual(immutablePreview);
    const staleCheck = panel.getByTestId('workspace-operation-check-status');
    await expect(staleCheck).toHaveAttribute('data-status', 'stale', { timeout: 30_000 });
    await expect(staleCheck.getByRole('heading', { name: 'Files changed — check again', exact: true })).toBeVisible();
    await expect(staleCheck).toContainText('Files or document text changed after this check started. Check again to get a current preview before approving.');
    await expect(acceptButton).toHaveCount(0);
    const checkAgain = staleCheck.getByTestId('workspace-operation-check-again');
    await expect(checkAgain).toHaveAccessibleName('Check again');
    await expect(checkAgain).toBeEnabled();
    // The UI proactively prevents approval. The independent authenticated API
    // must also reject the original immutable batch and plan after this upload.
    const rejected = await cleanupRequest.post('/api/files/operation-reviews/batches', {
      headers, data: { action: 'accept', batchId: staleBatch.batchId, planId: staleBatch.planId }, timeout: 5_000,
    });
    expect(rejected.status()).toBe(409);
    expect(await rejected.json()).toMatchObject({ success: false, code: 'PREVIEW_STALE' });
    const notQueued = await readBatch(staleBatch);
    expect(notQueued.status).toBe('preview');
    expect(notQueued.completedActions).toBe(0);
    expect(notQueued.preview).toEqual(immutablePreview);
    expect(await read(asset)).toBe(changedAsset);
    expect(await read(`${source}/${contentPlan}`)).toBe('# Content plan\n');
    expect(await read(structure)).toBe('[Content plan](atelier-notes/_content-plan.md)\n');
    expect(await read(strategy)).toBe('[Content plan](../atelier-notes/_content-plan.md)\n');
    expect(await read(affected)).toBe('# Article\n[[The First 100 Collection]]\n');
    expect(await read(selectedCollection)).toBe('# Selected collection\n');
    expect(await read(otherCollection)).toBe('# Other collection\n');
    expect(await read('The First 100 Collection.md')).toBe('# Collection\n');
    expect(await read(unrelated)).toBe('[Old link](unavailable.md)\n');
    expect(await read('archive/new.md')).toBe('[Another old link](also-unavailable.md)\n');
    expect((await context.request.get(`/api/files/read?path=${encodeURIComponent(`${destination}/${contentPlan}`)}`, { headers, timeout: 5_000 })).status()).toBe(404);
  } catch (error) {
    primaryError = error;
  } finally {
    try { await cleanupOwnedWorkspace(cleanupRequest); } catch (error) { cleanupErrors.push(error); }
    try { await cleanupRequest.dispose(); } catch (error) { cleanupErrors.push(error); }
    try { await context.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], 'File review failed and owned fixture cleanup also failed.');
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned file review fixture cleanup failed.');
});
