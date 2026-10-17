import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES, COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import type { WorkspaceOperationNativeCopyPreviewPublic } from '../app/lib/files/workspace-operation-native-copy-public';
import { requireOwnedYjsQaTarget, type OwnedYjsReceipt } from '../scripts/lib/owned-yjs-authority-qa';
import { ownedNativeFileRoomReceiptIdentity } from '../scripts/lib/owned-yjs-native-delete-links-room-target';
import type { OwnedRestartRoomEvidence } from '../scripts/lib/owned-yjs-restart-room-read';
import { assertCompletedWorkspaceMarkdownCreate, createAuthenticatedContext } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { prepareDestinationTreeRequestBudget, waitForDestinationFileTreeBudget } from './helpers/destination-tree-request-budget';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { nativeRichParagraph } from './helpers/native-rich-paragraph';
import { aggregateOwnedNativeErrors, runOwnedNativeCommand } from './helpers/owned-native-command';
import { observeOwnedCopyFiles } from './helpers/owned-copy-files-observer';
import type { OwnedCopyB2FaultInput } from '../scripts/lib/owned-yjs-native-copy-b2-fault';

const spec = 'tests/workspace-operation-native-copy.spec.ts', selector = '.tiptap-editor-shell .ProseMirror';
const profiles = [{ name: 'desktop', viewport: { width: 1440, height: 960 }, mobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true }] as const;
type Profile = typeof profiles[number];
type NativeSession = { success: boolean; provider: string; documentId: string; lifecycleGeneration: number;
  documentSequence: number; representation: string; schemaVersion: number; stateProof: string; stateVector: string; degraded: boolean };
type Workspace = { id: string; name: string; type: string; permissions: { canManageWorkspace: boolean } };
type Fixture = { owned: OwnedYjsReceipt; context: BrowserContext; contexts: BrowserContext[]; workspaces: Workspace[]; profile: Profile };
type Operation = { operationId: string; planId: string; status: string; errorCode: string | null; completedSteps: string[]; pendingSteps: string[] };
const fileName = () => `owned-yjs-restart-${randomUUID()}.md`;
const folderName = () => `owned-yjs-restart-${randomUUID()}`;
const headers = (workspaceId: string) => ({ 'x-canvas-workspace-id': workspaceId });
const version = (value: NativeSession) => ({ documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration,
  documentSequence: value.documentSequence, stateProof: value.stateProof, stateVector: value.stateVector });

function privateFieldsAbsent(value: unknown): void {
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    expect(['origin', 'requestJson', 'request_json', 'actor', 'actorId', 'actorUserId', 'actorSessionId', 'sessionId',
      'sourceScope', 'destinationScope', 'sourceEvidence', 'destinationEvidence', 'nativePathPlan', 'cloneRequirements',
      'rootPath', 'rootRelativePath', 'documentId', 'lineageId', 'reference', 'startAnchor', 'endAnchor', 'targetRange',
      'yjsState', 'stateVector', 'previewContents', 'originalDocuments', 'private_result', 'requestFingerprint']).not.toContain(key);
    privateFieldsAbsent(child);
  }
}
async function session(request: APIRequestContext, workspaceId: string, file: string): Promise<NativeSession> {
  const response = await request.post('/api/files/collaboration/session', { headers: headers(workspaceId),
    data: { path: file, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES } });
  expect(response.status()).toBe(200); const value = await response.json() as NativeSession;
  expect(value).toMatchObject({ success: true, provider: 'yjs', representation: 'tiptap_blocks', degraded: false, schemaVersion: COLLABORATION_SCHEMA_VERSION });
  expect(value.documentId).toBeTruthy(); expect(value.lifecycleGeneration).toBeGreaterThan(0);
  expect(value.stateProof).toMatch(/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u); expect(value.stateVector).toBeTruthy(); return value;
}
async function room(f: Fixture, workspaceId: string, file: string, expected: NativeSession): Promise<OwnedRestartRoomEvidence> {
  const owned = f.owned, wire = Buffer.from(JSON.stringify({ version: 1,
    target: { nonce: owned.nonce, repo: owned.repo, head: owned.head, sourceFingerprint: owned.sourceFingerprint,
      buildFingerprint: owned.buildFingerprint, buildId: owned.buildId, receiptIdentity: ownedNativeFileRoomReceiptIdentity(owned) },
    room: { documentId: expected.documentId, path: file, generation: expected.lifecycleGeneration, expectedWorkspaceId: workspaceId },
    expectedSession: { documentSequence: expected.documentSequence, stateProof: expected.stateProof, stateVector: expected.stateVector },
  })).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx',
    'scripts/owned-yjs-native-copy-room-read.ts', wire], { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(result.stdout) as OwnedRestartRoomEvidence;
}
async function released(f: Fixture, workspaceId: string, file: string, expected: NativeSession): Promise<void> {
  await expect.poll(async () => (await room(f, workspaceId, file, expected)).released,
    { timeout: 40_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  expect(await room(f, workspaceId, file, expected)).toMatchObject({ ownerTupleCleared: true, advisoryLockHeld: false,
    releaseReceiptValid: true, admissionPending: false, released: true });
}
async function closeAndRelease(page: Page, f: Fixture, workspaceId: string, file: string, expected: NativeSession) {
  expect(await room(f, workspaceId, file, expected)).toMatchObject({ ownerTupleComplete: true, advisoryLockHeld: true, released: false });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(page.locator(selector)).toHaveCount(0); await released(f, workspaceId, file, expected);
}
async function persisted(page: Page, workspaceId: string, file: string, initial: NativeSession) {
  const candidate = await readNativeRichCandidate(page, selector); let current: NativeSession | undefined;
  await expect.poll(async () => {
    current = await session(page.request, workspaceId, file); return { documentId: current.documentId,
      generation: current.lifecycleGeneration, proof: current.stateProof, vector: current.stateVector };
  }, { timeout: 40_000 }).toEqual({ documentId: initial.documentId, generation: initial.lifecycleGeneration,
    proof: candidate.stateProof, vector: candidate.stateVector });
  return { candidate, session: current! };
}
async function open(page: Page, workspaceId: string, file: string) {
  await page.goto(`/en/notebook?workspaceId=${workspaceId}&path=${encodeURIComponent(file)}`);
  await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
}
async function createInUi(page: Page, workspaceId: string, file: string) {
  await page.goto(`/en?workspaceId=${workspaceId}`);
  await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New note', exact: true });
  await dialog.getByLabel('Note name', { exact: true }).fill(path.posix.basename(file));
  const directory = path.posix.dirname(file);
  if (directory !== '.') {
    await dialog.getByText('Choose another folder', { exact: true }).click();
    const destination = dialog.getByTitle(directory, { exact: true }); await destination.click();
    await expect(destination).toHaveAttribute('aria-pressed', 'true');
  }
  await waitForFileCreateBudget();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
    && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspaceId
    && response.request().postDataJSON()?.path === file);
  await dialog.getByRole('button', { name: 'Create and open', exact: true }).click(); const response = await created;
  await assertCompletedWorkspaceMarkdownCreate(response, { requestId: response.request().postDataJSON().requestId, workspaceId, targetPath: file });
  await expect(dialog).toHaveCount(0); await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.locator(selector)).toHaveText(''); return session(page.request, workspaceId, file);
}
async function pasteMarkdown(page: Page, f: Fixture, markdown: string) {
  const title = 'Insert Markdown…';
  if (f.profile.mobile) {
    await page.locator(selector).tap(); await page.setViewportSize({ width: 390, height: 544 });
    await page.getByRole('button', { name: title, exact: true }).filter({ visible: true }).tap();
  } else { await page.getByTestId('markdown-toolbar-insert').click(); await page.getByRole('menuitem', { name: title, exact: true }).click(); }
  const dialog = page.getByRole('dialog', { name: title, exact: true }), field = dialog.getByRole('textbox', { name: 'Markdown', exact: true });
  await field.focus(); await page.evaluate(value => navigator.clipboard.writeText(value), markdown);
  await page.keyboard.press('ControlOrMeta+v'); await expect(field).toHaveValue(markdown);
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click(); await expect(dialog).toHaveCount(0);
  if (f.profile.mobile) await page.setViewportSize(f.profile.viewport);
}
function semanticDocument(document: JSONContent, replacements: Record<string, string> = {}) {
  const result = structuredClone(document);
  const visit = (node: JSONContent) => {
    // Only block IDs are freshly minted by native Clone. Every other node,
    // attribute, mark and literal remains part of this equality assertion.
    if (node.attrs && Object.hasOwn(node.attrs, 'id')) delete node.attrs.id;
    for (const mark of node.marks ?? []) if (mark.type === 'link' && typeof mark.attrs?.href === 'string'
      && Object.hasOwn(replacements, mark.attrs.href)) mark.attrs.href = replacements[mark.attrs.href];
    for (const child of node.content ?? []) visit(child);
  }; visit(result); return result;
}
function blockIds(document: JSONContent): string[] {
  const ids: string[] = []; const visit = (node: JSONContent) => {
    if (typeof node.attrs?.id === 'string') ids.push(node.attrs.id);
    for (const child of node.content ?? []) visit(child);
  }; visit(document); expect(ids.length).toBeGreaterThan(0); expect(new Set(ids).size).toBe(ids.length); return ids;
}
async function freshContext(browser: Browser, f: Fixture, workspaceId: string, newLogin = false) {
  const context = await browser.newContext({ baseURL: process.env.BASE_URL, viewport: f.profile.viewport,
    hasTouch: f.profile.mobile, isMobile: f.profile.mobile,
    ...(newLogin ? {} : { storageState: { cookies: await f.context.cookies(), origins: [] } }) });
  f.contexts.push(context);
  if (newLogin) {
    const email = process.env.TEST_LOGIN_EMAIL, password = process.env.TEST_LOGIN_PASSWORD; expect(Boolean(email && password)).toBe(true);
    const response = await context.request.post('/api/auth/sign-in/email', { timeout: 15_000,
      headers: { Origin: process.env.BASE_URL! }, data: { email, password } }); expect(response.status()).toBe(200);
  }
  await context.addInitScript(({ id, mobile }) => {
    localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
    localStorage.setItem('canvas-browser-mode', mobile ? 'list' : 'tree');
  }, { id: workspaceId, mobile: f.profile.mobile });
  return context;
}
async function loginIdentity(request: APIRequestContext) {
  const response = await request.get('/api/auth/get-session'); expect(response.status()).toBe(200);
  const body = await response.json() as { user: { id: string }; session: { id: string; userId: string } };
  expect(body.session.userId).toBe(body.user.id); expect(body.session.id).toBeTruthy(); return { userId: body.user.id, sessionId: body.session.id };
}
async function children(request: APIRequestContext, workspaceId: string, directory: string) {
  await waitForDestinationFileTreeBudget();
  const response = await request.get('/api/files/tree', { headers: headers(workspaceId), params: { path: directory, depth: '6', noCache: '1' } });
  expect(response.status()).toBe(200); const body = await response.json() as { data: Array<{ path: string; children?: unknown[] }> };
  const paths: string[] = []; const visit = (nodes: typeof body.data) => { for (const node of nodes) {
    paths.push(node.path); if (node.children) visit(node.children as typeof body.data);
  } }; visit(body.data); return paths.sort();
}
async function bytes(request: APIRequestContext, workspaceId: string, file: string, expected: Buffer) {
  const response = await request.get('/api/files/download', { headers: headers(workspaceId), params: { path: file } });
  expect(response.status()).toBe(200); expect(await response.body()).toEqual(expected);
}
async function status(request: APIRequestContext, operation: Operation) {
  const response = await request.get(`/api/files/operations/${operation.operationId}`); expect(response.status()).toBe(200);
  const body = await response.json(); privateFieldsAbsent(body);
  expect(body.operation).toMatchObject({ operationId: operation.operationId, planId: operation.planId,
    kind: 'copy', status: 'completed', phase: 'completed', errorCode: null });
  expect(body.operation.steps.length).toBeGreaterThan(0);
  expect(body.operation.steps.every((step: { status: string }) => step.status === 'applied')).toBe(true); return body;
}
async function copyInUi(page: Page, f: Fixture, sourceId: string, targetId: string, sourcePath: string,
  directory: string, createDirectory: boolean, links: number, info: TestInfo,
  recovery?: { beforeApply: (preview: WorkspaceOperationNativeCopyPreviewPublic) => Promise<void> }) {
  await page.goto(`/en/files?workspaceId=${sourceId}`);
  const row = page.locator(`[data-file-path="${sourcePath}"]`).filter({ visible: true }).first(); await expect(row).toBeVisible(); await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Copy to workspace', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy to workspace', exact: true });
  await dialog.getByRole('combobox', { name: 'Target workspace', exact: true }).selectOption(targetId);
  if (createDirectory) {
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click(); await dialog.getByLabel('New folder name', { exact: true }).fill(directory);
    await waitForFileCreateBudget(); const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
      && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === targetId
      && response.request().postDataJSON()?.path === directory && response.request().postDataJSON()?.type === 'directory');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click(); expect((await created).status()).toBe(200);
  } else await dialog.getByRole('button', { name: directory === '.' ? '/ (root)' : directory, exact: true }).click();
  await expect(dialog.getByRole('button', { name: directory === '.' ? '/ (root)' : directory, exact: true })).toHaveAttribute('aria-pressed', 'true');
  const matches = (response: { url(): string; request(): { method(): string; postDataJSON(): Record<string, unknown> } }, dryRun: boolean) => {
    if (new URL(response.url()).pathname !== '/api/files/copy' || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON(); return body.dryRun === (dryRun ? true : undefined)
      && body.sourceWorkspaceId === sourceId && body.targetWorkspaceId === targetId && body.destDir === directory
      && JSON.stringify(body.sources) === JSON.stringify([sourcePath]);
  };
  const previewResponse = page.waitForResponse(response => matches(response, true));
  await dialog.getByRole('button', { name: 'Preview links', exact: true }).click(); const response = await previewResponse; expect(response.status()).toBe(200);
  const preview = await response.json() as { success: boolean; dryRun: true; requiresRevalidation: true; plan: WorkspaceOperationNativeCopyPreviewPublic };
  privateFieldsAbsent(preview); expect(preview).toMatchObject({ success: true, dryRun: true, requiresRevalidation: true,
    plan: { version: 4, kind: 'native-copy', sourceWorkspaceId: sourceId, destinationWorkspaceId: targetId, readiness: 'ready', issues: [] } });
  expect(preview.plan.planId).toMatch(/^[a-f0-9]{64}$/u); expect(preview.plan.linkEdits).toHaveLength(links);
  expect(preview.plan.pathMappings.find(mapping => mapping.sourcePath === sourcePath)?.destinationPath)
    .toBe(directory === '.' ? sourcePath : `${directory}/${path.posix.basename(sourcePath)}`);
  await expect(dialog.getByRole('status').filter({ hasText: 'Preview readiness: ready' })).toBeVisible();
  const bounds = await dialog.boundingBox(); expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(f.profile.viewport.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await dialog.screenshot({ path: info.outputPath('native-copy-v4-preview.png'), animations: 'disabled' });
  if (recovery) await recovery.beforeApply(preview.plan);
  const copied = page.waitForResponse(reply => matches(reply, false), { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click(); const applied = await copied; expect(applied.status()).toBe(200);
  expect(applied.request().postDataJSON().planId).toBe(preview.plan.planId);
  const body = await applied.json(); privateFieldsAbsent(body);
  if (recovery) {
    expect(body).toMatchObject({ success: true, copied: [], failed: [], skipped: [], linkStatus: 'partial', updatedLinks: 0,
      operation: { planId: preview.plan.planId, status: 'needs_recovery', errorCode: 'NATIVE_COPY_PUBLICATION_UNCONFIRMED' } });
    expect(body.operation.pendingSteps.length).toBeGreaterThan(0);
  } else expect(body).toMatchObject({ success: true, failed: [], skipped: [], linkStatus: 'complete', updatedLinks: links,
    operation: { planId: preview.plan.planId, status: 'complete', pendingSteps: [], errorCode: null } });
  expect(body.operation.operationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u);
  if (recovery) await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden({ timeout: 90_000 }); return { operation: body.operation as Operation, preview: preview.plan };
}
async function copyB2Fault(input: OwnedCopyB2FaultInput) {
  const wire = Buffer.from(JSON.stringify(input)).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx',
    'scripts/owned-yjs-native-copy-b2-fault.ts', wire], { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(result.stdout) as { armed?: boolean; faultId?: string; removed?: boolean; fired?: boolean; matchingAttempts?: string };
}
async function withNativeCopyBrowserFixture(browser: Browser, profile: Profile, count: number, run: (fixture: Fixture) => Promise<void>) {
  const owned = await requireOwnedYjsQaTarget(); expect(owned.activeSpec).toBe(spec);
  const context = await createAuthenticatedContext(browser, { viewport: profile.viewport, isMobile: profile.mobile, hasTouch: profile.mobile });
  const f: Fixture = { owned, context, contexts: [context], workspaces: [], profile }; let failed = false, primary: unknown;
  const cleanup: unknown[] = [];
  try {
    await prepareDestinationTreeRequestBudget(context); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    for (let index = 0; index < count; index++) {
      const name = `Copy ${profile.name} ${index} ${randomUUID().slice(0, 8)}`;
      const response = await context.request.post('/api/workspaces', { data: { type: 'personal', name } }); const body = await response.json();
      if (body.workspace?.id) f.workspaces.push(body.workspace); expect(response.status()).toBe(201);
      expect(body.workspace).toMatchObject({ name, type: 'personal', permissions: { canManageWorkspace: true } });
      expect(body.starterDocumentInitialization.status).toBe('completed');
    }
    const availability = await context.request.get('/api/document-review/availability'); expect(availability.status()).toBe(200);
    expect((await availability.json()).data.documentReviewEnabled).toBe(false);
    await context.addInitScript(({ id, mobile }) => {
      localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
      localStorage.setItem('canvas-browser-mode', mobile ? 'list' : 'tree');
    }, { id: f.workspaces[0].id, mobile: profile.mobile });
    await run(f);
  } catch (error) { failed = true; primary = error; }
  finally {
    for (const held of f.contexts) for (const page of held.pages()) try { await page.close(); } catch (error) { cleanup.push(error); }
    for (const space of [...f.workspaces].reverse()) try {
      const listed = await context.request.get('/api/workspaces'); expect(listed.status()).toBe(200);
      expect((await listed.json()).workspaces.find((value: Workspace) => value.id === space.id)).toMatchObject({
        id: space.id, name: space.name, type: 'personal', permissions: { canManageWorkspace: true } });
      expect((await context.request.delete(`/api/workspaces/${space.id}`)).status()).toBe(200);
    } catch (error) { cleanup.push(error); }
    for (const held of [...f.contexts].reverse()) try { await held.close(); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw aggregateOwnedNativeErrors(failed ? primary : undefined, cleanup, 'Owned native Copy browser fixture cleanup failed.');
  if (failed) throw primary;
}

test.describe('owned native Copy through V4 preview, rich editor and original completed receipts', () => {
  test.describe.configure({ retries: 0 }); test.setTimeout(300_000);
  for (const profile of profiles) {
    test(`${profile.name}: rich manual note copy rewrites relative Keep link and isolates later clone edits`, async ({ browser }, info) => {
      await withNativeCopyBrowserFixture(browser, profile, 1, async f => {
        const workspaceId = f.workspaces[0].id, page = await f.context.newPage(), source = fileName(), keep = fileName(), backlink = fileName(), folder = folderName();
        const before: Record<string, Awaited<ReturnType<typeof persisted>>> = {};
        await test.step('create native notes manually, paste Markdown and prove durable room release', async () => {
          for (const [file, markdown] of [[keep, '# Keep target\n\nKeep remains original.\n'],
            [source, `# Original rich copy\n\n[Keep](${keep})\n\n| Key | Value |\n| --- | --- |\n| Alpha | Beta |\n\nClone paragraph.\n`],
            [backlink, `# Original backlink\n\n[Source](${source})\n`]]) {
            const initial = await createInUi(page, workspaceId, file); await pasteMarkdown(page, f, markdown);
            before[file] = await persisted(page, workspaceId, file, initial); await closeAndRelease(page, f, workspaceId, file, before[file].session);
          }
        });
        const copiedPath = `${folder}/${source}`;
        const { operation, preview } = await copyInUi(page, f, workspaceId, workspaceId, source, folder, true, 1, info);
        expect(preview.linkEdits).toEqual([{ sourcePathBefore: source, sourcePathAfter: copiedPath,
          previousTargetLiteral: keep, nextTargetLiteral: `../${keep}` }]);
        const clone = await session(page.request, workspaceId, copiedPath); expect(clone.documentId).not.toBe(before[source].session.documentId);
        expect(clone.documentSequence).toBe(1);
        for (const file of [source, keep, backlink]) expect(version(await session(page.request, workspaceId, file))).toEqual(version(before[file].session));
        const fresh = await freshContext(browser, f, workspaceId), reopened = await fresh.newPage(); await open(reopened, workspaceId, copiedPath);
        const actual = await readNativeRichCandidate(reopened, selector);
        expect(semanticDocument(actual.document)).toEqual(semanticDocument(before[source].candidate.document, { [keep]: `../${keep}` }));
        expect(actual.stateProof).toBe(clone.stateProof); expect(actual.stateVector).toBe(clone.stateVector);
        expect(blockIds(actual.document).every(id => !blockIds(before[source].candidate.document).includes(id))).toBe(true);
        await (await nativeRichParagraph(reopened, selector, 'Clone paragraph.')).click(); await reopened.keyboard.press('End');
        await reopened.keyboard.insertText(' Clone-only change.'); const edited = await persisted(reopened, workspaceId, copiedPath, clone);
        expect(edited.session.stateProof).not.toBe(clone.stateProof); await reopened.screenshot({ path: info.outputPath('native-copy-clone-only-edit.png'), animations: 'disabled' });
        await closeAndRelease(reopened, f, workspaceId, copiedPath, edited.session);
        await open(reopened, workspaceId, source); expect((await readNativeRichCandidate(reopened, selector)).document).toEqual(before[source].candidate.document);
        await closeAndRelease(reopened, f, workspaceId, source, before[source].session);
        for (const file of [source, keep, backlink]) expect(version(await session(fresh.request, workspaceId, file))).toEqual(version(before[file].session));
        await status(fresh.request, operation);
      });
    });
    test(`${profile.name}: mixed cross-workspace folder keeps link literals, PDF bytes and historical replay after a clone change`, async ({ browser }, info) => {
      await withNativeCopyBrowserFixture(browser, profile, 2, async f => {
        const [sourceWorkspace, targetWorkspace] = f.workspaces, sourceId = sourceWorkspace.id, targetId = targetWorkspace.id;
        const page = await f.context.newPage(), folder = folderName(), note = fileName(), target = fileName(), pdf = `owned-native-${randomUUID()}.pdf`;
        const notePath = `${folder}/${note}`, targetPath = `${folder}/${target}`, pdfPath = `${folder}/${pdf}`;
        await waitForFileCreateBudget(); expect((await page.request.post('/api/files/create', { headers: headers(sourceId), data: { path: folder, type: 'directory' } })).status()).toBe(200);
        const before: Record<string, Awaited<ReturnType<typeof persisted>>> = {};
        for (const [file, markdown] of [[targetPath, '# Copied target heading\n\nTarget stays local.\n'],
          [notePath, `# Mixed native source\n\n[Internal target](${target}) and [PDF](${pdf}).\n\nClone paragraph.\n`]]) {
          const initial = await createInUi(page, sourceId, file); await pasteMarkdown(page, f, markdown);
          before[file] = await persisted(page, sourceId, file, initial); await closeAndRelease(page, f, sourceId, file, before[file].session);
        }
        const pdfBytes = await readFile('tests/fixtures/pdf-viewer-layers.pdf');
        const uploaded = await page.request.post('/api/files/upload', { headers: headers(sourceId), multipart: {
          path: folder, files: { name: pdf, mimeType: 'application/pdf', buffer: pdfBytes },
        } }); expect(uploaded.status()).toBe(200); await bytes(page.request, sourceId, pdfPath, pdfBytes);
        const originalLogin = await loginIdentity(page.request);
        const { operation, preview } = await copyInUi(page, f, sourceId, targetId, folder, '.', false, 0, info);
        expect(preview.pathMappings.map(mapping => mapping.sourcePath).sort()).toEqual([folder, notePath, targetPath, pdfPath].sort());
        const cloneNote = await session(page.request, targetId, notePath), cloneTarget = await session(page.request, targetId, targetPath);
        expect(new Set([before[notePath].session.documentId, before[targetPath].session.documentId, cloneNote.documentId, cloneTarget.documentId]).size).toBe(4);
        expect(cloneNote.documentSequence).toBe(0); expect(cloneTarget.documentSequence).toBe(0);
        await bytes(page.request, targetId, pdfPath, pdfBytes);
        for (const file of [notePath, targetPath]) expect(version(await session(page.request, sourceId, file))).toEqual(version(before[file].session));
        const fresh = await freshContext(browser, f, targetId), reopened = await fresh.newPage(); await open(reopened, targetId, notePath);
        const candidate = await readNativeRichCandidate(reopened, selector);
        expect(semanticDocument(candidate.document)).toEqual(semanticDocument(before[notePath].candidate.document));
        expect(candidate.stateProof).toBe(cloneNote.stateProof); expect(candidate.stateVector).toBe(cloneNote.stateVector);
        expect(blockIds(candidate.document).every(id => !blockIds(before[notePath].candidate.document).includes(id))).toBe(true);
        await reopened.locator(selector).getByRole('link', { name: 'Internal target', exact: true }).click();
        const linkMenu = reopened.getByRole('dialog', { name: 'Link menu', exact: true }); await expect(linkMenu).toBeVisible();
        const opened = reopened.waitForResponse(response => new URL(response.url()).pathname === '/api/files/collaboration/session'
          && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === targetId
          && response.request().postDataJSON()?.path === targetPath);
        await linkMenu.getByRole('button', { name: 'Open link', exact: true }).click(); const openedResponse = await opened; expect(openedResponse.status()).toBe(200);
        expect((await openedResponse.json()).documentId).toBe(cloneTarget.documentId);
        await expect(reopened.getByTestId('document-header')).toContainText(targetPath);
        await expect(reopened.locator(selector).getByRole('heading', { name: 'Copied target heading', exact: true })).toBeVisible();
        expect(await reopened.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'))).toBe(targetId);
        await reopened.screenshot({ path: info.outputPath('native-copy-fresh-cross-workspace-link.png'), animations: 'disabled' });
        await reopened.close(); await released(f, targetId, notePath, cloneNote); await released(f, targetId, targetPath, cloneTarget);
        const editor = await fresh.newPage(); await open(editor, targetId, notePath);
        await (await nativeRichParagraph(editor, selector, 'Clone paragraph.')).click(); await editor.keyboard.press('End'); await editor.keyboard.insertText(' Later legitimate clone change.');
        const edited = await persisted(editor, targetId, notePath, cloneNote); await closeAndRelease(editor, f, targetId, notePath, edited.session);
        const originalStatus = await status(fresh.request, operation), originalChildren = await children(fresh.request, targetId, '.');
        const loggedIn = await freshContext(browser, f, targetId, true), currentLogin = await loginIdentity(loggedIn.request);
        expect(currentLogin.userId).toBe(originalLogin.userId); expect(currentLogin.sessionId).not.toBe(originalLogin.sessionId);
        const replay = await loggedIn.request.post(`/api/files/operations/${operation.operationId}`); expect(replay.status()).toBe(200);
        const replayBody = await replay.json(); privateFieldsAbsent(replayBody);
        expect(replayBody).toMatchObject({ success: true, operation, linkStatus: 'complete' });
        expect(await status(loggedIn.request, operation)).toEqual(originalStatus);
        expect(await children(loggedIn.request, targetId, '.')).toEqual(originalChildren);
        expect(version(await session(loggedIn.request, targetId, notePath))).toEqual(version(edited.session));
        expect(version(await session(loggedIn.request, targetId, targetPath))).toEqual(version(cloneTarget));
        for (const file of [notePath, targetPath]) expect(version(await session(loggedIn.request, sourceId, file))).toEqual(version(before[file].session));
        await bytes(loggedIn.request, sourceId, pdfPath, pdfBytes); await bytes(loggedIn.request, targetId, pdfPath, pdfBytes);
        info.annotations.push({ type: 'acceptance-scope', description: 'Completed native Copy replay under a genuinely new login after a legitimate clone edit. No incomplete-stage crash recovery, PDF parsing/import or Undo claim.' });
      });
    });
    test(`${profile.name}: pending Copy recovery reaches an already open target view and preserves the shared title`, async ({ browser }, info) => {
      await withNativeCopyBrowserFixture(browser, profile, 2, async f => {
        const [sourceWorkspace, targetWorkspace] = f.workspaces, sourceId = sourceWorkspace.id, targetId = targetWorkspace.id;
        const page = await f.context.newPage(), file = fileName(), title = `Shared DB title ${randomUUID().slice(0, 8)}`;
        const initial = await createInUi(page, sourceId, file);
        await pasteMarkdown(page, f, '# Content heading differs from shared title\n\nRecovery keeps this original native document.\n');
        const original = await persisted(page, sourceId, file, initial); await closeAndRelease(page, f, sourceId, file, original.session);
        const sourceInfo = await page.request.get('/api/files/info', { headers: headers(sourceId), params: { path: file } });
        expect(sourceInfo.status()).toBe(200); const sourceNode = (await sourceInfo.json()).data;
        expect(sourceNode.metadataTarget).toMatchObject({ kind: 'native_file', documentId: original.session.documentId,
          lifecycleGeneration: original.session.lifecycleGeneration, workspaceId: sourceId, path: file });
        const titled = await page.request.patch('/api/files/metadata', { headers: headers(sourceId),
          data: { path: file, expectedTarget: sourceNode.metadataTarget, title } }); expect(titled.status()).toBe(200);
        const sourceTitle = await page.request.get('/api/files/info', { headers: headers(sourceId), params: { path: file } });
        expect(sourceTitle.status()).toBe(200); expect((await sourceTitle.json()).data.title).toBe(title);

        const targetContext = await freshContext(browser, f, targetId), targetPage = await targetContext.newPage();
        const observer = observeOwnedCopyFiles(targetPage, targetId, file);
        await targetPage.goto(`/en/files?workspaceId=${targetId}`);
        await expect.poll(() => observer.snapshot().opened, { timeout: 30_000 }).toBeGreaterThan(0);
        const targetRow = targetPage.locator(`[data-file-path="${file}"]`).filter({ visible: true });
        await expect(targetRow).toHaveCount(0); const openView = observer.snapshot();
        const login = await loginIdentity(page.request); expect(login.userId).toBe(f.owned.actorId);
        let fault: OwnedCopyB2FaultInput | undefined, faultClosed = false, bodyFailed = false, primary: unknown;
        try {
          const pending = await copyInUi(page, f, sourceId, targetId, file, '.', false, 0, info, {
            beforeApply: async preview => {
              const owned = f.owned;
              const operationId = createHash('sha256').update(JSON.stringify(['workspace-file-operation-v1', login.userId,
                sourceId, targetId, preview.planId])).digest('hex');
              fault = { version: 1, action: 'arm', faultId: randomUUID().replaceAll('-', ''), target: {
                nonce: owned.nonce, repo: owned.repo, head: owned.head, sourceFingerprint: owned.sourceFingerprint,
                buildFingerprint: owned.buildFingerprint, buildId: owned.buildId, receiptIdentity: ownedNativeFileRoomReceiptIdentity(owned) },
              sourceWorkspaceId: sourceId, destinationWorkspaceId: targetId, actorUserId: login.userId, sourcePath: file,
              destinationPath: file, sourceDocumentId: original.session.documentId, sourceGeneration: original.session.lifecycleGeneration,
              planId: preview.planId, operationId };
              expect(await copyB2Fault(fault)).toEqual({ armed: true, faultId: fault.faultId });
            },
          });
          expect(fault).toBeTruthy(); expect(pending.operation.operationId).toBe(fault!.operationId);
          const pendingStatus = await page.request.get(`/api/files/operations/${pending.operation.operationId}`);
          expect(pendingStatus.status()).toBe(200); const pendingBody = await pendingStatus.json(); privateFieldsAbsent(pendingBody);
          expect(pendingBody.operation).toMatchObject({ operationId: pending.operation.operationId, status: 'recovery_required' });
          expect(pendingBody.operation.steps.some((step: { key: string; status: string }) => step.key === 'copy-completion' && step.status === 'applied')).toBe(false);
          expect(observer.snapshot().adds).toBe(0);
          expect(await copyB2Fault({ ...fault!, action: 'cleanup' })).toEqual({ removed: true, fired: true, matchingAttempts: '1' }); faultClosed = true;

          const recovered = await page.request.post(`/api/files/operations/${pending.operation.operationId}`, { timeout: 90_000 });
          expect(recovered.status()).toBe(200); const recoveredBody = await recovered.json(); privateFieldsAbsent(recoveredBody);
          expect(recoveredBody).toMatchObject({ success: true, linkStatus: 'complete', operation: {
            operationId: pending.operation.operationId, planId: pending.operation.planId, status: 'complete', pendingSteps: [], errorCode: null } });
          await expect.poll(() => observer.snapshot().adds, { timeout: 30_000 }).toBe(1);
          await expect.poll(() => observer.snapshot().treeRequests, { timeout: 30_000 }).toBeGreaterThan(openView.treeRequests);
          await expect(targetRow).toHaveCount(1); await expect(targetRow).toBeVisible();
          expect(observer.snapshot().navigations).toBe(openView.navigations); expect(observer.snapshot().errors).toEqual([]);
          expect(await targetPage.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'))).toBe(targetId);

          await targetRow.hover(); await targetRow.getByRole('button', { name: /^More actions for /u }).click();
          const targetInfo = targetPage.waitForResponse(response => new URL(response.url()).pathname === '/api/files/info'
            && new URL(response.url()).searchParams.get('path') === file
            && response.request().headers()['x-canvas-workspace-id'] === targetId);
          await targetPage.getByRole('menuitem', { name: 'Information', exact: true }).click();
          const targetInfoResponse = await targetInfo; expect(targetInfoResponse.status()).toBe(200);
          const cloneNode = (await targetInfoResponse.json()).data;
          expect(cloneNode).toMatchObject({ path: file, title, metadataTarget: { kind: 'native_file', workspaceId: targetId, path: file } });
          expect(cloneNode.metadataTarget.documentId).not.toBe(original.session.documentId);
          const dialog = targetPage.getByRole('dialog', { name: 'Information', exact: true });
          await expect(dialog.locator('dt').filter({ hasText: /^Title$/u })).toBeVisible();
          await expect(dialog.locator('dd').filter({ hasText: title })).toHaveText(title);
          await dialog.screenshot({ path: info.outputPath('native-copy-recovery-shared-title.png'), animations: 'disabled' });
          await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close', exact: true }).click(); await expect(dialog).toHaveCount(0);
          const clone = await session(targetContext.request, targetId, file);
          expect(clone.documentId).toBe(cloneNode.metadataTarget.documentId); expect(clone.documentSequence).toBe(0);
          const editor = await targetContext.newPage(); await open(editor, targetId, file);
          const cloneContent = await readNativeRichCandidate(editor, selector);
          expect(semanticDocument(cloneContent.document)).toEqual(semanticDocument(original.candidate.document));
          expect(blockIds(cloneContent.document).every(id => !blockIds(original.candidate.document).includes(id))).toBe(true);
          expect(cloneContent.stateProof).toBe(clone.stateProof); expect(cloneContent.stateVector).toBe(clone.stateVector);
          await closeAndRelease(editor, f, targetId, file, clone); await editor.close();
          expect(version(await session(page.request, sourceId, file))).toEqual(version(original.session));

          const beforeHistory = observer.snapshot(), completedStatus = await status(page.request, recoveredBody.operation);
          const historical = await page.request.post(`/api/files/operations/${pending.operation.operationId}`, { timeout: 90_000 });
          expect(historical.status()).toBe(200); const historicalBody = await historical.json(); privateFieldsAbsent(historicalBody);
          expect(historicalBody).toMatchObject({ success: true, linkStatus: 'complete' });
          const historicalOperation = historicalBody.operation as Operation;
          for (const operation of [recoveredBody.operation as Operation, historicalOperation]) {
            expect(new Set(operation.completedSteps).size).toBe(operation.completedSteps.length);
          }
          expect(historicalOperation.completedSteps).toHaveLength(recoveredBody.operation.completedSteps.length);
          expect({ ...historicalOperation, completedSteps: [...historicalOperation.completedSteps].sort() })
            .toEqual({ ...recoveredBody.operation, completedSteps: [...recoveredBody.operation.completedSteps].sort() });
          expect(await status(page.request, recoveredBody.operation)).toEqual(completedStatus);
          // A real later heartbeat on this same files subscription closes the observation window.
          const afterHistoryHeartbeat = observer.snapshot().heartbeats;
          await expect.poll(() => observer.snapshot().heartbeats, { timeout: 40_000, intervals: [250, 500] }).toBeGreaterThan(afterHistoryHeartbeat);
          expect(observer.snapshot().adds).toBe(beforeHistory.adds); expect(observer.snapshot().errors).toEqual([]);
          expect(observer.snapshot().navigations).toBe(openView.navigations); await expect(targetRow).toHaveCount(1);
          expect(version(await session(targetContext.request, targetId, file))).toEqual(version(clone));
          expect(version(await session(page.request, sourceId, file))).toEqual(version(original.session));
          await info.attach('native-copy-files-protocol.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(observer.snapshot())) });
        } catch (error) { bodyFailed = true; primary = error; }
        finally {
          // Known faultId locates the durable intent even when arm lost its ACK.
          if (fault && !faultClosed) try { expect((await copyB2Fault({ ...fault, action: 'cleanup' })).removed).toBe(true); }
          catch (error) { throw aggregateOwnedNativeErrors(bodyFailed ? primary : undefined, [error], 'Owned Copy fault cleanup failed.'); }
        }
        if (bodyFailed) throw primary;
      });
    });
  }
});
