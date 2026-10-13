import { expect, request, type APIRequestContext } from '@playwright/test';
import { test } from './helpers/excalidraw-experimental-review';
import { randomUUID } from 'node:crypto';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

type Element = Record<string, unknown> & { id: string; version: number; versionNonce: number; x: number; isDeleted: boolean };
type Scene = { documentId: string; path: string; lifecycleGeneration: number; sceneSequence: number;
  elements: Element[]; canonicalHash: string; checkpoint: { status: string; revisionId: string | null } };

function rectangle(id: string, x: number): Element {
  return { id, type: 'rectangle', x, y: 120, width: 120, height: 90, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
    roundness: { type: 3 }, seed: 17, version: 1, versionNonce: 29, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false };
}

test.describe('Headless Excalidraw REST and history', () => {
  test.skip(process.env.EXCALIDRAW_SCENE_E2E !== '1', 'Requires the isolated managed PostgreSQL profile.');
  for (const workspaceType of ['personal', 'team'] as const) {
    test(`${workspaceType}: creates closed scenes, edits independent targets and restores through the UI`, async ({ browser }, info) => {
      test.setTimeout(180_000);
      const suffix = randomUUID();
      const context = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      let workspaceId: string | undefined;
      let filePath: string | undefined;
      let cleanup: APIRequestContext | undefined;
      let bearer: APIRequestContext | undefined;
      let failure: unknown;
      try {
        await authenticateManagedTestPage(page);
        cleanup = await request.newContext({ baseURL: process.env.BASE_URL, storageState: await context.storageState() });
        const createdWorkspace = await page.request.post('/api/workspaces', {
          data: { type: workspaceType, name: `Headless scene ${workspaceType} ${suffix}` },
        });
        expect(createdWorkspace.status()).toBe(201);
        workspaceId = (await createdWorkspace.json()).workspace.id;
        expect(workspaceId).toBeTruthy();
        const headers = { 'x-canvas-workspace-id': workspaceId! };
        filePath = `closed-${suffix}.excalidraw`;
        const createInput = { workspaceId, path: filePath, idempotencyKey: `create-${suffix}` };
        const create = await page.request.post('/api/excalidraw/scenes', { headers, data: createInput });
        expect(create.status(), await create.text()).toBe(201);
        const initial: Scene = (await create.json()).document;
        expect(initial.elements).toEqual([]);
        expect(initial.checkpoint.status).toBe('saved');
        const repeated = await page.request.post('/api/excalidraw/scenes', { headers, data: createInput });
        expect(repeated.status()).toBe(201);
        expect((await repeated.json()).document.documentId).toBe(initial.documentId);
        const conflict = await page.request.post('/api/excalidraw/scenes', {
          headers, data: { ...createInput, path: `different-${suffix}.excalidraw` },
        });
        expect(conflict.status()).toBe(409);

        const url = `/api/excalidraw/scenes/${encodeURIComponent(initial.documentId)}`;
        const get = async () => {
          const response = await page.request.get(url, { headers });
          expect(response.ok(), await response.text()).toBe(true);
          return (await response.json()).document as Scene;
        };
        const edit = async (scene: Scene, actions: unknown[], key = randomUUID()) => {
          const response = await page.request.post(`${url}/operations`, { headers, data: {
            workspaceId, documentId: scene.documentId, lifecycleGeneration: scene.lifecycleGeneration,
            observedSceneSequence: scene.sceneSequence, actions, idempotencyKey: key,
          } });
          expect(response.ok(), await response.text()).toBe(true);
          return (await response.json()).operation as { operationId: string; status: string;
            checkpoint: { status: string }; documentUrl: string; reviewRequired: boolean };
        };
        const added = await edit(initial, [
          { type: 'create', element: rectangle('left', 200) },
          { type: 'create', element: rectangle('right', 430) },
        ]);
        expect(added.status).toBe('applied');
        expect(added.checkpoint.status).toBe('saved');
        const observed = await get();
        expect(observed.elements).toHaveLength(2);
        const update = (element: Element, x: number) => ({ type: 'update', elementId: element.id,
          expectedVersion: element.version, expectedVersionNonce: element.versionNonce,
          element: { ...element, x, version: element.version + 1, versionNonce: element.versionNonce + 1 } });
        // Both writes use the same observed sequence; their distinct targets
        // must each commit even though the scene advances in between.
        const outcomes = await Promise.all(observed.elements.map(element => edit(observed, [update(element, element.x + 30)])));
        expect(outcomes.map(operation => operation.status)).toEqual(['applied', 'applied']);
        const edited = await get();
        expect(edited.sceneSequence).toBe(observed.sceneSequence + 2);
        expect(edited.elements.map(element => element.x).sort((a, b) => a - b)).toEqual([230, 460]);
        const review = await edit(observed, [update(observed.elements[0], 999)]);
        expect(review.status).toBe('needs_review');
        expect(review.reviewRequired).toBe(true);
        expect((await get()).canonicalHash).toBe(edited.canonicalHash);
        const cancel = await page.request.post(`/api/files/excalidraw-collaboration/operations/${review.operationId}/cancel`, {
          headers, data: { idempotencyKey: `cancel-${suffix}` },
        });
        expect(cancel.status(), await cancel.text()).toBe(200);
        expect((await cancel.json()).operation.status).toBe('cancelled');

        // Use the genuine Better Auth session token with an empty cookie jar.
        const authenticated = await page.request.get('/api/auth/get-session');
        const session = await authenticated.json();
        expect(typeof session.session?.token).toBe('string');
        bearer = await request.newContext({ baseURL: process.env.BASE_URL,
          extraHTTPHeaders: { ...headers, Authorization: `Bearer ${session.session.token}` } });
        expect((await bearer.get(url)).status()).toBe(200);
        const unauthenticated = await request.newContext({ baseURL: process.env.BASE_URL });
        try { expect((await unauthenticated.get(url, { headers })).status()).toBe(401); }
        finally { await unauthenticated.dispose(); }

        await context.addInitScript(id => {
          localStorage.setItem('canvas.activeWorkspaceId', id);
          localStorage.setItem('canvas.notebook.chatVisible', 'false');
        }, workspaceId!);
        await page.goto(added.documentUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.excalidraw canvas.excalidraw__canvas.interactive')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByLabel(/Live collaboration|Live-Bearbeitung aktiv/i)).toBeVisible({ timeout: 30_000 });
        const download = await page.request.get(`/api/files/download?path=${encodeURIComponent(filePath)}`, { headers });
        expect(download.ok(), await download.text()).toBe(true);
        expect(JSON.parse((await download.body()).toString()).elements.map((element: Element) => element.x).sort((a: number, b: number) => a - b))
          .toEqual([230, 460]);

        const target = { kind: 'document' as const, workspaceId: workspaceId!, documentId: initial.documentId };
        const resolved = await page.request.post('/api/files/version-center/v1/resolve', {
          headers, data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
        });
        expect(resolved.ok(), await resolved.text()).toBe(true);
        const timeline = await resolved.json();
        expect(timeline.capabilities).toMatchObject({ history: true, restore: true, compare: false });
        expect(initial.checkpoint.revisionId).toBeTruthy();
        const selected = timeline.entries.find((entry: { kind: string; revisionId?: string }) =>
          entry.kind === 'revision' && entry.revisionId === initial.checkpoint.revisionId);
        expect(selected?.restorable).toBe(true);
        await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
          selectedEntry: { kind: 'revision', id: initial.checkpoint.revisionId! }, initialView: 'history', source: 'deep_link' }));
        const restore = page.getByRole('button', { name: 'Restore version', exact: true });
        await expect(restore).toBeVisible({ timeout: 30_000 });
        await restore.click();
        const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/files/version-center/v1/restore');
        await page.getByRole('button', { name: 'Restore as new version', exact: true }).click();
        const response = await responsePromise;
        expect(response.ok(), await response.text()).toBe(true);
        const receipt = await response.json();
        expect(receipt.outcome).toBe('restored');
        const restored = await get();
        expect(restored.lifecycleGeneration).toBe(edited.lifecycleGeneration + 1);
        expect(restored.elements).toEqual([]);
        await info.attach(`excalidraw-${workspaceType}-history.png`, {
          contentType: 'image/png', body: await page.screenshot({ fullPage: true }),
        });
        await info.attach(`excalidraw-${workspaceType}-receipts`, { contentType: 'application/json', body: JSON.stringify({
          workspaceId, documentId: initial.documentId, initialSequence: initial.sceneSequence,
          editedSequence: edited.sceneSequence, restoredSequence: restored.sceneSequence,
          restoredGeneration: restored.lifecycleGeneration, statuses: outcomes.map(operation => operation.status),
          staleTarget: review.status, cookie: true, bearer: true, historyRestore: receipt.outcome,
        }) });
      } catch (error) { failure = error; throw error; }
      finally {
        const cleanupErrors: unknown[] = [];
        const clean = async (action: () => Promise<unknown>) => {
          try { await action(); } catch (error) { cleanupErrors.push(error); }
        };
        await clean(() => context.close());
        if (bearer) await clean(() => bearer!.dispose());
        if (cleanup && workspaceId && filePath) await clean(async () => {
          const deleted = await cleanup!.delete('/api/files/delete', {
            headers: { 'x-canvas-workspace-id': workspaceId! }, data: { path: filePath },
          });
          expect(deleted.status(), await deleted.text()).toBe(200);
        });
        if (cleanup && workspaceId && cleanupErrors.length === 0) await clean(async () => {
          expect((await cleanup!.delete(`/api/workspaces/${encodeURIComponent(workspaceId!)}`)).status()).toBe(200);
        });
        if (cleanup) await clean(() => cleanup!.dispose());
        if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors,
          'Headless Excalidraw fixture cleanup failed; retain its API-owned identities.');
      }
    });
  }
});
