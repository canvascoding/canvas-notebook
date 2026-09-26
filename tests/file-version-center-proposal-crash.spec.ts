import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CrashPoint } from '../scripts/collaboration-proposal-crash-probe';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { parseProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';
import { startProposalCrashHost } from './helpers/proposal-crash-host';

const execFileAsync = promisify(execFile);
const ACTION = '/api/files/version-center/v1/proposals/actions';
const INITIAL = 'Diese Zeile wird gelöscht.';

for (const workspaceKind of ['personal', 'team'] as const) {
  for (const point of ['persisted-before-ack', 'persisted-before-history', 'history-before-receipt'] as CrashPoint[]) {
    test(`Proposal process crash (${workspaceKind}) ${point} recovers without replay`, async ({ browser }, info) => {
      test.skip(process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1', 'Explicitly owns port 3000; do not run against another app process.');
      test.setTimeout(300_000);
      let host = await startProposalCrashHost(info.outputPath('initial-host.log'));
      try {
        await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, agentContext, content, revisionCount }) => {
          try {
            const headers = { 'x-canvas-workspace-id': target.workspaceId };
            const beforeRevisions = await revisionCount();
            const read = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `ordinary-crash-${randomUUID()}`,
              params: { path: filePath, source: 'blocks' }, context: agentContext });
            expect(read.isError).not.toBe(true);
            const created = await runOrdinaryAgentTool({ toolName: 'edit_file', toolCallId: `ordinary-crash-${randomUUID()}`,
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
            await info.attach('pre-crash-preview.png', { contentType: 'image/png', body: await page.screenshot() });
            await host.arm({ ...target, path: filePath, userId: agentContext.userId as string }, point,
              agentContext.sessionId as string, agentContext.agentId as string);
            await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
            const sent = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === ACTION);
            await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
            const request = (await sent).postDataJSON();
            const interrupted = await host.crashed();
            await info.attach('crash-boundary.json', { contentType: 'application/json', body: JSON.stringify(interrupted) });
            expect(interrupted.boundary).toMatchObject({ point, mutations: 1, acknowledged: point !== 'persisted-before-ack',
              historyCaptured: point === 'history-before-receipt', documentSequence: 1 });
            const operationId = interrupted.boundary.operationId!;
            expect(host.messages.filter(message => message.type === 'direct' && message.operationId === operationId)).toHaveLength(1);
            // A disconnected browser must not resend its cached Yjs state on restart.
            await page.goto('about:blank');
            const saved = async () => {
              let stdout: string;
              try {
                ({ stdout } = await execFileAsync(path.resolve('node_modules/.bin/tsx'), ['--conditions', 'react-server',
                  'scripts/collaboration-e2e-storage-read.ts', Buffer.from(JSON.stringify({ documentId: target.documentId,
                    workspaceId: target.workspaceId, path: filePath, operationId, includeGraphProof: true })).toString('base64url')],
                { env: process.env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }));
              } catch { throw new Error('Scoped persisted crash evidence was unavailable.'); }
              return JSON.parse(stdout) as { canonicalContent: string; binaryHash: string; stateProof: string;
                documentSequence: number; degraded: boolean; receipt: { status: string; snapshotHash: string | null } };
            };
            const beforeRestart = await saved();
            expect(beforeRestart.canonicalContent).toBe('');
            expect(beforeRestart.degraded).toBe(false);
            expect(beforeRestart.receipt.status).toBe(point === 'persisted-before-ack' ? 'applying' : 'applied_to_ydoc');
            if (point === 'persisted-before-ack') expect(beforeRestart.receipt.snapshotHash).toBeNull();
            else expect(beforeRestart.receipt.snapshotHash).toMatch(/^[a-f0-9]{64}$/u);
            host = await startProposalCrashHost(info.outputPath('recovery-host.log'));
            await expect.poll(async () => (await saved()).receipt.status, { timeout: 30_000 }).toBe('persisted_yjs');
            const afterRestart = await saved();
            expect(afterRestart.canonicalContent).toBe('');
            expect(afterRestart.binaryHash).toBe(beforeRestart.binaryHash);
            expect(afterRestart.stateProof).toBe(beforeRestart.stateProof);
            expect(afterRestart.documentSequence).toBe(beforeRestart.documentSequence);
            expect(host.messages.filter(message => message.type === 'direct' && message.documentId === target.documentId)).toEqual([]);
            const retried = await context.request.post(ACTION, { headers, data: request });
            expect(retried.ok()).toBeTruthy();
            const receipt = await retried.json() as ProposalActionReceiptV1;
            expect(receipt.phase).toBe('succeeded');
            expect(receipt.result?.kind).toBe('content_changed');
            expect(receipt.result?.resolutions).toEqual([{ proposalId: proposal.proposalId, lifecycle: 'applied' }]);
            expect(await content()).toBe('');
            expect(await revisionCount()).toBe(beforeRevisions + 1);
            const retryAgain = await context.request.post(ACTION, { headers, data: request });
            expect(retryAgain.ok()).toBeTruthy(); expect(await retryAgain.json()).toEqual(receipt);
            expect(await revisionCount()).toBe(beforeRevisions + 1);
            const reviewResponse = await context.request.post('/api/files/version-center/v1/proposals/review', { headers,
              data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: proposal.operationId } } });
            expect(reviewResponse.ok()).toBeTruthy();
            const review = parseProposalReviewSessionResponseV1(await reviewResponse.json());
            if (review.mode !== 'graph') throw new Error('Recovered proposal must remain graph-owned.');
            expect(review.actions.accept).toBeUndefined();
            const statusReply = page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === `${ACTION}/status` && response.ok());
            await page.goto(link);
            expect((await (await statusReply).json()).receipt).toEqual(receipt);
            await expect(page.getByTestId('graph-review-pending-action')).toHaveCount(0, { timeout: 30_000 });
            await expect(page.getByRole('dialog').getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
            // Lost-response convergence deliberately refreshes/selects Current.
            // A subsequent explicit historical deep link must still be available.
            await page.goto(link);
            await expect(graph.getByTestId('graph-review-historical-status')).toBeVisible({ timeout: 30_000 });
            await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
            await info.attach('post-restart-review.png', { contentType: 'image/png', body: await page.screenshot() });
            expect(host.messages.filter(message => message.type === 'direct' && message.documentId === target.documentId)).toEqual([]);
            await info.attach('crash-recovery-evidence.json', { contentType: 'application/json', body: JSON.stringify({
              workspaceKind, point, target, interrupted, beforeRestart, afterRestart, beforeRevisions,
              afterRevisions: await revisionCount(), receipt, recoveryDirectCalls: 0,
            }, null, 2) });
          } finally {
            // Restore a confirmed-dead owned child before the fixture's API
            // cleanup. Never replace a still-live process after a timeout.
            if (!host.isRunning()) host = await startProposalCrashHost(info.outputPath('cleanup-recovery-host.log'));
          }
        }, { workspaceKind, bindToolSessionToFixture: true });
      } finally { await host.stop(); }
    });
  }
}
