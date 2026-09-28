import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type { PreparingCrashPoint } from '../scripts/collaboration-proposal-preparing-crash-probe';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { parseProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1, type ProposalReviewActionApiRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';
import { startProposalCrashHost } from './helpers/proposal-crash-host';
import { readProposalCrashState } from './helpers/proposal-crash-state';

const ACTION = '/api/files/version-center/v1/proposals/actions';
const INITIAL = 'Diese Zeile wird gelöscht.';
const PREPARING_POINT: PreparingCrashPoint = 'prepared-before-apply';

for (const workspaceKind of ['personal', 'team'] as const) {
  test(`Proposal preparation crash (${workspaceKind}) leaves no effect and permits a fresh approval`, async ({ browser }, info) => {
    test.skip(process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1', 'Explicitly owns port 3000; do not run against another app process.');
    test.setTimeout(360_000);
    let host = await startProposalCrashHost(info.outputPath('initial-host.log'));
    try {
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, agentContext, content, revisionCount }) => {
        try {
          const headers = { 'x-canvas-workspace-id': target.workspaceId };
          const beforeRevisions = await revisionCount();
          const readState = (operationId?: string) => readProposalCrashState({
            documentId: target.documentId, workspaceId: target.workspaceId, path: filePath, operationId,
          });
          const baseline = await readState();
          expect(baseline.canonicalContent).toBe(INITIAL);
          expect(baseline.degraded).toBe(false);

          const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-preparing-${randomUUID()}`,
            params: { path: filePath, source: 'blocks' }, context: agentContext });
          expect(read.isError).not.toBe(true);
          const created = await runOrdinaryAgentTool({ toolName: 'edit_file', toolCallId: `ordinary-preparing-${randomUUID()}`,
            params: { path: filePath, document: read.details!.document, blockId: read.details!.structure!.blocks[0]!.id,
              expectedSha256: read.details!.sha256, oldText: INITIAL, newText: '' }, context: agentContext });
          expect(created.isError).not.toBe(true);
          expect(created.details?.outcome).toBe('review_required');
          const proposal = parseProposalToolCreationResultV1(created.details?.proposal);
          expect(await content()).toBe(INITIAL);

          const link = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
            selectedEntry: { kind: 'agent_operation', id: proposal.operationId }, initialView: 'reviews', source: 'deep_link' });
          await page.goto(link);
          const graph = page.getByTestId('graph-review-comparison');
          await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled({ timeout: 30_000 });
          await expect(graph.getByTestId('graph-review-hunks')).toContainText(INITIAL);
          await info.attach('preparing-before-crash-preview.png', { contentType: 'image/png', body: await page.screenshot() });

          await host.arm({ ...target, path: filePath, userId: agentContext.userId as string }, PREPARING_POINT,
            agentContext.sessionId as string, agentContext.agentId as string);
          await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
          const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === ACTION);
          await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
          const oldRequest = (await sent).postDataJSON() as ProposalReviewActionApiRequestV1;
          const interrupted = await host.crashed();
          await info.attach('preparing-crash-boundary.json', { contentType: 'application/json', body: JSON.stringify(interrupted) });
          expect(interrupted.boundary).toMatchObject({ point: PREPARING_POINT, mutations: 0, acknowledged: false,
            historyCaptured: false, documentSequence: baseline.documentSequence });
          const operationId = interrupted.boundary.operationId!;
          expect(host.messages.filter(message => message.type === 'direct' && message.documentId === target.documentId)).toHaveLength(0);
          await page.goto('about:blank');

          const afterCrash = await readState(operationId);
          expect(afterCrash.canonicalContent).toBe(baseline.canonicalContent);
          expect(afterCrash.binaryHash).toBe(baseline.binaryHash);
          expect(afterCrash.stateProof).toBe(baseline.stateProof);
          expect(afterCrash.documentSequence).toBe(baseline.documentSequence);
          expect(afterCrash.degraded).toBe(false);
          expect(afterCrash.receipt).toMatchObject({ status: 'preparing', snapshotHash: null, resultHash: null });

          host = await startProposalCrashHost(info.outputPath('recovery-host.log'));
          await expect.poll(async () => (await readState(operationId)).receipt?.status, { timeout: 30_000 }).toBe('cancelled');
          const afterRestart = await readState(operationId);
          expect(afterRestart.canonicalContent).toBe(baseline.canonicalContent);
          expect(afterRestart.binaryHash).toBe(baseline.binaryHash);
          expect(afterRestart.stateProof).toBe(baseline.stateProof);
          expect(afterRestart.documentSequence).toBe(baseline.documentSequence);
          expect(afterRestart.degraded).toBe(false);
          expect(afterRestart.receipt).toMatchObject({ status: 'cancelled', snapshotHash: null, resultHash: null });
          expect(host.messages.filter(message => message.type === 'direct' && message.documentId === target.documentId)).toEqual([]);
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(beforeRevisions);

          const failedResponse = await context.request.post(ACTION, { headers, data: oldRequest });
          expect(failedResponse.ok()).toBeTruthy();
          const failedReceipt = await failedResponse.json() as ProposalActionReceiptV1;
          expect(failedReceipt.phase).toBe('failed');
          expect(failedReceipt.errorCode).toBe('PROPOSAL_NO_EFFECT');
          expect(failedReceipt.result).toBeNull();
          expect(failedReceipt.actionId).toBe(operationId);
          expect(failedReceipt.operationId).toBe(operationId);
          const failedRetry = await context.request.post(ACTION, { headers, data: oldRequest });
          expect(failedRetry.ok()).toBeTruthy();
          expect(await failedRetry.json()).toEqual(failedReceipt);
          expect(await revisionCount()).toBe(beforeRevisions);
          expect(await content()).toBe(INITIAL);

          const statusResponse = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === `${ACTION}/status` && response.ok());
          await page.goto(link);
          const recoveredStatus = await (await statusResponse).json() as { receipt: ProposalActionReceiptV1 };
          expect(recoveredStatus.receipt).toEqual(failedReceipt);
          await expect(page.getByTestId('graph-review-pending-action')).toHaveCount(0, { timeout: 30_000 });
          const accept = graph.getByRole('button', { name: 'Accept change', exact: true });
          await expect(accept).toBeEnabled({ timeout: 30_000 });
          await info.attach('preparing-crash-recovered-review.png', { contentType: 'image/png', body: await page.screenshot() });

          await accept.click();
          const freshSent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === ACTION);
          const freshResponse = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === ACTION);
          await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
          const freshRequest = (await freshSent).postDataJSON() as ProposalReviewActionApiRequestV1;
          expect(freshRequest.action.idempotencyKey).not.toBe(oldRequest.action.idempotencyKey);
          const freshReply = await freshResponse;
          expect(freshReply.ok()).toBeTruthy();
          const succeeded = await freshReply.json() as ProposalActionReceiptV1;
          expect(succeeded.phase).toBe('succeeded');
          expect(succeeded.result?.kind).toBe('content_changed');
          expect(succeeded.result?.resolutions).toEqual([{ proposalId: proposal.proposalId, lifecycle: 'applied' }]);
          expect(await content()).toBe('');
          expect(await revisionCount()).toBe(beforeRevisions + 1);
          const recoveryDirectCalls = host.messages.filter(message => message.type === 'direct'
            && message.documentId === target.documentId);
          expect(recoveryDirectCalls).toHaveLength(1);
          expect(recoveryDirectCalls[0]!.operationId).toBe(succeeded.operationId);
          expect(recoveryDirectCalls[0]!.operationId).not.toBe(operationId);

          const freshRetry = await context.request.post(ACTION, { headers, data: freshRequest });
          expect(freshRetry.ok()).toBeTruthy();
          expect(await freshRetry.json()).toEqual(succeeded);
          expect(await revisionCount()).toBe(beforeRevisions + 1);
          const oldStillFailed = await context.request.post(ACTION, { headers, data: oldRequest });
          expect(oldStillFailed.ok()).toBeTruthy();
          expect(await oldStillFailed.json()).toEqual(failedReceipt);

          const reviewResponse = await context.request.post('/api/files/version-center/v1/proposals/review', { headers,
            data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: proposal.operationId } } });
          expect(reviewResponse.ok()).toBeTruthy();
          const review = parseProposalReviewSessionResponseV1(await reviewResponse.json());
          if (review.mode !== 'graph') throw new Error('Applied proposal must remain graph-owned for historical review.');
          expect(review.actions.accept).toBeUndefined();
          await page.goto(link);
          await expect(graph.getByTestId('graph-review-historical-status')).toBeVisible({ timeout: 30_000 });
          await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
          await info.attach('preparing-crash-historic-review.png', { contentType: 'image/png', body: await page.screenshot() });
          expect(host.messages.filter(message => message.type === 'direct' && message.documentId === target.documentId)).toHaveLength(1);
          await info.attach('preparing-crash-recovery-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, point: PREPARING_POINT, target, interrupted, baseline, afterCrash, afterRestart, beforeRevisions,
            afterRevisions: await revisionCount(), failedReceipt, succeeded, recoveryDirectCalls,
            oldRequestIdentity: { idempotencyKeyHash: createHash('sha256').update(oldRequest.action.idempotencyKey).digest('hex'),
              requestDigest: oldRequest.action.fence.requestDigest },
            freshRequestIdentity: { idempotencyKeyHash: createHash('sha256').update(freshRequest.action.idempotencyKey).digest('hex'),
              requestDigest: freshRequest.action.fence.requestDigest },
          }, null, 2) });
        } finally {
          // Restore a confirmed-dead owned child before fixture API cleanup.
          // Never replace a still-live process after a timeout.
          if (!host.isRunning()) host = await startProposalCrashHost(info.outputPath('cleanup-recovery-host.log'));
        }
      }, { workspaceKind, bindToolSessionToFixture: true });
    } finally { await host.stop(); }
  });
}
