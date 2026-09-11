import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Editor, JSONContent } from '@tiptap/core';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

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
    { cwd: process.cwd(), env: process.env, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout) as ToolResult;
}

async function login(page: Page, secondary: boolean): Promise<string> {
  const email = secondary ? process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL
    : process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = secondary ? process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD
    : process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
  expect(Boolean(email && password), 'Managed fixture credentials are required.').toBe(true);
  const response = await page.request.post('/api/auth/sign-in/email', { headers: { Origin: BASE_URL }, data: { email, password } });
  expect(response.ok()).toBe(true);
  const session = await page.request.get('/api/auth/get-session');
  expect(session.ok()).toBe(true);
  const userId = (await session.json()).user.id as string;
  expect(userId).toBeTruthy();
  return userId;
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
  let uploaded = false;
  const filePath = `agent-review-lifecycle-${randomUUID()}.md`;
  const pageErrors: string[] = [];
  try {
    for (let index = 0; index < 2; index++) contexts.push(await browser.newContext({ baseURL, viewport,
      isMobile, hasTouch, userAgent, deviceScaleFactor }));
    const owner = await contexts[0].newPage();
    const peer = await contexts[1].newPage();
    for (const page of [owner, peer]) page.on('pageerror', (error) => pageErrors.push(error.message));
    const userId = await login(owner, false);
    expect(await login(peer, true)).not.toBe(userId);
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
    const created = await owner.request.post('/api/sessions', { headers,
      data: { agentId: 'canvas-agent', workspaceId, title: 'Synthetic agent review lifecycle acceptance' } });
    expect(created.ok()).toBe(true);
    const storedSession = (await created.json()).session;
    sessionId = storedSession.sessionId as string;
    const agentId = storedSession.agentId as string;
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
  } finally {
    // Close editors before deleting only this test's synthetic file/session.
    for (const context of contexts) for (const page of context.pages()) await page.close().catch(() => undefined);
    try {
      try {
        if (contexts[0] && sessionId) {
          const deleted = await contexts[0].request.delete('/api/sessions', { params: { sessionId, agentId: 'canvas-agent' } });
          expect(deleted.ok(), 'The real test agent session must be cleaned up.').toBe(true);
        }
      } finally {
        if (contexts[0] && workspaceId && uploaded) {
          const deleted = await contexts[0].request.delete('/api/files/delete', {
            headers: { [WORKSPACE_HEADER]: workspaceId }, data: { path: filePath },
          });
          expect(deleted.ok(), 'The synthetic review document must be cleaned up.').toBe(true);
        }
      }
    } finally {
      for (const context of contexts) await context.close();
    }
  }
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
async function showPanel(fixture: Fixture, tab: 'review' | 'activity' = 'review'): Promise<Locator> {
  const region = fixture.owner.getByRole('region', { name: /Agent changes|Agentenänderungen/u });
  if (!await region.isVisible()) await fixture.owner.getByRole('button', { name: /Agent changes|Agentenänderungen/u }).click();
  await expect(region).toBeVisible();
  await region.getByRole('tab', { name: tab === 'review' ? /Review|Prüfung/u : /Activity|Aktivität/u }).click();
  return region;
}
function expectDurable(result: Operation) {
  expect(result.durability).toMatch(/^(persisted_yjs|checkpointed_file)$/u);
  expect(result.conflicts).toEqual([]);
  expect(result.appliedTargetIds).toHaveLength(1);
}
async function acceptInUi(fixture: Fixture, review: Operation): Promise<Operation> {
  const panel = await showPanel(fixture);
  const pending = fixture.owner.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${operationUrl(review)}/accept`);
  await panel.getByRole('button', { name: /^(Accept|Annehmen)$/u }).click();
  const response = await pending;
  expect(response.request().postDataJSON()).toMatchObject({ proposalVersion: review.proposalVersion });
  expect(response.ok()).toBe(true);
  const result = (await response.json()).operation as Operation;
  expectDurable(result);
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

test.describe('Agent review lifecycle with two real collaborators', () => {
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
      await acceptInUi(fixture, review);
      await expect.poll(() => text(fixture.peerEditor)).toBe('AlphaHuman paragraphAgent revisedTail');
      const accepted = await tree(fixture.editor);
      expect(accepted.content!.map((block) => block.attrs!.id)).toEqual(movedIds);
      await expect.poll(() => tree(fixture.peerEditor)).toEqual(accepted);
    });
  });

  test('retries an actually accepted request after only its browser response is lost', async ({ browser }, info) => {
    await withFixture(browser, info, async (fixture) => {
      const review = await propose(fixture, 'Agent target', 'Agent target AGENT-ONCE');
      const panel = await showPanel(fixture);
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
      let requestBody: { idempotencyKey: string; proposalVersion: string } | undefined;
      let actualReceipt: Operation | undefined;
      let aborted = false;
      const acceptPath = `${operationUrl(review)}/accept`;
      await fixture.owner.route(`**${acceptPath}`, async (route) => {
        requestBody = route.request().postDataJSON();
        const response = await route.fetch(); // Real server mutation and durable receipt happen first.
        expect(response.ok()).toBe(true);
        actualReceipt = (await response.json()).operation as Operation;
        await route.abort('failed'); // Deliberately lose only the browser's HTTP response, not the server process.
        aborted = true;
      }, { times: 1 });
      await panel.getByRole('button', { name: /^(Accept|Annehmen)$/u }).click();
      await expect.poll(() => aborted, { timeout: 30_000 }).toBe(true);
      expect(requestBody).toMatchObject({ proposalVersion: review.proposalVersion });
      expect(requestBody!.idempotencyKey).toBeTruthy();
      expectDurable(actualReceipt!);
      await expect.poll(() => text(fixture.peerEditor)).toBe('AlphaAgent target AGENT-ONCEHuman paragraphTail');
      const afterFirst = await tree(fixture.editor);
      const retried = await fixture.owner.request.post(acceptPath, { headers: fixture.headers, data: requestBody });
      expect(retried.ok()).toBe(true);
      const retryReceipt = (await retried.json()).operation as Operation;
      expectDurable(retryReceipt);
      expect(retryReceipt).toMatchObject({ operationId: actualReceipt!.operationId, casVersion: actualReceipt!.casVersion,
        stateVector: actualReceipt!.stateVector, appliedTargetIds: actualReceipt!.appliedTargetIds });
      expect(await tree(fixture.editor)).toEqual(afterFirst);
      await expect.poll(() => tree(fixture.peerEditor)).toEqual(afterFirst);
      expect(await fixture.editor.evaluate((element) => (element as ObservedEditor).receiptProbe!.changes.length)).toBe(1);
      const listing = await fixture.owner.request.get('/api/files/collaboration/operations', {
        headers: fixture.headers, params: { documentId: review.documentId },
      });
      expect(listing.ok()).toBe(true);
      expect(((await listing.json()).operations as Operation[]).map((entry) => entry.operationId)).toEqual([review.operationId]);
      await fixture.editor.evaluate((element) => {
        const target = element as ObservedEditor;
        target.editor.off('update', target.receiptProbe!.listener); delete target.receiptProbe;
      });
    });
  });

  test('selective UI revert preserves a peer paragraph and a later overlapping revert conflicts', async ({ browser }, info) => {
    await withFixture(browser, info, async (fixture) => {
      const review = await propose(fixture);
      await acceptInUi(fixture, review);
      await expect.poll(() => text(fixture.peerEditor)).toContain('Agent revised');
      await fixture.peerEditor.getByText('Human paragraph', { exact: true }).click();
      await fixture.peer.keyboard.press('End'); await fixture.peer.keyboard.insertText(' from colleague');
      await expect.poll(() => text(fixture.editor)).toContain('Human paragraph from colleague');
      const panel = await showPanel(fixture, 'activity');
      const revertResponse = fixture.owner.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `${operationUrl(review)}/revert`);
      await panel.getByRole('button', { name: /^(Revert|Rückgängig machen)$/u }).click();
      const response = await revertResponse;
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
      await expect(conflictPanel).toContainText(/Review required|Prüfung erforderlich|conflicts with|kollidiert/u, { timeout: 20_000 });
      await expect(conflictPanel.getByRole('button', { name: /^(Accept|Annehmen)$/u })).toHaveCount(0);
    });
  });

  test('rejects an old approval after the target block was deleted without recreating it', async ({ browser }, info) => {
    await withFixture(browser, info, async (fixture) => {
      const targetId = (await tree(fixture.editor)).content![1].attrs!.id;
      const review = await propose(fixture);
      await selectParagraph(fixture.peer, fixture.peerEditor, 'Agent target');
      await fixture.peer.keyboard.press('Backspace'); await fixture.peer.keyboard.press('Backspace');
      await expect.poll(async () => (await tree(fixture.editor)).content!.map((block) => block.attrs!.id)).not.toContain(targetId);
      await expect.poll(async () => (await operation(fixture, review.operationId)).proposalVersion,
        { timeout: 20_000 }).toBeNull();
      const before = await tree(fixture.editor);
      const rejected = await fixture.owner.request.post(`${operationUrl(review)}/accept`, {
        headers: fixture.headers, data: { idempotencyKey: `deleted-target-${randomUUID()}`, proposalVersion: review.proposalVersion },
      });
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: 'AGENT_PROPOSAL_CHANGED' });
      expect(await tree(fixture.editor)).toEqual(before);
      await expect.poll(() => tree(fixture.peerEditor)).toEqual(before);
      expect(await text(fixture.editor)).not.toContain('Agent revised');
    });
  });
});
