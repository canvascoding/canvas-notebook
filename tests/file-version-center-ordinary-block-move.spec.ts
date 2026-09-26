import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { COLLABORATION_CLIENT_CAPABILITIES, type CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1, type ProposalReviewSessionRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nHinweis: Standardversand\n\nEntfernen: Entwurf\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n\nNotiz: Intern\n';
const MOVED = '# Versand\n\nHinweis: Standardversand\n\nLieferzeit: 5 Tage\n\nEntfernen: Entwurf\n\nKosten: 10 EUR\n\nNotiz: Intern\n';
const DELETED = '# Versand\n\nHinweis: Standardversand\n\nLieferzeit: 5 Tage\n\nKosten: 10 EUR\n\nNotiz: Intern\n';
const REBASED = '# Versand\n\nHinweis: Standardversand\n\nHinweis: Express möglich\n\nLieferzeit: 5 Tage\n\nKosten: 10 EUR\n\nNotiz: Intern\n';
const AFTER_DELIVERY = '# Versand\n\nHinweis: Standardversand\n\nHinweis: Express möglich\n\nLieferzeit: 2 Tage\n\nKosten: 10 EUR\n\nNotiz: Intern\n';
const FINAL = '# Versand\n\nHinweis: Standardversand\n\nHinweis: Express möglich\n\nLieferzeit: 2 Tage\n\nKosten: 12 EUR\n\nNotiz: Intern\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary rich block move (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    for (const mode of ['sequential', 'batch'] as const) {
      test(`${mode} retains moved targets and unrelated editor insertions/deletions`, async ({ browser }, info) => {
        test.setTimeout(240_000);
        await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
          agentContext, content, revisionCount }) => {
          page.setDefaultTimeout(20_000);
          expect(representation).toBe('tiptap_blocks');
          const headers = { 'x-canvas-workspace-id': target.workspaceId };
          const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
            runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-block-move-${randomUUID()}`, params, context: agentContext });
          const read = async () => {
            const response = await run('read', { path: filePath, source: 'blocks' });
            expect(response.isError).not.toBe(true);
            expect(response.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
            expect(response.details?.structure?.nextOffset).toBeNull();
            return response.details!;
          };
          const review = async (selection: ProposalReviewSessionRequestV1['selection']) => {
            const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
              headers, data: { contractVersion: 1, target, selection },
            });
            expect(response.ok()).toBeTruthy();
            const result = parseProposalReviewSessionResponseV1(await response.json());
            if (result.mode !== 'graph') throw new Error('Moved ordinary block edits must not use legacy review.');
            return result;
          };
          const session = async () => {
            const response = await context.request.post('/api/files/collaboration/session', {
              headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
            });
            expect(response.ok()).toBeTruthy();
            const result = await response.json() as CollaborationSessionResponse;
            expect(result.documentId).toBe(target.documentId);
            expect(result.representation).toBe('tiptap_blocks');
            return result;
          };
          const source = await read();
          const originalIds = source.structure!.blocks.map(block => block.id);
          expect(source.structure!.blocks.map(block => block.text)).toEqual([
            'Versand', 'Hinweis: Standardversand', 'Entfernen: Entwurf', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage', 'Notiz: Intern',
          ]);
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
          const cost = await create(3, '10 EUR', '12 EUR');
          const delivery = await create(4, '5 Tage', '2 Tage');
          const proposals = [delivery, cost];
          const oldSingle = await review({ kind: 'operation', operationId: delivery.operationId });
          const oldBatch = await review({ kind: 'proposals', proposalIds: proposals.map(proposal => proposal.proposalId) });
          expect(oldSingle.status).toBe('clean');
          expect(oldBatch.status).toBe('clean_rebased');
          expect(oldSingle.actions.accept).toBeTruthy();
          expect(oldBatch.actions.accept).toBeTruthy();
          expect(await content()).toBe(INITIAL);
          const beforeEdit = await session();

          await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
          const editor = page.locator('.tiptap-editor-shell .ProseMirror');
          await expect(editor).toHaveAttribute('contenteditable', 'true');
          await editor.getByText('Lieferzeit: 5 Tage', { exact: true }).click();
          await page.keyboard.press('Alt+Shift+ArrowUp');
          await page.keyboard.press('Alt+Shift+ArrowUp');
          await expect.poll(content, { timeout: 30_000, intervals: [500, 1000] }).toBe(MOVED);
          const moved = await read();
          expect(moved.document).toEqual(source.document);
          expect(moved.structure!.blocks.map(block => block.id)).toEqual([
            originalIds[0], originalIds[1], originalIds[4], originalIds[2], originalIds[3], originalIds[5],
          ]);
          const removed = editor.getByText('Entfernen: Entwurf', { exact: true });
          await removed.click();
          await removed.evaluate(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
          });
          await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Entfernen: Entwurf');
          await page.keyboard.press('Backspace');
          await page.keyboard.press('Backspace');
          await expect.poll(content, { timeout: 30_000, intervals: [500, 1000] }).toBe(DELETED);
          expect((await read()).structure!.blocks.map(block => block.id)).toEqual([
            originalIds[0], originalIds[1], originalIds[4], originalIds[3], originalIds[5],
          ]);
          await editor.getByText('Hinweis: Standardversand', { exact: true }).click();
          await page.keyboard.press('End');
          await page.keyboard.press('Enter');
          await page.keyboard.insertText('Hinweis: Express möglich');
          await expect.poll(content, { timeout: 30_000, intervals: [500, 1000] }).toBe(REBASED);
          const modified = await read();
          const insertedId = modified.structure!.blocks[2]!.id;
          expect(originalIds).not.toContain(insertedId);
          const expectedIds = [originalIds[0], originalIds[1], insertedId, originalIds[4], originalIds[3], originalIds[5]];
          const assertBlocks = async (expectedContent: string) => {
            const current = await read();
            expect(current.document).toEqual(source.document);
            expect(current.structure!.blocks.map(block => block.id)).toEqual(expectedIds);
            expect(current.structure!.blocks.map(block => block.text)).toEqual(
              expectedContent.trimEnd().replace(/^# /u, '').split('\n\n'));
          };
          await assertBlocks(REBASED);
          await expect.poll(async () => {
            const current = await session();
            return current.documentSequence! > beforeEdit.documentSequence!
              && current.checkpointSequence === current.documentSequence;
          }, { timeout: 30_000, intervals: [500, 1000] }).toBe(true);
          const beforeMerge = await revisionCount();
          await page.reload();
          await expect(editor.getByText('Hinweis: Express möglich', { exact: true })).toBeVisible();
          await expect(editor.getByText('Entfernen: Entwurf', { exact: true })).toHaveCount(0);
          await assertBlocks(REBASED);
          await info.attach('ordinary-block-moved-editor.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
          const rebased = await review({ kind: 'operation', operationId: delivery.operationId });
          expect(rebased.status).toBe('clean_rebased');
          expect(rebased.actions.accept).toBeTruthy();
          for (const prepared of [oldSingle.actions.accept!, oldBatch.actions.accept!]) {
            const rejected = await context.request.post(ACTION_PATH, { headers, data: { contractVersion: 1, target,
              action: { contractVersion: 1, ...prepared, idempotencyKey: randomUUID(), creation: null } } });
            expect(rejected.status()).toBe(409);
            expect((await rejected.json()).error.code).toBe(Codes.currentChanged);
            expect(await content()).toBe(REBASED);
            expect(await revisionCount()).toBe(beforeMerge);
          }
          expect((await review({ kind: 'operation', operationId: delivery.operationId })).compare!.binding!.current)
            .toEqual(rebased.compare!.binding!.current);
          let actionPosts = 0;
          page.on('request', request => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
          });
          const receipts: ProposalActionReceiptV1[] = [];
          const decisions = mode === 'batch' ? [proposals] : proposals.map(proposal => [proposal]);
          for (const [index, selected] of decisions.entries()) {
            const selectedIds = selected.map(proposal => proposal.proposalId);
            const preview = await review({ kind: 'proposals', proposalIds: selectedIds });
            expect(preview.status).toBe('clean_rebased');
            expect(preview.actions.accept).toBeTruthy();
            expect(preview.context?.dependencyProposalIds).toEqual([]);
            expect([...preview.context!.applyProposalIds].sort()).toEqual([...selectedIds].sort());
            const changedLines = preview.compare!.hunks.flatMap(hunk => hunk.lines);
            expect(changedLines.filter(line => line.kind === 'addition').map(line => line.text)).toEqual(
              selected.map(proposal => proposal.proposalId === delivery.proposalId ? 'Lieferzeit: 2 Tage' : 'Kosten: 12 EUR'));
            expect(changedLines.filter(line => line.kind === 'deletion').map(line => line.text)).toEqual(
              selected.map(proposal => proposal.proposalId === delivery.proposalId ? 'Lieferzeit: 5 Tage' : 'Kosten: 10 EUR'));
            await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
              selectedEntry: { kind: 'agent_operation', id: selected[0]!.operationId }, initialView: 'reviews', source: 'deep_link' }));
            const graph = page.getByTestId('graph-review-comparison');
            await expect(graph.getByText('Ready after rebase', { exact: true })).toBeVisible();
            if (mode === 'batch') {
              await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
              await expect(graph).toContainText('2 proposals selected');
              await expect(graph.getByText('Ready after rebase', { exact: true })).toBeVisible();
            }
            await expect(page.getByText('This comparison is no longer current', { exact: true })).toHaveCount(0);
            for (const proposal of selected) {
              const [oldLine, newLine] = proposal.proposalId === delivery.proposalId
                ? ['Lieferzeit: 5 Tage', 'Lieferzeit: 2 Tage'] : ['Kosten: 10 EUR', 'Kosten: 12 EUR'];
              await expect(graph.getByTestId('graph-review-hunks')).toContainText(oldLine);
              await expect(graph.getByTestId('graph-review-hunks')).toContainText(newLine);
            }
            await info.attach(`ordinary-block-moved-review-${index}.png`, { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
            await graph.getByRole('button', { name: mode === 'batch' ? 'Accept all changes' : 'Accept change', exact: true }).click();
            const pending = page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === ACTION_PATH);
            await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
            const accepted = await pending;
            expect(accepted.ok()).toBeTruthy();
            const receipt = await accepted.json() as ProposalActionReceiptV1;
            expect(receipt.phase).toBe('succeeded');
            expect(receipt.result?.kind).toBe('content_changed');
            expect(receipt.actionType).toBe(mode === 'batch' ? 'batch_accept' : 'accept');
            expect([...receipt.affectedProposalIds].sort()).toEqual([...selectedIds].sort());
            expect(receipt.result?.resolutions.map(resolution => `${resolution.proposalId}:${resolution.lifecycle}`).sort())
              .toEqual(selectedIds.map(id => `${id}:applied`).sort());
            const expectedContent = mode === 'sequential' && index === 0 ? AFTER_DELIVERY : FINAL;
            expect(await content()).toBe(expectedContent);
            await assertBlocks(expectedContent);
            expect(await revisionCount()).toBe(beforeMerge + index + 1);
            const retry = await context.request.post(ACTION_PATH, { headers, data: accepted.request().postDataJSON() });
            expect(retry.ok()).toBeTruthy();
            expect(await retry.json()).toEqual(receipt);
            expect(await revisionCount()).toBe(beforeMerge + index + 1);
            receipts.push(receipt);
          }
          expect(actionPosts).toBe(mode === 'batch' ? 1 : 2);
          for (const proposal of proposals) {
            const history = await review({ kind: 'operation', operationId: proposal.operationId });
            expect(history.context?.proposals.find(node => node.proposalId === proposal.proposalId)?.lifecycle).toBe('applied');
            expect(history.actions).toEqual({});
          }
          expect(await content()).toBe(FINAL);
          await assertBlocks(FINAL);
          expect(await revisionCount()).toBe(beforeMerge + decisions.length);
          await info.attach('ordinary-block-moved-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, mode, target, representation, originalIds, expectedIds,
            costProposalId: cost.proposalId, deliveryProposalId: delivery.proposalId,
            beforeMergeRevisionCount: beforeMerge, finalRevisionCount: beforeMerge + decisions.length,
            oldProof: oldSingle.compare!.binding!.current, rebasedProof: rebased.compare!.binding!.current,
            rebasedContent: REBASED, finalContent: FINAL, actionPosts, receipts,
          }, null, 2) });
        }, { workspaceKind });
      });
    }
  });
}
