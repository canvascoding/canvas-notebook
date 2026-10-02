import { expect, request as requestFactory, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import type { Editor, JSONContent } from '@tiptap/core';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { createAuthenticatedContext } from './helpers/managed-test-context';
import { withOwnedTestCleanup } from './helpers/owned-test-cleanup';
import { parseProposalActionReceiptV1, PROPOSAL_GRAPH_ERROR_CODES, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewActionApiRequestV1, parseProposalReviewSessionResponseV1, type ProposalReviewActionApiRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WORKSPACE_HEADER = 'x-canvas-workspace-id';
const execFileAsync = promisify(execFile);
const INITIAL = 'Alpha\n\nAgent target\n\nHuman paragraph\n\nTail';
type Workspace = {
  id: string; name: string; type: string; rootRelativePath: string;
  organizationId?: string | null; customerId?: string | null; projectId?: string | null; legacy?: boolean;
  permissions: { canWrite: boolean; canDelete: boolean; canCreatePublicLinks: boolean };
};
type Operation = {
  operationId: string; documentId: string; proposalVersion: string | null; operationStatus: string;
  durability: string; casVersion: number; stateVector: string; appliedTargetIds: string[];
  conflicts: Array<{ code: string }>;
};
type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  details?: { sha256?: string; collaboration?: { operationId?: string; reviewRequired?: boolean } };
};
type ObservedEditor = HTMLElement & {
  editor: Editor;
  receiptProbe?: { changes: string[]; listener: () => void };
};
type Fixture = {
  owner: Page; peer: Page; editor: Locator; peerEditor: Locator; filePath: string;
  headers: Record<string, string>; agentContext: Record<string, unknown>;
};

async function runTool(fixture: Fixture, toolName: 'read' | 'edit_file', params: Record<string, unknown>): Promise<ToolResult> {
  const encoded = Buffer.from(JSON.stringify({ toolName, toolCallId: `review-browser-${randomUUID()}`,
    params, context: fixture.agentContext })).toString('base64url');
  const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
    ['--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts', encoded],
    { cwd: process.cwd(), env: process.env, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
  return JSON.parse(result.stdout) as ToolResult;
}

async function login(page: Page, secondary: boolean): Promise<string> {
  const email = secondary ? process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL
    : process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = secondary ? process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD
    : process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
  expect(Boolean(email && password), 'Managed fixture credentials are required.').toBe(true);
  let session = await page.request.get('/api/auth/get-session');
  let payload = await session.json() as { user?: { id?: string } } | null;
  if (!payload?.user?.id) {
    const response = await page.request.post('/api/auth/sign-in/email', { headers: { Origin: BASE_URL }, data: { email, password } });
    expect(response.ok()).toBe(true);
    session = await page.request.get('/api/auth/get-session');
    payload = await session.json() as { user?: { id?: string } } | null;
  }
  expect(session.ok()).toBe(true);
  const userId = payload?.user?.id;
  expect(userId).toBeTruthy();
  return userId!;
}

async function workspaceFor(page: Page): Promise<Workspace> {
  const response = await page.request.get('/api/workspaces');
  expect(response.ok()).toBe(true);
  const workspace = ((await response.json()).workspaces as Workspace[])
    .find((item) => item.name === 'Shared Test Workspace' && item.permissions.canWrite);
  expect(workspace?.rootRelativePath).toBeTruthy();
  return workspace!;
}

async function withFixture(browser: Browser, info: TestInfo, run: (fixture: Fixture) => Promise<void>) {
  const { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = info.project.use;
  const contexts: BrowserContext[] = [];
  let workspaceId: string | undefined;
  let sessionId: string | undefined;
  let agentId: string | undefined;
  let cleanup: APIRequestContext | undefined;
  let uploaded = false;
  const filePath = `agent-review-lifecycle-${randomUUID()}.md`;
  const pageErrors: string[] = [];
  await withOwnedTestCleanup(async () => {
    const contextOptions = { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor };
    contexts.push(await createAuthenticatedContext(browser, contextOptions));
    cleanup = await requestFactory.newContext({ baseURL: BASE_URL, storageState: await contexts[0].storageState(), timeout: 15_000 });
    contexts.push(await createAuthenticatedContext(browser, contextOptions));
    const owner = await contexts[0].newPage();
    const peer = await contexts[1].newPage();
    for (const page of [owner, peer]) {
      page.on('pageerror', (error) => pageErrors.push(error.message));
    }
    const userId = await login(owner, false);
    expect(await login(peer, false)).toBe(userId);
    const workspace = await workspaceFor(owner);
    workspaceId = workspace.id;
    expect((await workspaceFor(peer)).id).toBe(workspaceId);
    const headers = { [WORKSPACE_HEADER]: workspaceId };
    const upload = await owner.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
      name: filePath, mimeType: 'text/markdown', buffer: Buffer.from(INITIAL),
    } } });
    expect(upload.ok()).toBe(true);
    uploaded = true;
    for (const context of contexts) await context.addInitScript((id) => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspaceId);
    for (const page of [owner, peer]) {
      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^(Edit|Bearbeiten)$/u }).click();
      await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    }
    const reviewPolicy = owner.getByRole('switch', {
      name: /Require review for agent changes|Review für Agentenänderungen erforderlich|Edit directly when safe|Direkt bearbeiten, wenn sicher/u,
    });
    await expect(reviewPolicy).not.toBeChecked({ timeout: 30_000 });
    await reviewPolicy.click();
    await expect(reviewPolicy).toBeChecked();
    const created = await owner.request.post('/api/sessions', { headers,
      data: { agentId: 'canvas-agent', workspaceId, title: `Synthetic agent review lifecycle acceptance:${filePath}` } });
    expect(created.ok()).toBe(true);
    const storedSession = (await created.json()).session;
    sessionId = storedSession.sessionId as string;
    agentId = storedSession.agentId as string;
    expect(sessionId).toBeTruthy();
    expect(agentId).toBeTruthy();
    const fixture: Fixture = { owner, peer, filePath, headers,
      editor: owner.locator('.tiptap-editor-shell .ProseMirror'),
      peerEditor: peer.locator('.tiptap-editor-shell .ProseMirror'),
      agentContext: { userId, sessionId, agentId, workspaceId,
        workspaceType: workspace.type, workspaceName: workspace.name, organizationId: workspace.organizationId ?? null,
        customerId: workspace.customerId ?? null, projectId: workspace.projectId ?? null,
        workspaceRoot: path.resolve(process.env.DATA || 'data', workspace.rootRelativePath),
        workspaceRootRelativePath: workspace.rootRelativePath, canWrite: true,
        canDelete: workspace.permissions.canDelete, canShare: workspace.permissions.canCreatePublicLinks,
        legacy: Boolean(workspace.legacy) } };
    await expect.poll(() => text(fixture.peerEditor)).toBe('AlphaAgent targetHuman paragraphTail');
    await run(fixture);
    expect(pageErrors).toEqual([]);
  }, [
    ...[0, 1].map(index => ({ label: `editor pages ${index}`, run: async () => {
      const results = await Promise.allSettled((contexts[index]?.pages() ?? []).map(page => page.close()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Owned editor pages failed to close.');
    } })),
    { label: 'lifecycle agent session', run: async () => {
      if (cleanup && sessionId && agentId) {
        const deleted = await cleanup.delete('/api/sessions', { params: { sessionId, agentId } });
        expect(deleted.status()).toBe(200);
        expect(await deleted.json()).toMatchObject({ success: true, deleted: sessionId });
      }
    } },
    { label: 'lifecycle document', run: async () => {
      if (cleanup && workspaceId && uploaded) {
        const deleted = await cleanup.delete('/api/files/delete', {
          headers: { [WORKSPACE_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.status()).toBe(200);
        expect(await deleted.json()).toMatchObject({ success: true, deleted: [filePath], failed: [] });
      }
    } },
    ...[0, 1].map(index => ({ label: `editor context ${index}`, run: async () => { await contexts[index]?.close(); } })),
    { label: 'lifecycle cleanup API', run: async () => { await cleanup?.dispose(); } },
  ]);
}

const tree = (editor: Locator): Promise<JSONContent> => editor.evaluate((element) => (element as ObservedEditor).editor.getJSON());
const text = (editor: Locator): Promise<string> => editor.evaluate((element) => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.collaboration-carets__label').forEach((label) => label.remove());
  return clone.textContent || '';
});
const operationUrl = (operation: Pick<Operation, 'operationId'>) => `/api/files/collaboration/operations/${operation.operationId}`;
async function operation(fixture: Fixture, operationId: string): Promise<Operation> {
  const response = await fixture.owner.request.get(operationUrl({ operationId }), { headers: fixture.headers });
  expect(response.ok()).toBe(true);
  return (await response.json()).operation as Operation;
}
async function propose(fixture: Fixture, oldText = 'Agent target', newText = 'Agent revised'): Promise<Operation> {
  const read = await runTool(fixture, 'read', { path: fixture.filePath });
  expect(read.content?.[0]?.text).toContain('Source: live Yjs collaboration state');
  expect(read.content?.[0]?.text).toContain(oldText);
  expect(read.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  const edited = await runTool(fixture, 'edit_file', { path: fixture.filePath,
    expectedSha256: read.details!.sha256, oldText, newText });
  expect(edited.details?.collaboration?.reviewRequired).toBe(true);
  const review = await operation(fixture, edited.details!.collaboration!.operationId!);
  expect(review.operationStatus).toBe('needs_review');
  expect(review.proposalVersion).toMatch(/^v1\.[a-f0-9]{64}$/u);
  return review;
}
async function showPanel(fixture: Fixture): Promise<Locator> {
  const center = fixture.owner.getByTestId('file-version-center');
  if (!await center.isVisible()) {
    const trigger = fixture.owner.getByRole('button', {
      name: /Open agent changes|Offene Agentenänderungen/u,
    });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();
  }
  await expect(center).toBeVisible();
  return center;
}
function expectDurable(result: Operation) {
  expect(result.durability).toMatch(/^(persisted_yjs|checkpointed_file)$/u);
  expect(result.conflicts).toEqual([]);
  expect(result.appliedTargetIds).toHaveLength(1);
}
async function graphReview(fixture: Fixture, review: Operation) {
  const response = await fixture.owner.request.post('/api/files/version-center/v1/proposals/review', {
    headers: fixture.headers, data: { contractVersion: 1,
      target: { kind: 'document', workspaceId: fixture.agentContext.workspaceId, documentId: review.documentId },
      selection: { kind: 'operation', operationId: review.operationId } },
  });
  expect(response.status()).toBe(200);
  const session = parseProposalReviewSessionResponseV1(await response.json());
  expect(session.mode).toBe('graph');
  if (session.mode !== 'graph') throw new Error('Ordinary agent proposals need graph review.');
  expect(session.target.workspaceId).toBe(fixture.agentContext.workspaceId);
  expect(session.target.documentId).toBe(review.documentId);
  expect(session.selectedProposalIds).toHaveLength(1);
  return session;
}
async function expectGraphReceipt(fixture: Fixture, review: Operation, receipt: ProposalActionReceiptV1, proposalIds: string[]) {
  expect(receipt.phase).toBe('succeeded');
  expect(receipt.actionType).toBe('accept');
  expect(receipt.affectedProposalIds).toEqual(proposalIds);
  expect(receipt.scope.workspaceId).toBe(fixture.agentContext.workspaceId);
  expect(receipt.scope.documentId).toBe(review.documentId);
  if (receipt.phase !== 'succeeded' || receipt.result.kind !== 'content_changed' || !receipt.operationId) {
    throw new Error('An accepted graph action needs a durable content revision and action operation.');
  }
  expect(receipt.result.current.revisionId).toBe(receipt.result.revisionId);
  const applied = await operation(fixture, receipt.operationId);
  expect(applied.documentId).toBe(review.documentId);
  expectDurable(applied);
  return applied;
}
async function acceptGraphInUi(fixture: Fixture, review: Operation) {
  const session = await graphReview(fixture, review);
  const panel = await showPanel(fixture);
  const graph = panel.getByTestId('graph-review-comparison');
  const accept = graph.getByRole('button', { name: /^(Accept change|Änderung annehmen)$/u });
  await expect(accept).toBeEnabled({ timeout: 20_000 });
  await accept.click();
  const pending = fixture.owner.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions', { timeout: 30_000 });
  await graph.getByRole('button', { name: /^(Confirm action|Aktion bestätigen)$/u }).click();
  const response = await pending;
  const request = parseProposalReviewActionApiRequestV1(response.request().postDataJSON());
  expect(request.action.fence.selectedProposalIds).toEqual(session.selectedProposalIds);
  expect(response.status()).toBe(200);
  const receipt = parseProposalActionReceiptV1(await response.json());
  await expectGraphReceipt(fixture, review, receipt, session.selectedProposalIds);
  await fixture.owner.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  return receipt;
}
async function acceptInUi(fixture: Fixture, review: Operation): Promise<Operation> {
  const panel = await showPanel(fixture);
  const accept = panel.getByRole('button', { name: /^(Accept change|Änderung annehmen)$/u });
  const retry = panel.getByRole('button', {
    name: /^(Try again|Erneut versuchen|Refresh timeline|Timeline aktualisieren)$/u,
  });
  // A retained comparison can finish refreshing between visibility and click.
  await expect.poll(async () => await accept.isEnabled().catch(() => false)
    || await retry.isVisible(), { timeout: 20_000 }).toBe(true);
  if (!await accept.isEnabled().catch(() => false)) {
    try {
      await retry.click({ timeout: 2_000 });
    } catch (error) {
      if (!await accept.isEnabled().catch(() => false)) throw error;
    }
  }
  await expect(accept).toBeEnabled({ timeout: 20_000 });
  const pending = fixture.owner.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${operationUrl(review)}/accept`, { timeout: 30_000 });
  await accept.click();
  const response = await pending;
  expect(response.request().postDataJSON()).toMatchObject({ proposalVersion: review.proposalVersion });
  expect(response.ok()).toBe(true);
  const result = (await response.json()).operation as Operation;
  expectDurable(result);
  await fixture.owner.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  return result;
}
async function selectParagraph(page: Page, editor: Locator, content: string) {
  const paragraph = editor.locator('p').filter({ hasText: new RegExp(`^${content}$`, 'u') });
  await paragraph.click();
  const bounds = await paragraph.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  // Real selection events let the editor observe the range during peer updates.
  await page.mouse.move(bounds.left, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.right, bounds.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(content);
}

test.describe('Agent review lifecycle with two real browser clients', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed Postgres team fixture and actual agent tool driver.');
  test.setTimeout(180_000);

  test('accepts the exact original proposal after its unchanged target block moves', async ({ browser }, info) => {
    await withFixture(browser, info, async (fixture) => {
      const initialIds = (await tree(fixture.editor)).content!.map((block) => block.attrs!.id);
      const review = await propose(fixture);
      await fixture.peerEditor.getByText('Agent target', { exact: true }).click();
      await fixture.peer.keyboard.press('Alt+Shift+ArrowDown');
      const movedIds = [initialIds[0], initialIds[2], initialIds[1], initialIds[3]];
      await expect.poll(async () => (await tree(fixture.editor)).content!.map((block) => block.attrs!.id)).toEqual(movedIds);
      expect((await operation(fixture, review.operationId)).proposalVersion).toBe(review.proposalVersion);
      await acceptGraphInUi(fixture, review);
      await expect.poll(() => text(fixture.peerEditor)).toBe('AlphaHuman paragraphAgent revisedTail');
      const accepted = await tree(fixture.editor);
      expect(accepted.content!.map((block) => block.attrs!.id)).toEqual(movedIds);
      await expect.poll(() => tree(fixture.peerEditor)).toEqual(accepted);
    });
  });

  test('retries an actually accepted request after only its browser response is lost', async ({ browser }, info) => {
    await withFixture(browser, info, async (fixture) => {
      const review = await propose(fixture, 'Agent target', 'Agent target AGENT-ONCE');
      const session = await graphReview(fixture, review);
      const panel = await showPanel(fixture);
      await withOwnedTestCleanup(async () => {
        await fixture.editor.evaluate((element) => {
          const target = element as ObservedEditor;
          let prior = JSON.stringify(target.editor.getJSON());
          const changes: string[] = [];
          const listener = () => {
            const next = JSON.stringify(target.editor.getJSON());
            if (next !== prior) { changes.push(next); prior = next; }
          };
          target.receiptProbe = { changes, listener }; target.editor.on('update', listener);
        });
        let requestBody: ProposalReviewActionApiRequestV1 | undefined;
        let actualReceipt: ProposalActionReceiptV1 | undefined;
        let aborted = false;
        const acceptPath = '/api/files/version-center/v1/proposals/actions';
        await fixture.owner.route(`**${acceptPath}`, async (route) => {
          requestBody = parseProposalReviewActionApiRequestV1(route.request().postDataJSON());
          const response = await route.fetch(); // Real server mutation and durable receipt happen first.
          expect(response.status()).toBe(200);
          actualReceipt = parseProposalActionReceiptV1(await response.json());
          await route.abort('failed'); // Deliberately lose only the browser's HTTP response, not the server process.
          aborted = true;
        }, { times: 1 });
        const graph = panel.getByTestId('graph-review-comparison');
        await graph.getByRole('button', { name: /^(Accept change|Änderung annehmen)$/u }).click();
        await graph.getByRole('button', { name: /^(Confirm action|Aktion bestätigen)$/u }).click();
        await expect.poll(() => aborted, { timeout: 30_000 }).toBe(true);
        expect(requestBody!.action.fence.selectedProposalIds).toEqual(session.selectedProposalIds);
        expect(requestBody!.action.idempotencyKey).toBeTruthy();
        const applied = await expectGraphReceipt(fixture, review, actualReceipt!, session.selectedProposalIds);
        await expect.poll(() => text(fixture.peerEditor)).toBe('AlphaAgent target AGENT-ONCEHuman paragraphTail');
        const afterFirst = await tree(fixture.editor);
        const retried = await fixture.owner.request.post(acceptPath, { headers: fixture.headers, data: requestBody });
        expect(retried.status()).toBe(200);
        const retryReceipt = parseProposalActionReceiptV1(await retried.json());
        const replayed = await expectGraphReceipt(fixture, review, retryReceipt, session.selectedProposalIds);
        expect(retryReceipt).toEqual(actualReceipt);
        expect(replayed).toMatchObject({ operationId: applied.operationId, casVersion: applied.casVersion,
          stateVector: applied.stateVector, appliedTargetIds: applied.appliedTargetIds });
        expect(await tree(fixture.editor)).toEqual(afterFirst);
        await expect.poll(() => tree(fixture.peerEditor)).toEqual(afterFirst);
        expect(await fixture.editor.evaluate((element) => (element as ObservedEditor).receiptProbe!.changes.length)).toBe(1);
        const listing = await fixture.owner.request.get('/api/files/collaboration/operations', {
          headers: fixture.headers, params: { documentId: review.documentId },
        });
        expect(listing.ok()).toBe(true);
        expect(((await listing.json()).operations as Operation[]).map((entry) => entry.operationId).sort())
          .toEqual([review.operationId, actualReceipt!.operationId].sort());
      }, [{ label: 'receipt editor listener', run: async () => { await fixture.editor.evaluate((element) => {
        const target = element as ObservedEditor;
        if (target.receiptProbe) { target.editor.off('update', target.receiptProbe.listener); delete target.receiptProbe; }
      }); } }]);
    });
  });

  test('selective revert preserves a peer paragraph and a later overlapping revert conflicts', async ({ browser }, info) => {
    await withFixture(browser, info, async (fixture) => {
      const review = await propose(fixture);
      await acceptInUi(fixture, review);
      await expect.poll(() => text(fixture.peerEditor)).toContain('Agent revised');
      await fixture.peerEditor.getByText('Human paragraph', { exact: true }).click();
      await fixture.peer.keyboard.press('End'); await fixture.peer.keyboard.insertText(' from colleague');
      await expect.poll(() => text(fixture.editor)).toContain('Human paragraph from colleague');
      const response = await fixture.owner.request.post(`${operationUrl(review)}/revert`, {
        headers: fixture.headers,
        data: { idempotencyKey: `selective-revert-${randomUUID()}` },
      });
      expect(response.ok()).toBe(true);
      const reverted = (await response.json()).operation as Operation;
      expect(reverted.operationStatus).toBe('reverted'); expectDurable(reverted);
      await expect.poll(() => text(fixture.peerEditor)).toBe('AlphaAgent targetHuman paragraph from colleagueTail');

      const second = await propose(fixture, 'Agent target', 'Agent second');
      await acceptInUi(fixture, second);
      await expect.poll(() => text(fixture.peerEditor)).toContain('Agent second');
      await selectParagraph(fixture.peer, fixture.peerEditor, 'Agent second');
      await fixture.peer.keyboard.insertText('Human overrides target');
      await expect.poll(() => text(fixture.editor)).toContain('Human overrides target');
      const beforeConflict = await tree(fixture.editor);
      const overlapRevert = await fixture.owner.request.post(`${operationUrl(second)}/revert`, {
        headers: fixture.headers, data: { idempotencyKey: `overlap-revert-${randomUUID()}` },
      });
      expect(overlapRevert.ok()).toBe(true);
      const conflicted = (await overlapRevert.json()).operation as Operation;
      expect(conflicted.operationStatus).toMatch(/^(needs_review|semantic_conflict)$/u);
      expect(conflicted.appliedTargetIds).toEqual([]);
      expect(conflicted.conflicts.some((conflict) => ['target_changed', 'anchor_invalid', 'target_deleted'].includes(conflict.code))).toBe(true);
      expect(await tree(fixture.editor)).toEqual(beforeConflict);
      await expect.poll(() => tree(fixture.peerEditor)).toEqual(beforeConflict);
      const conflictPanel = await showPanel(fixture);
      await expect(conflictPanel).toContainText(
        /Needs review|Review required|Prüfung erforderlich|conflicts with|kollidiert|comparison is no longer current|Vergleich ist nicht mehr aktuell/u,
        { timeout: 20_000 },
      );
      await expect(conflictPanel.getByRole('button', { name: /^(Accept change|Änderung annehmen)$/u })).toHaveCount(0);
    });
  });

  test('rejects an old approval after the target block was deleted without recreating it', async ({ browser }, info) => {
    await withFixture(browser, info, async (fixture) => {
      const targetId = (await tree(fixture.editor)).content![1].attrs!.id;
      const review = await propose(fixture);
      const session = await graphReview(fixture, review);
      expect(session.actions.accept).toBeTruthy();
      const approval = parseProposalReviewActionApiRequestV1({ contractVersion: 1,
        target: { kind: 'document', workspaceId: session.target.workspaceId, documentId: session.target.documentId },
        action: { contractVersion: 1, idempotencyKey: `deleted-target-${randomUUID()}`,
          fence: session.actions.accept!.fence, fenceToken: session.actions.accept!.fenceToken, creation: null } });
      await selectParagraph(fixture.peer, fixture.peerEditor, 'Agent target');
      await fixture.peer.keyboard.press('Backspace'); await fixture.peer.keyboard.press('Backspace');
      await expect.poll(async () => (await tree(fixture.editor)).content!.map((block) => block.attrs!.id)).not.toContain(targetId);
      const before = await tree(fixture.editor);
      const rejected = await fixture.owner.request.post('/api/files/version-center/v1/proposals/actions', {
        headers: fixture.headers, data: approval,
      });
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: { code: PROPOSAL_GRAPH_ERROR_CODES.currentChanged } });
      expect(await tree(fixture.editor)).toEqual(before);
      await expect.poll(() => tree(fixture.peerEditor)).toEqual(before);
      expect(await text(fixture.editor)).not.toContain('Agent revised');
    });
  });
});
