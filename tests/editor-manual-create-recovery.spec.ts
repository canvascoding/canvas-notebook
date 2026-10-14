import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { assertCompletedWorkspaceMarkdownCreate, authenticateManagedTestPage } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';

type Workspace = { id: string; headers: Record<string, string> };
type CreateBody = { path: string; type: 'file'; requestId: string };
const editorSelector = '.tiptap-editor-shell .ProseMirror';

async function recoveryWorkspace(page: Page): Promise<Workspace> {
  await authenticateManagedTestPage(page);
  const response = await page.request.get('/api/workspaces');
  expect(response.status()).toBe(200);
  const { workspaces } = await response.json();
  const workspace = workspaces.find((entry: { id: string; name: string; permissions?: { canWrite: boolean } }) =>
    entry.name === 'Shared Test Workspace' && entry.permissions?.canWrite);
  expect(workspace?.id).toBeTruthy();
  await page.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  return { id: workspace.id, headers: { 'x-canvas-workspace-id': workspace.id } };
}

async function openCreateDialog(page: Page, entry: 'home' | 'file-browser'): Promise<Locator> {
  if (entry === 'home') {
    await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
    return page.getByRole('dialog', { name: 'New note', exact: true });
  }
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
  return page.getByRole('dialog', { name: 'Create new file', exact: true });
}

async function nativeIdentity(page: Page, workspace: Workspace, path: string) {
  const response = await page.request.post('/api/files/collaboration/session', {
    headers: workspace.headers, data: { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.status()).toBe(200);
  const value = await response.json();
  expect(value.documentId).toBeTruthy(); expect(value.lifecycleGeneration).toBeGreaterThan(0);
  return { documentId: value.documentId as string, lifecycleGeneration: value.lifecycleGeneration as number };
}

test.describe('Real manual Create response loss and explicit recovery', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1',
    'Requires the explicitly owned compiled application and genuine native Create coordinator.');
  test.setTimeout(150_000);
  test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']); });

  for (const entry of ['home', 'file-browser'] as const) {
    test(`${entry}: server completes the genuine POST, lost reply stays closed across reload until same UUID is explicitly checked`, async ({ page }, info) => {
      const workspace = await recoveryWorkspace(page), path = `lost-create-${entry}-${randomUUID()}.md`;
      const bodies: CreateBody[] = [], prematureOpens: string[] = [];
      let explicitResume = false, routeFailure: unknown, firstHandlerStarted = false;
      let serverResolve!: () => void, serverReject!: (reason: unknown) => void, releaseReply!: () => void, handlerResolve!: () => void;
      const serverCompleted = new Promise<void>((resolve, reject) => { serverResolve = resolve; serverReject = reject; });
      void serverCompleted.catch(() => undefined);
      const replyBarrier = new Promise<void>(resolve => { releaseReply = resolve; });
      const firstHandlerClosed = new Promise<void>(resolve => { handlerResolve = resolve; });
      const observeOpening = (request: Request) => {
        if (explicitResume) return;
        const url = new URL(request.url());
        if (url.pathname === '/api/files/read' && url.searchParams.get('path') === path
          || url.pathname === '/api/files/collaboration/session' && request.method() === 'POST' && request.postDataJSON()?.path === path) {
          prematureOpens.push(url.pathname);
        }
      };
      page.on('request', observeOpening);
      const handler = async (route: Route) => {
        const request = route.request();
        if (request.method() !== 'POST' || request.headers()['x-canvas-workspace-id'] !== workspace.id
          || request.postDataJSON()?.path !== path) { await route.continue(); return; }
        const body = request.postDataJSON() as CreateBody;
        bodies.push(body);
        if (bodies.length !== 1) { await route.continue(); return; }
        firstHandlerStarted = true;
        let actual: Awaited<ReturnType<Route['fetch']>> | undefined;
        try {
          expect(Object.keys(body).sort()).toEqual(['path', 'requestId', 'type']);
          expect(body.type).toBe('file'); expect(body.requestId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
          // A real server request completes its native commit, physical birth
          // and Create effects. Only this browser's outgoing reply is lost.
          actual = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 45_000 });
          await assertCompletedWorkspaceMarkdownCreate(actual, { requestId: body.requestId, workspaceId: workspace.id, targetPath: path });
          serverResolve();
          await replyBarrier;
          await route.abort('failed');
        } catch (error) {
          routeFailure = error; serverReject(error);
          await route.abort('failed').catch(() => undefined);
        } finally {
          try { await actual?.dispose(); } catch (error) { routeFailure ??= error; }
          finally { handlerResolve(); }
        }
      };
      await page.route('**/api/files/create', handler);
      try {
        await page.goto(entry === 'home' ? '/en' : `/en/files?workspaceId=${workspace.id}`);
        let dialog = await openCreateDialog(page, entry);
        await dialog.getByLabel(entry === 'home' ? 'Note name' : 'File name', { exact: true }).fill(path);
        await waitForFileCreateBudget();
        await dialog.getByRole('button', { name: entry === 'home' ? 'Create and open' : 'Create file', exact: true }).click();
        await serverCompleted;
        expect(routeFailure).toBeUndefined(); expect(bodies).toHaveLength(1);
        await expect(dialog).toBeVisible(); await expect(page.locator(editorSelector)).toHaveCount(0);
        expect(new URL(page.url()).searchParams.get('path')).toBeNull(); expect(prematureOpens).toEqual([]);
        const identity = await nativeIdentity(page, workspace, path);
        const durable = await page.request.get('/api/files/download', { headers: workspace.headers, params: { path } });
        expect(durable.status()).toBe(200); expect(await durable.body()).toEqual(Buffer.alloc(0));
        releaseReply(); await firstHandlerClosed;
        expect(routeFailure).toBeUndefined();
        await expect(dialog.getByRole('button', { name: 'Check creation again', exact: true })).toBeEnabled();
        await expect(page.locator(editorSelector)).toHaveCount(0); expect(prematureOpens).toEqual([]);
        await page.screenshot({ path: info.outputPath(`${entry}-lost-reply-pending.png`), animations: 'disabled' });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.reload();
        dialog = await openCreateDialog(page, entry);
        await expect(dialog).toContainText(path);
        const resume = dialog.getByRole('button', { name: 'Check creation again', exact: true });
        await expect(resume).toBeEnabled();
        // A restored visible pending row proves hydration has committed. No
        // operation is dispatched by reload, opening, or hydration itself.
        expect(bodies).toHaveLength(1); expect(prematureOpens).toEqual([]);
        await expect(page.locator(editorSelector)).toHaveCount(0);
        await waitForFileCreateBudget();
        const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
          && response.request().method() === 'POST' && response.request().postDataJSON()?.path === path);
        explicitResume = true;
        await resume.click();
        await assertCompletedWorkspaceMarkdownCreate(await completed, { requestId: bodies[0].requestId, workspaceId: workspace.id, targetPath: path });
        expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
        await expect(dialog).toHaveCount(0);
        await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        expect(await nativeIdentity(page, workspace, path)).toEqual(identity);
        await page.locator(editorSelector).focus();
        await page.evaluate(text => navigator.clipboard.writeText(text), 'First paste after explicit recovery.');
        await page.keyboard.press('ControlOrMeta+v');
        await expect(page.locator(editorSelector)).toHaveText('First paste after explicit recovery.');
        await expect.poll(async () => {
          const response = await page.request.get('/api/files/read', { headers: workspace.headers, params: { path } });
          expect(response.status()).toBe(200); return (await response.json()).data.content as string;
        }, { timeout: 20_000 }).toContain('First paste after explicit recovery.');
        await page.reload(); await expect(page.locator(editorSelector)).toHaveText('First paste after explicit recovery.');
        expect(await nativeIdentity(page, workspace, path)).toEqual(identity);
        expect(bodies).toHaveLength(2);
        await info.attach(`${entry}-real-create-recovery-coordinates`, { contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ serverCompleted: true, lostReply: true, explicitResume: true, bodies, identity, prematureOpens })) });
      } finally {
        releaseReply();
        if (firstHandlerStarted) await firstHandlerClosed;
        page.off('request', observeOpening);
        await page.unroute('**/api/files/create', handler);
        await page.goto('about:blank').catch(() => undefined);
        await page.request.delete('/api/files/delete', { headers: workspace.headers, data: { path } });
      }
    });
  }
});
