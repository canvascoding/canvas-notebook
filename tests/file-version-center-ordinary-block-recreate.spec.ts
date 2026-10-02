import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { COLLABORATION_CLIENT_CAPABILITIES, type CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1, type ProposalReviewSessionRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nHinweis: Standardversand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const DELETED = '# Versand\n\nHinweis: Standardversand\n\nLieferzeit: 5 Tage\n';
const FINAL = '# Versand\n\nHinweis: Standardversand\n\nKosten: 10 EUR\n\nLieferzeit: 2 Tage\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary rich block recreation (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    test('equal text cannot revive a deleted target, while the independent proposal still applies', async ({ browser }, info) => {
      test.setTimeout(240_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
        agentContext, content, revisionCount }) => {
        page.setDefaultTimeout(20_000);
        expect(representation).toBe('tiptap_blocks');
        const headers = { 'x-canvas-workspace-id': target.workspaceId };
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-block-recreate-${randomUUID()}`, params, context: agentContext });
        const read = async () => {
          const result = await run('read', { path: filePath, source: 'blocks' });
          expect(result.isError).not.toBe(true);
          expect(result.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
          expect(result.details?.structure?.nextOffset).toBeNull();
          return result.details!;
        };
        const review = async (selection: ProposalReviewSessionRequestV1['selection']) => {
          const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
            headers, data: { contractVersion: 1, target, selection },
          });
          expect(response.ok()).toBeTruthy();
          const session = parseProposalReviewSessionResponseV1(await response.json());
          if (session.mode !== 'graph') throw new Error('Block recreation must not fall back to a legacy comparison.');
          return session;
        };
        const session = async () => {
          const response = await context.request.post('/api/files/collaboration/session', {
            headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
          });
          expect(response.ok()).toBeTruthy();
          const value = await response.json() as CollaborationSessionResponse;
          expect(value.documentId).toBe(target.documentId);
          expect(value.representation).toBe('tiptap_blocks');
          return value;
        };
        const source = await read();
        const blocks = source.structure!.blocks;
        expect(blocks.map(block => block.text)).toEqual(['Versand', 'Hinweis: Standardversand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage']);
        const originalIds = blocks.map(block => block.id);
        const create = async (index: number, oldText: string, newText: string) => {
          const result = await run('edit_file', { path: filePath, document: source.document,
            blockId: originalIds[index], expectedSha256: source.sha256, oldText, newText });
          expect(result.isError).not.toBe(true);
          expect(result.details?.outcome).toBe('review_required');
          const proposal = parseProposalToolCreationResultV1(result.details?.proposal);
          expect(proposal.creationKind).toBe('independent');
          expect(proposal.source.kind).toBe('authoritative');
          return proposal;
        };
        const safe = await create(3, '5 Tage', '2 Tage');
        const obsolete = await create(2, '10 EUR', '12 EUR');
        const selectedIds = [safe.proposalId, obsolete.proposalId];
        expect(await content()).toBe(INITIAL);
        const ready = await review({ kind: 'operation', operationId: obsolete.operationId });
        const batchReady = await review({ kind: 'proposals', proposalIds: selectedIds });
        expect(ready.status).toBe('clean');
        expect(batchReady.status).toBe('clean_rebased');
        expect(ready.actions.accept).toBeTruthy();
        expect(batchReady.actions.accept).toBeTruthy();
        const beforeEditSession = await session();

        // Real editing gestures only: select the paragraph's visible text, erase
        // it, remove its empty block, then insert a new paragraph at that position.
        await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
        const editor = page.locator('.tiptap-editor-shell .ProseMirror');
        await expect(editor).toHaveAttribute('contenteditable', 'true');
        const cost = editor.getByText('Kosten: 10 EUR', { exact: true });
        await cost.click();
        await cost.evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Kosten: 10 EUR');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await expect(cost).toHaveCount(0);
        await expect.poll(content, { timeout: 30_000, intervals: [500, 1000] }).toBe(DELETED);
        const deleted = await read();
        expect(deleted.structure!.blocks.map(block => block.id)).toEqual([originalIds[0], originalIds[1], originalIds[3]]);
        expect(deleted.document).toEqual(source.document);
        await editor.getByText('Hinweis: Standardversand', { exact: true }).click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.insertText('Kosten: 10 EUR');
        await expect.poll(content, { timeout: 30_000, intervals: [500, 1000] }).toBe(INITIAL);
        const recreated = await read();
        expect(recreated.sha256).toBe(source.sha256);
        expect(recreated.document).toEqual(source.document);
        expect(recreated.structure!.blocks.map(block => block.text)).toEqual(blocks.map(block => block.text));
        const newBlockId = recreated.structure!.blocks[2]!.id;
        expect(originalIds).not.toContain(newBlockId);
        const newIds = [originalIds[0], originalIds[1], newBlockId, originalIds[3]];
        expect(recreated.structure!.blocks.map(block => block.id)).toEqual(newIds);
        await info.attach('ordinary-block-recreated-editor.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        // Wait for durable Yjs and the file/history checkpoint, not just equal
        // projected text. Otherwise a delayed user checkpoint could skew +1.
        await expect.poll(async () => {
          const current = await session();
          return current.documentSequence! > beforeEditSession.documentSequence!
            && current.checkpointSequence === current.documentSequence;
        }, { timeout: 30_000, intervals: [500, 1000] }).toBe(true);
        const beforeMerge = await revisionCount();
        let actionPosts = 0;
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
        });
        const assertConflict = async () => {
          const result = await review({ kind: 'operation', operationId: obsolete.operationId });
          expect(result.status).toBe('conflicted');
          expect(result.diagnosis.reasonCode).toBe(Codes.batchConflict);
          expect(result.actions.accept).toBeUndefined();
          expect(result.compare?.candidate).toMatchObject({ contentAvailable: false, noEffect: false });
          expect(result.compare?.binding?.selectedProposalIds).toEqual([obsolete.proposalId]);
          expect(result.compare?.diagnosis.availability).toBe('unavailable');
          expect(result.compare?.hunks).toEqual([]);
          expect(result.context?.proposals.find(proposal => proposal.proposalId === obsolete.proposalId)?.lifecycle).toBe('open');
          return result;
        };
        const conflict = await assertConflict();
        const safeReady = await review({ kind: 'operation', operationId: safe.operationId });
        expect(safeReady.status).toBe('clean_rebased');
        expect(safeReady.actions.accept).toBeTruthy();
        expect(conflict.compare!.binding!.current).toEqual(safeReady.compare!.binding!.current);
        expect(safeReady.compare!.binding!.current.contentHash).toBe(ready.compare!.binding!.current.contentHash);
        expect(safeReady.compare!.binding!.current.structureHash).not.toBe(ready.compare!.binding!.current.structureHash);
        expect(safeReady.compare!.binding!.current.fullStateHash).not.toBe(ready.compare!.binding!.current.fullStateHash);
        for (const prepared of [ready.actions.accept!, batchReady.actions.accept!]) {
          const rejected = await context.request.post(ACTION_PATH, { headers, data: { contractVersion: 1, target,
            action: { contractVersion: 1, ...prepared, idempotencyKey: randomUUID(), creation: null } } });
          expect(rejected.status()).toBe(409);
          expect((await rejected.json()).error.code).toBe(Codes.currentChanged);
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(beforeMerge);
        }
        const blockedBatch = await review({ kind: 'proposals', proposalIds: selectedIds });
        expect(blockedBatch.status).toBe('conflicted');
        expect(blockedBatch.diagnosis.reasonCode).toBe(Codes.batchConflict);
        expect(blockedBatch.actions.accept).toBeUndefined();
        expect(blockedBatch.compare!.binding!.current).toEqual(safeReady.compare!.binding!.current);
        expect(blockedBatch.context?.proposals.filter(proposal => selectedIds.includes(proposal.proposalId))
          .map(proposal => proposal.lifecycle)).toEqual(['open', 'open']);
        const link = (operationId: string) => buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
          selectedEntry: { kind: 'agent_operation', id: operationId }, initialView: 'reviews', source: 'deep_link' });
        await page.goto(link(obsolete.operationId));
        const graph = page.getByTestId('graph-review-comparison');
        await expect(graph.getByTestId('graph-review-blocked')).toBeVisible();
        await expect(page.getByText('This comparison is no longer current', { exact: true })).toHaveCount(0);
        await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
        await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
        await expect(graph).toContainText('2 proposals selected');
        await expect(graph.getByTestId('graph-review-blocked')).toBeVisible();
        await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
        expect(actionPosts).toBe(0);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(beforeMerge);
        expect((await review({ kind: 'operation', operationId: safe.operationId })).compare!.binding!.current)
          .toEqual(safeReady.compare!.binding!.current);
        await info.attach('ordinary-block-recreated-batch.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });

        await page.goto(link(safe.operationId));
        await expect(graph.getByText('Ready after rebase', { exact: true })).toBeVisible();
        expect((await review({ kind: 'operation', operationId: safe.operationId })).context?.applyProposalIds).toEqual([safe.proposalId]);
        await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
        const pending = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === ACTION_PATH);
        await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
        const accepted = await pending;
        expect(accepted.ok()).toBeTruthy();
        const receipt = await accepted.json() as ProposalActionReceiptV1;
        expect(receipt.phase).toBe('succeeded');
        expect(receipt.affectedProposalIds).toEqual([safe.proposalId]);
        expect(receipt.result?.resolutions).toEqual([{ proposalId: safe.proposalId, lifecycle: 'applied' }]);
        expect(await content()).toBe(FINAL);
        expect(await revisionCount()).toBe(beforeMerge + 1);
        const retry = await context.request.post(ACTION_PATH, { headers, data: accepted.request().postDataJSON() });
        expect(retry.ok()).toBeTruthy();
        expect(await retry.json()).toEqual(receipt);
        await assertConflict();
        const final = await read();
        expect(final.document).toEqual(source.document);
        expect(final.structure!.blocks.map(block => [block.id, block.text])).toEqual([
          [newIds[0], 'Versand'], [newIds[1], 'Hinweis: Standardversand'], [newIds[2], 'Kosten: 10 EUR'], [newIds[3], 'Lieferzeit: 2 Tage'],
        ]);
        expect(await content()).toBe(FINAL);
        expect(await revisionCount()).toBe(beforeMerge + 1);
        expect(actionPosts).toBe(1);
        await page.goto(link(obsolete.operationId));
        await expect(graph.getByTestId('graph-review-blocked')).toBeVisible();
        await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
        await info.attach('ordinary-block-recreated-final.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        await info.attach('ordinary-block-recreated-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, target, representation, originalIds, newIds,
          safeProposalId: safe.proposalId, obsoleteProposalId: obsolete.proposalId,
          equalContentHash: recreated.sha256 === source.sha256,
          oldProof: ready.compare!.binding!.current, recreatedProof: safeReady.compare!.binding!.current,
          blockedBatchStatus: blockedBatch.status, beforeMergeRevisionCount: beforeMerge, finalRevisionCount: beforeMerge + 1,
          finalContent: FINAL, actionPosts, receipt,
        }, null, 2) });
      }, { workspaceKind });
    });
  });
}
