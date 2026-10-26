import { expect, test } from '@playwright/test';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} file errors can be dismissed independently of their status`, async ({ browser }, info) => {
    test.setTimeout(180_000);
    expect(process.env.E2E_EXTERNAL_SERVER).toBe('1');
    const context = await createAuthenticatedContext(browser, {
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: mobile, hasTouch: mobile,
    });
    const workspaceName = `E2E notification dismissal ${mobile ? 'mobile' : 'desktop'} ${Date.now()}`;
    const created = await context.request.post('/api/workspaces', { data: { type: 'personal', name: workspaceName } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const workspaceId = (await created.json()).workspace.id as string;
    const headers = { 'x-canvas-workspace-id': workspaceId };
    try {
      for (const filePath of ['before.md', 'occupied.md']) {
        await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: `# ${filePath}\n` });
      }
      // A rejected native preview creates no executable batch. Exercise the
      // real persisted request diagnostic, which remains available independently.
      const raiseRequestProblem = async () => {
        const response = await context.request.post('/api/files/rename', {
          headers, data: { oldPath: 'before.md', newPath: 'occupied.md', overwrite: 'invalid' },
        });
        expect(response.status()).toBe(422);
        expect((await response.json()).code).toBe('BATCH_INVALID_REQUEST');
      };
      await raiseRequestProblem();
      type Item = { id: string; workspaceId: string; notificationRevision: string;
        target: { kind: string; problemId?: string; status?: string } };
      const notifications = async () => {
        const response = await context.request.get('/api/notifications/summary?todoMode=lifecycle');
        expect(response.ok()).toBeTruthy();
        return (await response.json()).data.sections.notifications as Item[];
      };
      const isOwnedProblem = (item: Item) => item.workspaceId === workspaceId
        && item.target.kind === 'file_path_operation' && typeof item.target.problemId === 'string';
      await expect.poll(async () => (await notifications()).some(isOwnedProblem)).toBe(true);
      const originalProblem = (await notifications()).find(isOwnedProblem)!;
      const itemId = originalProblem.id;
      expect(itemId).toBe(`file-path-problem:${originalProblem.target.problemId}`);
      expect(originalProblem.target.status).toBe('failed');
      await expect.poll(async () => (await notifications()).some((item) => item.id === itemId)).toBe(true);
      await context.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
      const page = await context.newPage();
      await page.goto('/en');
      const openHomeList = async () => {
        if (mobile) await page.getByRole('button', { name: 'Show notifications', exact: true }).click();
      };
      await openHomeList();
      const homeContainer = mobile ? page.getByRole('dialog') : page.locator('#home-attention-items');
      const homeRow = homeContainer.locator(`[data-notification-id="${itemId}"]`);
      await expect(homeRow).toBeVisible({ timeout: 60_000 });
      await expect(homeRow.getByRole('button', { name: 'Remove from notifications' })).toBeVisible();
      await page.screenshot({ path: info.outputPath('home-dismissible-error.png'), animations: 'disabled' });
      // A failed save leaves the row and provides retry without opening the action details.
      await page.route('**/api/notifications/summary*', async (route) => {
        if (new URL(route.request().url()).pathname !== '/api/notifications/summary'
          || route.request().method() !== 'PATCH') return route.continue();
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic unavailable storage' }) });
      });
      await homeRow.getByRole('button', { name: 'Remove from notifications' }).click();
      const errorContainer = mobile ? page.getByRole('dialog') : page.locator('aside[aria-labelledby="home-attention-heading"]');
      await expect(errorContainer.getByRole('alert')).toContainText('The change could not be saved');
      await expect(homeRow).toBeVisible();
      await expect(page.getByTestId('workspace-path-operation-status')).toHaveCount(0);
      await page.unroute('**/api/notifications/summary*');
      await errorContainer.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(homeRow).toHaveCount(0);
      await expect.poll(async () => (await notifications()).some((item) => item.id === itemId)).toBe(false);
      await page.reload();
      await openHomeList();
      await expect(page.locator('#home-attention-items')).toHaveAttribute('aria-busy', 'false');
      await expect(homeContainer.locator(`[data-notification-id="${itemId}"]`)).toHaveCount(0);
      if (mobile) await page.keyboard.press('Escape');
      // Dismissing a notification preserves its actual stored diagnostic.
      await page.goto(`/en/notebook?workspaceId=${workspaceId}&workspacePathProblem=${originalProblem.target.problemId}`);
      await expect(page.getByTestId('workspace-path-operation-status')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('workspace-path-operation-status')).toContainText('before.md');
      await expect(page.getByTestId('workspace-path-operation-status')).toContainText('BATCH_INVALID_REQUEST');
      await page.keyboard.press('Escape');
      // A repeated problem retains its identity and advances the revision,
      // so an earlier dismissal cannot hide this new failure occurrence.
      await raiseRequestProblem();
      await expect.poll(async () => (await notifications()).some(item => item.id === itemId)).toBe(true);
      const nextProblem = (await notifications()).find(item => item.id === itemId)!;
      expect(nextProblem.notificationRevision).not.toBe(originalProblem.notificationRevision);
      const nextId = nextProblem.id;
      expect(nextId).toBe(itemId);
      await page.reload();
      await page.getByTestId('notification-bell').click({ timeout: 60_000 });
      const bellRow = page.locator(`[data-notification-id="${nextId}"]`).locator('..');
      await expect(bellRow).toBeVisible();
      await expect(bellRow.getByRole('button', { name: 'Remove from notifications' })).toBeVisible();
      await page.screenshot({ path: info.outputPath('bell-dismissible-error.png'), animations: 'disabled' });
      await bellRow.getByRole('button', { name: 'Remove from notifications' }).click();
      await expect(bellRow).toHaveCount(0);
      await expect.poll(async () => (await notifications()).some((item) => item.id === nextId)).toBe(false);
      for (const filePath of ['before.md', 'occupied.md']) {
        const read = await context.request.get(`/api/files/read?path=${filePath}`, { headers });
        expect(read.ok()).toBeTruthy();
        expect((await read.json()).data.content).toBe(`# ${filePath}\n`);
      }
    } finally {
      await context.request.delete(`/api/workspaces/${workspaceId}`);
      await context.close();
    }
  });
}
