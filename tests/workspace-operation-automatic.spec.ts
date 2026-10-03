import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';

const targetContent = '# Target\n\nPreserved file content.\n';
const backlinkContent = '# Backlinks\n\n'
  + '[Inline label](target.md#section)\n\n'
  + '[[target|Wiki alias]]\n\n'
  + '![Image alt](target.md)\n\n'
  + '[Reference label][target-ref]\n\n'
  + '[target-ref]: target.md "Reference title"\n\n'
  + '`[Inline code](target.md)`\n\n'
  + 'External [site](https://example.com/target.md)\n';
const renamedBacklinks = backlinkContent
  .replace('[Inline label](target.md#section)', '[Inline label](renamed.md#section)')
  .replace('[[target|Wiki alias]]', '[[renamed|Wiki alias]]')
  .replace('![Image alt](target.md)', '![Image alt](renamed.md)')
  .replace('[target-ref]: target.md "Reference title"', '[target-ref]: renamed.md "Reference title"');

async function setup(browser: Browser, mobile: boolean) {
  const runId = process.env.CANVAS_BATCH_E2E_RUN_ID;
  expect(process.env.E2E_EXTERNAL_SERVER, 'Only the managed runner starts the single owned Notebook process.').toBe('1');
  expect(runId, 'Use scripts/run-workspace-operation-batch-e2e.mjs --automatic.').toMatch(/^[a-f0-9-]{36}$/u);
  const context = await createAuthenticatedContext(browser, {
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    hasTouch: mobile, isMobile: mobile,
  });
  const created = await context.request.post('/api/workspaces', {
    data: { type: 'personal', name: `E2E batch review ${runId} automatic-${mobile ? 'mobile' : 'desktop'}` },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const workspaceId = (await created.json()).workspace.id as string;
  const headers = { 'x-canvas-workspace-id': workspaceId };
  const read = async (filePath: string): Promise<string> => {
    const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
    expect(response.ok(), `Read ${filePath}`).toBeTruthy();
    return (await response.json()).data.content as string;
  };
  const absent = async (filePath: string) => {
    const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
    expect(response.status(), `${filePath} must be absent`).toBe(404);
  };
  const settled = async (operation: WorkspacePathOperationPublic, expected: 'applied' | 'undone') => {
    await expect.poll(async () => {
      const response = await context.request.get(`/api/files/operations/batches/${operation.batchId}`, { headers });
      expect(response.ok()).toBeTruthy();
      const current = (await response.json()).operation as WorkspacePathOperationPublic;
      expect(current.batchId).toBe(operation.batchId); expect(current.planId).toBe(operation.planId);
      expect(current.workspaceId).toBe(workspaceId);
      if (current.status === expected) {
        expect(current.phase).toBe('complete'); expect(current.completedActions).toBe(current.totalActions);
      }
      return current.status;
    }, { timeout: 90_000 }).toBe(expected);
  };
  await context.addInitScript(({ id, narrow }) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
    localStorage.setItem('canvas-browser-mode', narrow ? 'list' : 'tree');
  }, { id: workspaceId, narrow: mobile });
  return { context, workspaceId, headers, read, absent, settled };
}

async function fileActions(page: Page, filePath: string): Promise<void> {
  const row = page.locator(`[data-file-path="${filePath}"]`).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
}

async function assertMobileDialog(dialog: Locator): Promise<void> {
  const bounds = await dialog.boundingBox();
  expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
}

test.describe('automatic file link maintenance', () => {
  for (const mobile of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'} file browser rename, delete and toast Undo repair links with Review Center off`, async ({ browser }, info) => {
      test.setTimeout(240_000);
      const fixture = await setup(browser, mobile);
      try {
        const availability = await fixture.context.request.get('/api/document-review/availability');
        expect(availability.ok()).toBeTruthy();
        expect((await availability.json()).data.documentReviewEnabled,
          'The owned fresh Notebook starts with the experimental Review Center disabled.').toBe(false);
        for (const [filePath, content] of [['target.md', targetContent], ['links.md', backlinkContent]]) {
          await uploadWorkspaceTextFile({ request: fixture.context.request, workspaceId: fixture.workspaceId, filePath, content });
        }
        const page = await fixture.context.newPage();
        const reviewRequests: string[] = [];
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.startsWith('/api/files/operation-reviews')) reviewRequests.push(request.url());
        });
        await page.goto('/en/settings?tab=experimental');
        await expect(page.locator('#document-review-enabled')).not.toBeChecked({ timeout: 60_000 });
        await page.goto(`/en/notebook?workspaceId=${fixture.workspaceId}`);
        if (mobile) await page.getByRole('button', { name: 'Open file explorer', exact: true }).click();
        else {
          const sidebarToggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
          if (await sidebarToggle.isVisible()) await sidebarToggle.click();
        }

        await fileActions(page, 'target.md');
        await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
        const renameDialog = page.getByRole('dialog', { name: 'Rename "target.md"', exact: true });
        await expect(renameDialog).toBeVisible();
        await renameDialog.getByLabel('New name', { exact: true }).fill('renamed.md');
        if (mobile) await assertMobileDialog(renameDialog);
        const renameResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/files/rename'
          && response.request().method() === 'POST', { timeout: 90_000 });
        await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click();
        const rename = await renameResponse;
        expect(rename.ok()).toBeTruthy();
        const renameResult = await rename.json() as WorkspacePathOperationResponse & { reviewRequired?: unknown };
        expect(renameResult.reviewRequired).toBeUndefined();
        expect(renameResult.operation).toBeTruthy();
        await fixture.settled(renameResult.operation, 'applied');
        await expect(renameDialog).toBeHidden({ timeout: 90_000 });
        await expect.poll(() => fixture.read('links.md'), { timeout: 30_000 }).toBe(renamedBacklinks);
        expect(await fixture.read('renamed.md')).toBe(targetContent);
        await fixture.absent('target.md');
        await expect(page.locator('[data-file-path="renamed.md"]').first()).toBeVisible();
        await expect(page.getByTestId('workspace-operation-review-center')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('automatic-rename.png'), animations: 'disabled' });

        await fileActions(page, 'renamed.md');
        await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
        const deleteDialog = page.getByRole('alertdialog');
        await expect(deleteDialog).toContainText('renamed.md');
        if (mobile) await assertMobileDialog(deleteDialog);
        const deleteResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/files/delete'
          && response.request().method() === 'DELETE', { timeout: 90_000 });
        await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
        const deletion = await deleteResponse;
        expect(deletion.ok()).toBeTruthy();
        const deleteResult = await deletion.json() as WorkspacePathOperationResponse & { reviewRequired?: unknown };
        expect(deleteResult.reviewRequired).toBeUndefined();
        expect(deleteResult.operation).toBeTruthy();
        await fixture.settled(deleteResult.operation, 'applied');
        await expect(deleteDialog).toBeHidden({ timeout: 90_000 });
        await fixture.absent('renamed.md');
        const cleaned = await fixture.read('links.md');
        for (const label of ['Inline label', 'Wiki alias', 'Image alt', 'Reference label']) expect(cleaned).toContain(label);
        for (const markup of ['[Inline label](', '[[renamed|', '![Image alt](', '[Reference label][', '[target-ref]:']) {
          expect(cleaned).not.toContain(markup);
        }
        expect(cleaned).toContain('`[Inline code](target.md)`');
        expect(cleaned).toContain('External [site](https://example.com/target.md)');
        await expect(page.getByTestId('workspace-operation-review-center')).toHaveCount(0);
        const toast = page.locator('[data-sonner-toast]').filter({ has: page.getByRole('button', { name: 'Undo', exact: true }) });
        await expect(toast).toContainText('1 item was moved to trash.');
        await page.screenshot({ path: info.outputPath('automatic-delete-undo-toast.png'), animations: 'disabled' });

        const undoResponse = page.waitForResponse((response) => new URL(response.url()).pathname
          === `/api/files/operations/batches/${deleteResult.operation.batchId}` && response.request().method() === 'POST', { timeout: 90_000 });
        await toast.getByRole('button', { name: 'Undo', exact: true }).click();
        const undo = await undoResponse;
        expect(undo.ok()).toBeTruthy();
        expect(undo.request().postDataJSON()).toEqual({ action: 'undo', planId: deleteResult.operation.planId });
        await fixture.settled(deleteResult.operation, 'undone');
        await expect.poll(() => fixture.read('links.md'), { timeout: 30_000 }).toBe(renamedBacklinks);
        expect(await fixture.read('renamed.md')).toBe(targetContent);
        await expect(page.locator('[data-file-path="renamed.md"]').first()).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('[data-sonner-toast]').filter({ hasText: '1 item was restored.' })).toBeVisible();
        await expect(page.getByTestId('workspace-operation-review-center')).toHaveCount(0);
        expect(reviewRequests, 'Direct file actions never require a review request when the experiment is off.').toEqual([]);
        await page.screenshot({ path: info.outputPath('automatic-undo-complete.png'), animations: 'disabled' });
      } finally {
        const cleanup = await fixture.context.request.delete(`/api/workspaces/${fixture.workspaceId}`);
        expect(cleanup.ok()).toBeTruthy();
        await fixture.context.close();
      }
    });
  }
});
