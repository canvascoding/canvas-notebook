import { createHash, randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import {
  createAuthenticatedContext,
  requestManagedTestSession,
  runManagedTestPreflight,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const originalContent = '# Wärmepumpe – Testprotokoll\n\nOriginaler Inhalt: Größe, Wärme und Rücklauf bleiben erhalten.\n\nZweiter Absatz mit Unicode: äöü ß → 22 °C.\n';
const originalHash = createHash('sha256').update(originalContent).digest('hex');

type WorkspaceSummary = { id: string; name: string; type: string; status: string;
  permissions: { canRead: boolean; canWrite: boolean; canDelete: boolean; canManageWorkspace: boolean } };
type FileEvidence = { path: string; content: string; stats: { sha256: string } };
type SharedFixture = { workspaceId: string; admin: BrowserContext; peer: BrowserContext; adminPage: Page; peerPage: Page;
  headers: Record<string, string>; upload: (path: string, content: string) => Promise<void>;
  read: (api: APIRequestContext, path: string) => Promise<FileEvidence> };

async function authenticatedUserId(context: BrowserContext): Promise<string> {
  const response = await requestManagedTestSession(context.request, { phase: 'Managed fixture identity' });
  expect(response.status(), 'Authenticated fixture session').toBe(200);
  const user = (await response.json()).user as { id?: string } | undefined;
  if (!user?.id) throw new Error('The authenticated fixture has no user ID.');
  return user.id;
}

async function ownWorkspace(api: APIRequestContext, workspaceId: string): Promise<WorkspaceSummary | undefined> {
  const response = await api.get('/api/workspaces');
  expect(response.status(), 'Shared workspace listing').toBe(200);
  const payload = await response.json() as { workspaces: WorkspaceSummary[] };
  return payload.workspaces.find((workspace) => workspace.id === workspaceId);
}

/** Every case owns a separate team workspace; cleanup remains independent of open editor sessions. */
async function withSharedFixture(browser: Browser, work: (fixture: SharedFixture) => Promise<void>): Promise<void> {
  expect(process.env.E2E_EXTERNAL_SERVER, 'Use the single externally managed Notebook stack.').toBe('1');
  const secondaryEmail = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
  const secondaryPassword = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
  expect(Boolean(secondaryEmail && secondaryPassword), 'Configure the managed secondary fixture credentials.').toBe(true);
  const contexts: BrowserContext[] = [];
  let cleanupApi: APIRequestContext | undefined;
  let workspaceId: string | undefined;
  let adminUserId: string | undefined;
  const workspaceName = `E2E shared HTML move ${randomUUID()}`;
  let failed = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const admin = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 1000 } });
    contexts.push(admin);
    cleanupApi = await request.newContext({ baseURL: process.env.BASE_URL,
      storageState: await admin.storageState(), timeout: 15_000 });
    const peer = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 1000 } },
      { email: secondaryEmail, password: secondaryPassword });
    contexts.push(peer);
    adminUserId = await authenticatedUserId(admin);
    const peerUserId = await authenticatedUserId(peer);
    expect(adminUserId === peerUserId, 'The shared test requires two distinct authenticated users.').toBe(false);
    const created = await admin.request.post('/api/workspaces', { data: { type: 'team', name: workspaceName } });
    const receipt = (await created.json()).workspace as WorkspaceSummary | undefined;
    if (receipt?.id) workspaceId = receipt.id;
    expect(created.status(), 'Create an isolated shared team workspace').toBe(201);
    expect(receipt).toMatchObject({ id: workspaceId, name: workspaceName, type: 'team',
      permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true } });
    if (!workspaceId) throw new Error('The created shared workspace has no ID.');
    const id = workspaceId;
    const membership = await admin.request.post(`/api/workspaces/${id}/members`, {
      data: { userId: peerUserId, role: 'member', canRead: true, canWrite: true, canManage: false },
    });
    expect(membership.status(), 'Grant the second user read and write membership').toBe(200);
    expect((await membership.json()).success).toBe(true);
    await runManagedTestPreflight(admin, { workspaceId: id, requireWorkspacePermission: 'write' });
    await runManagedTestPreflight(peer, { workspaceId: id, requireWorkspacePermission: 'write' });
    expect(await ownWorkspace(peer.request, id)).toMatchObject({ id, name: workspaceName, type: 'team',
      permissions: { canRead: true, canWrite: true, canDelete: false } });
    const headers = { [WORKSPACE_ID_HEADER]: id };
    const directory = await admin.request.post('/api/files/create', { headers, data: { path: 'Ziel', type: 'directory' } });
    expect(directory.status(), 'Create the move destination').toBe(200);
    for (const context of contexts) {
      await context.addInitScript((activeWorkspaceId) => {
        localStorage.setItem('canvas.activeWorkspaceId', activeWorkspaceId);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
        localStorage.setItem('canvas-browser-mode', 'tree');
      }, id);
    }
    const adminPage = await admin.newPage();
    const peerPage = await peer.newPage();
    for (const page of [adminPage, peerPage]) page.setDefaultTimeout(15_000);
    const read = async (api: APIRequestContext, filePath: string) => {
      const response = await api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
      expect(response.status(), `Read owned fixture ${filePath}`).toBe(200);
      const payload = await response.json() as { data: FileEvidence };
      expect(payload.data.path).toBe(filePath);
      return payload.data;
    };
    await work({ workspaceId: id, admin, peer, adminPage, peerPage, headers, read,
      upload: (filePath, content) => uploadWorkspaceTextFile({ request: admin.request, workspaceId: id, filePath, content }) });
  } catch (error) {
    failed = true; primaryError = error;
  } finally {
    // Close both editors before deleting the exact workspace through its public API.
    for (const context of [...contexts].reverse()) {
      try { await context.close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (workspaceId && cleanupApi) {
      try {
        const session = await requestManagedTestSession(cleanupApi, { phase: 'Managed fixture identity' });
        expect(session.status(), 'Independent cleanup authentication').toBe(200);
        expect((await session.json()).user.id).toBe(adminUserId);
        expect(await ownWorkspace(cleanupApi, workspaceId)).toMatchObject({ id: workspaceId, name: workspaceName,
          type: 'team', status: 'active', permissions: { canManageWorkspace: true } });
        const deleted = await cleanupApi.delete(`/api/workspaces/${workspaceId}`);
        expect(deleted.status(), 'Delete the exact owned shared workspace').toBe(200);
        expect(await deleted.json()).toEqual({ success: true });
        expect(await ownWorkspace(cleanupApi, workspaceId), 'Owned workspace is absent after cleanup').toBeUndefined();
      } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupApi) {
      try { await cleanupApi.dispose(); } catch (error) { cleanupErrors.push(error); }
    }
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'Shared HTML move fixture cleanup failed.');
  if (failed) throw primaryError;
}

async function openOriginal(page: Page, workspaceId: string, filePath: string): Promise<void> {
  await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
    { waitUntil: 'domcontentloaded' });
  await page.getByRole('group', { name: 'Document view', exact: true })
    .getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.locator('.tiptap-editor-shell .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  await expect(editor).toContainText('Originaler Inhalt: Größe, Wärme und Rücklauf bleiben erhalten.');
  await expect(editor).toContainText('Zweiter Absatz mit Unicode: äöü ß → 22 °C.');
  const sidebarToggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
}

async function moveDialog(page: Page, filePath: string) {
  const row = page.locator(`[data-file-path="${filePath}"]`).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Move "${filePath}"`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Destination folder', { exact: true }).fill('Ziel');
  return dialog;
}

async function assertOriginal(fixture: SharedFixture, filePath: string): Promise<void> {
  for (const context of [fixture.admin, fixture.peer]) {
    const evidence = await fixture.read(context.request, filePath);
    expect(evidence.content).toBe(originalContent);
    expect(evidence.stats.sha256).toBe(originalHash);
  }
}

async function assertAbsent(fixture: SharedFixture, filePath: string): Promise<void> {
  const response = await fixture.admin.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers: fixture.headers });
  expect(response.status(), `Owned fixture ${filePath} is absent`).toBe(404);
}

async function waitApplied(fixture: SharedFixture, expected: WorkspacePathOperationPublic): Promise<void> {
  await expect.poll(async () => {
    const response = await fixture.admin.request.get(`/api/files/operations/batches/${encodeURIComponent(expected.batchId)}`,
      { headers: fixture.headers });
    expect(response.status(), 'Read the exact owned file operation').toBe(200);
    const current = (await response.json()).operation as WorkspacePathOperationPublic;
    expect(current).toMatchObject({ batchId: expected.batchId, planId: expected.planId, workspaceId: fixture.workspaceId });
    if (current.status === 'applied') {
      expect(current.phase).toBe('complete');
      expect(current.completedActions).toBe(current.totalActions);
    }
    return current.status;
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe('applied');
}

test.describe('shared workspace HTML move safety', () => {
  test.setTimeout(240_000);

  test('external HTML permits a move, updates Markdown backlinks and preserves both users documents', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      await fixture.upload('transkript.md', originalContent);
      const backlinks = '[Transkript](transkript.md)\n\n![Externes Markdown-Bild](https://example.com/fixture.svg)\n';
      await fixture.upload('Verweise.md', backlinks);
      const externalHtml = '<img src="https://example.com/fixture.svg" alt="Externes Testbild" width="320" height="160">\n';
      await fixture.upload('Bild.md', externalHtml);
      await openOriginal(fixture.adminPage, fixture.workspaceId, 'transkript.md');
      await openOriginal(fixture.peerPage, fixture.workspaceId, 'transkript.md');
      const dialog = await moveDialog(fixture.adminPage, 'transkript.md');
      const [response] = await Promise.all([
        fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
          && candidate.request().method() === 'POST'),
        dialog.getByRole('button', { name: 'Move', exact: true }).click(),
      ]);
      expect(response.ok(), 'Unrelated external HTML must not block the move').toBe(true);
      const result = await response.json() as WorkspacePathOperationResponse;
      expect(result.operation).toMatchObject({ workspaceId: fixture.workspaceId, kind: 'rename' });
      await waitApplied(fixture, result.operation);
      await expect(dialog).toBeHidden({ timeout: 90_000 });
      await assertAbsent(fixture, 'transkript.md');
      await assertOriginal(fixture, 'Ziel/transkript.md');
      const rewritten = backlinks.replace('(transkript.md)', '(Ziel/transkript.md)');
      for (const context of [fixture.admin, fixture.peer]) {
        expect((await fixture.read(context.request, 'Verweise.md')).content).toBe(rewritten);
        expect((await fixture.read(context.request, 'Bild.md')).content).toBe(externalHtml);
      }
      for (const page of [fixture.adminPage, fixture.peerPage]) {
        await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toContainText('Originaler Inhalt: Größe, Wärme und Rücklauf bleiben erhalten.');
        await openOriginal(page, fixture.workspaceId, 'Ziel/transkript.md');
      }
      await fixture.adminPage.screenshot({ path: info.outputPath('shared-external-html-move.png'), animations: 'disabled' });
    });
  });

  for (const variant of ['local', 'mixed'] as const) {
    test(`${variant} HTML blocks a move with an actionable filename and a dry-run-only recheck`, async ({ browser }, info) => {
      await withSharedFixture(browser, async (fixture) => {
        const source = `transkript-${variant}.md`;
        const issueFile = `HTML-${variant}.md`;
        const issueMarker = `Shared HTML ${variant} fixture ${fixture.workspaceId}`;
        await fixture.upload(source, originalContent);
        const html = `# HTML-${variant} Fixture\n\n${issueMarker}\n\n`
          + (variant === 'local' ? `<a href="${source}">Transkript</a>\n`
            : `<a href="${source}"><img src="https://example.com/fixture.svg" alt="Extern"></a>\n`);
        await fixture.upload(issueFile, html);
        await openOriginal(fixture.adminPage, fixture.workspaceId, source);
        await openOriginal(fixture.peerPage, fixture.workspaceId, source);
        const renames: Array<Record<string, unknown>> = [];
        fixture.adminPage.on('request', (observed) => {
          if (new URL(observed.url()).pathname === '/api/files/rename' && observed.method() === 'POST') {
            renames.push(observed.postDataJSON() as Record<string, unknown>);
          }
        });
        const dialog = await moveDialog(fixture.adminPage, source);
        const [blocked] = await Promise.all([
          fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
            && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun !== true),
          dialog.getByRole('button', { name: 'Move', exact: true }).click(),
        ]);
        expect(blocked.status(), 'Local HTML remains protected').toBe(409);
        const failure = await blocked.json();
        expect(failure).toMatchObject({ code: 'PREVIEW_BLOCKED', operation: { workspaceId: fixture.workspaceId,
          status: 'blocked', errorCode: 'PREVIEW_BLOCKED', completedActions: 0,
          issues: expect.arrayContaining([{ code: 'unevaluated-link', path: issueFile }]) } });
        const issues = dialog.getByTestId('workspace-move-operation-issues');
        await expect(issues).toBeVisible();
        await expect(issues).toContainText(issueFile);
        await expect(issues).toContainText('unevaluated-link');
        await expect(issues.getByRole('button', { name: 'Open affected file', exact: true })).toBeVisible();
        await assertOriginal(fixture, source);
        await assertAbsent(fixture, `Ziel/${source}`);
        const [preview] = await Promise.all([
          fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
            && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun === true),
          dialog.getByRole('button', { name: 'Check again', exact: true }).click(),
        ]);
        expect(preview.status(), 'Recheck reads a new preview').toBe(200);
        expect(preview.request().postDataJSON()).toEqual({ oldPath: source, newPath: `Ziel/${source}`, dryRun: true });
        expect(await preview.json()).toMatchObject({ dryRun: true, requiresRevalidation: true, plan: { readiness: 'blocked' } });
        await expect(dialog.getByTestId('workspace-move-preview')).toContainText('blocked');
        expect(renames.filter((body) => body.dryRun !== true), 'Recheck never applies or retries the move').toHaveLength(1);
        expect(renames.filter((body) => body.dryRun === true)).toHaveLength(1);
        await assertOriginal(fixture, source);
        await assertAbsent(fixture, `Ziel/${source}`);
        expect((await fixture.read(fixture.admin.request, issueFile)).content).toBe(html);
        await fixture.adminPage.screenshot({ path: info.outputPath(`shared-${variant}-html-blocked.png`), animations: 'disabled' });
        await expect(issues).toContainText(issueFile);
        await issues.getByRole('button', { name: 'Open affected file', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(fixture.adminPage.getByRole('tab', { name: issueFile, exact: true })).toHaveAttribute('aria-selected', 'true');
        const openedIssue = fixture.adminPage.getByRole('tabpanel', { name: issueFile, exact: true });
        await expect(openedIssue).toBeVisible();
        await expect(openedIssue).toContainText(issueMarker);
        expect(renames, 'Opening the affected file does not submit another file action').toHaveLength(2);
        await fixture.adminPage.screenshot({ path: info.outputPath(`shared-${variant}-html-opened.png`), animations: 'disabled' });
      });
    });
  }
});
