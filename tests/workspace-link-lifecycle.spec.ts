import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createAuthenticatedContext, runManagedTestPreflight, uploadWorkspaceTextFile } from './helpers/managed-test-context';

const original = '---\ntitle: 😀\n---\n\n[first](B.md)\n\n[second](B.md)\n';
const target = '# Target\n\nSynthetic lifecycle link target.\n';

async function navigateBoth(page: Page, workspaceId: string, sourcePath: string, targetPath: string) {
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(sourcePath)}&collaborationDebug=1`,
      { waitUntil: 'domcontentloaded' });
    const panel = page.getByRole('tabpanel', { name: 'A.md', exact: true });
    await expect(panel).toBeVisible({ timeout: 90_000 });
    await panel.getByRole('group', { name: 'Document view', exact: true })
      .getByRole('button', { name: 'Read', exact: true }).click();
    const links = panel.locator('.markdown-read-viewport [data-canvas-wiki-status]');
    await expect(links).toHaveCount(2);
    await expect(links.nth(ordinal)).toHaveAttribute('data-canvas-wiki-status', 'resolved');
    await links.nth(ordinal).click();
    const preview = page.getByRole('dialog', { name: 'Target', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(targetPath);
    await expect(preview).toContainText('Synthetic lifecycle link target.');
    await preview.getByRole('button', { name: 'Open in editor', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: targetPath, exact: true })).toBeVisible();
  }
}

for (const scenario of [
  { name: 'target rename', oldPath: 'B.md', newPath: 'C.md', sourcePath: 'A.md', targetPath: 'C.md', literal: 'C.md' },
  { name: 'source move', oldPath: 'A.md', newPath: 'nested/A.md', sourcePath: 'nested/A.md', targetPath: 'B.md', literal: '../B.md' },
]) {
  test(`never-opened Markdown ${scenario.name} persists repairs and immediately undoes with an owner release proof`, async ({ browser }, info) => {
    test.setTimeout(240_000);
    expect(process.env.E2E_EXTERNAL_SERVER, 'Use the fresh managed container.').toBe('1');
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 1000 } });
    let workspaceId: string | undefined;
    let batchId: string | undefined;
    let page: Page | undefined;
    try {
      const created = await context.request.post('/api/workspaces', {
        data: { type: 'team', name: `E2E lifecycle links ${randomUUID()}` },
      });
      expect(created.status()).toBe(201);
      workspaceId = (await created.json()).workspace.id;
      const id = workspaceId!;
      const headers = { 'x-canvas-workspace-id': id };
      await runManagedTestPreflight(context, { workspaceId: id, requireWorkspacePermission: 'write' });
      for (const [filePath, content] of [['A.md', original], ['B.md', target], ['nested/keep.txt', 'Owned fixture directory.\n']]) {
        await uploadWorkspaceTextFile({ request: context.request, workspaceId: id, filePath, content });
      }
      const read = async (path: string) => {
        const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, { headers });
        expect(response.status(), `Read own ${path}`).toBe(200);
        return (await response.json()).data.content as string;
      };
      // No editor or browser navigation occurs before apply: this covers initial Yjs state allocation under the retained PG guard.
      const dryRun = await context.request.post('/api/files/rename', {
        headers, data: { oldPath: scenario.oldPath, newPath: scenario.newPath, dryRun: true },
      });
      expect(dryRun.status()).toBe(200);
      const { plan } = await dryRun.json();
      expect(plan.readiness).toBe('ready');
      expect(plan.coverage.complete).toBe(true);
      expect(plan.linkEdits).toHaveLength(2);
      expect(plan.linkEdits.map((edit: { nextTargetLiteral: string }) => edit.nextTargetLiteral)).toEqual([scenario.literal, scenario.literal]);
      const apply = await context.request.post('/api/files/rename', {
        headers, data: { oldPath: scenario.oldPath, newPath: scenario.newPath, planId: plan.planId }, timeout: 90_000,
      });
      const applied = await apply.json();
      expect(apply.ok(), JSON.stringify({ status: apply.status(), code: applied.code, operation: applied.operation })).toBeTruthy();
      batchId = applied.operation.batchId as string;
      expect(batchId).toBeTruthy();
      const status = async () => {
        const response = await context.request.get(`/api/files/operations/batches/${batchId}`, { headers });
        expect(response.ok()).toBeTruthy();
        return (await response.json()).operation.status as string;
      };
      await expect.poll(status, { timeout: 90_000 }).toBe('applied');
      const repaired = original.replaceAll('(B.md)', `(${scenario.literal})`);
      expect(await read(scenario.sourcePath)).toBe(repaired);
      expect(await read(scenario.targetPath)).toBe(target);
      expect((await context.request.get(`/api/files/read?path=${encodeURIComponent(scenario.oldPath)}`, { headers })).status()).toBe(404);

      // Immediately undo, without a sleep or editor disconnect: inverse writes to a moved source must prove their owner was durably released.
      const undo = await context.request.post(`/api/files/operation-reviews/batches/${batchId}`, {
        headers, data: { action: 'undo', planId: plan.planId },
      });
      expect(undo.status()).toBe(202);
      await expect.poll(status, { timeout: 90_000 }).toBe('undone');
      expect(await read('A.md')).toBe(original);
      expect(await read('B.md')).toBe(target);
      expect((await context.request.get(`/api/files/read?path=${encodeURIComponent(scenario.newPath)}`, { headers })).status()).toBe(404);
      const indexResponse = await context.request.get('/api/markdown/link-index', { headers });
      const index = (await indexResponse.json()).index;
      expect(index.coverage.complete).toBe(true);
      expect(index.edges.filter((edge: { sourcePath: string }) => edge.sourcePath === 'A.md')
        .map((edge: { status: string; targetPath: string }) => [edge.status, edge.targetPath]))
        .toEqual([['resolved', 'B.md'], ['resolved', 'B.md']]);
      await context.addInitScript((activeId) => {
        localStorage.setItem('canvas.activeWorkspaceId', activeId);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
        localStorage.setItem('canvas-browser-mode', 'tree');
      }, id);
      page = await context.newPage();
      await navigateBoth(page, id, 'A.md', 'B.md');
      await page.screenshot({ path: info.outputPath('lifecycle-links-undone.png'), animations: 'disabled' });
      await info.attach('lifecycle-rename-undo-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        scenario: scenario.name, workspaceId: id, batchId, original, repaired, persistedApply: true,
        immediateUndo: true, persistedUndo: true, navigatedAfterUndo: ['first', 'second'], coverageComplete: true,
      }, null, 2)) });
    } catch (error) {
      if (workspaceId) {
        const headers = { 'x-canvas-workspace-id': workspaceId };
        const response = batchId ? await context.request.get(`/api/files/operations/batches/${batchId}`, {
          headers, timeout: 10_000,
        }).catch(() => undefined) : undefined;
        const operation = response?.ok() ? (await response.json()).operation : undefined;
        const files = await Promise.all(['A.md', 'B.md', 'C.md', 'nested/A.md'].map(async (path) => {
          const file = await context.request.get(`/api/files/read?path=${encodeURIComponent(path)}`, {
            headers, timeout: 10_000,
          }).catch(() => undefined);
          return { path, status: file?.status() ?? null,
            ...(file?.ok() ? { content: (await file.json()).data.content } : {}) };
        }));
        await info.attach('lifecycle-refusal-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
          scenario: scenario.name, workspaceId, batchId, operation, files,
        }, null, 2)) });
      }
      if (page && !page.isClosed()) await page.screenshot({ path: info.outputPath('lifecycle-links-failure.png'), animations: 'disabled' });
      throw error;
    } finally {
      await page?.close();
      try {
        if (workspaceId) {
          const removed = await context.request.delete(`/api/workspaces/${workspaceId}`);
          expect(removed.ok(), 'Delete only this synthetic workspace').toBeTruthy();
          const listing = await context.request.get('/api/workspaces');
          expect((await listing.json()).workspaces.some((entry: { id: string }) => entry.id === workspaceId)).toBe(false);
        }
      } finally { await context.close(); }
    }
  });
}
