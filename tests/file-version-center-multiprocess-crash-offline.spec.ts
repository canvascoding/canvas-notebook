import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';

import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { COLLABORATION_CLIENT_CAPABILITIES, type CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { parseProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewActionApiRequestV1,
  ProposalReviewActionStatusResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { startCollaborationFailoverProxy } from './helpers/collaboration-failover-proxy';
import { readCollaborationMultiprocessOwnerState } from './helpers/collaboration-multiprocess-owner-state';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';
import { startProposalCrashHost } from './helpers/proposal-crash-host';
import { readProposalCrashState } from './helpers/proposal-crash-state';

const ACTION = '/api/files/version-center/v1/proposals/actions';
const EDITOR = '.tiptap-editor-shell .ProseMirror';
const INITIAL = '# Recovery\n\nAgent target.\n\nPeer target.';
const AFTER_AGENT = '# Recovery\n\nAgent target approved.\n\nPeer target.';
const AFTER_BOTH = '# Recovery\n\nAgent target approved.\n\nPeer target. offline';

async function openEditor(page: Page, filePath: string) {
  await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator(EDITOR)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
}

async function sessionFor(context: BrowserContext, workspaceId: string, filePath: string) {
  const response = await context.request.post('/api/files/collaboration/session', {
    headers: { 'x-canvas-workspace-id': workspaceId },
    data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as CollaborationSessionResponse;
}

async function localRichState(page: Page, session: CollaborationSessionResponse) {
  const databaseName = `canvas:${session.documentId}:${session.lifecycleGeneration}:${session.representation}`;
  const updates = await page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some(database => database.name === name)) return null;
    return await new Promise<number[][]>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(new Error('Could not open local collaboration cache.'));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('updates', 'readonly');
        const request = transaction.objectStore('updates').getAll();
        transaction.onerror = () => { database.close(); reject(new Error('Could not read local collaboration cache.')); };
        transaction.oncomplete = () => {
          const result = (request.result as Uint8Array[]).map(update => Array.from(update));
          database.close();
          resolve(result);
        };
      };
    });
  }, databaseName);
  if (!updates) return null;
  const document = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(document, Uint8Array.from(update));
    return readRichDocumentJson(document);
  } finally { document.destroy(); }
}

function ownerApplicationName(pid: number) {
  return `canvas-collaboration-owner-test-${pid}`;
}

for (const workspaceKind of ['personal', 'team'] as const) {
  test(`Two-process crash preserves an offline peer and permits a later review (${workspaceKind})`, async ({ browser }, info) => {
    test.skip(process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1'
      || process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST !== '1',
    'Explicitly owns local ports 3000, 3101 and 3102.');
    test.setTimeout(480_000);
    const proxy = await startCollaborationFailoverProxy(3101);
    const processA = await startProposalCrashHost(info.outputPath('process-a.log'), { port: 3101, multiprocess: true });
    const processB = await startProposalCrashHost(info.outputPath('process-b.log'), { port: 3102, multiprocess: true });
    try {
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, agentContext, content, revisionCount }) => {
        const peerContext = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
        const peer = await peerContext.newPage();
        let challengeContext: BrowserContext | undefined;
        let recoveryContext: BrowserContext | undefined;
        const headers = { 'x-canvas-workspace-id': target.workspaceId };
        let request: ProposalReviewActionApiRequestV1 | undefined;
        let firstProposal: ReturnType<typeof parseProposalToolCreationResultV1> | undefined;
        let firstReceipt: ProposalActionReceiptV1 | undefined;
        try {
          for (const candidate of [peerContext]) await candidate.addInitScript((workspaceId: string) => {
            localStorage.setItem('canvas.activeWorkspaceId', workspaceId);
            localStorage.setItem('canvas.notebook.chatVisible', 'false');
          }, target.workspaceId);
          await openEditor(peer, filePath);
          const peerSession = await sessionFor(peerContext, target.workspaceId, filePath);
          await expect.poll(async () => (await readCollaborationMultiprocessOwnerState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath,
          })).lockHeld, { timeout: 30_000 }).toBe(true);
          const ownedByA = await readCollaborationMultiprocessOwnerState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath,
          });
          expect(ownedByA.activities.some(activity => activity.applicationName === ownerApplicationName(processA.pid))).toBe(true);
          expect(ownedByA.backendPid).not.toBeNull();

          const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `multiprocess-read-${randomUUID()}`,
            params: { path: filePath, source: 'blocks' }, context: agentContext });
          expect(read.isError).not.toBe(true);
          const agentBlock = read.details!.structure!.blocks.find(block => block.text === 'Agent target.');
          expect(agentBlock).toBeTruthy();
          const created = await runOrdinaryAgentTool({ toolName: 'edit_file', toolCallId: `multiprocess-edit-${randomUUID()}`,
            params: { path: filePath, document: read.details!.document, blockId: agentBlock!.id,
              expectedSha256: read.details!.sha256, oldText: 'Agent target.', newText: 'Agent target approved.' }, context: agentContext });
          expect(created.isError).not.toBe(true);
          expect(created.details?.outcome).toBe('review_required');
          firstProposal = parseProposalToolCreationResultV1(created.details?.proposal);

          await peerContext.setOffline(true);
          await peer.locator(EDITOR).getByText('Peer target.', { exact: true }).click();
          await peer.keyboard.press('End');
          await peer.keyboard.insertText(' offline');
          await expect(peer.locator(EDITOR)).toContainText('Peer target. offline');
          await expect.poll(async () => JSON.stringify(await localRichState(peer, peerSession))).toContain('Peer target. offline');
          expect(await content()).toBe(INITIAL);

          proxy.switchBackend(3102);
          challengeContext = await createAuthenticatedContext(browser, { viewport: { width: 1100, height: 800 } });
          await challengeContext.addInitScript((workspaceId: string) => {
            localStorage.setItem('canvas.activeWorkspaceId', workspaceId);
            localStorage.setItem('canvas.notebook.chatVisible', 'false');
          }, target.workspaceId);
          const challenge = await challengeContext.newPage();
          await challenge.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
          await expect.poll(async () => (await readCollaborationMultiprocessOwnerState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath,
          })).activities.map(activity => activity.applicationName), { timeout: 30_000 })
            .toContain(ownerApplicationName(processB.pid));
          const contended = await readCollaborationMultiprocessOwnerState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath,
          });
          expect(contended.epoch).toBe(ownedByA.epoch);
          expect(contended.backendPid).toBe(ownedByA.backendPid);
          expect(contended.tokenHash).toBe(ownedByA.tokenHash);
          expect(contended.lockHeld).toBe(true);
          await challengeContext.close();
          challengeContext = undefined;

          proxy.switchBackend(3101);
          const beforeRevisions = await revisionCount();
          const link = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
            selectedEntry: { kind: 'agent_operation', id: firstProposal.operationId }, initialView: 'reviews', source: 'deep_link' });
          await page.goto(link);
          const graph = page.getByTestId('graph-review-comparison');
          await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled({ timeout: 30_000 });
          await processA.arm({ ...target, path: filePath, userId: agentContext.userId as string },
            'persisted-before-history', agentContext.sessionId as string, agentContext.agentId as string);
          await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
          const sent = page.waitForRequest(candidate => candidate.method() === 'POST'
            && new URL(candidate.url()).pathname === ACTION);
          await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
          request = (await sent).postDataJSON() as ProposalReviewActionApiRequestV1;
          const interrupted = await processA.crashed();
          proxy.switchBackend(3102);
          expect(interrupted.boundary).toMatchObject({ point: 'persisted-before-history', mutations: 1,
            acknowledged: true, historyCaptured: false });
          await page.goto('about:blank').catch(() => undefined);
          const afterCrash = await readProposalCrashState({ documentId: target.documentId,
            workspaceId: target.workspaceId, path: filePath, operationId: interrupted.boundary.operationId });
          expect(afterCrash.canonicalContent).toBe(AFTER_AGENT);
          const ownerAfterCrash = await readCollaborationMultiprocessOwnerState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath,
          });
          expect(ownerAfterCrash.backendPid).toBe(ownedByA.backendPid);
          expect(ownerAfterCrash.lockHeld).toBe(false);

          recoveryContext = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
          await recoveryContext.addInitScript((workspaceId: string) => {
            localStorage.setItem('canvas.activeWorkspaceId', workspaceId);
            localStorage.setItem('canvas.notebook.chatVisible', 'false');
          }, target.workspaceId);
          const recovery = await recoveryContext.newPage();
          await openEditor(recovery, filePath);
          await expect(recovery.locator(EDITOR)).toContainText('Agent target approved.');
          await expect(recovery.locator(EDITOR)).toContainText('Peer target.');
          await expect.poll(async () => (await readCollaborationMultiprocessOwnerState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath,
          })).activities.map(activity => activity.applicationName), { timeout: 30_000 })
            .toContain(ownerApplicationName(processB.pid));
          const ownedByB = await readCollaborationMultiprocessOwnerState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath,
          });
          expect(ownedByB.epoch).toBe(ownedByA.epoch + 1);
          expect(ownedByB.backendPid).not.toBe(ownedByA.backendPid);
          expect(ownedByB.lockHeld).toBe(true);
          expect(ownedByB.activities.find(activity => activity.pid === ownedByB.backendPid)?.applicationName)
            .toBe(ownerApplicationName(processB.pid));

          await peerContext.setOffline(false);
          await expect.poll(content, { timeout: 45_000 }).toBe(AFTER_BOTH);
          await expect(recovery.locator(EDITOR)).toContainText('Peer target. offline');
          const merged = await readProposalCrashState({ documentId: target.documentId,
            workspaceId: target.workspaceId, path: filePath, operationId: interrupted.boundary.operationId });
          expect(merged.canonicalContent).toBe(AFTER_BOTH);
          await expect.poll(async () => (await readProposalCrashState({ documentId: target.documentId,
            workspaceId: target.workspaceId, path: filePath, operationId: interrupted.boundary.operationId })).receipt?.status,
          { timeout: 30_000 }).toMatch(/^(persisted_yjs|checkpointed_file)$/u);

          const retried = await context.request.post(ACTION, { headers, data: request });
          expect(retried.ok()).toBeTruthy();
          firstReceipt = await retried.json() as ProposalActionReceiptV1;
          const statusIdentity = { contractVersion: 1 as const, target: request.target,
            idempotencyKey: request.action.idempotencyKey, requestDigest: request.action.fence.requestDigest,
            approvalExpiresAt: request.action.fence.expiresAt };
          await expect.poll(async () => {
            const statusResponse = await context.request.post(`${ACTION}/status`, { headers, data: statusIdentity });
            if (statusResponse.status() === 409) {
              const pending = await statusResponse.json() as { error?: { code?: string }; code?: string };
              expect(pending.error?.code ?? pending.code).toBe('PROPOSAL_RECOVERY_REQUIRED');
              return firstReceipt?.phase;
            }
            expect(statusResponse.ok()).toBeTruthy();
            const status = await statusResponse.json() as ProposalReviewActionStatusResponseV1;
            if (status.receipt) firstReceipt = status.receipt;
            return firstReceipt?.phase;
          }, { timeout: 30_000 }).toBe('succeeded');
          expect(firstReceipt.result?.resolutions).toEqual([{ proposalId: firstProposal.proposalId, lifecycle: 'applied' }]);
          const revisionsAfterRetry = await revisionCount();
          const retriedAgain = await context.request.post(ACTION, { headers, data: request });
          expect(retriedAgain.ok()).toBeTruthy();
          expect(await retriedAgain.json()).toEqual(firstReceipt);
          expect(await revisionCount()).toBe(revisionsAfterRetry);
          expect(revisionsAfterRetry).toBeGreaterThan(beforeRevisions);
          expect(await content()).toBe(AFTER_BOTH);

          const followRead = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `multiprocess-follow-read-${randomUUID()}`,
            params: { path: filePath, source: 'blocks' }, context: agentContext });
          expect(followRead.isError).not.toBe(true);
          const heading = followRead.details!.structure!.blocks.find(block => block.text === 'Recovery');
          expect(heading).toBeTruthy();
          const followCreated = await runOrdinaryAgentTool({ toolName: 'edit_file', toolCallId: `multiprocess-follow-edit-${randomUUID()}`,
            params: { path: filePath, document: followRead.details!.document, blockId: heading!.id,
              expectedSha256: followRead.details!.sha256, oldText: 'Recovery', newText: 'Recovery complete' }, context: agentContext });
          expect(followCreated.isError).not.toBe(true);
          expect(followCreated.details?.outcome).toBe('review_required');
          const followProposal = parseProposalToolCreationResultV1(followCreated.details?.proposal);
          const followLink = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
            selectedEntry: { kind: 'agent_operation', id: followProposal.operationId }, initialView: 'reviews', source: 'deep_link' });
          await recovery.goto(followLink);
          const followGraph = recovery.getByTestId('graph-review-comparison');
          await expect(followGraph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled({ timeout: 30_000 });
          await followGraph.getByRole('button', { name: 'Accept change', exact: true }).click();
          const followResponse = recovery.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === ACTION);
          await followGraph.getByRole('button', { name: 'Confirm action', exact: true }).click();
          const followReply = await followResponse;
          expect(followReply.ok()).toBeTruthy();
          const followReceipt = await followReply.json() as ProposalActionReceiptV1;
          expect(followReceipt.phase).toBe('succeeded');
          await expect.poll(content, { timeout: 30_000 }).toBe('# Recovery complete\n\nAgent target approved.\n\nPeer target. offline');
          await info.attach('multiprocess-crash-offline-recovery.png', { contentType: 'image/png', body: await recovery.screenshot() });
          await info.attach('multiprocess-crash-offline-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, processA: { pid: processA.pid, port: processA.port }, processB: { pid: processB.pid, port: processB.port },
            ownedByA, contended, ownerAfterCrash, ownedByB, afterCrash, merged, firstReceipt, followReceipt,
          }, null, 2) });
        } finally {
          await page.goto('about:blank').catch(() => undefined);
          await peerContext.setOffline(false).catch(() => undefined);
          await Promise.all([
            challengeContext?.close().catch(() => undefined),
            recoveryContext?.close().catch(() => undefined),
            peerContext.close().catch(() => undefined),
          ]);
          if (processA.isRunning()) await processA.stop();
          // Keep the surviving process behind the stable origin until the
          // scoped helper cleanup has removed the synthetic document.
          proxy.switchBackend(3102);
        }
      }, { workspaceKind, bindToolSessionToFixture: true, expectedReviewServerErrors: [
        { path: ACTION, status: 502 },
        { path: `${ACTION}/status`, status: 502, minCount: 0, maxCount: 3 },
      ] });
    } finally {
      if (processA.isRunning()) await processA.stop().catch(() => undefined);
      if (processB.isRunning()) await processB.stop().catch(() => undefined);
      await proxy.stop().catch(() => undefined);
    }
  });
}
