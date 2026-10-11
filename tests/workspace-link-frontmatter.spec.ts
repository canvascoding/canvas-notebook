import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  createAuthenticatedContext,
  runManagedTestPreflight,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';
import type { WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';

const before = '---\ntitle: 😀\n---\n\n[[B]]\n\n[link](B.md)\n';
const after = '---\ntitle: 😀\n---\n\n[[C]]\n\n[link](C.md)\n';
const target = '# Target\n\nSynthetic emoji link regression target.\n';

async function openSource(page: Page, workspaceId: string) {
  await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&path=A.md&collaborationDebug=1`,
    { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('tabpanel', { name: 'A.md', exact: true });
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await panel.getByRole('group', { name: 'Document view', exact: true })
    .getByRole('button', { name: 'Read', exact: true }).click();
  const links = panel.locator('.markdown-read-viewport [data-canvas-wiki-status]');
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) await expect(link).toHaveAttribute('data-canvas-wiki-status', 'resolved');
  return links;
}

test('emoji YAML links navigate before and after a managed UI rename with persistent repairs', async ({ browser }, info) => {
  test.setTimeout(240_000);
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
    page.setDefaultTimeout(30_000);
    const read = async (path: string) => {
      const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers });
      expect(response.status(), `Read owned ${path}`).toBe(200);
      return (await response.json()).data.content as string;
    };
    const navigateBoth = async (targetPath: string) => {
      for (let index = 0; index < 2; index++) {
        const links = await openSource(page!, id);
        await links.nth(index).click();
        const preview = page!.getByRole('dialog', { name: 'Target', exact: true });
        await expect(preview).toBeVisible();
        await expect(preview).toContainText(targetPath);
        await expect(preview).toContainText('Synthetic emoji link regression target.');
        await preview.getByRole('button', { name: 'Open in editor', exact: true }).click();
        const opened = page!.getByRole('tabpanel', { name: targetPath, exact: true });
        await expect(opened).toBeVisible();
        await expect(opened).toContainText('Synthetic emoji link regression target.');
      }
    };
    const waitSavedEditor = async () => {
      await page!.getByRole('group', { name: 'Document view', exact: true })
        .getByRole('button', { name: 'Edit', exact: true }).click();
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
      expect(payload.plan.linkEdits.map((edit: { nextTargetLiteral: string }) => edit.nextTargetLiteral)).toEqual(['C', 'C.md']);
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
    await expect.poll(async () => {
      const response = await context.request.get(`/api/files/operations/batches/${result.operation.batchId}`, { headers });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).operation.status as string;
    }, { timeout: 90_000 }).toBe('applied');
    await expect(renameDialog).toBeHidden();
    await expect.poll(() => read('A.md'), { timeout: 30_000 }).toBe(after);
    expect(await read('C.md')).toBe(target);
    expect((await context.request.get('/api/files/read?path=B.md', { headers })).status()).toBe(404);
    const indexResponse = await context.request.get('/api/markdown/link-index', { headers });
    expect(indexResponse.ok()).toBeTruthy();
    const index = (await indexResponse.json()).index;
    expect(index.coverage.complete).toBe(true);
    expect(index.edges.filter((edge: { sourcePath: string }) => edge.sourcePath === 'A.md')
      .map((edge: { kind: string; status: string; targetPath: string }) => [edge.kind, edge.status, edge.targetPath]))
      .toEqual([['wiki', 'resolved', 'C.md'], ['markdown', 'resolved', 'C.md']]);
    await navigateBoth('C.md');
    expect(await read('A.md')).toBe(after);
    await openSource(page, id);
    await page.screenshot({ path: info.outputPath('emoji-links-renamed.png'), animations: 'disabled' });
    await info.attach('emoji-rename-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      workspaceId: id, batchId: result.operation.batchId, before, after, target,
      navigatedBefore: ['wiki', 'markdown'], navigatedAfter: ['wiki', 'markdown'], coverageComplete: true,
    }, null, 2)) });
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: info.outputPath('emoji-links-failure.png'), animations: 'disabled' });
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
