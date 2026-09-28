import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const execFileAsync = promisify(execFile);
const BASE_TEXT = '# Proposal review fixture\n\nPlan: 100 USD.\n';
const PEER_TEXT = '# Proposal review fixture\n\nPlan: 140 USD.\n';
const FINAL_TEXT = '# Proposal review fixture\n\nPlan: 140 USD. LOCAL LATE\n';
const EDITOR = '.tiptap-editor-shell .ProseMirror';
type GraphFixture = { proposals: Array<{ label: string; operationId: string }> };

async function selectParagraph(page: Page, editor: Locator, content: string) {
  const paragraph = editor.locator('p').filter({ hasText: new RegExp(`^${content.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') });
  await paragraph.click();
  const bounds = await paragraph.evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(bounds.left, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.right, bounds.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(content);
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: /^(?:Version history|Versionshistorie)(?: \(view only\)| \(nur ansehen\))?$/iu }).click();
  await expect(page.getByTestId('file-version-center')).toBeVisible();
}

test.describe('Graph review with real peer and unsynchronized editor changes', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the approved managed local stack.');
  test.setTimeout(180_000);
  test('PG-U07 peer edits invalidate a shown approval and late offline edits survive reconnect', async ({ browser }, info) => {
    const ownerContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const peerContext = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
    const assertNoOwnerServerErrors = observeProposalReviewServerErrors(ownerContext);
    const assertNoPeerServerErrors = observeProposalReviewServerErrors(peerContext);
    const owner = await ownerContext.newPage();
    const peer = await peerContext.newPage();
    let holdOwnerCollaboration = false;
    let ownerSocket: WebSocketRoute | undefined;
    await ownerContext.routeWebSocket(/\/ws\/collaboration(?:[/?]|$)/, (socket) => {
      if (holdOwnerCollaboration) return socket.close({ code: 1013, reason: 'Review test: reconnect withheld' });
      ownerSocket = socket;
      socket.connectToServer();
    });
    const filePath = `fvrc-1006-${randomUUID()}.md`;
    let workspaceId: string | null = null;
    let uploaded = false;
    const actionPosts: string[] = [];
    const reviewReads: string[] = [];
    owner.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/proposals/actions')) actionPosts.push(request.url());
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/proposals/review')) reviewReads.push(request.url());
    });
    try {
      const auth = await (await ownerContext.request.get('/api/auth/get-session')).json();
      const list = await (await ownerContext.request.get('/api/workspaces')).json();
      const workspace = list.workspaces.find((candidate: { legacy?: boolean; permissions?: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean } }) =>
        !candidate.legacy && candidate.permissions?.canRead && candidate.permissions.canWrite && candidate.permissions.canRunAgent);
      expect(workspace?.id).toBeTruthy();
      workspaceId = workspace.id;
      const headers = { 'x-canvas-workspace-id': workspace.id as string };
      for (const context of [ownerContext, peerContext]) await context.addInitScript((id: string) => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspace.id);
      await uploadWorkspaceTextFile({ request: ownerContext.request, workspaceId: workspace.id, filePath, content: BASE_TEXT });
      uploaded = true;
      for (const page of [owner, peer]) {
        await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.locator(EDITOR)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
        await expect(page.locator(EDITOR)).toContainText('Plan: 100 USD.');
      }
      const initialized = await ownerContext.request.post('/api/files/collaboration/session', {
        headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      expect(initialized.ok()).toBeTruthy();
      const { documentId } = await initialized.json();
      const encoded = Buffer.from(JSON.stringify({ scenario: 'conflict', userId: auth.user.id, role: auth.user.role,
        workspaceId: workspace.id, documentId, filePath })).toString('base64url');
      const driver = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
        '--conditions', 'react-server', 'scripts/fvrc-1006-browser-fixture.ts', encoded,
      ], { cwd: process.cwd(), env: process.env, timeout: 60_000, maxBuffer: 1024 * 1024 });
      const line = driver.stdout.trim().split('\n').reverse().find(value => value.startsWith('{'));
      expect(line).toBeTruthy();
      const fixture = JSON.parse(line!) as GraphFixture;
      const proposalB = fixture.proposals.find(item => item.label === 'B')!;
      const read = async () => {
        const response = await ownerContext.request.get('/api/files/read', { headers, params: { path: filePath } });
        expect(response.ok()).toBeTruthy();
        return (await response.json()).data.content as string;
      };

      await openHistory(owner);
      await owner.locator(`button[data-operation-id="${proposalB.operationId}"]`).click();
      const graph = owner.getByTestId('graph-review-comparison');
      await expect(graph.getByText('Ready to apply', { exact: true })).toBeVisible();
      await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled();

      await peer.bringToFront();
      await selectParagraph(peer, peer.locator(EDITOR), 'Plan: 100 USD.');
      await peer.keyboard.insertText('Plan: 140 USD.');
      await expect.poll(read, { timeout: 30_000 }).toBe(PEER_TEXT);
      await owner.bringToFront();
      await expect(graph.getByTestId('graph-review-blocked').getByText('Conflicting changes', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
      expect(actionPosts).toEqual([]);
      await graph.screenshot({ path: info.outputPath('peer-invalidated-approval.png') });
      await owner.keyboard.press('Escape');
      await expect(owner.getByTestId('file-version-center')).toBeHidden();
      await expect(owner.locator(EDITOR)).toContainText('Plan: 140 USD.');

      await ownerContext.setOffline(true);
      holdOwnerCollaboration = true;
      await ownerSocket?.close({ code: 1013, reason: 'Review test: connection interrupted' });
      await owner.locator(EDITOR).getByText('Plan: 140 USD.', { exact: true }).click();
      await owner.keyboard.press('End');
      await owner.keyboard.insertText(' LOCAL');
      await expect(owner.locator(EDITOR)).toContainText('Plan: 140 USD. LOCAL');
      expect(await read()).toBe(PEER_TEXT);
      // Restore actual HTTP APIs while withholding only collaboration transport.
      // A successfully loaded server comparison must not authorize a write over
      // this browser's unsynchronized local document.
      await ownerContext.setOffline(false);
      await openHistory(owner);
      const center = owner.getByTestId('file-version-center');
      await expect(center.getByTestId('graph-review-local-sync-pending')).toBeVisible();
      await owner.locator(`button[data-operation-id="${proposalB.operationId}"]`).click();
      await expect(center.getByTestId('graph-review-comparison')).toBeVisible();
      for (const button of await center.getByRole('button', { name: /^(Accept change|Accept all changes|Confirm action)$/u }).all()) {
        await expect(button).toBeDisabled();
      }
      expect(actionPosts).toEqual([]);
      expect(await read()).toBe(PEER_TEXT);
      await center.screenshot({ path: info.outputPath('local-sync-blocks-review.png') });
      await owner.keyboard.press('Escape');
      await expect(center).toBeHidden();
      await expect(owner.locator(EDITOR)).toContainText('Plan: 140 USD. LOCAL');
      expect(await read()).toBe(PEER_TEXT);
      // HTTP has already recovered, but this tab's collaboration transport is
      // still withheld. Queue one more real editor change after the first review.
      await owner.locator(EDITOR).getByText('Plan: 140 USD. LOCAL', { exact: true }).click();
      await owner.keyboard.press('End');
      await owner.keyboard.insertText(' LATE');
      await expect(owner.locator(EDITOR)).toContainText('Plan: 140 USD. LOCAL LATE');
      expect(await read()).toBe(PEER_TEXT);
      await openHistory(owner);
      const lateCenter = owner.getByTestId('file-version-center');
      await expect(lateCenter.getByTestId('graph-review-local-sync-pending')).toBeVisible();
      await owner.locator(`button[data-operation-id="${proposalB.operationId}"]`).click();
      const lateGraph = lateCenter.getByTestId('graph-review-comparison');
      await expect(lateGraph).toBeVisible();
      for (const button of await lateCenter.getByRole('button', { name: /^(Accept change|Accept all changes|Confirm action)$/u }).all()) {
        await expect(button).toBeDisabled();
      }
      expect(actionPosts).toEqual([]);
      const beforeReconnectReviewReads = reviewReads.length;
      holdOwnerCollaboration = false;
      await expect.poll(read, { timeout: 30_000 }).toBe(FINAL_TEXT);
      await expect(peer.locator(EDITOR)).toContainText('Plan: 140 USD. LOCAL LATE');
      await expect(lateCenter.getByTestId('graph-review-local-sync-pending')).toBeHidden({ timeout: 30_000 });
      await expect.poll(() => reviewReads.length, { timeout: 30_000 }).toBeGreaterThan(beforeReconnectReviewReads);
      await expect(lateGraph.getByTestId('graph-review-blocked').getByText('Conflicting changes', { exact: true }))
        .toBeVisible({ timeout: 30_000 });
      await expect(lateGraph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
      expect(actionPosts).toEqual([]);
      await lateCenter.screenshot({ path: info.outputPath('late-local-edit-revalidated.png') });
      await owner.keyboard.press('Escape');
      await expect(lateCenter).toBeHidden();
      await owner.reload({ waitUntil: 'domcontentloaded' });
      await owner.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(owner.locator(EDITOR)).toBeVisible({ timeout: 30_000 });
      // Peer cursor labels live inside the paragraph but are not document text.
      // Check visibility here and assert exact persisted document bytes below.
      await expect(owner.locator(EDITOR).locator('p')).toContainText('Plan: 140 USD. LOCAL LATE');
      expect(await read()).toBe(FINAL_TEXT);
      expect(actionPosts).toEqual([]);
    } finally {
      holdOwnerCollaboration = false;
      await ownerContext.setOffline(false);
      await owner.close();
      await peer.close();
      if (uploaded && workspaceId) {
        const removed = await ownerContext.request.delete('/api/files/delete', {
          headers: { 'x-canvas-workspace-id': workspaceId }, data: { path: filePath },
        });
        expect(removed.ok()).toBeTruthy();
      }
      await ownerContext.close();
      await peerContext.close();
      assertNoOwnerServerErrors();
      assertNoPeerServerErrors();
    }
  });
});
