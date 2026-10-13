import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

test('the experimental Review Center stays disabled while normal scene editing works', async ({ browser }) => {
  test.skip(process.env.EXCALIDRAW_SCENE_E2E !== '1', 'Requires the isolated managed PostgreSQL profile.');
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL: process.env.BASE_URL });
  const page = await context.newPage();
  let workspaceId: string | undefined;
  let failure: unknown;
  try {
    await authenticateManagedTestPage(page);
    const availability = await page.request.get('/api/document-review/availability');
    expect((await availability.json()).data.documentReviewEnabled).toBe(false);
    await page.goto('/en/settings?tab=experimental');
    const toggle = page.locator('#document-review-enabled');
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    const createdWorkspace = await page.request.post('/api/workspaces', {
      data: { type: 'personal', name: `Review disabled ${randomUUID()}` },
    });
    expect(createdWorkspace.status()).toBe(201);
    workspaceId = (await createdWorkspace.json()).workspace.id;
    const headers = { 'x-canvas-workspace-id': workspaceId! };
    const create = await page.request.post('/api/excalidraw/scenes', {
      headers, data: { workspaceId, path: 'normal.excalidraw', idempotencyKey: randomUUID() },
    });
    expect(create.status()).toBe(201);
    const initial = (await create.json()).document;
    const url = `/api/excalidraw/scenes/${initial.documentId}`;
    const write = async (actions: unknown[]) => {
      const response = await page.request.post(`${url}/operations`, { headers, data: {
        workspaceId, documentId: initial.documentId, lifecycleGeneration: initial.lifecycleGeneration,
        observedSceneSequence: initial.sceneSequence, actions, idempotencyKey: randomUUID(),
      } });
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()).operation;
    };
    const element = { id: 'normal', type: 'rectangle', x: 200, y: 200, width: 100, height: 80,
      version: 1, versionNonce: 7, isDeleted: false };
    expect((await write([{ type: 'create', element }])).status).toBe('applied');
    const conflict = await write([{ type: 'update', elementId: element.id,
      expectedVersion: 2, expectedVersionNonce: 7, element: { ...element, x: 999, version: 3 } }]);
    expect(conflict.status).toBe('needs_review');
    expect(conflict.reviewRequired).toBe(true);
    expect(conflict.conflictHint).toMatch(/read|Get/iu);
    const before = (await (await page.request.get(url, { headers })).json()).document;
    const rejectedAccept = await page.request.post(`/api/files/excalidraw-collaboration/operations/${conflict.operationId}/accept`, {
      headers, data: { idempotencyKey: randomUUID(), expectedCasVersion: conflict.casVersion },
    });
    expect(rejectedAccept.status()).toBe(409);
    expect((await rejectedAccept.json()).code).toBe('DOCUMENT_REVIEW_DISABLED');
    expect((await (await page.request.get(url, { headers })).json()).document.canonicalHash).toBe(before.canonicalHash);
    await context.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId!);
    await page.goto(initial.documentUrl);
    await expect(page.locator('.excalidraw canvas.excalidraw__canvas.interactive')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel(/Live collaboration|Live-Bearbeitung aktiv/i)).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('excalidraw-agent-review')).toHaveCount(0);
    const cancel = await page.request.post(`/api/files/excalidraw-collaboration/operations/${conflict.operationId}/cancel`, {
      headers, data: { idempotencyKey: randomUUID() },
    });
    expect(cancel.status()).toBe(200);
    expect((await cancel.json()).operation.status).toBe('cancelled');
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      if (workspaceId) expect((await page.request.delete(`/api/workspaces/${encodeURIComponent(workspaceId)}`)).status()).toBe(200);
    } catch (error) {
      throw new AggregateError(failure ? [failure, error] : [error], 'Retain the API-owned experimental-feature fixture after cleanup failure.');
    } finally { await context.close(); }
  }
});
