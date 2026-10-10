import { createHash, randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import { COLLABORATION_CLIENT_CAPABILITIES, type CollaborationSessionResponse } from '../app/lib/collaboration/types';
import {
  createAuthenticatedContext,
  requestManagedTestSession,
  runManagedTestPreflight,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const originalContent = '# Wärmepumpe – Testprotokoll\n\nOriginaler Inhalt: Größe, Wärme und Rücklauf bleiben erhalten.\n\nZweiter Absatz mit Unicode: äöü ß → 22 °C.\n';
const originalHash = createHash('sha256').update(originalContent).digest('hex');
const localImagePath = 'canvas-holdings-screenshot.png';
const localHtmlPath = 'test_core_bearbeitungsfeatures.md';
const localHtmlContent = '# Bearbeitungsfeatures – synthetisches Testdokument\n\n## HTML-Bild\n\n'
  + `<img src="${localImagePath}" alt="Canvas Holdings Screenshot" width="800" style="max-width:100%; height:auto;">\n`;

type WorkspaceSummary = { id: string; name: string; type: string; status: string;
  permissions: { canRead: boolean; canWrite: boolean; canDelete: boolean; canManageWorkspace: boolean } };
type FileEvidence = { path: string; content: string; stats: { sha256: string } };
type SharedFixture = { workspaceId: string; admin: BrowserContext; peer: BrowserContext; adminPage: Page; peerPage: Page;
  peerUserId: string;
  headers: Record<string, string>; upload: (path: string, content: string) => Promise<void>;
  read: (api: APIRequestContext, path: string) => Promise<FileEvidence> };

async function uploadLocalImage(fixture: SharedFixture): Promise<void> {
  const response = await fixture.admin.request.post('/api/files/upload', {
    headers: fixture.headers,
    multipart: { path: '.', files: { name: localImagePath, mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64') } },
  });
  expect(response.status(), 'Upload the owned local HTML image fixture').toBe(200);
}

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

async function captureSharedFixtureFailure(contexts: BrowserContext[], workspaceId: string): Promise<void> {
  const info = test.info();
  for (const [index, context] of contexts.entries()) {
    const page = context.pages()[0];
    if (!page || page.isClosed()) continue;
    const url = new URL(page.url());
    // Capture only the exact owned Notebook page, never authentication screens or transport bodies.
    if (!/^\/(?:en\/)?notebook$/u.test(url.pathname) || url.searchParams.get('workspaceId') !== workspaceId) continue;
    const actor = index === 0 ? 'admin' : 'peer';
    try {
      await page.screenshot({ path: info.outputPath(`${actor}-before-cleanup-failure.png`), animations: 'disabled', timeout: 5_000 });
      const domText = (await page.locator('body').innerText({ timeout: 5_000 })).slice(0, 12_000);
      const accessibility = (await page.locator('body').ariaSnapshot({ timeout: 5_000 })).slice(0, 16_000);
      await info.attach(`${actor}-before-cleanup-ui`, { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        url: { origin: url.origin, pathname: url.pathname, workspaceId, path: url.searchParams.get('path') },
        viewport: page.viewportSize(), domText, accessibility,
      }, null, 2)) });
    } catch (error) {
      await info.attach(`${actor}-failure-capture-status`, { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ errorType: error instanceof Error ? error.name : 'unknown' })) });
    }
  }
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
    await work({ workspaceId: id, admin, peer, adminPage, peerPage, peerUserId, headers, read,
      upload: (filePath, content) => uploadWorkspaceTextFile({ request: admin.request, workspaceId: id, filePath, content }) });
  } catch (error) {
    failed = true; primaryError = error;
    if (workspaceId) await captureSharedFixtureFailure(contexts, workspaceId);
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
  observeSessionPaths(page);
  await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}&collaborationDebug=1`,
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

async function moveDialog(page: Page, filePath: string, destination = 'Ziel') {
  const mobileExplorer = page.getByRole('button', { name: 'Open file explorer', exact: true });
  if (await mobileExplorer.isVisible()) await mobileExplorer.click();
  const row = page.locator(`[data-file-path="${filePath}"]`).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Move "${filePath}"`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Destination folder', { exact: true }).fill(destination);
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

async function waitApplied(fixture: SharedFixture, expected: WorkspacePathOperationPublic,
  status: 'applied' | 'undone' = 'applied'): Promise<void> {
  await expect.poll(async () => {
    const response = await fixture.admin.request.get(`/api/files/operations/batches/${encodeURIComponent(expected.batchId)}`,
      { headers: fixture.headers });
    expect(response.status(), 'Read the exact owned file operation').toBe(200);
    const current = (await response.json()).operation as WorkspacePathOperationPublic;
    expect(current).toMatchObject({ batchId: expected.batchId, planId: expected.planId, workspaceId: fixture.workspaceId });
    if (current.status === status) {
      expect(current.phase).toBe('complete');
      expect(current.completedActions).toBe(current.totalActions);
    }
    return current.status;
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe(status);
}

type DocumentEvidence = Pick<CollaborationSessionResponse, 'documentId' | 'documentName' | 'lifecycleGeneration'
  | 'representation' | 'schemaVersion' | 'richTextSchemaVersion' | 'blockTreeFormatVersion' | 'permission'
  | 'documentSequence' | 'checkpointSequence' | 'degraded'>;
type ClientEvidence = { documentId: string; generation: number; connection: string; durability: string;
  documentSequence: number; checkpointSequence: number; unsyncedChanges: number; remoteSynced: boolean;
  indexedDbHydrated: boolean; failure: unknown; error: string | null };
const sessionPaths = new WeakMap<Page, string[]>();

function observeSessionPaths(page: Page) {
  if (sessionPaths.has(page)) return;
  const paths: string[] = [];
  sessionPaths.set(page, paths);
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/files/collaboration/session'
      || response.request().method() !== 'POST' || !response.ok()) return;
    const body = response.request().postDataJSON() as { path?: unknown };
    if (typeof body.path === 'string') paths.push(body.path);
  });
}

/** Public session evidence deliberately excludes tickets, user profiles and cookies. */
async function documentEvidence(fixture: SharedFixture, context: BrowserContext, filePath: string): Promise<DocumentEvidence> {
  const response = await context.request.post('/api/files/collaboration/session', { headers: fixture.headers,
    data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES } });
  expect(response.status(), `Authorize the current owned document ${filePath}`).toBe(200);
  const session = await response.json() as CollaborationSessionResponse;
  return { documentId: session.documentId, documentName: session.documentName, lifecycleGeneration: session.lifecycleGeneration,
    representation: session.representation, schemaVersion: session.schemaVersion, richTextSchemaVersion: session.richTextSchemaVersion,
    blockTreeFormatVersion: session.blockTreeFormatVersion, permission: session.permission,
    documentSequence: session.documentSequence, checkpointSequence: session.checkpointSequence, degraded: session.degraded };
}

function documentIdentity(evidence: DocumentEvidence) {
  return { documentId: evidence.documentId, documentName: evidence.documentName, generation: evidence.lifecycleGeneration,
    representation: evidence.representation, schemaVersion: evidence.schemaVersion,
    richTextSchemaVersion: evidence.richTextSchemaVersion, blockTreeFormatVersion: evidence.blockTreeFormatVersion };
}

async function clientEvidence(page: Page): Promise<ClientEvidence> {
  const diagnostic = page.getByTestId('markdown-save-state').locator('pre');
  await expect(diagnostic).toBeVisible({ timeout: 30_000 });
  return JSON.parse(await diagnostic.innerText()) as ClientEvidence;
}

async function assertHealthyClient(page: Page, identity: DocumentEvidence, permission: 'read' | 'write' = 'write') {
  let healthySince = 0;
  await expect.poll(async () => {
    const state = await clientEvidence(page);
    const healthy = state.documentId === identity.documentId && state.generation === identity.lifecycleGeneration
      && state.connection === (permission === 'write' ? 'live' : 'read_only')
      && ['persisted_yjs', 'checkpointed_file'].includes(state.durability)
      && state.unsyncedChanges === 0 && state.remoteSynced && state.indexedDbHydrated
      && state.failure === null && state.error === null;
    if (!healthy) { healthySince = 0; return false; }
    healthySince ||= Date.now();
    // Do not accept the old provider's last healthy render before the location transition settles.
    return Date.now() - healthySince >= 1000;
  }, { timeout: 45_000, intervals: [250, 500, 1000] }).toBe(true);
  return clientEvidence(page);
}

async function assertSameOpenDocuments(fixture: SharedFixture, filePath: string, before: DocumentEvidence,
  origins: number[], unchangedSequence = true, peerPermission: 'read' | 'write' = 'write') {
  const sessions = [];
  for (const [index, context] of [fixture.admin, fixture.peer].entries()) {
    const current = await documentEvidence(fixture, context, filePath);
    expect(documentIdentity(current)).toEqual(documentIdentity(before));
    expect(current.permission).toBe(index === 0 ? 'write' : peerPermission);
    expect(current.degraded).not.toBe(true);
    if (unchangedSequence) expect(current.documentSequence).toBe(before.documentSequence);
    const page = index === 0 ? fixture.adminPage : fixture.peerPage;
    // A collapsed destination tree is independent of the open document's resolved location.
    await expect.poll(() => sessionPaths.get(page)?.at(-1), { timeout: 45_000 }).toBe(filePath);
    const state = await assertHealthyClient(page, current, index === 0 ? 'write' : peerPermission);
    expect(state.documentSequence).toBe(current.documentSequence);
    expect(await page.evaluate(() => performance.timeOrigin), 'The mounted document must recover without a page reload').toBe(origins[index]);
    if (index === 0 || peerPermission === 'write') {
      const editor = page.locator(before.representation === 'plain_text' ? '.cm-content' : '.tiptap-editor-shell .ProseMirror');
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    } else {
      await expect(page.getByRole('group', { name: 'Document view', exact: true })
        .getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
      await expect(page.locator('.tiptap-editor-shell [contenteditable="true"], .cm-content[contenteditable="true"]')).toHaveCount(0);
    }
    sessions.push(current);
  }
  expect(documentIdentity(sessions[1])).toEqual(documentIdentity(sessions[0]));
  expect(sessions[1].documentSequence).toBe(sessions[0].documentSequence);
  return sessions;
}

async function openSharedDocument(page: Page, fixture: SharedFixture, filePath: string, marker: string,
  kind: 'rich' | 'code' | 'read' = 'rich') {
  observeSessionPaths(page);
  await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(fixture.workspaceId)}&path=${encodeURIComponent(filePath)}&collaborationDebug=1`,
    { waitUntil: 'domcontentloaded' });
  if (kind === 'rich') await page.getByRole('group', { name: 'Document view', exact: true })
    .getByRole('button', { name: 'Edit', exact: true }).click();
  const content = page.locator(kind === 'rich' ? '.tiptap-editor-shell .ProseMirror'
    : kind === 'code' ? '.cm-content' : '.markdown-editor-content');
  await expect(content).toBeVisible({ timeout: 60_000 });
  await expect(content).toContainText(marker);
  if (kind !== 'read') await expect(content).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  const sidebarToggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
}

async function moveUsingDialog(fixture: SharedFixture, filePath: string): Promise<WorkspacePathOperationPublic> {
  const dialog = await moveDialog(fixture.adminPage, filePath);
  const [response] = await Promise.all([
    fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
      && candidate.request().method() === 'POST'),
    dialog.getByRole('button', { name: 'Move', exact: true }).click(),
  ]);
  expect(response.ok(), `Move the exact owned fixture ${filePath}`).toBe(true);
  const result = await response.json() as WorkspacePathOperationResponse;
  expect(result.operation).toMatchObject({ workspaceId: fixture.workspaceId, kind: 'rename' });
  await waitApplied(fixture, result.operation);
  await expect(dialog).toBeHidden({ timeout: 90_000 });
  return result.operation;
}

async function richText(page: Page): Promise<string> {
  return page.locator('.tiptap-editor-shell .ProseMirror').evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.collaboration-carets__label').forEach((label) => label.remove());
    return copy.textContent || '';
  });
}

async function waitDurableContent(fixture: SharedFixture, filePath: string, markers: string[], deleted?: string) {
  await expect.poll(async () => {
    const document = await documentEvidence(fixture, fixture.admin, filePath);
    if (document.degraded || document.documentSequence !== document.checkpointSequence) return false;
    const evidence = await fixture.read(fixture.admin.request, filePath);
    return markers.every((marker) => evidence.content.split(marker).length === 2)
      && (!deleted || !evidence.content.includes(deleted));
  }, { timeout: 45_000, intervals: [500, 1000] }).toBe(true);
  const admin = await fixture.read(fixture.admin.request, filePath);
  const peer = await fixture.read(fixture.peer.request, filePath);
  expect(peer.content).toBe(admin.content);
  expect(peer.stats.sha256).toBe(admin.stats.sha256);
  expect(createHash('sha256').update(admin.content).digest('hex')).toBe(admin.stats.sha256);
  return admin;
}

test.describe('shared workspace HTML move safety', () => {
  test.setTimeout(240_000);

  for (const viewport of ['desktop', 'iphone'] as const) {
    test(`unrelated local HTML permits the reported nested move and Undo on ${viewport}`, async ({ browser }, info) => {
      await withSharedFixture(browser, async (fixture) => {
        const source = 'ek-fuchs-transkript.md';
        const destinationFolder = 'Koenenstrasse_8/WEG/Waermepumpe/Notizen';
        const destination = `${destinationFolder}/${source}`;
        const backlinks = `[Transkript](${source})\n`;
        const directory = await fixture.admin.request.post('/api/files/create', { headers: fixture.headers,
          data: { path: destinationFolder, type: 'directory' } });
        expect(directory.status(), 'Create the exact reported nested destination').toBe(200);
        await fixture.upload(source, originalContent);
        await fixture.upload('Verweise.md', backlinks);
        await fixture.upload(localHtmlPath, localHtmlContent);
        await uploadLocalImage(fixture);
        if (viewport === 'iphone') await fixture.adminPage.setViewportSize({ width: 390, height: 844 });
        await openOriginal(fixture.adminPage, fixture.workspaceId, source);
        await openOriginal(fixture.peerPage, fixture.workspaceId, source);
        const before = await documentEvidence(fixture, fixture.admin, source);
        for (const page of [fixture.adminPage, fixture.peerPage]) await assertHealthyClient(page, before);
        const origins = await Promise.all([fixture.adminPage, fixture.peerPage].map((page) => page.evaluate(() => performance.timeOrigin)));
        const dialog = await moveDialog(fixture.adminPage, source, destinationFolder);
        const [preview] = await Promise.all([
          fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
            && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun === true),
          dialog.getByRole('button', { name: 'Check again', exact: true }).click(),
        ]);
        expect(preview.status(), 'The unrelated local HTML reference does not block the actual UI preview').toBe(200);
        const previewBody = await preview.json();
        expect(previewBody).toMatchObject({ dryRun: true, requiresRevalidation: true, plan: { readiness: 'ready' } });
        await expect(dialog.getByTestId('workspace-move-preview')).toContainText('ready');
        await expect(dialog.getByTestId('workspace-move-operation-issues')).toHaveCount(0);
        const moveButton = dialog.getByRole('button', { name: 'Move', exact: true });
        await expect(moveButton).toBeEnabled();
        await moveButton.scrollIntoViewIfNeeded();
        if (viewport === 'iphone') {
          const bounds = await dialog.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
          await expect(moveButton).toBeInViewport();
        }
        await fixture.adminPage.screenshot({ path: info.outputPath(`unrelated-local-html-ready-${viewport}.png`), animations: 'disabled' });
        const [response] = await Promise.all([
          fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
            && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun !== true),
          moveButton.click(),
        ]);
        expect(response.ok(), 'The reported move succeeds while the HTML source remains unchanged').toBe(true);
        expect(response.request().postDataJSON()).toMatchObject({ oldPath: source, newPath: destination,
          planId: previewBody.plan.planId });
        const result = await response.json() as WorkspacePathOperationResponse;
        expect(result.operation).toMatchObject({ workspaceId: fixture.workspaceId, kind: 'rename' });
        await waitApplied(fixture, result.operation);
        await expect(dialog).toBeHidden({ timeout: 90_000 });
        await assertAbsent(fixture, source);
        await assertOriginal(fixture, destination);
        for (const context of [fixture.admin, fixture.peer]) {
          expect((await fixture.read(context.request, 'Verweise.md')).content).toBe(`[Transkript](${destination})\n`);
          const html = await fixture.read(context.request, localHtmlPath);
          expect(html.content).toBe(localHtmlContent);
          expect(html.stats.sha256).toBe(createHash('sha256').update(localHtmlContent).digest('hex'));
        }
        const after = await assertSameOpenDocuments(fixture, destination, before, origins);
        await fixture.adminPage.screenshot({ path: info.outputPath(`unrelated-local-html-moved-${viewport}.png`), animations: 'disabled' });
        const undo = await fixture.admin.request.post(`/api/files/operations/batches/${encodeURIComponent(result.operation.batchId)}`,
          { headers: fixture.headers, data: { action: 'undo', planId: result.operation.planId } });
        expect(undo.status(), 'Undo the exact reported move through the public operation API').toBe(202);
        const undone = (await undo.json() as WorkspacePathOperationResponse).operation;
        expect(undone).toMatchObject({ batchId: result.operation.batchId, planId: result.operation.planId,
          workspaceId: fixture.workspaceId });
        await waitApplied(fixture, undone, 'undone');
        await assertAbsent(fixture, destination);
        await assertOriginal(fixture, source);
        await assertSameOpenDocuments(fixture, source, before, origins);
        for (const context of [fixture.admin, fixture.peer]) {
          expect((await fixture.read(context.request, 'Verweise.md')).content).toBe(backlinks);
          expect((await fixture.read(context.request, localHtmlPath)).content).toBe(localHtmlContent);
        }
        await info.attach(`unrelated-local-html-${viewport}-evidence`, { contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ before, after, source, destination, batchId: result.operation.batchId,
            sha256: originalHash, htmlSha256: createHash('sha256').update(localHtmlContent).digest('hex'),
            viewport, undo: 'undone', reloaded: false }, null, 2)) });
      });
    });
  }

  test('moving a local HTML image or its referring document stays blocked with a precise diagnostic', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      await fixture.upload('unbeteiligt.md', originalContent);
      await fixture.upload(localHtmlPath, localHtmlContent);
      await uploadLocalImage(fixture);
      await openOriginal(fixture.adminPage, fixture.workspaceId, 'unbeteiligt.md');
      for (const source of [localImagePath, localHtmlPath]) {
        const dialog = await moveDialog(fixture.adminPage, source);
        const [response] = await Promise.all([
          fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
            && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun !== true),
          dialog.getByRole('button', { name: 'Move', exact: true }).click(),
        ]);
        expect(response.status(), `Moving ${source} changes the HTML link and remains protected`).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'PREVIEW_BLOCKED', operation: { workspaceId: fixture.workspaceId,
          status: 'blocked', completedActions: 0, issues: expect.arrayContaining([expect.objectContaining({
            code: 'affected-html-link', path: localHtmlPath, targetLiteral: localImagePath, line: 5,
          })]) } });
        const issues = dialog.getByTestId('workspace-move-operation-issues');
        await expect(issues).toContainText('This action affects a local HTML link.');
        await expect(issues).toContainText('Its file path cannot be updated safely yet.');
        await expect(issues).toContainText(`${localHtmlPath}:5`);
        await expect(issues).toContainText(localImagePath);
        await expect(issues.getByRole('button', { name: 'Open affected file', exact: true })).toBeVisible();
        await assertAbsent(fixture, `Ziel/${source}`);
        expect((await fixture.read(fixture.admin.request, localHtmlPath)).content).toBe(localHtmlContent);
        await fixture.adminPage.screenshot({ path: info.outputPath(`affected-html-${source.endsWith('.png') ? 'image' : 'source'}-blocked.png`),
          animations: 'disabled' });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(dialog).toBeHidden();
      }
    });
  });

  test('a peer changing an unrelated HTML target invalidates the checked move before apply', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      const source = 'ek-fuchs-transkript.md';
      await fixture.upload(source, originalContent);
      await fixture.upload(localHtmlPath, localHtmlContent);
      await uploadLocalImage(fixture);
      await openOriginal(fixture.adminPage, fixture.workspaceId, source);
      expect(fixture.peerPage.viewportSize(), 'The independent peer context keeps its explicit desktop viewport')
        .toEqual({ width: 1440, height: 1000 });
      await fixture.peerPage.goto(`/en/notebook?workspaceId=${encodeURIComponent(fixture.workspaceId)}&path=${encodeURIComponent(localHtmlPath)}`,
        { waitUntil: 'domcontentloaded' });
      const sourceButton = fixture.peerPage.getByRole('group', { name: 'Document view', exact: true })
        .getByRole('button', { name: 'Source', exact: true });
      await expect(sourceButton).toBeVisible({ timeout: 45_000 });
      await expect(sourceButton).toBeEnabled({ timeout: 45_000 });
      await sourceButton.click({ timeout: 45_000 });
      const sourceEditor = fixture.peerPage.locator('.cm-content');
      await expect(sourceEditor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      await expect(sourceEditor).toContainText(localImagePath);
      const dialog = await moveDialog(fixture.adminPage, source);
      const [preview] = await Promise.all([
        fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
          && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun === true),
        dialog.getByRole('button', { name: 'Check again', exact: true }).click(),
      ]);
      expect(preview.status()).toBe(200);
      const checked = await preview.json();
      expect(checked).toMatchObject({ dryRun: true, plan: { readiness: 'ready' } });
      await expect(dialog.getByTestId('workspace-move-preview')).toContainText('ready');
      const changedHtml = localHtmlContent.replace(`src="${localImagePath}"`, `src="${source}"`);
      await sourceEditor.click();
      await fixture.peerPage.keyboard.press('ControlOrMeta+A');
      await fixture.peerPage.keyboard.insertText(changedHtml);
      await expect(sourceEditor).toContainText(`src="${source}"`);
      await expect.poll(async () => (await fixture.read(fixture.peer.request, localHtmlPath)).content,
        { timeout: 45_000, intervals: [500, 1000] }).toBe(changedHtml);
      const [rejected] = await Promise.all([
        fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
          && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun !== true),
        dialog.getByRole('button', { name: 'Move', exact: true }).click(),
      ]);
      expect(rejected.request().postDataJSON()).toMatchObject({ oldPath: source, newPath: `Ziel/${source}`, planId: checked.plan.planId });
      expect(rejected.status(), 'The stale ready preview cannot approve the newly affected HTML target').toBe(409);
      expect(await rejected.json()).toMatchObject({ code: 'PREVIEW_STALE' });
      await expect(dialog.getByRole('alert')).toHaveText('Files changed since the preview. Check the links again.');
      await assertOriginal(fixture, source);
      await assertAbsent(fixture, `Ziel/${source}`);
      expect((await fixture.read(fixture.admin.request, localHtmlPath)).content).toBe(changedHtml);
      const [freshPreview] = await Promise.all([
        fixture.adminPage.waitForResponse((candidate) => new URL(candidate.url()).pathname === '/api/files/rename'
          && candidate.request().method() === 'POST' && candidate.request().postDataJSON().dryRun === true),
        dialog.getByRole('button', { name: 'Check again', exact: true }).click(),
      ]);
      expect(freshPreview.status()).toBe(200);
      const fresh = await freshPreview.json();
      expect(fresh.plan.planId).not.toBe(checked.plan.planId);
      expect(fresh.plan.readiness).toBe('blocked');
      await expect(dialog.getByTestId('workspace-move-preview')).toContainText('blocked');
      await assertOriginal(fixture, source);
      await assertAbsent(fixture, `Ziel/${source}`);
      await fixture.adminPage.screenshot({ path: info.outputPath('peer-html-target-stale-preview.png'), animations: 'disabled' });
    });
  });

  test('external HTML permits a move, updates Markdown backlinks and preserves both users documents', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      await fixture.upload('transkript.md', originalContent);
      const backlinks = '[Transkript](transkript.md)\n\n![Externes Markdown-Bild](https://example.com/fixture.svg)\n';
      await fixture.upload('Verweise.md', backlinks);
      const externalHtml = '<img src="https://example.com/fixture.svg" alt="Externes Testbild" width="320" height="160">\n';
      await fixture.upload('Bild.md', externalHtml);
      await openOriginal(fixture.adminPage, fixture.workspaceId, 'transkript.md');
      await openOriginal(fixture.peerPage, fixture.workspaceId, 'transkript.md');
      const before = await documentEvidence(fixture, fixture.admin, 'transkript.md');
      for (const page of [fixture.adminPage, fixture.peerPage]) await assertHealthyClient(page, before);
      const origins = await Promise.all([fixture.adminPage, fixture.peerPage].map((page) => page.evaluate(() => performance.timeOrigin)));
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
      }
      const after = await assertSameOpenDocuments(fixture, 'Ziel/transkript.md', before, origins);
      await info.attach('same-document-move-evidence', { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ before, after, sha256: originalHash, reloaded: false }, null, 2)) });
      await fixture.adminPage.screenshot({ path: info.outputPath('shared-external-html-move.png'), animations: 'disabled' });
    });
  });

  test('accepted concurrent rich insertions and a deletion survive a move without reloading either editor', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      const filePath = 'gemeinsam.md';
      const deleted = 'Entfernen: Platzhalter';
      await fixture.upload(filePath, `# Zusammenarbeit\n\nAdmin: Anfang\n\nPeer: Anfang\n\n${deleted}\n`);
      await openSharedDocument(fixture.adminPage, fixture, filePath, 'Admin: Anfang');
      await openSharedDocument(fixture.peerPage, fixture, filePath, 'Peer: Anfang');
      const before = await documentEvidence(fixture, fixture.admin, filePath);
      for (const page of [fixture.adminPage, fixture.peerPage]) await assertHealthyClient(page, before);
      const origins = await Promise.all([fixture.adminPage, fixture.peerPage].map((page) => page.evaluate(() => performance.timeOrigin)));
      const adminMarker = ` ADMIN-${randomUUID()}`;
      const peerMarker = ` PEER-${randomUUID()}`;
      for (const [page, paragraph] of [[fixture.adminPage, 'Admin: Anfang'], [fixture.peerPage, 'Peer: Anfang']] as const) {
        await page.locator('.tiptap-editor-shell .ProseMirror').getByText(paragraph, { exact: true }).click({ position: { x: 12, y: 8 } });
        await page.keyboard.press('End');
      }
      await Promise.all([fixture.adminPage.keyboard.insertText(adminMarker), fixture.peerPage.keyboard.insertText(peerMarker)]);
      // Only text observed in the actual editable DOM is counted as accepted input.
      await expect(fixture.adminPage.locator('.tiptap-editor-shell .ProseMirror')).toContainText(adminMarker.trim());
      await expect(fixture.peerPage.locator('.tiptap-editor-shell .ProseMirror')).toContainText(peerMarker.trim());
      const removed = fixture.peerPage.locator('.tiptap-editor-shell .ProseMirror').getByText(deleted, { exact: true });
      await removed.click({ position: { x: 12, y: 8 } });
      await removed.evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      });
      expect(await fixture.peerPage.evaluate(() => window.getSelection()?.toString())).toBe(deleted);
      await fixture.peerPage.keyboard.press('Backspace');
      await expect(fixture.peerPage.locator('.tiptap-editor-shell .ProseMirror')).not.toContainText(deleted);
      // Do not wait for persistence: the tracked mutation must drain accepted Yjs updates safely.
      const moved = await fixture.admin.request.post('/api/files/rename', { headers: fixture.headers,
        data: { oldPath: filePath, newPath: `Ziel/${filePath}` } });
      expect(moved.ok(), 'Move alongside accepted collaboration updates').toBe(true);
      const operation = (await moved.json() as WorkspacePathOperationResponse).operation;
      expect(operation.workspaceId).toBe(fixture.workspaceId);
      await waitApplied(fixture, operation);
      await assertAbsent(fixture, filePath);
      const saved = await waitDurableContent(fixture, `Ziel/${filePath}`, [adminMarker, peerMarker], deleted);
      const after = await assertSameOpenDocuments(fixture, `Ziel/${filePath}`, before, origins, false);
      expect(after[0].documentSequence).toBeGreaterThan(before.documentSequence ?? -1);
      await expect.poll(async () => (await richText(fixture.adminPage)) === (await richText(fixture.peerPage)),
        { timeout: 30_000 }).toBe(true);
      for (const page of [fixture.adminPage, fixture.peerPage]) {
        expect(await richText(page)).toContain(adminMarker);
        expect(await richText(page)).toContain(peerMarker);
        expect(await richText(page)).not.toContain(deleted);
      }
      // A new accepted edit after relocation proves that recovery restored real write access.
      const resumed = ` FORTSETZUNG-${randomUUID()}`;
      await fixture.peerPage.locator('.tiptap-editor-shell .ProseMirror').getByText(`Peer: Anfang${peerMarker}`, { exact: true })
        .click({ position: { x: 12, y: 8 } });
      await fixture.peerPage.keyboard.press('End');
      await fixture.peerPage.keyboard.insertText(resumed);
      await expect(fixture.peerPage.locator('.tiptap-editor-shell .ProseMirror')).toContainText(resumed.trim());
      const final = await waitDurableContent(fixture, `Ziel/${filePath}`, [adminMarker, peerMarker, resumed], deleted);
      await assertSameOpenDocuments(fixture, `Ziel/${filePath}`, before, origins, false);
      await info.attach('accepted-rich-move-evidence', { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ before, after, accepted: [adminMarker, peerMarker, resumed], deleted,
          beforeResumedSha256: saved.stats.sha256, finalSha256: final.stats.sha256, reloaded: false }, null, 2)) });
    });
  });

  test('directory move and public Undo keep both open rich editors usable and restore backlinks', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      const directory = await fixture.admin.request.post('/api/files/create', { headers: fixture.headers,
        data: { path: 'Quelle', type: 'directory' } });
      expect(directory.status()).toBe(200);
      const source = 'Quelle/notiz.md';
      const destination = 'Ziel/Quelle/notiz.md';
      const backlinks = '[Notiz](Quelle/notiz.md)\n';
      await fixture.upload(source, originalContent);
      await fixture.upload('Quelle/details.txt', 'Unbeteiligte Unterdatei\n');
      await fixture.upload('Verzeichnis-Verweise.md', backlinks);
      await openOriginal(fixture.adminPage, fixture.workspaceId, source);
      await openOriginal(fixture.peerPage, fixture.workspaceId, source);
      const before = await documentEvidence(fixture, fixture.admin, source);
      for (const page of [fixture.adminPage, fixture.peerPage]) await assertHealthyClient(page, before);
      const origins = await Promise.all([fixture.adminPage, fixture.peerPage].map((page) => page.evaluate(() => performance.timeOrigin)));
      const operation = await moveUsingDialog(fixture, 'Quelle');
      await assertAbsent(fixture, source);
      await assertOriginal(fixture, destination);
      await assertSameOpenDocuments(fixture, destination, before, origins);
      for (const context of [fixture.admin, fixture.peer]) {
        expect((await fixture.read(context.request, 'Verzeichnis-Verweise.md')).content).toBe('[Notiz](Ziel/Quelle/notiz.md)\n');
        expect((await fixture.read(context.request, 'Ziel/Quelle/details.txt')).content).toBe('Unbeteiligte Unterdatei\n');
      }
      const undo = await fixture.admin.request.post(`/api/files/operations/batches/${encodeURIComponent(operation.batchId)}`,
        { headers: fixture.headers, data: { action: 'undo', planId: operation.planId } });
      expect(undo.status(), 'Undo the exact owned tracked directory move').toBe(202);
      const undone = (await undo.json() as WorkspacePathOperationResponse).operation;
      expect(undone).toMatchObject({ batchId: operation.batchId, planId: operation.planId, workspaceId: fixture.workspaceId });
      await waitApplied(fixture, undone, 'undone');
      await assertAbsent(fixture, destination);
      await assertOriginal(fixture, source);
      const restored = await assertSameOpenDocuments(fixture, source, before, origins);
      for (const context of [fixture.admin, fixture.peer]) {
        expect((await fixture.read(context.request, 'Verzeichnis-Verweise.md')).content).toBe(backlinks);
        expect((await fixture.read(context.request, 'Quelle/details.txt')).content).toBe('Unbeteiligte Unterdatei\n');
      }
      await info.attach('directory-move-undo-evidence', { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ before, restored, batchId: operation.batchId, sha256: originalHash, reloaded: false }, null, 2)) });
    });
  });

  test('plain-text code editors recover the same document after a move and can continue writing', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      const source = 'quelltext.txt';
      const content = 'Erste Zeile\nZweite Zeile\n';
      await fixture.upload(source, content);
      await openSharedDocument(fixture.adminPage, fixture, source, 'Erste Zeile', 'code');
      await openSharedDocument(fixture.peerPage, fixture, source, 'Zweite Zeile', 'code');
      const before = await documentEvidence(fixture, fixture.admin, source);
      expect(before.representation).toBe('plain_text');
      for (const page of [fixture.adminPage, fixture.peerPage]) await assertHealthyClient(page, before);
      const origins = await Promise.all([fixture.adminPage, fixture.peerPage].map((page) => page.evaluate(() => performance.timeOrigin)));
      await moveUsingDialog(fixture, source);
      await assertAbsent(fixture, source);
      for (const context of [fixture.admin, fixture.peer]) expect((await fixture.read(context.request, `Ziel/${source}`)).content).toBe(content);
      await assertSameOpenDocuments(fixture, `Ziel/${source}`, before, origins);
      const marker = `CODE-${randomUUID()}`;
      await fixture.peerPage.locator('.cm-content').click({ position: { x: 12, y: 8 } });
      await fixture.peerPage.keyboard.press('ControlOrMeta+End');
      await fixture.peerPage.keyboard.insertText(marker);
      await expect(fixture.peerPage.locator('.cm-content')).toContainText(marker);
      const saved = await waitDurableContent(fixture, `Ziel/${source}`, [marker]);
      expect(saved.content).toBe(content + marker);
      await expect(fixture.adminPage.locator('.cm-content')).toContainText(marker);
      const after = await assertSameOpenDocuments(fixture, `Ziel/${source}`, before, origins, false);
      await info.attach('plain-text-move-evidence', { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ before, after, sha256: saved.stats.sha256, reloaded: false }, null, 2)) });
    });
  });

  test('moving a shared document retains a freshly authorized members read-only access', async ({ browser }, info) => {
    await withSharedFixture(browser, async (fixture) => {
      const source = 'leserecht.md';
      await fixture.upload(source, originalContent);
      await openOriginal(fixture.adminPage, fixture.workspaceId, source);
      const membership = await fixture.admin.request.post(`/api/workspaces/${fixture.workspaceId}/members`, {
        data: { userId: fixture.peerUserId, role: 'member', canRead: true, canWrite: false, canManage: false },
      });
      expect(membership.status(), 'Restrict only the member in the exact owned workspace').toBe(200);
      expect((await membership.json()).success).toBe(true);
      await runManagedTestPreflight(fixture.peer, { workspaceId: fixture.workspaceId, requireWorkspacePermission: 'read' });
      expect(await ownWorkspace(fixture.peer.request, fixture.workspaceId)).toMatchObject({ id: fixture.workspaceId,
        permissions: { canRead: true, canWrite: false, canDelete: false } });
      // Open with the actual new read permission before moving, rather than retaining an old write ticket.
      await openSharedDocument(fixture.peerPage, fixture, source, 'Originaler Inhalt', 'read');
      const before = await documentEvidence(fixture, fixture.admin, source);
      expect((await documentEvidence(fixture, fixture.peer, source)).permission).toBe('read');
      await assertHealthyClient(fixture.adminPage, before);
      await assertHealthyClient(fixture.peerPage, before, 'read');
      const origins = await Promise.all([fixture.adminPage, fixture.peerPage].map((page) => page.evaluate(() => performance.timeOrigin)));
      await moveUsingDialog(fixture, source);
      await assertAbsent(fixture, source);
      await assertOriginal(fixture, `Ziel/${source}`);
      const after = await assertSameOpenDocuments(fixture, `Ziel/${source}`, before, origins, true, 'read');
      await expect(fixture.peerPage.locator('.markdown-editor-content')).toContainText('Originaler Inhalt');
      const forbidden = await fixture.peer.request.post('/api/files/rename', { headers: fixture.headers,
        data: { oldPath: `Ziel/${source}`, newPath: 'unerlaubt.md' } });
      expect(forbidden.status(), 'A move never elevates the members structural permission').toBe(403);
      await assertAbsent(fixture, 'unerlaubt.md');
      await assertOriginal(fixture, `Ziel/${source}`);
      await info.attach('read-only-move-evidence', { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ before, after, forbiddenStatus: forbidden.status(), sha256: originalHash, reloaded: false }, null, 2)) });
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
          issues: expect.arrayContaining([expect.objectContaining({ code: 'affected-html-link', path: issueFile,
            targetLiteral: source })]) } });
        const issues = dialog.getByTestId('workspace-move-operation-issues');
        await expect(issues).toBeVisible();
        await expect(issues).toContainText(issueFile);
        await expect(issues).toContainText('affected-html-link');
        await expect(issues).toContainText(source);
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
