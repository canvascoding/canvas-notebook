import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { FileCollaborationState } from '../app/lib/files/types';
import type { WorkspaceOperationNativeCopyPreviewPublic } from '../app/lib/files/workspace-operation-native-copy-public';
import type { ExcalidrawAssetMetadata, ExcalidrawElementRecord, ExcalidrawSharedAppState } from '../app/lib/excalidraw-collaboration/protocol';
import { assertOwnedRoot, requireOwnedYjsQaTarget, type OwnedYjsReceipt } from '../scripts/lib/owned-yjs-authority-qa';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { prepareDestinationTreeRequestBudget } from './helpers/destination-tree-request-budget';
import { aggregateOwnedNativeErrors } from './helpers/owned-native-command';

const spec = 'tests/workspace-operation-managed-scene-copy.spec.ts';
const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 960 }, mobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true },
] as const;
type Profile = typeof profiles[number];
type Workspace = { id: string; name: string; type: 'personal'; rootRelativePath: string;
  permissions: { canRead: boolean; canWrite: boolean; canManageWorkspace: boolean } };
type Fixture = { owned: OwnedYjsReceipt; context: BrowserContext; workspaces: Workspace[]; profile: Profile };
type Scene = { documentId: string; workspaceId: string; path: string; lifecycleGeneration: number; sceneSequence: number;
  canonicalHash: string; elements: ExcalidrawElementRecord[]; appState: ExcalidrawSharedAppState; assets: ExcalidrawAssetMetadata[];
  checkpoint: { status: string; sequence: number; revisionId: string | null } };
type FileRead = { path: string; content: string; collaboration: FileCollaborationState;
  documentId?: string; lifecycleGeneration?: number; sceneSequence?: number };
const headers = (workspaceId: string) => ({ 'x-canvas-workspace-id': workspaceId });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const canvas = '.excalidraw canvas.excalidraw__canvas.interactive';
const editor = '.tiptap-editor-shell .ProseMirror';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function noPrivateCopyFields(value: unknown): void {
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    expect(['origin', 'requestJson', 'request_json', 'actorUserId', 'actorSessionId', 'sourceEvidence', 'destinationEvidence',
      'nativePathPlan', 'cloneRequirements', 'rootPath', 'rootRelativePath', 'documentId', 'lineageId', 'sceneRecords',
      'sceneAssets', 'assetOriginal', 'assetReceipt', 'nativeRecords', 'private_result', 'requestFingerprint']).not.toContain(key);
    noPrivateCopyFields(child);
  }
}
async function reviewOff(request: APIRequestContext) {
  const response = await request.get('/api/document-review/availability'); expect(response.status()).toBe(200);
  expect((await response.json()).data.documentReviewEnabled).toBe(false);
}
async function withFixture(browser: Browser, profile: Profile, run: (f: Fixture) => Promise<void>) {
  const owned = await requireOwnedYjsQaTarget(); expect(owned.activeSpec).toBe(spec);
  const context = await createAuthenticatedContext(browser, { viewport: profile.viewport, isMobile: profile.mobile, hasTouch: profile.mobile });
  const f: Fixture = { owned, context, workspaces: [], profile }; let failed = false, primary: unknown;
  const cleanup: unknown[] = [];
  try {
    await prepareDestinationTreeRequestBudget(context); await reviewOff(context.request);
    for (let index = 0; index < 2; index++) {
      const name = `Scene Copy ${profile.name} ${index} ${randomUUID().slice(0, 8)}`;
      const response = await context.request.post('/api/workspaces', { data: { type: 'personal', name } });
      const body = await response.json(); if (body.workspace?.id) f.workspaces.push(body.workspace);
      expect(response.status()).toBe(201); expect(body.starterDocumentInitialization.status).toBe('completed');
      expect(body.workspace).toMatchObject({ name, type: 'personal', permissions: { canRead: true, canWrite: true, canManageWorkspace: true } });
    }
    await context.addInitScript(({ id, mobile }) => {
      localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
      localStorage.setItem('canvas-browser-mode', mobile ? 'list' : 'tree');
    }, { id: f.workspaces[0].id, mobile: profile.mobile });
    await run(f); await reviewOff(context.request);
  } catch (error) { failed = true; primary = error; }
  finally {
    for (const page of context.pages()) try { await page.close(); } catch (error) { cleanup.push(error); }
    for (const workspace of [...f.workspaces].reverse()) try {
      const listed = await context.request.get('/api/workspaces'); expect(listed.status()).toBe(200);
      expect((await listed.json()).workspaces.find((value: Workspace) => value.id === workspace.id)).toMatchObject({
        id: workspace.id, name: workspace.name, type: 'personal', rootRelativePath: workspace.rootRelativePath,
        permissions: { canManageWorkspace: true } });
      expect((await context.request.delete(`/api/workspaces/${workspace.id}`)).status()).toBe(200);
    } catch (error) { cleanup.push(error); }
    try { await context.close(); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw aggregateOwnedNativeErrors(failed ? primary : undefined, cleanup, 'Owned Scene Copy browser fixture cleanup failed.');
  if (failed) throw primary;
}
async function fileRead(request: APIRequestContext, workspaceId: string, file: string): Promise<FileRead> {
  const response = await request.get('/api/files/read', { headers: headers(workspaceId), params: { path: file } });
  expect(response.status()).toBe(200); const data = (await response.json()).data as FileRead;
  expect(data.path).toBe(file); expect(data.collaboration.document?.status).toBe('active');
  expect(data.collaboration.lineageId).toBeTruthy(); return data;
}
async function sceneRead(request: APIRequestContext, workspaceId: string, documentId: string): Promise<Scene> {
  const response = await request.get(`/api/excalidraw/scenes/${encodeURIComponent(documentId)}`, { headers: headers(workspaceId) });
  expect(response.status()).toBe(200); const body = await response.json(); expect(body.success).toBe(true);
  expect(body.document).toMatchObject({ documentId, workspaceId }); return body.document;
}
function sceneContent(scene: Scene) {
  return { documentId: scene.documentId, workspaceId: scene.workspaceId, path: scene.path, lifecycleGeneration: scene.lifecycleGeneration,
    sceneSequence: scene.sceneSequence, canonicalHash: scene.canonicalHash, elements: scene.elements, appState: scene.appState, assets: scene.assets };
}
function rectangle(id: string): ExcalidrawElementRecord {
  return { id, type: 'rectangle', x: 200, y: 120, width: 120, height: 90, angle: 0, strokeColor: '#1e1e1e',
    backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: { type: 3 }, seed: 17, version: 1, versionNonce: 29,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}
async function initializedScene(request: APIRequestContext, workspaceId: string, file: string) {
  const response = await request.post('/api/excalidraw/scenes', { headers: headers(workspaceId),
    data: { workspaceId, path: file, idempotencyKey: randomUUID() } });
  expect(response.status()).toBe(201); const initial = (await response.json()).document as Scene;
  expect(initial.sceneSequence).toBe(0); expect(initial.elements).toEqual([]);
  const element = rectangle(`rectangle-${randomUUID()}`);
  const changed = await request.post(`/api/excalidraw/scenes/${initial.documentId}/operations`, { headers: headers(workspaceId), data: {
    workspaceId, documentId: initial.documentId, lifecycleGeneration: initial.lifecycleGeneration,
    observedSceneSequence: initial.sceneSequence, actions: [{ type: 'create', element }], idempotencyKey: randomUUID(),
  } });
  expect(changed.status()).toBe(200); expect((await changed.json()).operation).toMatchObject({
    status: 'applied', reviewRequired: false, reviewAvailable: false, checkpoint: { status: 'saved' } });
  const current = await sceneRead(request, workspaceId, initial.documentId);
  expect(current.sceneSequence).toBe(1); expect(current.canonicalHash).not.toBe(initial.canonicalHash);
  expect(current.elements).toEqual([element]); return current;
}
async function download(request: APIRequestContext, workspaceId: string, file: string) {
  const response = await request.get('/api/files/download', { headers: headers(workspaceId), params: { path: file } });
  expect(response.status()).toBe(200); return response.body();
}
async function upload(request: APIRequestContext, workspaceId: string, file: string, mimeType: string, buffer: Buffer) {
  const response = await request.post('/api/files/upload', { headers: headers(workspaceId), multipart: {
    path: path.posix.dirname(file), files: { name: path.posix.basename(file), mimeType, buffer },
  } }); expect(response.status()).toBe(200); expect((await response.json()).success).toBe(true);
}
function sameNode(left: BigIntStats, right: BigIntStats) {
  for (const field of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) expect(right[field]).toBe(left[field]);
}
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  expect(relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)).toBe(true);
}
/** Fault fixture only: remove exactly one API-created owned projection, never SQL or a foreign path. */
async function removeOwnProjection(f: Fixture, workspace: Workspace, file: string, expected: Buffer) {
  expect(f.workspaces).toContain(workspace); expect(file).toMatch(/^copy-scene-[a-f0-9-]{36}\.excalidraw$/u);
  await assertOwnedRoot(f.owned); expect(process.env.DATA).toBe(f.owned.dataRoot);
  const listed = await f.context.request.get('/api/workspaces'); expect(listed.status()).toBe(200);
  expect((await listed.json()).workspaces.find((value: Workspace) => value.id === workspace.id)).toMatchObject({
    id: workspace.id, name: workspace.name, rootRelativePath: workspace.rootRelativePath, permissions: { canManageWorkspace: true } });
  expect(path.isAbsolute(workspace.rootRelativePath)).toBe(false);
  const root = path.resolve(f.owned.dataRoot, workspace.rootRelativePath), absolute = path.resolve(root, file);
  inside(f.owned.dataRoot, root); inside(root, absolute); expect(await realpath(root)).toBe(root); expect(await realpath(absolute)).toBe(absolute);
  const parent = await lstat(root, { bigint: true }); expect(parent.isDirectory() && !parent.isSymbolicLink()).toBe(true);
  expect(parent.uid).toBe(BigInt(process.getuid!()));
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = await handle.stat({ bigint: true }); expect(held.isFile()).toBe(true); expect(held.nlink).toBe(BigInt(1));
    expect(held.uid).toBe(parent.uid); expect(held.size).toBe(BigInt(expected.length)); expect(expected.length).toBeLessThan(1024 * 1024);
    expect(sha(await handle.readFile())).toBe(sha(expected)); sameNode(held, await handle.stat({ bigint: true }));
    sameNode(parent, await lstat(root, { bigint: true })); sameNode(held, await lstat(absolute, { bigint: true }));
    await assertOwnedRoot(f.owned); expect(await realpath(root)).toBe(root); await unlink(absolute);
    await expect(lstat(absolute)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await handle.close(); }
}
async function copyInUi(page: Page, f: Fixture, source: Workspace, destination: Workspace, selected: string, info: TestInfo) {
  await page.goto(`/en/files?workspaceId=${source.id}`);
  await page.getByRole('navigation', { name: 'Current folder path', exact: true })
    .getByRole('button', { name: 'Jump to workspace root', exact: true }).click();
  const row = page.locator(`[data-file-path="${selected}"]`).filter({ visible: true }).first(); await expect(row).toBeVisible(); await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Copy to workspace', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy to workspace', exact: true });
  await dialog.getByRole('combobox', { name: 'Target workspace', exact: true }).selectOption(destination.id);
  await dialog.getByRole('button', { name: '/ (root)', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '/ (root)', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const matches = (response: { url(): string; request(): { method(): string; postDataJSON(): Record<string, unknown> } }, preview: boolean) => {
    if (new URL(response.url()).pathname !== '/api/files/copy' || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON(); return body.dryRun === (preview ? true : undefined)
      && body.sourceWorkspaceId === source.id && body.targetWorkspaceId === destination.id && body.destDir === '.'
      && JSON.stringify(body.sources) === JSON.stringify([selected]);
  };
  const previewResponse = page.waitForResponse(response => matches(response, true));
  await dialog.getByRole('button', { name: 'Preview links', exact: true }).click(); const response = await previewResponse;
  expect(response.status()).toBe(200); const preview = await response.json() as { plan: WorkspaceOperationNativeCopyPreviewPublic };
  noPrivateCopyFields(preview); expect(preview).toMatchObject({ success: true, dryRun: true, requiresRevalidation: true,
    plan: { version: 4, kind: 'native-copy', sourceWorkspaceId: source.id, destinationWorkspaceId: destination.id, readiness: 'ready', issues: [] } });
  expect(preview.plan.planId).toMatch(/^[a-f0-9]{64}$/u); expect(preview.plan.linkEdits).toEqual([]);
  expect(preview.plan.pathMappings.find(value => value.sourcePath === selected)?.destinationPath).toBe(selected);
  await expect(dialog.getByRole('status').filter({ hasText: 'Preview readiness: ready' })).toBeVisible();
  const bounds = await dialog.boundingBox(); expect(bounds).toBeTruthy(); expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(f.profile.viewport.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await dialog.screenshot({ path: info.outputPath('managed-scene-copy-preview.png'), animations: 'disabled' });
  const appliedResponse = page.waitForResponse(value => matches(value, false), { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click(); const applied = await appliedResponse;
  if (applied.status() !== 200) await info.attach('managed-scene-copy-failure', { body: await applied.body(), contentType: 'application/json' });
  expect(applied.status()).toBe(200); expect(applied.request().postDataJSON().planId).toBe(preview.plan.planId);
  const result = await applied.json(); noPrivateCopyFields(result);
  expect(result).toMatchObject({ success: true, failed: [], skipped: [], linkStatus: 'complete', updatedLinks: 0,
    operation: { planId: preview.plan.planId, status: 'complete', pendingSteps: [], errorCode: null } });
  expect(result.operation.operationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u);
  await expect(dialog).toBeHidden({ timeout: 90_000 });
  const status = await page.request.get(`/api/files/operations/${result.operation.operationId}`); expect(status.status()).toBe(200);
  const statusBody = await status.json(); noPrivateCopyFields(statusBody);
  expect(statusBody.operation).toMatchObject({ operationId: result.operation.operationId, status: 'completed', errorCode: null });
  expect(statusBody.operation.steps.every((step: { status: string }) => step.status === 'applied')).toBe(true);
  await info.attach('managed-scene-copy-public-result', { body: JSON.stringify({ preview, result, status: statusBody }), contentType: 'application/json' });
  return preview.plan;
}
function clonedIdentity(original: FileRead, clone: FileRead, provider: 'yjs' | 'excalidraw') {
  expect(original.collaboration.document?.provider).toBe(provider); expect(clone.collaboration.document?.provider).toBe(provider);
  expect(clone.collaboration.document?.id).toBeTruthy(); expect(clone.collaboration.document?.id).not.toBe(original.collaboration.document?.id);
  expect(clone.collaboration.lineageId).not.toBe(original.collaboration.lineageId);
}
async function destinationScene(page: Page, workspace: Workspace, file: string, expected: Scene, info: TestInfo) {
  const uiSession = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/collaboration/session'
    && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id
    && response.request().postDataJSON()?.path === file && response.request().postDataJSON()?.provider === 'excalidraw');
  const initialSession = uiSession();
  await page.goto(`/en/notebook?workspaceId=${workspace.id}&path=${encodeURIComponent(file)}`);
  const connected = await initialSession; expect(connected.status()).toBe(200);
  expect(await connected.json()).toMatchObject({ success: true, provider: 'excalidraw', documentId: expected.documentId,
    lifecycleGeneration: expected.lifecycleGeneration, permission: 'write' });
  await expect(page.locator(canvas)).toBeVisible({ timeout: 45_000 }); await expect(page.getByTestId('document-header')).toContainText(file);
  const shown = await sceneRead(page.request, workspace.id, expected.documentId);
  expect(shown.elements.map(element => element.id)).toEqual(expected.elements.map(element => element.id)); expect(shown.assets).toEqual(expected.assets);
  const reloadSession = uiSession(); await page.reload(); const reconnected = await reloadSession;
  expect(reconnected.status()).toBe(200); expect(await reconnected.json()).toMatchObject({ success: true,
    provider: 'excalidraw', documentId: expected.documentId, lifecycleGeneration: expected.lifecycleGeneration, permission: 'write' });
  await expect(page.locator(canvas)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('document-header')).toContainText(file);
  expect((await sceneRead(page.request, workspace.id, expected.documentId)).elements.map(element => element.id)).toEqual(expected.elements.map(element => element.id));
  await page.screenshot({ path: info.outputPath('managed-scene-copy-reloaded.png'), animations: 'disabled' });
}

test.describe('owned managed Scene Copy with Review disabled', () => {
  test.describe.configure({ retries: 0 }); test.setTimeout(300_000);
  for (const profile of profiles) {
    test(`${profile.name}: copies an updated initialized Scene whose own projection is missing`, async ({ browser }, info) => {
      await withFixture(browser, profile, async f => {
        const [source, destination] = f.workspaces, page = await f.context.newPage(), file = `copy-scene-${randomUUID()}.excalidraw`;
        const current = await initializedScene(page.request, source.id, file), before = await fileRead(page.request, source.id, file);
        expect(before.documentId).toBe(current.documentId); expect(before.sceneSequence).toBe(1);
        const projection = await download(page.request, source.id, file); expect(JSON.parse(projection.toString()).elements).toEqual(current.elements);
        await removeOwnProjection(f, source, file, projection);
        const plan = await copyInUi(page, f, source, destination, file, info);
        expect(plan.pathMappings.map(value => value.sourcePath)).toEqual([file]);
        const copied = await fileRead(page.request, destination.id, file); clonedIdentity(before, copied, 'excalidraw');
        expect(copied.documentId).toBe(copied.collaboration.document!.id); expect(copied.lifecycleGeneration).toBe(1); expect(copied.sceneSequence).toBe(0);
        const clone = await sceneRead(page.request, destination.id, copied.documentId!);
        expect(clone.canonicalHash).toBe(current.canonicalHash); expect(clone.elements).toEqual(current.elements);
        expect(clone.appState).toEqual(current.appState); expect(clone.assets).toEqual([]);
        await destinationScene(page, destination, file, clone, info);
        expect(sceneContent(await sceneRead(page.request, source.id, current.documentId))).toEqual(sceneContent(current));
        const original = await fileRead(page.request, source.id, file);
        expect(original.content).toBe(before.content); expect(original.collaboration.lineageId).toBe(before.collaboration.lineageId);
        info.annotations.push({ type: 'acceptance-scope', description: 'Real REST update persisted sequence 1; only its owned projection was removed. UI Copy, new D/L, sequence 0 and reloaded target canvas; no SQL fixture writes.' });
      });
    });
    test(`${profile.name}: copies a mixed Markdown, Scene, PNG and PDF folder across workspaces`, async ({ browser }, info) => {
      await withFixture(browser, profile, async f => {
        const [source, destination] = f.workspaces, page = await f.context.newPage(), folder = `copy-mixed-${randomUUID()}`;
        const note = `${folder}/note.md`, drawing = `${folder}/drawing.excalidraw`, image = `${folder}/pixel.png`, pdf = `${folder}/reference.pdf`;
        await waitForFileCreateBudget(); expect((await page.request.post('/api/files/create', { headers: headers(source.id),
          data: { path: folder, type: 'directory' } })).status()).toBe(200);
        await uploadWorkspaceTextFile({ request: page.request, workspaceId: source.id, filePath: note,
          content: '# Mixed copied note\n\n[PNG](pixel.png) and [PDF](reference.pdf).\n\nThe source stays unchanged.\n' });
        const fileId = `copy-pixel-${randomUUID()}`, element = { ...rectangle(`copy-image-${randomUUID()}`),
          type: 'image', fileId, status: 'saved', scale: [1, 1], crop: null, roundness: null };
        const portable = Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, source: 'canvas-notebook', elements: [element],
          appState: { viewBackgroundColor: '#ffffff' }, files: { [fileId]: { id: fileId, mimeType: 'image/png',
            dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } }));
        await upload(page.request, source.id, drawing, 'application/json', portable);
        await upload(page.request, source.id, image, 'image/png', png);
        const pdfBytes = await readFile(path.join(process.cwd(), 'tests/fixtures/pdf-viewer-layers.pdf'));
        await upload(page.request, source.id, pdf, 'application/pdf', pdfBytes);
        const sourceNote = await fileRead(page.request, source.id, note), sourceDrawing = await fileRead(page.request, source.id, drawing);
        const originalScene = await sceneRead(page.request, source.id, sourceDrawing.documentId!);
        expect(originalScene.assets).toHaveLength(1); expect(originalScene.assets[0]).toMatchObject({ fileId, contentHash: sha(png), mimeType: 'image/png', sizeBytes: png.length });
        const plan = await copyInUi(page, f, source, destination, folder, info);
        expect(plan.pathMappings.map(value => value.sourcePath).sort()).toEqual([folder, note, drawing, image, pdf].sort());
        const cloneNote = await fileRead(page.request, destination.id, note), cloneDrawing = await fileRead(page.request, destination.id, drawing);
        clonedIdentity(sourceNote, cloneNote, 'yjs'); clonedIdentity(sourceDrawing, cloneDrawing, 'excalidraw');
        expect(cloneNote.content).toBe(sourceNote.content); expect(cloneDrawing.sceneSequence).toBe(0); expect(cloneDrawing.lifecycleGeneration).toBe(1);
        const cloneScene = await sceneRead(page.request, destination.id, cloneDrawing.documentId!);
        expect(cloneScene.canonicalHash).toBe(originalScene.canonicalHash); expect(cloneScene.elements).toEqual(originalScene.elements);
        expect(cloneScene.assets).toEqual(originalScene.assets); expect(cloneScene.appState).toEqual(originalScene.appState);
        for (const workspace of [source, destination]) {
          expect(await download(page.request, workspace.id, image)).toEqual(png); expect(await download(page.request, workspace.id, pdf)).toEqual(pdfBytes);
          const asset = await page.request.get(`/api/files/excalidraw-assets/${fileId}`, { headers: headers(workspace.id) });
          expect(asset.status()).toBe(200); expect(asset.headers()['etag']).toBe(`"${sha(png)}"`); expect(await asset.body()).toEqual(png);
        }
        const exported = JSON.parse((await download(page.request, destination.id, drawing)).toString());
        expect(exported.elements).toEqual(originalScene.elements); expect(exported.files[fileId].dataURL).toBe(`data:image/png;base64,${png.toString('base64')}`);
        await destinationScene(page, destination, drawing, cloneScene, info);
        await page.goto(`/en/notebook?workspaceId=${destination.id}&path=${encodeURIComponent(note)}`);
        await expect(page.locator(editor)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect(page.locator(editor).getByRole('heading', { name: 'Mixed copied note', exact: true })).toBeVisible();
        await page.reload(); await expect(page.locator(editor).getByRole('link', { name: 'PNG', exact: true })).toHaveAttribute('href', 'pixel.png');
        await expect(page.locator(editor).getByRole('link', { name: 'PDF', exact: true })).toHaveAttribute('href', 'reference.pdf');
        await page.screenshot({ path: info.outputPath('managed-mixed-copy-reloaded-note.png'), animations: 'disabled' });
        const finalSource = await fileRead(page.request, source.id, note);
        expect(finalSource.content).toBe(sourceNote.content); expect(finalSource.collaboration).toEqual(sourceNote.collaboration);
        expect(sceneContent(await sceneRead(page.request, source.id, originalScene.documentId))).toEqual(sceneContent(originalScene));
        expect((await fileRead(page.request, source.id, drawing)).collaboration.lineageId).toBe(sourceDrawing.collaboration.lineageId);
        info.annotations.push({ type: 'acceptance-scope', description: 'Real multipart imports and UI folder Copy include native Markdown, initialized Scene with PNG asset, standalone PNG and PDF. No PDF parsing, Move/Delete, Undo or Review Center claim.' });
      });
    });
  }
});
