import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  createAuthenticatedContext,
  runManagedTestPreflight,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';
import type { WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import { WORKSPACE_FILE_UNDO_ENABLED } from '../app/lib/files/workspace-file-undo-policy';

const before = '---\ntitle: 😀\n---\n\n[[B]]\n\n[link](B.md)\n';
const after = '---\ntitle: 😀\n---\n\n[[/C]]\n\n[link](C.md)\n';
const target = '# Target\n\nSynthetic emoji link regression target.\n';

async function openSource(page: Page, workspaceId: string) {
  await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&path=A.md&collaborationDebug=1`,
    { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('tabpanel', { name: 'A.md', exact: true });
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(panel.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
  const links = panel.locator('.ProseMirror [data-canvas-wiki-status], .ProseMirror a[href]');
  await expect(links).toHaveCount(2);
  await expect(panel.locator('.ProseMirror [data-canvas-wiki-status]')).toHaveAttribute('data-canvas-wiki-status', 'resolved');
  return links;
}

test('rich emoji YAML Wiki and Markdown links navigate after managed UI rename and enforce the Undo release policy', async ({ browser }, info) => {
  test.setTimeout(300_000);
  expect(process.env.E2E_EXTERNAL_SERVER, 'Use the existing managed host server.').toBe('1');
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 1000 } });
  let workspaceId: string | undefined;
  let page: Page | undefined;
  try {
    const created = await context.request.post('/api/workspaces', {
      data: { type: 'team', name: `E2E emoji link repair ${randomUUID()}` },
    });
    const receipt = await created.json();
    workspaceId = receipt.workspace?.id;
    expect(created.status()).toBe(201);
    expect(workspaceId).toBeTruthy();
    const id = workspaceId!;
    const headers = { 'x-canvas-workspace-id': id };
    await runManagedTestPreflight(context, { workspaceId: id, requireWorkspacePermission: 'write' });
    for (const [filePath, content] of [['A.md', before], ['B.md', target]]) {
      await uploadWorkspaceTextFile({ request: context.request, workspaceId: id, filePath, content });
    }
    await context.addInitScript((activeId) => {
      localStorage.setItem('canvas.activeWorkspaceId', activeId);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
      localStorage.setItem('canvas-browser-mode', 'tree');
    }, id);
    page = await context.newPage();
    await page.addInitScript(() => {
      const key = '__canvasOwnedMarkdownLinkClicks';
      Reflect.set(globalThis, key, []);
      document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest('a[href]');
        const root = anchor?.closest('.ProseMirror');
        if (!anchor || !root) return;
        const row: Record<string, unknown> = {
          href: anchor.getAttribute('href'), ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
          at: performance.now(),
        };
        try {
          const editor = Reflect.get(root, 'editor') as {
            options?: { element?: HTMLElement }; view?: { dom?: HTMLElement };
          } | undefined;
          row.optionsRootConnected = editor?.options?.element?.isConnected;
          row.optionsRootContainsEditor = editor?.options?.element?.contains(root);
          row.viewDomMatches = editor?.view?.dom === root;
        } catch { row.editorObservationUnavailable = true; }
        queueMicrotask(() => {
          row.defaultPrevented = event.defaultPrevented;
          const rows = Reflect.get(globalThis, key) as Array<Record<string, unknown>>;
          rows.push(row);
          if (rows.length > 12) rows.shift();
        });
      }, true);
    });
    page.setDefaultTimeout(30_000);
    let sourceRepresentation: string | undefined;
    page.on('response', response => {
      if (new URL(response.url()).pathname !== '/api/files/collaboration/session'
        || response.request().method() !== 'POST' || response.request().postDataJSON()?.path !== 'A.md') return;
      void response.json().then(session => {
        if (session.success === true) sourceRepresentation = session.representation;
      }).catch(() => undefined);
    });
    const read = async (path: string) => {
      const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers });
      expect(response.status(), `Read owned ${path}`).toBe(200);
      return (await response.json()).data.content as string;
    };
    const navigateBoth = async (targetPath: string) => {
      for (let index = 0; index < 2; index++) {
        const links = await openSource(page!, id);
        const link = links.nth(index);
        const isWiki = await link.getAttribute('data-canvas-wiki-status') !== null;
        await link.click({ modifiers: ['ControlOrMeta'] });
        if (isWiki) {
          const preview = page!.getByRole('dialog', { name: 'Target', exact: true });
          await expect(preview).toBeVisible();
          await expect(preview).toContainText(targetPath);
          await expect(preview).toContainText('Synthetic emoji link regression target.');
          await preview.getByRole('button', { name: 'Open in editor', exact: true }).click();
        }
        const opened = page!.getByRole('tabpanel', { name: targetPath, exact: true });
        await expect(opened).toBeVisible();
        await expect(opened).toContainText('Synthetic emoji link regression target.');
      }
    };
    const waitSavedEditor = async () => {
      await expect(page!.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true');
      await expect.poll(async () => {
        const state = JSON.parse(await page!.getByTestId('markdown-save-state').locator('pre').innerText());
        return state.remoteSynced && state.indexedDbHydrated && state.unsyncedChanges === 0
          && state.durability === 'checkpointed_file';
      }, { timeout: 45_000 }).toBe(true);
    };
    await navigateBoth('B.md');
    await waitSavedEditor();
    expect(await read('B.md')).toBe(target);
    expect(await read('A.md')).toBe(before);
    await openSource(page, id);
    await waitSavedEditor();
    await expect.poll(() => sourceRepresentation, { timeout: 30_000 })
      .toMatch(/^tiptap_(?:xml|blocks)$/u);
    await page.getByTestId('notebook-documents-menu').click();
    await page.getByTestId('notebook-close-all-documents').click();
    await expect(page.getByRole('tabpanel')).toHaveCount(0);
    const sidebar = page.getByRole('button', { name: /^(?:Show|Hide) sidebar$/u });
    await expect(sidebar).toBeVisible();
    if (await sidebar.getAttribute('aria-label') === 'Show sidebar') await sidebar.click();
    const row = page.locator('[data-file-path="B.md"]').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.getByRole('button', { name: /^More actions for /u }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename "B.md"', exact: true });
    await renameDialog.getByLabel('New name', { exact: true }).fill('C.md');
    let stablePlanId: string | undefined;
    let stableSince = 0;
    await expect(async () => {
      const previewResponse = page!.waitForResponse((response) => new URL(response.url()).pathname === '/api/files/rename'
        && response.request().method() === 'POST' && response.request().postDataJSON().dryRun === true);
      await renameDialog.getByRole('button', { name: 'Preview links', exact: true }).click();
      const preview = await previewResponse;
      expect(preview.status()).toBe(200);
      const payload = await preview.json();
      expect(payload.plan.readiness).toBe('ready');
      expect(payload.plan.coverage.complete).toBe(true);
      expect(payload.plan.linkEdits).toHaveLength(2);
      expect(payload.plan.linkEdits.map((edit: { nextTargetLiteral: string }) => edit.nextTargetLiteral)).toEqual(['/C', 'C.md']);
      if (stablePlanId !== payload.plan.planId) {
        stablePlanId = payload.plan.planId;
        stableSince = Date.now();
      }
      expect(Date.now() - stableSince, 'Use a stable saved snapshot after the editor close').toBeGreaterThanOrEqual(5_000);
    }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 5_000] });
    const renamedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/files/rename'
      && response.request().method() === 'POST' && response.request().postDataJSON().dryRun !== true, { timeout: 90_000 });
    await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click();
    const renamed = await renamedResponse;
    expect(renamed.request().postDataJSON().planId, 'Apply the reviewed stable preview').toBe(stablePlanId);
    const result = await renamed.json() as WorkspacePathOperationResponse & { code?: string };
    if (!renamed.ok()) {
      const files = await Promise.all(['A.md', 'B.md', 'C.md'].map(async (path) => {
        const response = await context.request.get(`/api/files/read?path=${path}`, { headers });
        return { path, status: response.status(),
          ...(response.ok() ? { content: (await response.json()).data.content } : {}) };
      }));
      await info.attach('rename-refusal-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        status: renamed.status(), code: result.code, operation: result.operation, files,
      }, null, 2)) });
    }
    expect(renamed.ok(), JSON.stringify({ status: renamed.status(), code: result.code, operation: result.operation })).toBeTruthy();
    expect(result.operation?.batchId).toBeTruthy();
    const batchId = result.operation.batchId;
    const originalPlanId = result.operation.planId;
    expect(originalPlanId, 'Bind Undo to the exact reviewed and applied forward plan').toBe(stablePlanId);
    const operation = async () => {
      const response = await context.request.get(`/api/files/operations/batches/${batchId}`, { headers });
      expect(response.ok()).toBeTruthy();
      const current = (await response.json()).operation as WorkspacePathOperationResponse['operation'];
      expect(current.batchId).toBe(batchId);
      expect(current.planId).toBe(originalPlanId);
      expect(current.workspaceId).toBe(id);
      return current;
    };
    await expect.poll(async () => (await operation()).status, { timeout: 90_000 }).toBe('applied');
    await expect(renameDialog).toBeHidden();
    await expect.poll(() => read('A.md'), { timeout: 30_000 }).toBe(after);
    expect(await read('C.md')).toBe(target);
    expect((await context.request.get('/api/files/read?path=B.md', { headers })).status()).toBe(404);
    const indexResponse = await context.request.get('/api/markdown/link-index', { headers });
    expect(indexResponse.ok()).toBeTruthy();
    const index = (await indexResponse.json()).index;
    expect(index.coverage.complete).toBe(true);
    const repairedEdges = index.edges.filter((edge: { sourcePath: string }) => edge.sourcePath === 'A.md')
      .map((edge: { kind: string; status: string; targetPath: string }) => [edge.kind, edge.status, edge.targetPath]);
    expect(repairedEdges).toHaveLength(2);
    expect(repairedEdges).toEqual(expect.arrayContaining([
      ['wiki', 'resolved', 'C.md'], ['markdown', 'resolved', 'C.md'],
    ]));
    await navigateBoth('C.md');
    await waitSavedEditor();
    expect(await read('C.md')).toBe(target);
    expect(await read('A.md')).toBe(after);
    await openSource(page, id);
    await waitSavedEditor();
    await openSource(page, id);
    await page.screenshot({ path: info.outputPath('emoji-links-renamed.png'), animations: 'disabled' });
    await page.getByTestId('notebook-documents-menu').click();
    await page.getByTestId('notebook-close-all-documents').click();
    await expect(page.getByRole('tabpanel')).toHaveCount(0);

    if (!WORKSPACE_FILE_UNDO_ENABLED) {
      const refused = await context.request.post(`/api/files/operation-reviews/batches/${batchId}`, {
        headers, data: { action: 'undo', planId: originalPlanId }, timeout: 15_000,
      });
      expect(refused.status()).toBe(409);
      expect((await refused.json()).code).toBe('FILE_OPERATION_UNDO_DISABLED');
      expect((await operation()).status).toBe('applied');
      expect(await read('A.md')).toBe(after);
      expect(await read('C.md')).toBe(target);
      expect((await context.request.get('/api/files/read?path=B.md', { headers })).status()).toBe(404);
      await navigateBoth('C.md');
      await info.attach('emoji-disabled-undo-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        workspaceId: id, batchId, planId: originalPlanId, sourceRepresentation, before, after, target,
        navigatedBefore: ['wiki', 'markdown'], navigatedAfter: ['wiki', 'markdown'], undoDenied: true, appliedBytesPreserved: true,
      }, null, 2)) });
      return;
    }

    // A stable inverse preview synchronizes normal saved-room drain; only the original forward batch is undone.
    let inverseSnapshotId: string | undefined;
    let inverseStableSince = 0;
    await expect(async () => {
      const preview = await context.request.post('/api/files/rename', {
        headers, data: { oldPath: 'C.md', newPath: 'B.md', dryRun: true },
      });
      expect(preview.status()).toBe(200);
      const { plan } = await preview.json();
      expect(plan.readiness).toBe('ready');
      expect(plan.coverage.complete).toBe(true);
      expect(plan.linkEdits).toHaveLength(2);
      expect(plan.linkEdits.map((edit: { nextTargetLiteral: string }) => edit.nextTargetLiteral)).toEqual(['B', 'B.md']);
      if (inverseSnapshotId !== plan.planId) {
        inverseSnapshotId = plan.planId;
        inverseStableSince = Date.now();
      }
      expect(Date.now() - inverseStableSince, 'Wait for a stable saved inverse snapshot after closing editors').toBeGreaterThanOrEqual(5_000);
    }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 5_000] });
    expect(await read('A.md')).toBe(after);
    expect(await read('C.md')).toBe(target);
    const undo = await context.request.post(`/api/files/operation-reviews/batches/${batchId}`, {
      headers, data: { action: 'undo', planId: originalPlanId }, timeout: 90_000,
    });
    const undoPayload = await undo.json();
    if (!undo.ok()) await info.attach('undo-refusal-evidence', {
      contentType: 'application/json', body: Buffer.from(JSON.stringify({
        workspaceId: id, batchId, planId: originalPlanId, status: undo.status(), code: undoPayload.code,
        operation: await operation(),
      }, null, 2)),
    });
    expect(undo.status(), 'Undo the original applied batch through its authorized API').toBe(202);
    const undoReceipt = undoPayload.batch;
    expect(undoReceipt.batchId).toBe(batchId);
    expect(undoReceipt.planId).toBe(originalPlanId);
    await expect.poll(async () => (await operation()).status, { timeout: 90_000 }).toBe('undone');
    const undone = await operation();
    expect(undone.phase).toBe('complete');
    expect(undone.completedActions).toBe(undone.totalActions);
    expect(undone.errorCode).toBeNull();
    expect(await read('A.md')).toBe(before);
    expect(await read('B.md')).toBe(target);
    expect((await context.request.get('/api/files/read?path=C.md', { headers })).status()).toBe(404);
    const restoredIndex = await context.request.get('/api/markdown/link-index', { headers });
    expect(restoredIndex.ok()).toBeTruthy();
    const restored = (await restoredIndex.json()).index;
    expect(restored.coverage.complete).toBe(true);
    expect(restored.edges.filter((edge: { sourcePath: string }) => edge.sourcePath === 'A.md')
      .map((edge: { kind: string; status: string; targetPath: string }) => [edge.kind, edge.status, edge.targetPath]))
      .toEqual([['wiki', 'resolved', 'B.md'], ['markdown', 'resolved', 'B.md']]);
    await navigateBoth('B.md');
    expect(await read('A.md')).toBe(before);
    expect(await read('B.md')).toBe(target);
    await openSource(page, id);
    await page.screenshot({ path: info.outputPath('emoji-links-undone.png'), animations: 'disabled' });
    await info.attach('emoji-rename-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      workspaceId: id, batchId, planId: originalPlanId, sourceRepresentation, before, after, target,
      navigatedBefore: ['wiki', 'markdown'], navigatedAfter: ['wiki', 'markdown'],
      navigatedAfterUndo: ['wiki', 'markdown'], persistedUndo: true, undoStatus: undone.status, coverageComplete: true,
    }, null, 2)) });
  } catch (error) {
    if (page && !page.isClosed()) {
      await info.attach('owned-markdown-link-clicks.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(
        await page.evaluate(() => Reflect.get(globalThis, '__canvasOwnedMarkdownLinkClicks') ?? []), null, 2)) });
      await page.screenshot({ path: info.outputPath('emoji-links-failure.png'), animations: 'disabled' });
    }
    throw error;
  } finally {
    await page?.close();
    try {
      if (workspaceId) {
        const deleted = await context.request.delete(`/api/workspaces/${workspaceId}`);
        expect(deleted.ok(), 'Delete only the owned synthetic workspace').toBeTruthy();
        const listing = await context.request.get('/api/workspaces');
        expect((await listing.json()).workspaces.some((entry: { id: string }) => entry.id === workspaceId)).toBe(false);
      }
    } finally { await context.close(); }
  }
});
