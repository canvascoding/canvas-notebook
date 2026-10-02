import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { createHash, randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { parseFileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { runOrdinaryAgentTool, type OrdinaryAgentToolDetails } from './helpers/ordinary-agent-tool';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';

const INITIAL = '# Rich review\n\nP1=100 Q1=200\n';
const AFTER_P1 = '# Rich review\n\nP1=130 Q1=200\n';
const AFTER_Q = '# Rich review\n\nP1=100 Q1=230\n';
const FINAL = '# Rich review\n\nP1=130 Q1=230\n';

type Proposal = NonNullable<OrdinaryAgentToolDetails['proposal']>;

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary block-targeted Markdown edits (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');

    for (const order of ['p1-q', 'q-p1', 'batch'] as const) {
      test(`${order} preserves independent edits within the same live paragraph`, async ({ browser }, info) => {
        test.setTimeout(180_000);
        await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
          agentContext, content, revisionCount }) => {
          expect(representation).toBe('tiptap_blocks');
          expect(await content()).toBe(INITIAL);
          const before = await revisionCount();
          const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
            runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-block-${randomUUID()}`, params, context: agentContext });

          const source = await run('read', { path: filePath, source: 'blocks', structureLimit: 100 });
          expect(source.isError).not.toBe(true);
          const sourceDetails = source.details!;
          expect(sourceDetails.document).toMatchObject({ documentId: target.documentId,
            lifecycleGeneration: expect.any(Number), schemaVersion: expect.any(Number) });
          expect(sourceDetails.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
          const heading = sourceDetails.structure!.blocks.find(block => block.type === 'heading');
          const paragraph = sourceDetails.structure!.blocks.find(block => block.type === 'paragraph');
          expect(sourceDetails.structure!.blocks).toHaveLength(2);
          expect(sourceDetails.structure!.nextOffset).toBeNull();
          expect(heading?.text).toBe('Rich review');
          expect(paragraph?.text).toBe('P1=100 Q1=200');
          expect(heading!.id).not.toBe(paragraph!.id);

          const proposals: Proposal[] = [];
          for (const [oldText, newText] of [['P1=100', 'P1=130'], ['Q1=200', 'Q1=230']]) {
            const result = await run('edit_file', {
              path: filePath,
              document: sourceDetails.document,
              blockId: paragraph!.id,
              oldText,
              newText,
            });
            expect(result.isError).not.toBe(true);
            expect(result.details?.outcome).toBe('review_required');
            expect(result.details?.collaboration).toMatchObject({
              reviewRequired: true, operationStatus: 'needs_review', durability: 'not_applied',
            });
            expect(result.details?.proposal).toMatchObject({
              creationKind: 'independent', source: { kind: 'authoritative' },
            });
            proposals.push(result.details!.proposal!);
          }
          const [p1, q] = proposals;
          expect(p1!.proposalId).not.toBe(q!.proposalId);
          expect(p1!.operationId).not.toBe(q!.operationId);
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(before);

          const headers = { 'x-canvas-workspace-id': target.workspaceId };
          const review = async (selected: Proposal) => {
            const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
              headers,
              data: { contractVersion: 1, target,
                selection: { kind: 'operation', operationId: selected.operationId } },
            });
            expect(response.ok()).toBeTruthy();
            const session = await response.json() as ProposalReviewSessionResponseV1;
            expect(session.mode).toBe('graph');
            if (session.mode !== 'graph') throw new Error('Block-targeted ordinary edits must use graph review.');
            expect(session.selectedProposalIds).toEqual([selected.proposalId]);
            return session;
          };
          const assertLiveBlocks = async (expectedParagraph: string) => {
            const current = await run('read', { path: filePath, source: 'blocks', structureLimit: 100 });
            expect(current.isError).not.toBe(true);
            expect(current.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
            expect(current.details?.document).toEqual(sourceDetails.document);
            const blocks = current.details!.structure!.blocks;
            expect(blocks).toHaveLength(2);
            expect(current.details!.structure!.nextOffset).toBeNull();
            expect(blocks.find(block => block.type === 'heading')?.id).toBe(heading!.id);
            expect(blocks.find(block => block.type === 'heading')?.text).toBe('Rich review');
            expect(blocks.find(block => block.type === 'paragraph')?.id).toBe(paragraph!.id);
            expect(blocks.find(block => block.type === 'paragraph')?.text).toBe(expectedParagraph);
          };
          await assertLiveBlocks('P1=100 Q1=200');

          let actionPosts = 0;
          page.on('request', request => {
            if (request.method() === 'POST'
              && new URL(request.url()).pathname === '/api/files/version-center/v1/proposals/actions') actionPosts += 1;
          });
          const selectedOrder = order === 'q-p1' ? [q!, p1!] : order === 'p1-q' ? [p1!, q!] : [p1!];
          const receipts: ProposalActionReceiptV1[] = [];
          for (const [index, selected] of selectedOrder.entries()) {
            const session = await review(selected);
            expect(session.status).toBe(index === 0 ? 'clean' : 'clean_rebased');
            expect(session.context?.dependencyProposalIds).toEqual([]);
            expect(session.context?.applyProposalIds).toEqual([selected.proposalId]);

            const expectedCurrent = index === 0 ? INITIAL : order === 'p1-q' ? AFTER_P1 : AFTER_Q;
            const expectedNext = index === 0
              ? selected.proposalId === p1!.proposalId ? AFTER_P1 : AFTER_Q
              : FINAL;
            const changedLines = session.compare!.hunks.flatMap(hunk => hunk.lines)
              .filter(line => line.kind !== 'context').map(line => [line.kind, line.text]);
            expect(changedLines).toEqual([
              ['deletion', expectedCurrent.split('\n')[2]],
              ['addition', expectedNext.split('\n')[2]],
            ]);

            await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
              selectedEntry: { kind: 'agent_operation', id: selected.operationId }, initialView: 'reviews', source: 'deep_link' }));
            const graph = page.getByTestId('graph-review-comparison');
            await expect(graph.getByText(index === 0 ? 'Ready to apply' : 'Ready after rebase', { exact: true }))
              .toBeVisible({ timeout: 30_000 });
            if (order === 'batch') {
              await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
              await expect(graph).toContainText('2 proposals selected');
              await expect(graph.getByTestId('graph-review-hunks')).toContainText('P1=130 Q1=230');
            }
            await graph.getByRole('button', {
              name: order === 'batch' ? 'Accept all changes' : 'Accept change', exact: true,
            }).click();
            const pending = page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
            await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
            const response = await pending;
            expect(response.ok()).toBeTruthy();
            const receipt = await response.json() as ProposalActionReceiptV1;
            expect(receipt.phase).toBe('succeeded');
            expect(receipt.actionType).toBe(order === 'batch' ? 'batch_accept' : 'accept');
            expect(receipt.result?.kind).toBe('content_changed');
            const acceptedIds = order === 'batch' ? proposals.map(proposal => proposal.proposalId) : [selected.proposalId];
            expect([...receipt.affectedProposalIds].sort()).toEqual([...acceptedIds].sort());
            receipts.push(receipt);

            const expectedAfterAction = order === 'batch' || index === 1 ? FINAL : expectedNext;
            expect(await content()).toBe(expectedAfterAction);
            expect(await revisionCount()).toBe(before + index + 1);
            await assertLiveBlocks(expectedAfterAction.split('\n')[2]!);

            const decided = await review(selected);
            expect(decided.context?.proposals.find(proposal => proposal.proposalId === selected.proposalId)?.lifecycle)
              .toBe('applied');
            expect(decided.actions.accept).toBeUndefined();
          }

          for (const proposal of proposals) {
            const decided = await review(proposal);
            expect(decided.context?.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle).toBe('applied');
            expect(decided.actions.accept).toBeUndefined();
          }
          expect(actionPosts).toBe(order === 'batch' ? 1 : 2);
          expect(await content()).toBe(FINAL);
          expect(await revisionCount()).toBe(before + (order === 'batch' ? 1 : 2));
          await assertLiveBlocks('P1=130 Q1=230');

          const completed = page.getByRole('dialog', { name: 'Versions & changes' });
          await expect(completed.getByRole('region', { name: 'Agent reviews', exact: true }))
            .toContainText('No agent changes need review.', { timeout: 30_000 });
          const lastReceipt = receipts.at(-1);
          if (lastReceipt?.phase !== 'succeeded' || lastReceipt.result.kind !== 'content_changed') {
            throw new Error('The final accepted action needs a succeeded content revision receipt.');
          }
          const revisionId = lastReceipt.result.revisionId;
          expect(lastReceipt.result.current.revisionId).toBe(revisionId);
          const timelineResponse = await context.request.post('/api/files/version-center/v1/resolve', {
            headers: { ...headers, 'x-canvas-version-history-provenance': '1' },
            data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
          });
          expect(timelineResponse.status()).toBe(200);
          const timeline = parseFileVersionTimelineResponseV1(await timelineResponse.json());
          const current = timeline.entries.find(entry => entry.kind === 'current');
          const saved = timeline.entries.find(entry => entry.kind === 'revision' && entry.revisionId === revisionId);
          if (current?.kind !== 'current' || saved?.kind !== 'revision') {
            throw new Error('The final receipt revision needs current display provenance and immutable history.');
          }
          expect(current.displayRevisionId ?? current.revisionId).toBe(revisionId);
          const finalHash = createHash('sha256').update(FINAL).digest('hex');
          expect(saved.content.sha256).toBe(finalHash);
          expect(current.sha256).toBe(finalHash);
          expect(lastReceipt.result.current.contentHash).toBe(finalHash);
          await expect(completed.getByRole('heading', { name: `Current version · Version ${saved.revisionNumber}`, exact: true })).toBeVisible();
          await expect(completed.getByRole('region', { name: 'Current', exact: true }).locator('button[data-entry-kind="current"]'))
            .toHaveAttribute('aria-pressed', 'true');
          await expect(completed.locator('dt').filter({ hasText: /^Version ID$/u }).locator('..').locator('dd')).toHaveText(revisionId);
          await info.attach('ordinary-block-tools-evidence.json', {
            contentType: 'application/json',
            body: JSON.stringify({ workspaceKind, order, representation: 'tiptap_blocks', sameParagraph: true,
              target, document: sourceDetails.document, headingBlockId: heading!.id, paragraphBlockId: paragraph!.id,
              proposalIds: proposals.map(proposal => proposal.proposalId),
              expectedFinalText: 'P1=130 Q1=230',
              beforeRevisionCount: before, afterRevisionCount: before + (order === 'batch' ? 1 : 2),
              actionPosts, receipts,
              proposalCount: proposals.length }, null, 2),
          });
          await info.attach('ordinary-block-tools-final.png', {
            contentType: 'image/png', body: await page.screenshot({ fullPage: true }),
          });
        }, { workspaceKind });
      });
    }
  });
}
