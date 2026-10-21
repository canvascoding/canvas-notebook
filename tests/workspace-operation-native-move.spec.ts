import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page,
  type TestInfo } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES, COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import type { WorkspacePathOperationPublic, WorkspacePathOperationResponse } from '../app/lib/files/workspace-path-operation-public';
import { requireOwnedYjsQaTarget, type OwnedYjsReceipt } from '../scripts/lib/owned-yjs-authority-qa';
import { ownedNativeFileRoomReceiptIdentity } from '../scripts/lib/owned-yjs-native-delete-links-room-target';
import type { OwnedRestartRoomEvidence } from '../scripts/lib/owned-yjs-restart-room-read';
import { assertCompletedWorkspaceMarkdownCreate, createAuthenticatedContext, createCompletedWorkspaceMarkdownFile } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { nativeRichParagraph } from './helpers/native-rich-paragraph';
import { aggregateOwnedNativeErrors, runOwnedNativeCommand } from './helpers/owned-native-command';
import { holdOwnedNativeMoveSharedRoom } from './helpers/owned-yjs-authority-runtime';
import { readWorkspaceImplicitMoveBinding, readWorkspaceImplicitMovePreparation } from '../app/lib/files/workspace-implicit-move-parser';
import type { WorkspaceImplicitMovePreparationPublicV2 } from '../app/lib/files/workspace-implicit-move-public';

const spec = 'tests/workspace-operation-native-move.spec.ts';
const selector = '.tiptap-editor-shell .ProseMirror', insertionTitle = 'Insert Markdown…';
const fileName = () => `owned-yjs-restart-${randomUUID()}.md`;
type NativeSession = { success: boolean; provider: string; documentId: string; lifecycleGeneration: number;
  documentSequence: number; representation: 'plain_text' | 'tiptap_blocks'; schemaVersion: number;
  stateProof: string; stateVector: string; degraded: boolean };
type Fixture = { owned: OwnedYjsReceipt; context: BrowserContext; workspaceId: string; headers: Record<string, string>;
  mobile: boolean; viewport: { width: number; height: number }; contexts: BrowserContext[] };

async function session(request: APIRequestContext, workspaceId: string, path: string,
  representation: NativeSession['representation'] = 'tiptap_blocks'): Promise<NativeSession> {
  const response = await request.post('/api/files/collaboration/session', {
    headers: { 'x-canvas-workspace-id': workspaceId }, data: { path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.status()).toBe(200);
  const value = await response.json() as NativeSession;
  expect(value).toMatchObject({ success: true, provider: 'yjs', representation, degraded: false, schemaVersion: COLLABORATION_SCHEMA_VERSION });
  expect(value.documentId).toBeTruthy(); expect(value.lifecycleGeneration).toBeGreaterThan(0);
  expect(value.stateProof).toMatch(/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u); expect(value.stateVector).toBeTruthy();
  return value;
}
async function room(fixture: Fixture, path: string, expected: NativeSession): Promise<OwnedRestartRoomEvidence> {
  const owned = fixture.owned;
  const wire = Buffer.from(JSON.stringify({ version: 1,
    target: { nonce: owned.nonce, repo: owned.repo, head: owned.head, sourceFingerprint: owned.sourceFingerprint,
      buildFingerprint: owned.buildFingerprint, buildId: owned.buildId, receiptIdentity: ownedNativeFileRoomReceiptIdentity(owned) },
    room: { documentId: expected.documentId, path, generation: expected.lifecycleGeneration, expectedWorkspaceId: fixture.workspaceId },
    expectedSession: { documentSequence: expected.documentSequence, stateProof: expected.stateProof, stateVector: expected.stateVector },
  })).toString('base64url');
  const observed = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx',
    'scripts/owned-yjs-native-move-room-read.ts', wire], { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(observed.stdout) as OwnedRestartRoomEvidence;
}
async function persisted(page: Page, fixture: Fixture, path: string, initial: NativeSession) {
  const candidate = await readNativeRichCandidate(page, selector);
  let current: NativeSession | undefined;
  await expect.poll(async () => {
    current = await session(page.request, fixture.workspaceId, path);
    return { documentId: current.documentId, generation: current.lifecycleGeneration, proof: current.stateProof, vector: current.stateVector };
  }, { timeout: 40_000 }).toEqual({ documentId: initial.documentId, generation: initial.lifecycleGeneration,
    proof: candidate.stateProof, vector: candidate.stateVector });
  return { candidate, session: current! };
}
async function closeAndRelease(page: Page, fixture: Fixture, path: string, expected: NativeSession) {
  const held = await room(fixture, path, expected);
  expect(held).toMatchObject({ ownerTupleComplete: true, advisoryLockHeld: true, released: false });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(page.locator(selector)).toHaveCount(0);
  await expect.poll(async () => (await room(fixture, path, expected)).released,
    { timeout: 40_000, intervals: [500, 1_000, 2_000] }).toBe(true);
  const released = await room(fixture, path, expected);
  expect(released).toMatchObject({ ownerTupleCleared: true, advisoryLockHeld: false,
    releaseReceiptValid: true, admissionPending: false, released: true });
  expect(released.version).toEqual(held.version);
}
async function open(page: Page, fixture: Fixture, path: string) {
  await page.goto(`/en/notebook?workspaceId=${fixture.workspaceId}&path=${encodeURIComponent(path)}`);
  await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
}
async function createInUi(page: Page, fixture: Fixture, path: string) {
  await page.goto('/en');
  await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New note', exact: true });
  await dialog.getByLabel('Note name', { exact: true }).fill(path);
  await waitForFileCreateBudget();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
    && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === fixture.workspaceId
    && response.request().postDataJSON()?.path === path);
  await dialog.getByRole('button', { name: 'Create and open', exact: true }).click();
  const response = await created;
  await assertCompletedWorkspaceMarkdownCreate(response, { requestId: response.request().postDataJSON().requestId,
    workspaceId: fixture.workspaceId, targetPath: path });
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(url => url.pathname === '/en/notebook' && url.searchParams.get('path') === path);
  await expect(page.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.locator(selector)).toHaveText('');
  return session(page.request, fixture.workspaceId, path);
}
async function pasteMarkdown(page: Page, fixture: Fixture, markdown: string) {
  if (fixture.mobile) {
    await page.locator(selector).tap(); await page.setViewportSize({ width: 390, height: 544 });
    await page.getByRole('button', { name: insertionTitle, exact: true }).filter({ visible: true }).tap();
  } else {
    await page.getByTestId('markdown-toolbar-insert').click();
    await page.getByRole('menuitem', { name: insertionTitle, exact: true }).click();
  }
  const dialog = page.getByRole('dialog', { name: insertionTitle, exact: true });
  const text = dialog.getByRole('textbox', { name: 'Markdown', exact: true });
  await text.focus(); await page.evaluate(value => navigator.clipboard.writeText(value), markdown);
  await page.keyboard.press('ControlOrMeta+v'); await expect(text).toHaveValue(markdown);
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click(); await expect(dialog).toHaveCount(0);
  if (fixture.mobile) await page.setViewportSize(fixture.viewport);
}
function rewriteHrefs(document: JSONContent, replacements: Record<string, string>): JSONContent {
  const expected = structuredClone(document), changed = new Set<string>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) if (mark.type === 'link' && typeof mark.attrs?.href === 'string'
      && Object.hasOwn(replacements, mark.attrs.href)) {
      changed.add(mark.attrs.href); mark.attrs.href = replacements[mark.attrs.href];
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(expected); expect([...changed].sort()).toEqual(Object.keys(replacements).sort()); return expected;
}
async function settled(request: APIRequestContext, fixture: Fixture, operation: WorkspacePathOperationPublic,
  paths: string[], links: number): Promise<WorkspacePathOperationResponse> {
  let latest: WorkspacePathOperationResponse | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/files/operations/batches/${operation.batchId}`, { headers: fixture.headers });
    expect(response.status()).toBe(200); latest = await response.json() as WorkspacePathOperationResponse;
    expect(latest.operation).toMatchObject({ batchId: operation.batchId, planId: operation.planId, workspaceId: fixture.workspaceId });
    expect(['blocked', 'failed', 'needs_recovery', 'needs_review']).not.toContain(latest.operation.status);
    return latest.operation.status;
  }, { timeout: 90_000 }).toBe('applied');
  expect(latest!.operation).toMatchObject({ phase: 'complete', completedActions: 1 + paths.length, totalActions: 1 + paths.length, errorCode: null });
  expect(latest!.linkStatus).toBe('complete');
  expect(latest!.linkUpdates).toEqual({ updatedFiles: [...paths].sort(), updatedLinks: links, warnings: [] });
  return latest!;
}
async function moveInUi(page: Page, fixture: Fixture, source: string, destination: string, kind: 'rename' | 'move',
  updatedPaths: string[], updatedLinks: number, info: TestInfo) {
  await page.goto(`/en/files?workspaceId=${fixture.workspaceId}`);
  const row = page.locator(`[data-file-path="${source}"]`).first(); await expect(row).toBeVisible(); await row.hover();
  await row.getByRole('button', { name: /^More actions for /u }).click();
  await page.getByRole('menuitem', { name: kind === 'rename' ? 'Rename' : 'Move', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${kind === 'rename' ? 'Rename' : 'Move'} "${source}"`, exact: true });
  if (kind === 'rename') await dialog.getByLabel('New name', { exact: true }).fill(destination);
  else {
    const [folder, name] = destination.split('/'); expect(destination.split('/')).toHaveLength(2);
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
    await dialog.getByLabel('New folder name', { exact: true }).fill(folder); await waitForFileCreateBudget();
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
      && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === fixture.workspaceId
      && response.request().postDataJSON()?.path === folder && response.request().postDataJSON()?.type === 'directory');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click(); expect((await created).status()).toBe(200);
    await expect(dialog.getByLabel('Destination folder', { exact: true })).toHaveValue(folder);
  }
  const bounds = await dialog.boundingBox(); expect(bounds).toBeTruthy();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(fixture.viewport.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await dialog.screenshot({ path: info.outputPath('native-path-dialog.png'), animations: 'disabled' });
  const reply = page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/files/rename' || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON();
    return body.dryRun !== true && body.oldPath === source && body.newPath === destination
      && response.request().headers()['x-canvas-workspace-id'] === fixture.workspaceId;
  }, { timeout: 90_000 });
  await dialog.getByRole('button', { name: kind === 'rename' ? 'Rename' : 'Move', exact: true }).click();
  const response = await reply; expect([200, 202]).toContain(response.status());
  const value = await response.json() as WorkspacePathOperationResponse;
  expect(value.operation).toMatchObject({ workspaceId: fixture.workspaceId, selections: [{ sourcePath: source, destinationPath: destination }] });
  expect(value.operation.batchId).toBeTruthy(); expect(value.operation.planId).toMatch(/^[a-f0-9]{64}$/u);
  const final = await settled(page.request, fixture, value.operation, updatedPaths, updatedLinks);
  await expect(dialog).toBeHidden({ timeout: 90_000 });
  const absent = await page.request.get('/api/files/read', { headers: fixture.headers, params: { path: source } }); expect(absent.status()).toBe(404);
  return final.operation;
}
async function freshContext(browser: Browser, fixture: Fixture): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: process.env.BASE_URL,
    storageState: { cookies: await fixture.context.cookies(), origins: [] }, viewport: fixture.viewport,
    hasTouch: fixture.mobile, isMobile: fixture.mobile });
  fixture.contexts.push(context); return context;
}
async function withFixture(browser: Browser, mobile: boolean, operation: (fixture: Fixture) => Promise<void>) {
  const owned = await requireOwnedYjsQaTarget(); expect(owned.activeSpec).toBe(spec);
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 };
  const context = await createAuthenticatedContext(browser, { viewport, hasTouch: mobile, isMobile: mobile });
  let workspaceId: string | undefined, primary: unknown, failed = false;
  const contexts: BrowserContext[] = [];
  try {
    const response = await context.request.post('/api/workspaces', { data: { type: 'personal', name: `Native move ${owned.nonce.slice(0, 8)} ${randomUUID()}` } });
    expect(response.status()).toBe(201); const body = await response.json(); workspaceId = body.workspace.id;
    expect(body.starterDocumentInitialization.status).toBe('completed');
    const availability = await context.request.get('/api/document-review/availability');
    expect(availability.ok()).toBe(true); expect((await availability.json()).data.documentReviewEnabled).toBe(false);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript(({ id, narrow }) => {
      localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
      localStorage.setItem('canvas-browser-mode', narrow ? 'list' : 'tree');
    }, { id: workspaceId!, narrow: mobile });
    await operation({ owned, context, workspaceId: workspaceId!, headers: { 'x-canvas-workspace-id': workspaceId! }, mobile, viewport, contexts });
  } catch (error) { primary = error; failed = true; }
  finally {
    const errors: unknown[] = [];
    for (const child of contexts.reverse()) try { await child.close(); } catch (error) { errors.push(error); }
    for (const page of context.pages()) try { await page.close(); } catch (error) { errors.push(error); }
    try { if (workspaceId) expect((await context.request.delete(`/api/workspaces/${workspaceId}`)).ok()).toBe(true); } catch (error) { errors.push(error); }
    try { await context.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw aggregateOwnedNativeErrors(failed ? primary : undefined, errors, 'Owned native Move browser fixture cleanup failed.');
    if (failed) throw primary;
  }
}

test.describe('native path operations through ordinary UI, durable jobs and original receipts', () => {
  test.skip(process.env.CANVAS_YJS_AUTHORITY_E2E !== '1', 'Requires the original sealed owned QA host; no server fallback.');
  test.setTimeout(300_000);
  for (const mobile of [false, true]) test(`${mobile ? 'mobile Move' : 'desktop Rename'}: manual notes, pasted Markdown, real rich peer and fresh link resolution`, async ({ browser }, info) => {
    await withFixture(browser, mobile, async fixture => {
      const page = await fixture.context.newPage(), source = fileName(), backlink = fileName(), keep = fileName();
      const destination = mobile ? `owned-yjs-restart-${randomUUID()}/${fileName()}` : fileName();
      await createCompletedWorkspaceMarkdownFile({ request: page.request, workspaceId: fixture.workspaceId, filePath: keep });
      const keepBefore = await session(page.request, fixture.workspaceId, keep);
      const sourceInitial = await createInUi(page, fixture, source);
      await pasteMarkdown(page, fixture, `# Moved native note\n\nOutgoing [Keep](${keep}).\n`);
      const sourceBefore = await persisted(page, fixture, source, sourceInitial);
      await closeAndRelease(page, fixture, source, sourceBefore.session);
      const backlinkInitial = await createInUi(page, fixture, backlink);
      await pasteMarkdown(page, fixture, `# Native rich links äöü 😀\n\nIncoming [**Target**](${source}) and [Keep](${keep}).\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n\n\`\`\`custom-widget\n<custom-widget preserve="yes">Do not flatten this literal</custom-widget>\n\`\`\`\n\nPeer paragraph.\n`);
      const peerContext = await freshContext(browser, fixture), peer = await peerContext.newPage();
      await open(peer, fixture, backlink);
      const ownerCandidate = await readNativeRichCandidate(page, selector), peerCandidate = await readNativeRichCandidate(peer, selector);
      expect(peerCandidate.localClient).not.toBe(ownerCandidate.localClient);
      await expect.poll(async () => (await readNativeRichCandidate(peer, selector)).document).toEqual(ownerCandidate.document);
      await (await nativeRichParagraph(peer, selector, 'Peer paragraph.')).click();
      await peer.keyboard.press('End'); await peer.keyboard.insertText(' Written by a real browser peer.');
      await expect(page.locator(selector)).toContainText('Peer paragraph. Written by a real browser peer.');
      const before = await persisted(page, fixture, backlink, backlinkInitial);
      await expect.poll(async () => (await readNativeRichCandidate(peer, selector)).stateProof).toBe(before.candidate.stateProof);
      await peer.close(); await closeAndRelease(page, fixture, backlink, before.session);
      const expectedBacklink = rewriteHrefs(before.candidate.document, { [source]: destination });
      const expectedSource = mobile ? rewriteHrefs(sourceBefore.candidate.document, { [keep]: `../${keep}` }) : sourceBefore.candidate.document;
      const updated = mobile ? [destination, backlink] : [backlink];
      const operation = await moveInUi(page, fixture, source, destination, mobile ? 'move' : 'rename', updated, mobile ? 2 : 1, info);
      const sourceAfter = await session(page.request, fixture.workspaceId, destination), backlinkAfter = await session(page.request, fixture.workspaceId, backlink);
      expect(sourceAfter).toMatchObject({ documentId: sourceBefore.session.documentId, lifecycleGeneration: sourceBefore.session.lifecycleGeneration,
        documentSequence: sourceBefore.session.documentSequence + (mobile ? 1 : 0) });
      if (!mobile) expect(sourceAfter).toMatchObject({ stateProof: sourceBefore.session.stateProof, stateVector: sourceBefore.session.stateVector });
      expect(backlinkAfter).toMatchObject({ documentId: before.session.documentId, lifecycleGeneration: before.session.lifecycleGeneration,
        documentSequence: before.session.documentSequence + 1 });
      expect(backlinkAfter.stateProof).not.toBe(before.session.stateProof);
      expect(await session(page.request, fixture.workspaceId, keep)).toMatchObject({ documentId: keepBefore.documentId,
        lifecycleGeneration: keepBefore.lifecycleGeneration, documentSequence: keepBefore.documentSequence, stateProof: keepBefore.stateProof, stateVector: keepBefore.stateVector });
      const fresh = await freshContext(browser, fixture), reopened = await fresh.newPage();
      await open(reopened, fixture, backlink);
      const actualBacklink = await readNativeRichCandidate(reopened, selector); expect(actualBacklink.document).toEqual(expectedBacklink);
      expect(actualBacklink.stateProof).toBe(backlinkAfter.stateProof); expect(actualBacklink.stateVector).toBe(backlinkAfter.stateVector);
      await expect(reopened.locator(selector).locator('table')).toContainText('Alpha');
      await expect(reopened.locator(selector).locator('pre')).toContainText('<custom-widget preserve="yes">Do not flatten this literal</custom-widget>');
      await expect(reopened.locator(selector).locator(`a[href="${source}"]`)).toHaveCount(0);
      await expect(reopened.locator(selector).locator(`a[href="${destination}"]`)).toHaveText('Target');
      await reopened.screenshot({ path: info.outputPath('native-move-rich-peer-preserved.png'), animations: 'disabled' });
      if (!mobile) {
        await reopened.locator(selector).getByRole('link', { name: 'Target', exact: true }).click({ modifiers: ['Control'] });
        await expect(reopened.getByTestId('document-header')).toContainText(destination);
        await expect(reopened.locator(selector).getByRole('heading', { name: 'Moved native note', exact: true })).toBeVisible();
      } else await open(reopened, fixture, destination);
      await expect(reopened.locator(selector)).toHaveAttribute('contenteditable', 'true');
      const actualSource = await readNativeRichCandidate(reopened, selector); expect(actualSource.document).toEqual(expectedSource);
      expect(actualSource.stateProof).toBe(sourceAfter.stateProof); expect(actualSource.stateVector).toBe(sourceAfter.stateVector);
      await closeAndRelease(reopened, fixture, destination, sourceAfter);
      await settled(fresh.request, fixture, operation, updated, mobile ? 2 : 1);
      info.annotations.push({ type: 'acceptance-scope', description: 'Actual manual UI creation, browser clipboard Markdown insertion, independent authenticated browser peer, UI path action and fresh native PM equality. Unknown markup is deliberately literal fenced code; arbitrary unsupported native nodes are not claimed supported. Mobile keyboard height is emulated, with no OS/device clipboard or Undo claim.' });
    });
  });

  test('desktop genuine pre-batch preparation survives reload and continues only through its original UUID', async ({ browser }, info) => {
    await withFixture(browser, false, async fixture => {
      const page = await fixture.context.newPage(), source = fileName(), destination = fileName(), backlink = fileName();
      const initial = await createInUi(page, fixture, source);
      await pasteMarkdown(page, fixture, '# Original pending source\n\nThe exact native paragraph remains.\n');
      const before = await persisted(page, fixture, source, initial); await closeAndRelease(page, fixture, source, before.session);
      const backlinkInitial = await createInUi(page, fixture, backlink);
      await pasteMarkdown(page, fixture, `# Pending backlink\n\nRead [**Target**](${source}).\n\nIndependent paragraph.\n`);
      const backlinkBefore = await persisted(page, fixture, backlink, backlinkInitial);
      await closeAndRelease(page, fixture, backlink, backlinkBefore.session);
      const expectedBacklink = rewriteHrefs(backlinkBefore.candidate.document, { [source]: destination });
      const target = { version: 1 as const,
        target: { nonce: fixture.owned.nonce, repo: fixture.owned.repo, head: fixture.owned.head,
          sourceFingerprint: fixture.owned.sourceFingerprint, buildFingerprint: fixture.owned.buildFingerprint,
          buildId: fixture.owned.buildId, receiptIdentity: ownedNativeFileRoomReceiptIdentity(fixture.owned) },
        room: { documentId: before.session.documentId, path: source, generation: before.session.lifecycleGeneration,
          expectedWorkspaceId: fixture.workspaceId },
        expectedSession: { documentSequence: before.session.documentSequence,
          stateProof: before.session.stateProof, stateVector: before.session.stateVector } };
      const holder = await holdOwnedNativeMoveSharedRoom(target);
      let preparation: WorkspaceImplicitMovePreparationPublicV2 | undefined, complete = false, failed = false, primary: unknown;
      try {
        expect(holder.held).toMatchObject({ workspaceId: fixture.workspaceId, documentId: before.session.documentId,
          mode: 'ShareLock', lockCount: 1 });
        const auth = await fixture.context.request.get('/api/auth/get-session'); expect(auth.status()).toBe(200);
        const actorUserId = (await auth.json()).user.id as string, operationId = randomUUID();
        // API -> UI boundary: one genuine authenticated request creates the
        // preparation. No active Rename client's automatic continuation spans
        // the following navigation/reload, so passive POST observations are exact.
        const started = performance.now();
        const pending = await fixture.context.request.post('/api/files/rename', { headers: fixture.headers, timeout: 60_000,
          data: { oldPath: source, newPath: destination, idempotencyKey: operationId } });
        expect(pending.status()).toBe(202); const initialWaitMs = Math.round(performance.now() - started);
        const payload = await pending.json(); expect(payload.operation).toBeUndefined();
        preparation = readWorkspaceImplicitMovePreparation(payload.preparation, { actorUserId, workspaceId: fixture.workspaceId,
          operationId, action: 'rename', selections: [{ sourcePath: source, destinationPath: destination }] });
        expect(preparation.state).toBe('pending'); if (preparation.state !== 'pending') throw new Error('Expected real pending preparation.');
        expect(['reserved', 'draining']).toContain(preparation.status); expect(preparation.canResume).toBe(true);
        const saved = preparation;
        const observed = await room(fixture, source, before.session);
        expect(observed).toMatchObject({ ownerTupleCleared: true, admissionPending: true, version: { sequence: before.session.documentSequence, stateProof: before.session.stateProof } });
        const itemId = `file-path-preparation:${saved.requestId}`;
        const census = await fixture.context.request.get('/api/notifications/summary?todoMode=lifecycle', { headers: fixture.headers });
        expect(census.status()).toBe(200);
        expect((await census.json()).data.sections.notifications).toEqual(expect.arrayContaining([expect.objectContaining({
          id: itemId, workspaceId: fixture.workspaceId, target: expect.objectContaining({
            workspaceId: fixture.workspaceId, preparationRequestId: saved.requestId, operationKind: 'rename', status: 'pending' }) })]));
        const traffic: Array<{ path: string; method: string }> = [];
        page.on('request', request => {
          const path = new URL(request.url()).pathname;
          if (path === '/api/files/rename' || path.startsWith('/api/files/operations/implicit-moves/')) {
            traffic.push({ path, method: request.method() });
          }
        });
        await page.goto(`/en?workspaceId=${fixture.workspaceId}`); await page.reload();
        const row = page.locator('#home-attention-items').locator(`[data-notification-id="${itemId}"]`);
        await expect(row).toBeVisible({ timeout: 60_000 });
        await row.getByRole('link').click();
        const status = page.getByTestId('workspace-path-operation-status'); await expect(status).toBeVisible();
        await expect(status).toContainText(source); await expect(status).toContainText(destination);
        await expect(page.getByTestId('workspace-path-operation-resume')).toBeEnabled();
        await expect.poll(() => traffic.filter(request => request.path === saved.statusUrl && request.method === 'GET').length,
          { timeout: 10_000 }).toBeGreaterThanOrEqual(2); // real mount + existing 2s passive poll
        expect(traffic.filter(request => request.method === 'POST')).toEqual([]);
        await status.getByRole('button', { name: 'Close', exact: true }).last().click();
        await page.reload(); await expect(row).toBeVisible({ timeout: 60_000 });
        await page.goto(`/en/notebook?workspaceId=${fixture.workspaceId}&workspacePathPreparation=${saved.requestId}`);
        await expect(status).toBeVisible(); await expect(status).toContainText(source);
        await expect(page.getByTestId('workspace-path-operation-resume')).toBeEnabled();
        expect(traffic.filter(request => request.method === 'POST')).toEqual([]);
        const requested = page.waitForRequest(request => new URL(request.url()).pathname === saved.resumeUrl && request.method() === 'POST');
        const resumed = page.waitForResponse(response => new URL(response.url()).pathname === saved.resumeUrl
          && response.request().method() === 'POST', { timeout: 90_000 });
        void requested.catch(() => {}); void resumed.catch(() => {});
        await page.getByTestId('workspace-path-operation-resume').click();
        const actualRequest = await requested;
        expect(actualRequest.headers()['x-canvas-workspace-id']).toBe(fixture.workspaceId);
        expect(actualRequest.postData()).toBeNull();
        await holder.release();
        const response = await resumed; expect([200, 202]).toContain(response.status());
        const result = await response.json() as WorkspacePathOperationResponse;
        const binding = readWorkspaceImplicitMoveBinding(result.operation.implicitBinding, {
          actorUserId, workspaceId: fixture.workspaceId, operationId, requestId: saved.requestId, selectionDigest: saved.selectionDigest });
        expect(binding.requestId).toBe(saved.requestId);
        const final = await settled(fixture.context.request, fixture, result.operation, [backlink], 1); complete = true;
        await expect(status).toContainText('Files and links updated', { timeout: 90_000 });
        expect(traffic.filter(request => request.method === 'POST')).toEqual([{ path: saved.resumeUrl, method: 'POST' }]);
        const after = await session(fixture.context.request, fixture.workspaceId, destination);
        expect(after).toMatchObject({ documentId: before.session.documentId, lifecycleGeneration: before.session.lifecycleGeneration,
          documentSequence: before.session.documentSequence, stateProof: before.session.stateProof, stateVector: before.session.stateVector });
        const backlinkAfter = await session(fixture.context.request, fixture.workspaceId, backlink);
        expect(backlinkAfter).toMatchObject({ documentId: backlinkBefore.session.documentId,
          lifecycleGeneration: backlinkBefore.session.lifecycleGeneration, documentSequence: backlinkBefore.session.documentSequence + 1 });
        expect((await fixture.context.request.get('/api/files/read', { headers: fixture.headers, params: { path: source } })).status()).toBe(404);
        const original = await fixture.context.request.get(saved.statusUrl, { headers: fixture.headers }); expect(original.status()).toBe(200);
        expect((await original.json()).operation).toMatchObject({ batchId: final.operation.batchId, planId: final.operation.planId,
          implicitBinding: binding, status: 'applied', phase: 'complete' });
        await status.getByRole('button', { name: 'Close', exact: true }).last().click();
        const fresh = await freshContext(browser, fixture), reopened = await fresh.newPage(); await open(reopened, fixture, backlink);
        expect((await readNativeRichCandidate(reopened, selector)).document).toEqual(expectedBacklink);
        await expect(reopened.locator(selector).locator(`a[href="${destination}"]`)).toHaveText('Target');
        await reopened.screenshot({ path: info.outputPath('pending-reload-original-uuid-complete.png'), animations: 'disabled' });
        await closeAndRelease(reopened, fixture, backlink, backlinkAfter);
        await info.attach('pending-acceptance-scope', { body: JSON.stringify({ version: 1,
          initialBoundary: 'real authenticated API -> ordinary browser UI', initialWaitMs,
          holderMode: holder.held.mode, originalRequestId: saved.requestId, completedBatchId: final.operation.batchId,
          passivePosts: 0, explicitResumePosts: 1 }), contentType: 'application/json' });
      } catch (error) { failed = true; primary = error; }
      finally {
        const errors: unknown[] = [];
        let releaseConfirmed = false;
        try { await holder.release(); releaseConfirmed = true; } catch (error) { errors.push(error); }
        // Dispose a real saved pending selection through its original API only
        // after releasing the test lock; never cancel/rewrite rows by SQL.
        if (preparation && !complete && releaseConfirmed) try {
          const response = await fixture.context.request.post(`/api/files/operations/implicit-moves/${preparation.requestId}`,
            { headers: fixture.headers, timeout: 60_000 }); expect([200, 202]).toContain(response.status());
          const payload = await response.json() as WorkspacePathOperationResponse;
          expect(payload.operation).toBeTruthy(); await settled(fixture.context.request, fixture, payload.operation, [backlink], 1);
        } catch (error) { errors.push(error); }
        if (errors.length) throw aggregateOwnedNativeErrors(failed ? primary : undefined, errors, 'Owned Pending browser control cleanup failed.');
        if (failed) throw primary;
      }
    });
  });

  test('desktop PDF asset Move retains uploaded bytes and updates its actual native backlink', async ({ browser }, info) => {
    await withFixture(browser, false, async fixture => {
      const page = await fixture.context.newPage(), pdf = `owned-native-${randomUUID()}.pdf`, backlink = fileName();
      const destination = `owned-yjs-restart-${randomUUID()}/${pdf}`;
      const bytes = await readFile('tests/fixtures/pdf-viewer-layers.pdf');
      const upload = await page.request.post('/api/files/upload', { headers: fixture.headers, multipart: {
        path: '.', files: { name: pdf, mimeType: 'application/pdf', buffer: bytes },
      } }); expect(upload.status()).toBe(200);
      const initial = await createInUi(page, fixture, backlink);
      await pasteMarkdown(page, fixture, `# PDF reference\n\nRead [**original PDF**](${pdf}).\n\nUnrelated paragraph stays.\n`);
      const before = await persisted(page, fixture, backlink, initial); await closeAndRelease(page, fixture, backlink, before.session);
      const expected = rewriteHrefs(before.candidate.document, { [pdf]: destination });
      const operation = await moveInUi(page, fixture, pdf, destination, 'move', [backlink], 1, info);
      const after = await session(page.request, fixture.workspaceId, backlink);
      expect(after).toMatchObject({ documentId: before.session.documentId, lifecycleGeneration: before.session.lifecycleGeneration,
        documentSequence: before.session.documentSequence + 1 });
      const fresh = await freshContext(browser, fixture), reopened = await fresh.newPage(); await open(reopened, fixture, backlink);
      const actual = await readNativeRichCandidate(reopened, selector); expect(actual.document).toEqual(expected);
      expect(actual.stateProof).toBe(after.stateProof); expect(actual.stateVector).toBe(after.stateVector);
      const downloaded = await fresh.request.get('/api/files/download', { headers: fixture.headers, params: { path: destination } });
      expect(downloaded.status()).toBe(200); expect(await downloaded.body()).toEqual(bytes);
      await expect(reopened.locator(selector).locator(`a[href="${destination}"]`)).toHaveText('original PDF');
      await reopened.screenshot({ path: info.outputPath('pdf-native-backlink-after-move.png'), animations: 'disabled' });
      await closeAndRelease(reopened, fixture, backlink, after); await settled(fresh.request, fixture, operation, [backlink], 1);
    });
  });

  test('mobile unsupported Source HTML blocks a path action and retains exact native source', async ({ browser }, info) => {
    await withFixture(browser, true, async fixture => {
      const page = await fixture.context.newPage(), source = fileName(), destination = fileName(), target = fileName();
      await createCompletedWorkspaceMarkdownFile({ request: page.request, workspaceId: fixture.workspaceId, filePath: target });
      const markdown = `---\ntitle: Preserve unsupported Source\ncustom:\n  keep: true\n---\n\n# Source retained\n\n<custom-widget preserve="yes"><a href="${target}">Exact unsupported HTML</a></custom-widget>\n`;
      await page.goto('/en'); await page.getByTestId('home-files').getByRole('button', { name: 'Import files', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
      const completed = page.waitForResponse(response => /^\/api\/files\/uploads\/[^/]+\/complete$/u.test(new URL(response.url()).pathname)
        && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === fixture.workspaceId);
      await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: source, mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
      expect((await completed).status()).toBe(200); await expect(dialog).toHaveCount(0);
      await page.goto(`/en/notebook?workspaceId=${fixture.workspaceId}&path=${encodeURIComponent(source)}`);
      await expect(page.locator('.markdown-source-shell .cm-content')).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
      await expect(page.locator(selector)).toHaveCount(0);
      const before = await session(page.request, fixture.workspaceId, source, 'plain_text');
      const read = async () => {
        const response = await fixture.context.request.get('/api/files/read', { headers: fixture.headers, params: { path: source } });
        expect(response.status()).toBe(200); return (await response.json()).data.content as string;
      };
      expect(await read()).toBe(markdown); await page.close();
      const rejected = await fixture.context.request.post('/api/files/rename', { headers: fixture.headers,
        data: { oldPath: source, newPath: destination, idempotencyKey: randomUUID() } });
      expect(rejected.status()).toBe(409); expect(await rejected.json()).toMatchObject({ code: 'NATIVE_MOVE_PLAN_UNSUPPORTED' });
      expect(await read()).toBe(markdown);
      expect(await session(fixture.context.request, fixture.workspaceId, source, 'plain_text')).toMatchObject({ documentId: before.documentId,
        lifecycleGeneration: before.lifecycleGeneration, documentSequence: before.documentSequence, stateProof: before.stateProof, stateVector: before.stateVector });
      const absent = await fixture.context.request.get('/api/files/read', { headers: fixture.headers, params: { path: destination } }); expect(absent.status()).toBe(404);
      const fresh = await freshContext(browser, fixture), reopened = await fresh.newPage();
      await reopened.goto(`/en/notebook?workspaceId=${fixture.workspaceId}&path=${encodeURIComponent(source)}`);
      await expect(reopened.locator('.markdown-source-shell .cm-content')).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
      await expect(reopened.locator('.cm-line').filter({ hasText: 'Exact unsupported HTML' })).toBeVisible();
      await reopened.screenshot({ path: info.outputPath('unsupported-source-action-blocked-preserved.png'), animations: 'disabled' });
      info.annotations.push({ type: 'acceptance-scope', description: 'Real Markdown-file import remains native Source/plain_text. Unsupported local HTML links explicitly block Rename and retain source bytes/ID/proof/vector; this is no support claim for HTML rewriting or PDF-to-notebook conversion.' });
    });
  });
});
