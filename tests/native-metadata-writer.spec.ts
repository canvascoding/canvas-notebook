import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import type { WorkspaceFileMetadataTarget } from '../app/lib/files/workspace-file-metadata-contract';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { observeNativeDurabilityAcknowledgements } from './helpers/native-durability-ack';
import { aggregateOwnedNativeErrors, runOwnedNativeCommand } from './helpers/owned-native-command';

const editorSelector = '.tiptap-editor-shell .ProseMirror';
type Workspace = { id: string; name: string; legacy: boolean; status: string;
  permissions: { canRead: boolean; canWrite: boolean } };
type FileInfo = { path: string; title?: string | null; isFavorite?: boolean; pinnedAt?: number | null;
  metadataTarget?: WorkspaceFileMetadataTarget };
type NativeTarget = Extract<WorkspaceFileMetadataTarget, { kind: 'native_file' }>;
type Durable = { documentId: string; generation: number; sequence: number; stateProof: string;
  content: { kind: 'rich_text'; document: JSONContent };
  projection: { checkpointSequence: number; checkpointedAt: number | null; error?: unknown } };

async function json<T>(response: APIResponse): Promise<T> {
  try { expect(response.status()).toBe(200); return await response.json() as T; }
  finally { await response.dispose(); }
}

async function withOwnedContext(browser: Browser, operation: (context: BrowserContext, workspace: Workspace) => Promise<void>) {
  const target = await requireOwnedYjsQaTarget();
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 950 } });
  let failed = false, failure: unknown;
  try {
    const actor = await json<{ user: { id: string } }>(await context.request.get('/api/auth/get-session'));
    expect(actor.user.id).toBe(target.actorId);
    const off = await json<{ success: boolean; data: { documentReviewEnabled: boolean } }>(
      await context.request.patch('/api/admin/experimental-settings', {
        headers: { Origin: process.env.BASE_URL! }, data: { documentReviewEnabled: false },
      }));
    expect(off).toMatchObject({ success: true, data: { documentReviewEnabled: false } });
    expect((await json<{ data: { documentReviewEnabled: boolean } }>(
      await context.request.get('/api/server-settings'))).data.documentReviewEnabled).toBe(false);
    const listing = await json<{ workspaces: Workspace[] }>(await context.request.get('/api/workspaces'));
    const workspace = listing.workspaces.find(value => value.name === 'Shared Test Workspace'
      && !value.legacy && value.status === 'active' && value.permissions.canRead && value.permissions.canWrite);
    assert(workspace);
    await operation(context, workspace);
  } catch (cause) { failed = true; failure = cause; }
  // Leave the synthetic files in the owned DATA. The original supervisor owns
  // its final cleanup; failures retain their actual document/metadata evidence.
  try { await context.close(); }
  catch (cause) { throw aggregateOwnedNativeErrors(failed ? failure : undefined, [cause], 'Metadata browser context closure failed.'); }
  if (failed) throw failure;
}

async function info(request: APIRequestContext, workspace: Workspace, filePath: string): Promise<FileInfo> {
  const value = await json<{ success: boolean; data: FileInfo }>(await request.get(
    `/api/files/info?${new URLSearchParams({ path: filePath })}`, { headers: { 'x-canvas-workspace-id': workspace.id } }));
  expect(value.success).toBe(true); expect(value.data.path).toBe(filePath);
  assert(value.data.metadataTarget);
  expect(value.data.metadataTarget).toMatchObject({ version: 1, workspaceId: workspace.id, path: filePath });
  return value.data;
}

async function patch(request: APIRequestContext, workspace: Workspace, target: WorkspaceFileMetadataTarget,
  change: { title: string; isFavorite: boolean; pinned: boolean }) {
  const value = await json<{ success: boolean }>(await request.patch('/api/files/metadata', {
    headers: { 'x-canvas-workspace-id': workspace.id }, data: { path: target.path, expectedTarget: target, ...change },
  }));
  expect(value.success).toBe(true);
}

async function rejectedPatch(request: APIRequestContext, workspace: Workspace, target: WorkspaceFileMetadataTarget) {
  const response = await request.patch('/api/files/metadata', {
    headers: { 'x-canvas-workspace-id': workspace.id }, data: {
      path: target.path, expectedTarget: target, title: 'Rejected metadata title', isFavorite: false, pinned: false,
    },
  });
  try {
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: 'FILE_METADATA_SCOPE_CHANGED' });
  } finally { await response.dispose(); }
}

async function createDocument(page: Page, workspace: Workspace, filePath: string) {
  await page.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  await page.goto('/en');
  await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New note', exact: true });
  await dialog.getByLabel('Note name', { exact: true }).fill(filePath); await waitForFileCreateBudget();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
    && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id
    && response.request().postDataJSON()?.path === filePath);
  await dialog.getByRole('button', { name: 'Create and open', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const request = response.request().postDataJSON() as { requestId: string };
  expect(request.requestId).toMatch(/^[a-f0-9-]{36}$/iu);
  expect(await response.json()).toEqual({ success: true, completion: {
    status: 'completed', requestId: request.requestId, workspaceId: workspace.id, targetPath: filePath,
  } });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.locator(editorSelector)).toHaveText('');
}

async function durable(target: NativeTarget): Promise<Durable> {
  const input = Buffer.from(JSON.stringify({ documentId: target.documentId, workspaceId: target.workspaceId,
    path: target.path, generation: target.lifecycleGeneration })).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx',
    'scripts/owned-yjs-authority-storage-read.ts', input],
  { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });
  expect(result.receipt).toMatchObject({ exitVerified: true, exitCode: 0 });
  return JSON.parse(result.stdout) as Durable;
}

async function expectFavoritesUi(page: Page, workspace: Workspace, filePath: string, title: string) {
  const panel = page.getByTestId('home-files');
  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  await panel.getByRole('combobox', { name: 'File view', exact: true }).selectOption('favorites');
  await panel.getByRole('textbox', { name: 'Search files …', exact: true }).fill(title);
  const link = panel.getByRole('link').filter({ hasText: title });
  await expect(link).toHaveCount(1); await expect(link.getByText(title, { exact: true })).toBeVisible();
  await expect(link.getByLabel('Pinned', { exact: true })).toBeVisible();
  const href = await link.getAttribute('href'); assert(href);
  const url = new URL(href, 'http://owned.invalid');
  expect(url.searchParams.get('path')).toBe(filePath); expect(url.searchParams.get('workspaceId')).toBe(workspace.id);
}

test('Native metadata uses the active document identity without changing its durable rich state', async ({ browser }) => {
  test.setTimeout(240_000);
  await withOwnedContext(browser, async (context, workspace) => {
    const page = await context.newPage(), acknowledgements = observeNativeDurabilityAcknowledgements(page);
    const filePath = `owned-yjs-restart-${randomUUID()}.md`, title = `Native metadata ${randomUUID()}`;
    try {
      await createDocument(page, workspace, filePath);
      const initial = await info(context.request, workspace, filePath);
      assert(initial.metadataTarget?.kind === 'native_file'); const target = initial.metadataTarget;
      const text = 'Metadata keeps this native paragraph.';
      await page.locator(editorSelector).focus(); await page.keyboard.insertText(`X${text}`);
      await expect(page.locator(editorSelector)).toHaveText(`X${text}`);
      const beforeDelete = await readNativeRichCandidate(page, editorSelector);
      await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Delete');
      await expect(page.locator(editorSelector)).toHaveText(text);
      const candidate = await readNativeRichCandidate(page, editorSelector);
      expect(candidate.stateVector).toBe(beforeDelete.stateVector);
      expect(candidate.stateProof).not.toBe(beforeDelete.stateProof);
      await expect.poll(() => acknowledgements.hasAcknowledged(target, candidate), { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        const value = await durable(target);
        return { documentId: value.documentId, generation: value.generation, stateProof: value.stateProof,
          document: value.content.document, projected: value.projection.checkpointSequence === value.sequence, error: value.projection.error };
      }, { timeout: 45_000, intervals: [250, 500, 1_000] }).toEqual({ documentId: target.documentId,
        generation: target.lifecycleGeneration, stateProof: candidate.stateProof, document: candidate.document, projected: true, error: undefined });
      const saved = await durable(target);
      await patch(context.request, workspace, target, { title, isFavorite: true, pinned: true });
      await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true');
      expect(await readNativeRichCandidate(page, editorSelector)).toEqual(candidate);
      expect(await durable(target)).toEqual(saved);
      const annotated = await info(context.request, workspace, filePath);
      expect(annotated).toMatchObject({ title, isFavorite: true, metadataTarget: target });
      expect(Number.isSafeInteger(annotated.pinnedAt)).toBe(true); expect(annotated.pinnedAt).toBeGreaterThan(0);

      // A valid but mismatched generation is rejected atomically. This is not
      // a Move/recreate test; those lifecycle operations have separate coverage.
      await rejectedPatch(context.request, workspace, { ...target, lifecycleGeneration: target.lifecycleGeneration + 1 });
      expect(await info(context.request, workspace, filePath)).toEqual(annotated);
      expect(await readNativeRichCandidate(page, editorSelector)).toEqual(candidate);
      expect(await durable(target)).toEqual(saved);

      const home = await context.newPage();
      await home.goto('/en');
      await expectFavoritesUi(home, workspace, filePath, title);
      await home.reload(); await expectFavoritesUi(home, workspace, filePath, title);
      expect(await info(context.request, workspace, filePath)).toEqual(annotated);
      expect(await readNativeRichCandidate(page, editorSelector)).toEqual(candidate);
      expect(await durable(target)).toEqual(saved);
    } finally { acknowledgements.dispose(); }
  });
});

test('Physical metadata requires the current file version and rejects an old version without partial changes', async ({ browser }) => {
  test.setTimeout(180_000);
  await withOwnedContext(browser, async (context, workspace) => {
    // CSV uses revision_check; .txt creates an active CRDT document on read
    // and correctly rejects the whole-file writer used by this countercase.
    const filePath = `owned-yjs-restart-${randomUUID()}.csv`, title = `Physical metadata ${randomUUID()}`;
    const headers = { 'x-canvas-workspace-id': workspace.id };
    await waitForFileCreateBudget();
    expect(await json<{ success: boolean }>(await context.request.post('/api/files/create', {
      headers, data: { path: filePath, type: 'file' },
    }))).toMatchObject({ success: true });
    const initial = await info(context.request, workspace, filePath);
    assert(initial.metadataTarget?.kind === 'filesystem'); const target = initial.metadataTarget;
    expect(target.entryType).toBe('file');
    const read = async () => json<{ success: boolean; data: { content: string; stats: { sha256: string; fileVersion: string };
      revision: { id: string } | null } }>(await context.request.get(
      `/api/files/read?${new URLSearchParams({ path: filePath })}`, { headers }));
    const before = await read(); expect(before.success).toBe(true); expect(before.data.content).toBe('');
    expect(before.data.stats.fileVersion).toBe(target.fileVersion);
    await patch(context.request, workspace, target, { title, isFavorite: true, pinned: true });
    const annotated = await info(context.request, workspace, filePath);
    expect(annotated).toMatchObject({ title, isFavorite: true, metadataTarget: target });
    expect(Number.isSafeInteger(annotated.pinnedAt)).toBe(true); expect(annotated.pinnedAt).toBeGreaterThan(0);
    expect(await read()).toEqual(before);

    // The ordinary revision-checked writer creates the new physical identity;
    // neither the fixture nor the metadata endpoint writes the file directly.
    const content = 'Changed through the ordinary file write API.\n';
    expect(await json<{ success: boolean }>(await context.request.post('/api/files/write', {
      headers, data: { path: filePath, content, expectedSha256: before.data.stats.sha256,
        baseRevisionId: before.data.revision?.id ?? null },
    }))).toMatchObject({ success: true });
    const changed = await read(); expect(changed.data.content).toBe(content);
    expect(changed.data.stats.fileVersion).not.toBe(target.fileVersion);
    const current = await info(context.request, workspace, filePath);
    assert(current.metadataTarget?.kind === 'filesystem');
    expect(current.metadataTarget.fileVersion).toBe(changed.data.stats.fileVersion);
    expect(current).toMatchObject({ title, isFavorite: true, pinnedAt: annotated.pinnedAt });
    await rejectedPatch(context.request, workspace, target);
    expect(await info(context.request, workspace, filePath)).toEqual(current);
    expect(await read()).toEqual(changed);
    const alias = await context.request.get(`/api/files/info?${new URLSearchParams({ path: ` ${filePath}` })}`, { headers });
    try { expect(alias.status()).toBe(409); expect(await alias.json()).toMatchObject({ success: false }); }
    finally { await alias.dispose(); }
    expect(await info(context.request, workspace, filePath)).toEqual(current);
  });
});
