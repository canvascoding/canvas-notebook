import { randomUUID } from 'node:crypto';
import { expect, test, type Route } from '@playwright/test';
import { authenticateManagedTestPage } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';

test.describe('Confirmed physical file creation survives explorer refresh failure', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1',
    'Requires the managed compiled application and owned workspace fixture.');
  test.setTimeout(120_000);

  for (const mobile of [false, true]) for (const drawing of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'} ${drawing ? 'Excalidraw' : 'ordinary file'}: one confirmed create remains successful after a tree failure`, async ({ page }, info) => {
      const origin = new URL(process.env.BASE_URL!);
      expect(['127.0.0.1', 'localhost']).toContain(origin.hostname);
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await authenticateManagedTestPage(page);
      const settings = await page.request.get('/api/server-settings');
      expect(settings.status()).toBe(200);
      expect((await settings.json()).data.documentReviewEnabled).toBe(false);
      const nonce = randomUUID();
      const createdWorkspace = await page.request.post('/api/workspaces', {
        headers: { Origin: origin.origin }, data: { type: 'personal', name: `Create confirmation ${nonce}` },
      });
      expect(createdWorkspace.status()).toBe(201);
      const workspace = (await createdWorkspace.json()).workspace;
      expect(workspace.id).toMatch(/^ws_[a-f0-9-]{36}$/u);
      const headers = { 'x-canvas-workspace-id': workspace.id };
      const filePath = `confirmed-${nonce}.${drawing ? 'excalidraw' : 'txt'}`;
      const actualCreates: Array<{ path: string; template?: string; status: number }> = [];
      const failures: unknown[] = [];
      let serverConfirmed = false, injectedFailures = 0;
      await page.addInitScript(id => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspace.id);
      const create = async (route: Route) => {
        const request = route.request(), body = request.postDataJSON();
        if (request.method() !== 'POST' || request.headers()['x-canvas-workspace-id'] !== workspace.id || body?.path !== filePath) {
          await route.continue(); return;
        }
        let response: Awaited<ReturnType<Route['fetch']>> | undefined;
        try {
          response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 45_000 });
          actualCreates.push({ path: body.path, template: body.template, status: response.status() });
          expect(response.status()).toBe(200); expect((await response.json()).success).toBe(true);
          serverConfirmed = true;
          await route.fulfill({ response });
        } catch (error) {
          failures.push(error); await route.abort('failed').catch(() => undefined);
        } finally { await response?.dispose(); }
      };
      const tree = async (route: Route) => {
        const request = route.request();
        if (serverConfirmed && injectedFailures === 0 && request.method() === 'GET'
          && request.headers()['x-canvas-workspace-id'] === workspace.id) {
          injectedFailures++;
          await route.fulfill({ status: 503, contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'Independent explorer refresh failed', code: 'TREE_REFRESH_TEST_FAILURE' }) });
          return;
        }
        await route.continue();
      };
      await page.route('**/api/files/create', create);
      await page.route('**/api/files/tree?**', tree);
      try {
        await page.goto(`/en/files?workspaceId=${workspace.id}`);
        await page.getByRole('button', { name: 'Create', exact: true }).click();
        await page.getByRole('menuitem', { name: drawing ? 'New Excalidraw drawing' : 'New file', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: drawing ? 'Create Excalidraw drawing' : 'Create new file', exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('File name', { exact: true }).fill(filePath);
        await waitForFileCreateBudget();
        await dialog.getByRole('button', { name: drawing ? 'Create drawing' : 'Create file', exact: true }).click();
        await expect.poll(() => injectedFailures).toBe(1);
        await expect(dialog).toHaveCount(0);
        expect(failures).toEqual([]); expect(actualCreates).toHaveLength(1);
        expect(actualCreates[0].template).toBe(drawing ? 'excalidraw' : undefined);
        const download = await page.request.get('/api/files/download', { headers, params: { path: filePath } });
        expect(download.status()).toBe(200);
        const bytes = await download.body();
        if (drawing) {
          const scene = JSON.parse(bytes.toString('utf8'));
          expect(scene.type).toBe('excalidraw'); expect(scene.elements).toEqual([]);
        } else expect(bytes).toEqual(Buffer.alloc(0));
        await page.screenshot({ path: info.outputPath('confirmed-create-after-refresh-failure.png'), animations: 'disabled' });
        await page.unroute('**/api/files/tree?**', tree);
        await page.reload();
        const after = await page.request.get('/api/files/download', { headers, params: { path: filePath } });
        expect(after.status()).toBe(200); expect(await after.body()).toEqual(bytes);
        expect(actualCreates).toHaveLength(1);
        await info.attach('confirmed-creation-evidence', { contentType: 'application/json', body: JSON.stringify({
          serverConfirmed, injectedRefreshFailures: injectedFailures, actualCreateRequests: actualCreates.length,
          filePath, workspaceId: workspace.id, bytes: bytes.length, retainedAfterReload: true,
          reviewCenterUsed: false, undoUsed: false, ownedFixtureRetained: true,
        }) });
      } finally {
        await page.unroute('**/api/files/create', create);
        await page.unroute('**/api/files/tree?**', tree);
        const ended = await page.request.post('/api/auth/sign-out', { headers: { Origin: origin.origin }, data: {} });
        expect(ended.status()).toBe(200);
      }
    });
  }
});
