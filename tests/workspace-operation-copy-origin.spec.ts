import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { prepareDestinationTreeRequestBudget, waitForDestinationFileTreeBudget } from './helpers/destination-tree-request-budget';

const spec = 'tests/workspace-operation-copy-origin.spec.ts';
const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 960 }, mobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true },
] as const;
type Profile = typeof profiles[number];
type SessionIdentity = { userId: string; sessionId: string };
type Operation = { operationId: string; planId: string; status: string; errorCode: string | null;
  completedSteps: string[]; pendingSteps: string[] };
type Workspace = { id: string; name: string; type: string; permissions: { canManageWorkspace: boolean } };

function copyOriginPublicPrivacy(value: unknown): void {
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    expect(['origin', 'requestJson', 'request_json', 'actor', 'actorId', 'actorUserId', 'actorSessionId', 'sessionId',
      'sourceScope', 'destinationScope', 'private_result', 'requestFingerprint']).not.toContain(key);
    copyOriginPublicPrivacy(child);
  }
}
async function copyOriginSession(request: APIRequestContext): Promise<SessionIdentity> {
  const response = await request.get('/api/auth/get-session', { timeout: 15_000 });
  expect(response.status()).toBe(200);
  const body = await response.json() as { user: { id: string }; session: { id: string; userId: string } };
  expect(typeof body.user.id).toBe('string'); expect(body.user.id.length).toBeGreaterThan(0);
  expect(typeof body.session.id).toBe('string'); expect(body.session.id.length).toBeGreaterThan(0);
  expect(body.session.userId).toBe(body.user.id);
  return { userId: body.user.id, sessionId: body.session.id };
}
async function copyOriginFreshSession(browser: Browser, profile: Profile): Promise<BrowserContext> {
  // A second cached authenticated context could reuse the original session.
  // Sign in normally in a genuinely empty context; retain both real sessions.
  const context = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: profile.viewport,
    isMobile: profile.mobile, hasTouch: profile.mobile });
  try {
    const email = process.env.TEST_LOGIN_EMAIL, password = process.env.TEST_LOGIN_PASSWORD;
    expect(Boolean(email && password), 'The owned supervisor supplies the private fixture credentials.').toBe(true);
    const response = await context.request.post('/api/auth/sign-in/email', { timeout: 15_000,
      headers: { Origin: process.env.BASE_URL! }, data: { email, password } });
    expect(response.status()).toBe(200);
    return context;
  } catch (error) { await context.close(); throw error; }
}
async function copyOriginBytes(request: APIRequestContext, workspaceId: string, filePath: string, expected: string): Promise<void> {
  const response = await request.get(`/api/files/download?path=${encodeURIComponent(filePath)}`, {
    headers: { 'x-canvas-workspace-id': workspaceId }, timeout: 15_000,
  });
  expect(response.status()).toBe(200); expect(await response.body()).toEqual(Buffer.from(expected));
}
async function copyOriginChildren(request: APIRequestContext, workspaceId: string, folder: string): Promise<string[]> {
  await waitForDestinationFileTreeBudget();
  const response = await request.get('/api/files/tree', { headers: { 'x-canvas-workspace-id': workspaceId },
    params: { path: folder, depth: '1', noCache: '1' }, timeout: 15_000 });
  expect(response.status()).toBe(200);
  const body = await response.json() as { data: Array<{ path: string; type: string }> };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.every(entry => entry.type === 'file')).toBe(true);
  return body.data.map(entry => entry.path).sort();
}
async function copyOriginStatus(request: APIRequestContext, operation: Operation, sourceId: string, destinationId: string,
  sourcePath: string, targetPath: string): Promise<unknown> {
  const response = await request.get(`/api/files/operations/${operation.operationId}`, { timeout: 15_000 });
  expect(response.status()).toBe(200);
  const body = await response.json(); copyOriginPublicPrivacy(body);
  expect(body).toMatchObject({ success: true, operation: { operationId: operation.operationId, planId: operation.planId,
    kind: 'copy', selections: [{ sourcePath, destinationPath: targetPath }], sourceWorkspaceId: sourceId,
    destinationWorkspaceId: destinationId, status: 'completed', phase: 'completed', errorCode: null } });
  expect(body.operation.steps.length).toBeGreaterThan(0);
  expect(body.operation.steps.every((step: { status: string }) => step.status === 'applied')).toBe(true);
  return body;
}
async function copyOriginInUi(page: Page, sourceId: string, destinationId: string, sourcePath: string, folder: string,
  createFolder: boolean, profile: Profile, screenshot: string): Promise<Operation> {
  await page.goto(`/en/files?workspaceId=${sourceId}`);
  const row = page.locator(`[data-file-path="${sourcePath}"]`).filter({ visible: true }).first();
  await expect(row).toBeVisible({ timeout: 45_000 }); await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Copy to workspace', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy to workspace', exact: true });
  await dialog.getByRole('combobox', { name: 'Target workspace', exact: true }).selectOption(destinationId);
  await expect(dialog.getByRole('combobox', { name: 'Target workspace', exact: true })).toHaveValue(destinationId);
  if (createFolder) {
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
    await dialog.getByLabel('New folder name', { exact: true }).fill(folder);
    await waitForFileCreateBudget();
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
      && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === destinationId
      && response.request().postDataJSON()?.path === folder && response.request().postDataJSON()?.type === 'directory');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    expect((await created).status()).toBe(200);
    await expect(dialog.getByLabel('New folder name', { exact: true })).toBeHidden();
  } else await dialog.getByRole('button', { name: folder, exact: true }).click();
  await expect(dialog.getByRole('button', { name: folder, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toContainText(`Selected folder: /${folder}`);
  const bounds = await dialog.boundingBox(); expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1); expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(profile.viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(profile.viewport.height + 1);
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  const copied = page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/files/copy' || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON();
    return body.dryRun !== true && body.sourceWorkspaceId === sourceId && body.targetWorkspaceId === destinationId
      && body.destDir === folder && body.sources?.length === 1 && body.sources[0] === sourcePath
      && response.request().headers()['x-canvas-workspace-id'] === sourceId;
  }, { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  const response = await copied; expect(response.status()).toBe(200);
  const body = await response.json(); copyOriginPublicPrivacy(body);
  expect(body).toMatchObject({ success: true, copied: [`${folder}/${sourcePath}`], failed: [], skipped: [],
    sourceWorkspaceId: sourceId, targetWorkspaceId: destinationId, linkStatus: 'complete',
    operation: { status: 'complete', errorCode: null, pendingSteps: [] } });
  expect(body.operation.operationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u);
  expect(body.operation.planId).toMatch(/^[a-f0-9]{64}$/u);
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  return body.operation as Operation;
}

test.describe('owned copy origin UI and fresh member-session status', { tag: '@owned-yjs' }, () => {
  test.setTimeout(240_000);
  for (const profile of profiles) test(`${profile.name}: TXT and link-free Markdown copies retain public results across a fresh login`, async ({ browser }, info) => {
    const owned = await requireOwnedYjsQaTarget(); expect(owned.activeSpec).toBe(spec);
    const context = await createAuthenticatedContext(browser, { viewport: profile.viewport,
      isMobile: profile.mobile, hasTouch: profile.mobile });
    const contexts = [context], workspaces: Workspace[] = [];
    let failed = false, primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      await prepareDestinationTreeRequestBudget(context);
      const originalSession = await copyOriginSession(context.request);
      const prefix = randomUUID().slice(0, 8), files = [
        { path: `origin-${prefix}.txt`, content: 'Physical TXT copy: λ → äöü ß.\n', mimeType: 'text/plain' },
        { path: `origin-${prefix}.md`, content: '# Copy origin\n\nMarkdown without local links: λ → äöü.\n', mimeType: 'text/markdown' },
      ];
      await test.step('create only the two owned workspaces and physical source files', async () => {
        for (const role of ['source', 'target']) {
          const name = `Copy ${profile.name} ${role} ${prefix}`;
          const response = await context.request.post('/api/workspaces', { data: { type: 'personal', name } });
          const body = await response.json() as { workspace?: Workspace };
          if (body.workspace?.id) workspaces.push(body.workspace);
          expect(response.status()).toBe(201);
          expect(body.workspace).toMatchObject({ name, type: 'personal', permissions: { canManageWorkspace: true } });
        }
        expect(workspaces).toHaveLength(2); expect(workspaces[0].id).not.toBe(workspaces[1].id);
        for (const file of files) await uploadWorkspaceTextFile({ request: context.request, workspaceId: workspaces[0].id,
          filePath: file.path, content: file.content, mimeType: file.mimeType });
      });
      const [source, destination] = workspaces, folder = 'OriginCopies';
      await context.addInitScript(workspaceId => {
        localStorage.setItem('canvas.activeWorkspaceId', workspaceId);
        localStorage.setItem('canvas.notebook.chatVisible', 'false'); localStorage.setItem('canvas-browser-mode', 'list');
      }, source.id);
      const page = await context.newPage(), operations: Operation[] = [], beforeStatus: unknown[] = [];
      for (const [index, file] of files.entries()) await test.step(`copy ${file.path} in the real destination dialog`, async () => {
        const operation = await copyOriginInUi(page, source.id, destination.id, file.path, folder, index === 0,
          profile, info.outputPath(`${profile.name}-${index}-copy-dialog.png`));
        operations.push(operation);
        await copyOriginBytes(context.request, source.id, file.path, file.content);
        await copyOriginBytes(context.request, destination.id, `${folder}/${file.path}`, file.content);
        beforeStatus.push(await copyOriginStatus(context.request, operation, source.id, destination.id, file.path, `${folder}/${file.path}`));
      });
      expect(new Set(operations.map(operation => operation.operationId)).size).toBe(2);
      const beforeChildren = await copyOriginChildren(context.request, destination.id, folder);
      expect(beforeChildren).toEqual(files.map(file => `${folder}/${file.path}`).sort());
      await test.step('sign in a new real member session and requery completed operations without a second copy', async () => {
        const fresh = await copyOriginFreshSession(browser, profile); contexts.push(fresh);
        const currentSession = await copyOriginSession(fresh.request);
        expect(currentSession.userId).toBe(originalSession.userId); expect(currentSession.sessionId).not.toBe(originalSession.sessionId);
        for (const [index, file] of files.entries()) {
          const operation = operations[index];
          expect(await copyOriginStatus(fresh.request, operation, source.id, destination.id, file.path, `${folder}/${file.path}`)).toEqual(beforeStatus[index]);
          // This is a completed-operation requery. It is deliberately NOT a
          // crashed/incomplete native-stage recovery or private-ledger proof.
          const response = await fresh.request.post(`/api/files/operations/${operation.operationId}`);
          expect(response.status()).toBe(200);
          const body = await response.json(); copyOriginPublicPrivacy(body);
          expect(body).toMatchObject({ success: true, linkStatus: 'complete' });
          const historical = body.operation as Operation;
          for (const result of [historical, operation]) {
            expect(new Set(result.completedSteps).size).toBe(result.completedSteps.length);
          }
          expect(historical.completedSteps).toHaveLength(operation.completedSteps.length);
          expect({ ...historical, completedSteps: [...historical.completedSteps].sort() })
            .toEqual({ ...operation, completedSteps: [...operation.completedSteps].sort() });
          expect(await copyOriginStatus(fresh.request, operation, source.id, destination.id, file.path, `${folder}/${file.path}`)).toEqual(beforeStatus[index]);
          await copyOriginBytes(fresh.request, source.id, file.path, file.content);
          await copyOriginBytes(fresh.request, destination.id, `${folder}/${file.path}`, file.content);
        }
        expect(await copyOriginChildren(fresh.request, destination.id, folder)).toEqual(beforeChildren);
      });
    } catch (error) { failed = true; primaryError = error; }
    finally {
      for (const held of contexts) for (const page of held.pages()) {
        try { await page.close(); } catch (error) { cleanupErrors.push(error); }
      }
      for (const workspace of [...workspaces].reverse()) {
        try {
          const response = await context.request.get('/api/workspaces'); expect(response.status()).toBe(200);
          const listed = (await response.json()).workspaces as Workspace[];
          expect(listed.find(value => value.id === workspace.id)).toMatchObject({ id: workspace.id, name: workspace.name,
            type: 'personal', permissions: { canManageWorkspace: true } });
          expect((await context.request.delete(`/api/workspaces/${workspace.id}`)).status()).toBe(200);
        } catch (error) { cleanupErrors.push(error); }
      }
      for (const held of [...contexts].reverse()) {
        try { await held.close(); } catch (error) { cleanupErrors.push(error); }
      }
    }
    if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors, 'Owned copy-origin fixture cleanup failed.');
    if (failed) throw primaryError;
  });
});
