import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import type { WorkspaceOperationReviewPublic, WorkspaceOperationReviewKind } from '../app/lib/files/workspace-operation-review-contract';

const run = promisify(execFile);
type Action = { kind: WorkspaceOperationReviewKind; selections: Array<{ sourcePath: string; destinationPath?: string }> };
type Batch = { batchId: string; planId: string; status: string; errorCode: string | null; completedActions: number;
  totalActions: number; preview: { readiness: string; actions: Action[]; linkEdits: unknown[]; issues: Array<{ code: string }> } };

async function workspace(browser: Browser, body: (scope: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const scope = await setup(browser);
  try { await body(scope); }
  finally {
    const cleanup = await scope.context.request.delete(`/api/workspaces/${scope.workspaceId}`);
    expect(cleanup.ok()).toBeTruthy();
    await scope.context.close();
  }
}

async function setup(browser: Browser) {
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
  const session = await context.request.get('/api/auth/get-session');
  expect(session.ok()).toBeTruthy();
  const { user } = await session.json();
  const created = await context.request.post('/api/workspaces', {
    data: { type: 'personal', name: `E2E batch review ${process.env.CANVAS_BATCH_E2E_RUN_ID || 'standalone'} ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const workspaceId = (await created.json()).workspace.id as string;
  const headers = { 'x-canvas-workspace-id': workspaceId };
  const upload = (filePath: string, content: string) => uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content });
  const read = async (filePath: string) => {
    const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
    expect(response.ok(), `Read ${filePath}`).toBeTruthy();
    return (await response.json()).data.content as string;
  };
  const edit = async (filePath: string, content: string) => {
    const response = await context.request.post('/api/files/collaboration/session', {
      headers, data: { path: filePath, representation: 'plain_text' },
    });
    expect(response.ok()).toBeTruthy();
    const session = await response.json();
    expect(session.representation).toBe('plain_text');
    const doc = new Y.Doc();
    const cookies = (await context.cookies(process.env.BASE_URL)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    class AuthenticatedTestSocket extends WebSocket {
      constructor(address: string) { super(address, { origin: process.env.BASE_URL, headers: { Cookie: cookies } }); }
    }
    const socket = new HocuspocusProviderWebsocket({
      url: new URL(session.websocketUrl, process.env.BASE_URL).href.replace(/^http/u, 'ws'),
      preserveTrailingSlash: true, WebSocketPolyfill: AuthenticatedTestSocket,
    });
    const provider = new HocuspocusProvider({ websocketProvider: socket,
      name: session.documentName, token: session.token, document: doc });
    provider.attach();
    try {
      await expect.poll(() => provider.isSynced, { timeout: 30_000 }).toBe(true);
      doc.transact(() => {
        const text = doc.getText('content');
        text.delete(0, text.length);
        text.insert(0, content);
      });
      await expect.poll(async () => {
        const checkpoint = await context.request.post('/api/files/collaboration/checkpoint', {
          headers, data: { token: session.token,
            stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
            stateProof: collaborationStateProof(doc, Y) },
        });
        return checkpoint.ok();
      }, { timeout: 30_000 }).toBe(true);
      expect(await read(filePath)).toBe(content);
    } finally { provider.destroy(); socket.destroy(); doc.destroy(); }
  };
  const absent = async (filePath: string) => {
    const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
    expect(response.status(), `Absent ${filePath}`).toBe(404);
  };
  const submit = async (actions: Action[]): Promise<WorkspaceOperationReviewPublic[]> => {
    const result = await run(process.execPath, ['--conditions=react-server', '--import', 'tsx',
      'scripts/workspace-operation-batch-e2e-fixture.ts', JSON.stringify({ workspaceId, user, actions })],
    { cwd: process.cwd(), env: process.env, timeout: 90_000 });
    const line = result.stdout.split('\n').find((value) => value.startsWith('BATCH_FIXTURE:'));
    expect(line).toBeTruthy();
    const submissions = JSON.parse(line!.slice('BATCH_FIXTURE:'.length)) as Array<{ reviewId: string }>;
    return Promise.all(submissions.map(async ({ reviewId }) => {
      const response = await context.request.get(`/api/files/operation-reviews/${reviewId}`, { headers });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).review as WorkspaceOperationReviewPublic;
    }));
  };
  const preview = async (reviews: WorkspaceOperationReviewPublic[]): Promise<Batch> => {
    const response = await context.request.post('/api/files/operation-reviews/batches', {
      headers, data: { action: 'preview', reviewIds: reviews.map((review) => review.reviewId) },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).batch;
  };
  const accept = (batch: Batch) => context.request.post('/api/files/operation-reviews/batches', {
    headers, data: { action: 'accept', batchId: batch.batchId, planId: batch.planId },
  });
  const readBatch = async (batch: Batch): Promise<Batch> => {
    const response = await context.request.get(`/api/files/operation-reviews/batches/${batch.batchId}`, { headers });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).batch;
  };
  const done = async (batch: Batch) => {
    await expect.poll(async () => (await readBatch(batch)).status, { timeout: 90_000 }).toBe('applied');
    const applied = await readBatch(batch);
    expect(applied.completedActions).toBe(applied.totalActions);
    return applied;
  };
  const refresh = async (review: WorkspaceOperationReviewPublic): Promise<WorkspaceOperationReviewPublic> => {
    const response = await context.request.post(`/api/files/operation-reviews/${review.reviewId}`, {
      headers, data: { action: 'refresh', planId: review.planId },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).review;
  };
  await context.addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
  return { context, workspaceId, headers, upload, read, edit, absent, submit, preview, accept, readBatch, done, refresh };
}

const move = (sourcePath: string, destinationPath: string): Action => ({ kind: 'move', selections: [{ sourcePath, destinationPath }] });
const remove = (sourcePath: string): Action => ({ kind: 'delete', selections: [{ sourcePath }] });

test.describe('durable file review batches', () => {
  test.describe.configure({ mode: 'default' });
  test.setTimeout(180_000);

  test('UI approves mutually linked moves together and worker finishes after closing the review', async ({ browser }, info) => {
    await workspace(browser, async (s) => {
      await s.upload('source/A.md', '# A\n[B](B.md#details)\n[Keep](../assets/keep.md)\n');
      await s.upload('source/B.md', '# B\n[A](A.md)\n');
      await s.upload('source/group/child.md', '# Child\n');
      await s.upload('assets/keep.md', '# Keep\n');
      await s.upload('notes/index.md', '[A](../source/A.md) [B](../source/B.md)\n');
      await s.upload('archive/old.md', '[Existing missing](missing.md)\n');
      const reviews = await s.submit([move('source/A.md', 'final/A.md'), move('source/B.md', 'final/sub/B.md'),
        move('source/group', 'final/group')]);
      const page = await s.context.newPage();
      await page.goto(`/en/notebook?workspaceId=${s.workspaceId}&workspaceOperationReview=${reviews[0].reviewId}`);
      const panel = page.getByTestId('workspace-operation-review-center');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('workspace-operation-technical-details')).toBeAttached({ timeout: 60_000 });
      await expect(panel.getByTestId('workspace-operation-technical-details')).not.toHaveAttribute('open', '');
      await panel.getByRole('button', { name: 'Back to list', exact: true }).click();
      await panel.getByTestId('workspace-operation-review-select-all').check();
      const previewResponse = page.waitForResponse((response) => response.url().endsWith('/operation-reviews/batches')
        && response.request().postDataJSON()?.action === 'preview');
      await panel.getByTestId('workspace-operation-batch-preview').click();
      const response = await previewResponse;
      expect(response.ok()).toBeTruthy();
      const batch = (await response.json()).batch as Batch;
      expect(batch.preview.readiness).toBe('ready');
      await expect(panel).toContainText('final/sub/B.md');
      await page.screenshot({ path: info.outputPath('combined-review-desktop.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(panel.getByTestId('workspace-operation-batch-accept')).toBeInViewport();
      await expect.poll(async () => {
        const bounds = await panel.boundingBox();
        return bounds ? bounds.x : -1;
      }).toBeGreaterThanOrEqual(0);
      await expect.poll(async () => {
        const bounds = await panel.boundingBox();
        return bounds ? bounds.x + bounds.width : Infinity;
      }).toBeLessThanOrEqual(391);
      await page.screenshot({ path: info.outputPath('combined-review-mobile.png'), animations: 'disabled' });
      await panel.getByTestId('workspace-operation-batch-accept').click();
      await panel.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(panel).not.toBeVisible();
      await s.done(batch);
      expect(await s.read('final/A.md')).toBe('# A\n[B](sub/B.md#details)\n[Keep](../assets/keep.md)\n');
      expect(await s.read('final/sub/B.md')).toBe('# B\n[A](../A.md)\n');
      expect(await s.read('notes/index.md')).toBe('[A](../final/A.md) [B](../final/sub/B.md)\n');
      expect(await s.read('archive/old.md')).toBe('[Existing missing](missing.md)\n');
      await s.absent('source/A.md');
      await page.goto(`/en/notebook?workspaceId=${s.workspaceId}&workspaceOperationReview=${reviews[0].reviewId}`);
      await expect(panel).toContainText('File actions completed', { timeout: 30_000 });
    });
  });

  test('mixed move and delete removes inline, Wiki, reference and image links at the final source path', async ({ browser }) => {
    await workspace(browser, async (s) => {
      const content = '# A\nKeep [B](B.md), [[B|B label]], [Reference][target] and ![Picture](B.md).\n\n[target]: B.md "Title"\n\n`[code](B.md)`\n[External](https://example.com/B.md)\n';
      await s.upload('source/A.md', content);
      await s.upload('source/B.md', '# B\n');
      await s.upload('notes/index.md', '[A](../source/A.md) [B](../source/B.md)\n');
      const batch = await s.preview(await s.submit([move('source/A.md', 'final/A.md'), remove('source/B.md')]));
      expect(batch.preview.readiness).toBe('ready');
      expect(batch.preview.linkEdits.length).toBeGreaterThanOrEqual(5);
      expect((await s.accept(batch)).ok()).toBeTruthy();
      await s.done(batch);
      const result = await s.read('final/A.md');
      expect(result).toContain('Keep B, B label, Reference and Picture.');
      expect(result).not.toContain('[target]:');
      expect(result).toContain('`[code](B.md)`');
      expect(result).toContain('[External](https://example.com/B.md)');
      expect(await s.read('notes/index.md')).toBe('[A](../final/A.md) B\n');
      await s.absent('source/B.md');
    });
  });

  test('twenty reviews sharing one backlink document are applied without overwriting each other', async ({ browser }) => {
    await workspace(browser, async (s) => {
      const actions: Action[] = [];
      const before: string[] = [];
      const after: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        await s.upload(`source/file-${index}.md`, `# File ${index}\n`);
        actions.push(move(`source/file-${index}.md`, `final/file-${index}.md`));
        before.push(`[File ${index}](source/file-${index}.md)`);
        after.push(`[File ${index}](final/file-${index}.md)`);
      }
      await s.upload('index.md', `${before.join('\n')}\n`);
      const batch = await s.preview(await s.submit(actions));
      expect(batch.preview.readiness).toBe('ready');
      expect(batch.preview.linkEdits).toHaveLength(20);
      expect((await s.accept(batch)).ok()).toBeTruthy();
      await s.done(batch);
      expect(await s.read('index.md')).toBe(`${after.join('\n')}\n`);
      for (let index = 0; index < 20; index += 1) expect(await s.read(`final/file-${index}.md`)).toBe(`# File ${index}\n`);
    });
  });

  test('one proposal can move several selected roots with one shared link update', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('A.md', '# A\n');
      await s.upload('B.md', '# B\n');
      await s.upload('index.md', '[A](A.md) [B](B.md)\n');
      const [review] = await s.submit([{ kind: 'move', selections: [
        { sourcePath: 'A.md', destinationPath: 'new/A.md' },
        { sourcePath: 'B.md', destinationPath: 'new/B.md' },
      ] }]);
      expect(review.selections).toHaveLength(2);
      const batch = await s.preview([review]);
      expect(batch.preview.linkEdits).toHaveLength(2);
      expect((await s.accept(batch)).ok()).toBeTruthy();
      await s.done(batch);
      expect(await s.read('index.md')).toBe('[A](new/A.md) [B](new/B.md)\n');
      await s.absent('A.md');
      await s.absent('B.md');
    });
  });

  test('manual linked deletion opens an explicit cleanup review before the worker removes files', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('target.md', '# Target\n');
      await s.upload('index.md', '[Visible label](target.md)\n');
      const page = await s.context.newPage();
      await page.goto(`/en/notebook?workspaceId=${s.workspaceId}`);
      await page.getByRole('button', { name: 'More actions for target', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      const confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toContainText('target.md');
      const response = page.waitForResponse((result) => result.url().endsWith('/api/files/delete')
        && result.request().method() === 'DELETE');
      await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
      const deletion = await response;
      expect(deletion.ok()).toBeTruthy();
      const required = await deletion.json();
      expect(required.deleted).toEqual([]);
      expect(required.trashEntries).toEqual([]);
      expect(required.reviewRequired.status).toBe('pending');
      expect(await s.read('target.md')).toBe('# Target\n');
      expect(await s.read('index.md')).toBe('[Visible label](target.md)\n');
      await expect(confirmation).not.toBeVisible();
      const panel = page.getByTestId('workspace-operation-review-center');
      await expect(panel.getByTestId('workspace-operation-batch-accept')).toBeVisible({ timeout: 60_000 });
      await expect(panel).toContainText('Visible label');
      const accepted = page.waitForResponse((response) => response.url().endsWith('/operation-reviews/batches')
        && response.request().postDataJSON()?.action === 'accept');
      await panel.getByTestId('workspace-operation-batch-accept').click();
      expect((await accepted).ok()).toBeTruthy();
      await expect(panel).toContainText('File actions completed', { timeout: 90_000 });
      await s.absent('target.md');
      expect(await s.read('index.md')).toBe('Visible label\n');
    });
  });

  test('manual deletion blocks ambiguous backlinks and preserves existing link-free trash behavior', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('A/Trash.md', '# A\n');
      await s.upload('B/Trash.md', '# B\n');
      await s.upload('home.md', '[[Trash]]\n');
      const denied = await s.context.request.delete('/api/files/delete', {
        headers: s.headers, data: { path: 'A/Trash.md' },
      });
      expect(denied.status()).toBe(409);
      const required = await denied.json();
      expect(required.reviewRequired.status).toBe('blocked');
      expect(await s.read('A/Trash.md')).toBe('# A\n');
      expect(await s.read('home.md')).toBe('[[Trash]]\n');
      await s.upload('unlinked.txt', 'Plain file\n');
      const unlinked = await s.context.request.delete('/api/files/delete', {
        headers: s.headers, data: { path: 'unlinked.txt' },
      });
      expect(unlinked.ok()).toBeTruthy();
      const result = await unlinked.json();
      expect(result.deleted).toEqual(['unlinked.txt']);
      expect(result.trashEntries).toHaveLength(1);
      expect(result.reviewRequired).toBeUndefined();
      await s.absent('unlinked.txt');
    });
  });

  test('affected unresolved Wiki links block the UI until a repaired target is included in a refreshed preview', async ({ browser }, info) => {
    await workspace(browser, async (s) => {
      await s.upload('source/article.md', '# Article\n[[Missing Collection]]\n');
      const [review] = await s.submit([move('source', 'final')]);
      const page = await s.context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/en/notebook?workspaceId=${s.workspaceId}&workspaceOperationReview=${review.reviewId}`);
      const panel = page.getByTestId('workspace-operation-review-center');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('Missing Collection');
      await expect(panel.getByTestId('workspace-operation-batch-accept')).toHaveCount(0);
      await expect(panel.getByTestId('workspace-operation-review-refresh')).toBeVisible();
      await page.screenshot({ path: info.outputPath('affected-blocker-mobile.png'), animations: 'disabled' });
      expect(await s.read('source/article.md')).toBe('# Article\n[[Missing Collection]]\n');
      await s.upload('Missing Collection.md', '# Collection\n');
      const refreshResponse = page.waitForResponse((response) => response.url().endsWith(`/operation-reviews/${review.reviewId}`)
        && response.request().method() === 'POST');
      await panel.getByTestId('workspace-operation-review-refresh').click();
      const response = await refreshResponse;
      expect(response.ok()).toBeTruthy();
      const updated = (await response.json()).review as WorkspaceOperationReviewPublic;
      expect(updated.reviewId).not.toBe(review.reviewId);
      await expect(panel.getByTestId('workspace-operation-batch-accept')).toBeVisible();
      const acceptance = page.waitForResponse((result) => result.url().endsWith('/operation-reviews/batches')
        && result.request().postDataJSON()?.action === 'accept');
      await panel.getByTestId('workspace-operation-batch-accept').click();
      expect((await acceptance).ok()).toBeTruthy();
      await expect(panel).toContainText('File actions completed', { timeout: 90_000 });
      expect(await s.read('final/article.md')).toBe('# Article\n[[Missing Collection]]\n');
    });
  });

  test('changed document rejects the exact old plan and refresh creates a new review with current links', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('source.md', '# Source\n');
      await s.upload('index.md', '[Source](source.md)\n');
      const [original] = await s.submit([move('source.md', 'moved.md')]);
      const batch = await s.preview([original]);
      await s.edit('index.md', 'New introduction\n[Source](source.md)\n');
      const denied = await s.accept(batch);
      expect(denied.status()).toBe(409);
      expect(await s.read('source.md')).toBe('# Source\n');
      await s.absent('moved.md');
      const updated = await s.refresh(original);
      expect(updated.reviewId).not.toBe(original.reviewId);
      expect(updated.planId).not.toBe(original.planId);
      expect(updated.status).toBe('pending');
      const currentBatch = await s.preview([updated]);
      expect((await s.accept(currentBatch)).ok()).toBeTruthy();
      await s.done(currentBatch);
      expect(await s.read('index.md')).toBe('New introduction\n[Source](moved.md)\n');
    });
  });

  test('a dependent deletion refreshes after the linked document has moved', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('old/A.md', '[B](B.md)\n');
      await s.upload('old/B.md', '# B\n');
      const [a, b] = await s.submit([move('old/A.md', 'new/A.md'), remove('old/B.md')]);
      const first = await s.preview([a]);
      expect((await s.accept(first)).ok()).toBeTruthy();
      await s.done(first);
      expect(await s.read('new/A.md')).toBe('[B](../old/B.md)\n');
      const refreshed = await s.refresh(b);
      const next = await s.preview([refreshed]);
      expect((await s.accept(next)).ok()).toBeTruthy();
      await s.done(next);
      expect(await s.read('new/A.md')).toBe('B\n');
      await s.absent('old/B.md');
    });
  });

  test('dependent review follows consecutive moves and atomic Markdown checkpoint replacements', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('old/A.md', '# A\n[B](../targets/B.md)\n');
      await s.upload('targets/B.md', '# B\n');
      await s.upload('index.md', '[A](old/A.md)\n');
      const [firstMove, dependentDelete] = await s.submit([
        move('old/A.md', 'first/deeper/A.md'), remove('old/A.md'),
      ]);
      const first = await s.preview([firstMove]);
      expect((await s.accept(first)).ok()).toBeTruthy();
      await s.done(first);
      expect(await s.read('first/deeper/A.md')).toBe('# A\n[B](../../targets/B.md)\n');
      const second = await s.preview(await s.submit([move('first/deeper/A.md', 'final/A.md')]));
      expect((await s.accept(second)).ok()).toBeTruthy();
      await s.done(second);
      expect(await s.read('final/A.md')).toBe('# A\n[B](../targets/B.md)\n');
      const current = await s.refresh(dependentDelete);
      expect(current.selections).toEqual([{ sourcePath: 'final/A.md' }]);
      const cleanup = await s.preview([current]);
      expect(cleanup.preview.readiness).toBe('ready');
      expect((await s.accept(cleanup)).ok()).toBeTruthy();
      await s.done(cleanup);
      expect(await s.read('index.md')).toBe('A\n');
      expect(await s.read('targets/B.md')).toBe('# B\n');
      await s.absent('final/A.md');
    });
  });

  test('refresh follows the original moved document when an unrelated file reuses its old path', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('old/A.md', '# Original\n[B](../B.md)\n');
      await s.upload('B.md', '# B\n');
      await s.upload('index.md', '[Original](old/A.md)\n');
      const [movement, deletion, individual] = await s.submit([
        move('old/A.md', 'new/deeper/A.md'), remove('old/A.md'), remove('old/A.md'),
      ]);
      const moved = await s.preview([movement]);
      expect((await s.accept(moved)).ok()).toBeTruthy();
      await s.done(moved);
      await s.upload('old/A.md', '# Unrelated replacement\n');
      const refreshed = await s.refresh(individual);
      expect(refreshed.selections).toEqual([{ sourcePath: 'new/deeper/A.md' }]);
      const cleanup = await s.preview([deletion]);
      expect(cleanup.preview.actions[0].selections).toEqual([{ sourcePath: 'new/deeper/A.md' }]);
      expect(cleanup.preview.readiness).toBe('ready');
      expect((await s.accept(cleanup)).ok()).toBeTruthy();
      await s.done(cleanup);
      expect(await s.read('old/A.md')).toBe('# Unrelated replacement\n');
      expect(await s.read('index.md')).toBe('Original\n');
      expect(await s.read('B.md')).toBe('# B\n');
      await s.absent('new/deeper/A.md');
    });
  });

  test('overlapping roots and occupied destinations block the whole group before writing', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('folder/A.md', '# A\n');
      await s.upload('occupied.md', '# Occupied\n');
      const overlap = await s.preview(await s.submit([move('folder', 'moved-folder'), remove('folder/A.md')]));
      expect(overlap.preview.readiness).toBe('blocked');
      expect((await s.accept(overlap)).ok()).toBeFalsy();
      const collision = await s.preview(await s.submit([move('folder/A.md', 'occupied.md')]));
      expect(collision.preview.readiness).toBe('blocked');
      expect((await s.accept(collision)).ok()).toBeFalsy();
      expect(await s.read('folder/A.md')).toBe('# A\n');
      expect(await s.read('occupied.md')).toBe('# Occupied\n');
      await s.absent('moved-folder/A.md');
    });
  });

  test('duplicate acceptance has one durable result and full Undo restores paths and deleted-link text', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('A.md', '# A\n');
      await s.upload('B.md', '# B\n');
      await s.upload('index.md', '[A](A.md) [B](B.md)\n');
      const batch = await s.preview(await s.submit([move('A.md', 'moved/A.md'), remove('B.md')]));
      const results = await Promise.all([s.accept(batch), s.accept(batch)]);
      expect(results.every((response) => response.ok())).toBe(true);
      await s.done(batch);
      expect(await s.read('index.md')).toBe('[A](moved/A.md) B\n');
      const undo = await s.context.request.post(`/api/files/operation-reviews/batches/${batch.batchId}`, {
        headers: s.headers, data: { action: 'undo', planId: batch.planId },
      });
      expect(undo.ok()).toBeTruthy();
      await expect.poll(async () => (await s.readBatch(batch)).status, { timeout: 60_000 }).toBe('undone');
      expect(await s.read('A.md')).toBe('# A\n');
      expect(await s.read('B.md')).toBe('# B\n');
      expect(await s.read('index.md')).toBe('[A](A.md) [B](B.md)\n');
      await s.absent('moved/A.md');
    });
  });

  test('Undo protects subsequent user edits and batch access requires workspace authorization', async ({ browser }) => {
    await workspace(browser, async (s) => {
      await s.upload('A.md', '# A\n');
      await s.upload('index.md', '[A](A.md)\n');
      const batch = await s.preview(await s.submit([move('A.md', 'moved.md')]));
      expect((await s.accept(batch)).ok()).toBeTruthy();
      await s.done(batch);
      await s.edit('index.md', 'Edited by user\n[A](moved.md)\n');
      const undo = await s.context.request.post(`/api/files/operation-reviews/batches/${batch.batchId}`, {
        headers: s.headers, data: { action: 'undo', planId: batch.planId },
      });
      expect(undo.status()).toBe(409);
      expect(await s.read('index.md')).toBe('Edited by user\n[A](moved.md)\n');
      expect(await s.read('moved.md')).toBe('# A\n');
      let stranger: BrowserContext | undefined;
      try {
        stranger = await browser.newContext({ baseURL: process.env.BASE_URL });
        const forbidden = await stranger.request.get(`/api/files/operation-reviews/batches/${batch.batchId}`);
        expect(forbidden.status()).toBe(401);
      } finally { await stranger?.close(); }
    });
  });
});
