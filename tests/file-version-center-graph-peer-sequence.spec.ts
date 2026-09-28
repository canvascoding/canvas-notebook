import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewGraphSessionV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import type { FileVersionCenterRequestV1, FileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const execFileAsync = promisify(execFile);
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const BASE_TEXT = '# Graph flow fixture\n\nA0|B0\n';
const PARENT_TEXT = '# Graph flow fixture\n\nA1|B0\n';
const PEER_TEXT = '# Graph flow fixture\n\nA1|B9\n';
const EDITOR = '.tiptap-editor-shell .ProseMirror';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';

type Fixture = { scope: { workspaceId: string; lineageId: string; documentId: string };
  proposals: Array<{ label: string; proposalId: string; operationId: string }> };
type Workspace = { id: string; type: string; legacy?: boolean;
  permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean } };

function reviewLink(input: { workspaceId: string; lineageId: string; operationId: string }): string {
  const request: FileVersionCenterRequestV1 = { contractVersion: 1,
    target: { kind: 'lineage', workspaceId: input.workspaceId, lineageId: input.lineageId },
    selectedEntry: { kind: 'agent_operation', id: input.operationId }, initialView: 'reviews', source: 'deep_link' };
  return buildFileVersionCenterDeepLinkV1('/en', request);
}

async function createFixture(input: { userId: string; role: string; workspaceId: string; documentId: string;
  filePath: string }): Promise<Fixture> {
  if (!/^(owner|admin|member|external)$/u.test(input.role)) throw new Error('The fixture actor role is unavailable.');
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
  let stdout: string;
  try {
    const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
      '--conditions', 'react-server', 'scripts/fvrc-1006-graph-flow-fixture.ts', encoded,
    ], { cwd: process.cwd(), env: process.env, timeout: 120_000, maxBuffer: 1024 * 1024 });
    stdout = String(result.stdout);
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr : '';
    const code = /FVRC_GRAPH_FLOW_FIXTURE_CODE=([A-Z][A-Z0-9_]{0,79})/u.exec(stderr)?.[1] ?? 'UNKNOWN';
    throw new Error(`The dedicated graph fixture failed (${code}); arguments and stderr are redacted.`);
  }
  for (const line of stdout.trim().split('\n').reverse()) {
    try { return JSON.parse(line) as Fixture; } catch { /* Only the receipt line is JSON. */ }
  }
  throw new Error('The dedicated graph fixture returned no receipt.');
}

async function selectParagraph(page: Page, editor: Locator, content: string): Promise<void> {
  const paragraph = editor.locator('p').filter({ hasText: content });
  await paragraph.click();
  const bounds = await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(bounds.left, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.right, bounds.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(content);
}

test.describe('FVRC-1006 PG-U02 selected child across parent acceptance and peer edit', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the authorized managed local graph-review stack.');
  test.setTimeout(180_000);

  test('keeps P2 selected and focused, shows the parent-only rest diff, then blocks the stale approval', async ({ browser }, info) => {
    const firstContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const secondContext = await createAuthenticatedContext(browser, { viewport: { width: 1450, height: 900 } });
    const assertNoFirstServerErrors = observeProposalReviewServerErrors(firstContext);
    const assertNoSecondServerErrors = observeProposalReviewServerErrors(secondContext);
    const first = await firstContext.newPage();
    const peerEditor = await secondContext.newPage();
    const peerReview = await secondContext.newPage();
    const filePath = `fvrc-1006-${randomUUID()}.md`;
    let workspaceId: string | null = null;
    let uploaded = false;
    const firstActionPosts: string[] = [];
    first.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) firstActionPosts.push(request.url());
    });
    try {
      const authResponse = await firstContext.request.get('/api/auth/get-session');
      const auth = await authResponse.json() as { user?: { id?: string; role?: string } };
      expect(authResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await firstContext.request.get('/api/workspaces');
      const workspaces = await workspaceResponse.json() as { workspaces?: Workspace[] };
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = workspaces.workspaces?.find((candidate) => candidate.type === 'personal' && !candidate.legacy
        && candidate.permissions.canRead && candidate.permissions.canWrite && candidate.permissions.canRunAgent);
      expect(workspace, 'A writable Personal workspace is required.').toBeTruthy();
      workspaceId = workspace!.id;
      const headers = { [WORKSPACE_ID_HEADER]: workspaceId };
      for (const context of [firstContext, secondContext]) await context.addInitScript((id) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: firstContext.request, workspaceId, filePath, content: BASE_TEXT });
      uploaded = true;
      const collaboration = await firstContext.request.post('/api/files/collaboration/session', {
        headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      const collaborationBody = await collaboration.json() as { documentId?: string; error?: string };
      expect(collaboration.ok(), collaborationBody.error ?? 'Could not initialize the review document.').toBeTruthy();
      expect(collaborationBody.documentId).toBeTruthy();
      const fixture = await createFixture({ userId: auth.user!.id!, role: auth.user!.role ?? 'member',
        workspaceId, documentId: collaborationBody.documentId!, filePath });
      expect(fixture.proposals.map((item) => item.label)).toEqual(['A', 'B1', 'B2']);
      const parent = fixture.proposals[0]!;
      const child = fixture.proposals[1]!;
      const timeline = async (): Promise<FileVersionTimelineResponseV1> => {
        const response = await firstContext.request.post('/api/files/version-center/v1/resolve', {
          headers, data: { contractVersion: 1,
            target: { kind: 'path', workspaceId, pathHint: filePath }, initialView: 'history', source: 'file_browser' },
        });
        const body = await response.json() as FileVersionTimelineResponseV1;
        expect(response.ok()).toBeTruthy();
        return body;
      };
      const content = async (): Promise<string> => {
        const response = await firstContext.request.get('/api/files/read', { headers, params: { path: filePath } });
        const body = await response.json() as { data?: { content?: string } };
        expect(response.ok()).toBeTruthy();
        return body.data?.content ?? '';
      };
      const childReview = async (): Promise<ProposalReviewGraphSessionV1> => {
        const response = await firstContext.request.post('/api/files/version-center/v1/proposals/review', {
          headers, data: { contractVersion: 1, target: { kind: 'document', workspaceId,
            documentId: fixture.scope.documentId }, selection: { kind: 'operation', operationId: child.operationId } },
        });
        const body = await response.json() as ProposalReviewGraphSessionV1;
        expect(response.ok()).toBeTruthy();
        expect(body.mode).toBe('graph');
        return body;
      };

      await peerEditor.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await peerEditor.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(peerEditor.locator(EDITOR)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
      await expect(peerEditor.locator(EDITOR)).toContainText('A0|B0');
      const before = await timeline();
      const beforeCurrent = before.entries.find((entry) => entry.kind === 'current');
      expect(beforeCurrent?.kind).toBe('current');
      const beforeRevisionCount = before.entries.filter((entry) => entry.kind === 'revision').length;
      await first.goto(reviewLink({ workspaceId, lineageId: fixture.scope.lineageId, operationId: child.operationId }));
      const center = first.getByTestId('file-version-center');
      const graph = center.getByTestId('graph-review-comparison');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('A0|B0');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('A1|B1');
      await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled();
      const childCard = center.locator(`button[data-operation-id="${child.operationId}"]`);
      await childCard.focus();
      await expect(childCard).toBeFocused();
      await expect(childCard).toHaveAttribute('aria-pressed', 'true');
      const currentCard = center.locator('button[data-entry-kind="current"]');
      const beforeCurrentCardTime = await currentCard.locator('time').getAttribute('datetime');

      await peerReview.goto(reviewLink({ workspaceId, lineageId: fixture.scope.lineageId, operationId: parent.operationId }));
      const parentGraph = peerReview.getByTestId('graph-review-comparison');
      await expect(parentGraph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled();
      await parentGraph.getByRole('button', { name: 'Accept change', exact: true }).click();
      await expect(parentGraph.getByTestId('graph-review-confirmation')).toBeVisible();
      const parentResponsePromise = peerReview.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === ACTION_PATH);
      await parentGraph.getByRole('button', { name: 'Confirm action' }).click();
      const parentResponse = await parentResponsePromise;
      const parentReceipt = await parentResponse.json() as ProposalActionReceiptV1;
      expect(parentResponse.ok()).toBeTruthy();
      expect(parentReceipt.phase).toBe('succeeded');
      expect(parentReceipt.affectedProposalIds).toEqual([parent.proposalId]);
      expect(parentReceipt.result?.kind).toBe('content_changed');
      await expect.poll(content, { timeout: 30_000 }).toBe(PARENT_TEXT);
      const afterParent = await timeline();
      const parentCurrent = afterParent.entries.find((entry) => entry.kind === 'current');
      if (parentCurrent?.kind !== 'current' || parentReceipt.result?.kind !== 'content_changed') {
        throw new Error('The parent action did not produce a current content revision.');
      }
      expect(parentCurrent.sha256).toBe(createHash('sha256').update(PARENT_TEXT).digest('hex'));
      expect(parentCurrent.revisionId).toBe(parentReceipt.result.revisionId);
      expect(parentCurrent.revisionId).not.toBe(beforeCurrent?.revisionId);
      expect(afterParent.entries.filter((entry) => entry.kind === 'revision').length).toBe(beforeRevisionCount + 1);

      await first.bringToFront();
      await first.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(childCard).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => currentCard.locator('time').getAttribute('datetime'), { timeout: 30_000 })
        .not.toBe(beforeCurrentCardTime);
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('A1|B0');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('A1|B1');
      await expect(graph.getByTestId('graph-review-hunks')).not.toContainText('A0|B0');
      await expect(childCard).toBeFocused();
      await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled();
      const rest = await childReview();
      expect(rest.selectedProposalIds).toEqual([child.proposalId]);
      expect(rest.context?.applyProposalIds).toEqual([child.proposalId]);
      expect(rest.compare?.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === 'deletion').map((line) => line.text)))
        .toContain('A1|B0');
      expect(rest.compare?.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === 'addition').map((line) => line.text)))
        .toContain('A1|B1');
      await info.attach('pg-u02-parent-only-rest-diff.png', {
        body: await first.screenshot({ fullPage: true }), contentType: 'image/png',
      });

      await expect(peerEditor.locator(EDITOR)).toContainText('A1|B0');
      await selectParagraph(peerEditor, peerEditor.locator(EDITOR), 'A1|B0');
      await peerEditor.keyboard.insertText('A1|B9');
      await expect.poll(content, { timeout: 30_000 }).toBe(PEER_TEXT);
      await first.bringToFront();
      await first.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(childCard).toHaveAttribute('aria-pressed', 'true');
      const oldAccept = graph.getByRole('button', { name: 'Accept change', exact: true });
      await expect.poll(async () => await oldAccept.count() === 0 || await oldAccept.isDisabled(), { timeout: 30_000 })
        .toBe(true);
      await expect(graph.getByTestId('graph-review-blocked').getByText('Conflicting changes', { exact: true }))
        .toBeVisible({ timeout: 30_000 });
      await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
      await expect(graph.getByTestId('graph-review-hunks')).toHaveCount(0);
      await expect(childCard).toBeFocused();
      expect(firstActionPosts).toEqual([]);
      const peerCurrent = (await timeline()).entries.find((entry) => entry.kind === 'current');
      if (peerCurrent?.kind !== 'current') throw new Error('The peer edit has no current document proof.');
      expect(peerCurrent.sha256).toBe(createHash('sha256').update(PEER_TEXT).digest('hex'));
      expect(peerCurrent.revisionId).not.toBe(parentReceipt.result.revisionId);
      const conflicted = await childReview();
      expect(conflicted.status).toBe('conflicted');
      expect(conflicted.actions.accept).toBeUndefined();
      await info.attach('pg-u02-peer-conflict.png', {
        body: await first.screenshot({ fullPage: true }), contentType: 'image/png',
      });
    } finally {
      await first.close();
      await peerReview.close();
      await peerEditor.close();
      if (uploaded && workspaceId) {
        const removed = await firstContext.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(removed.ok(), 'Could not remove the dedicated graph sequence fixture.').toBeTruthy();
      }
      await firstContext.close();
      await secondContext.close();
      assertNoFirstServerErrors();
      assertNoSecondServerErrors();
    }
  });
});
