import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionRequestV1, ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1,
  type ProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const AFTER_PARENT = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 100 EUR\n\nLieferzeit: 5 Tage\n';
const FORK_FINAL = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 150 EUR\n\nLieferzeit: 3 Tage\n';
const CHAIN_FINAL = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 175 EUR\n\nLieferzeit: 5 Tage\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';
const CASES = {
  'fork-batch': { chain: false, parentFirst: false, batch: true, final: FORK_FINAL },
  'fork-parent-first': { chain: false, parentFirst: true, batch: true, final: FORK_FINAL },
  'chain-batch': { chain: true, parentFirst: false, batch: true, final: CHAIN_FINAL },
  'chain-leaf': { chain: true, parentFirst: false, batch: false, final: CHAIN_FINAL },
} as const;

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary shared ancestor closure (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    for (const [name, scenario] of Object.entries(CASES)) {
      test(`${name} composes each prerequisite exactly once`, async ({ browser }, info) => {
        test.setTimeout(240_000);
        await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
          agentContext, content, revisionCount }) => {
          page.setDefaultTimeout(20_000);
          expect(representation).toBe('tiptap_blocks');
          const before = await revisionCount();
          const headers = { 'x-canvas-workspace-id': target.workspaceId };
          const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
            runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-closure-${randomUUID()}`, params, context: agentContext });
          const source = await run('read', { path: filePath, source: 'blocks' });
          expect(source.isError).not.toBe(true);
          expect(source.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
          expect(source.details?.structure?.nextOffset).toBeNull();
          const originalBlocks = source.details!.structure!.blocks;
          expect(originalBlocks.map(block => block.text)).toEqual(['Versand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage']);
          const edit = async (params: Record<string, unknown>) => {
            const result = await run('edit_file', { path: filePath, ...params });
            expect(result.isError).not.toBe(true);
            expect(result.details?.outcome).toBe('review_required');
            return parseProposalToolCreationResultV1(result.details?.proposal);
          };
          const parent = await edit({ expectedSha256: source.details!.sha256,
            oldText: 'Kosten: 10 EUR', newText: 'Kosten: 12 EUR\n\nDeckung: 100 EUR' });
          expect(parent.creationKind).toBe('independent');
          expect(parent.relationships.dependency).toBeNull();
          const parentRead = await run('read', { path: filePath, source: 'blocks',
            proposal: { contractVersion: 1, proposalId: parent.proposalId, expectedScope: parent.scope } });
          expect(parentRead.isError).not.toBe(true);
          const insurance = parentRead.details!.structure!.blocks.find(block => block.text === 'Deckung: 100 EUR');
          expect(insurance).toBeTruthy();
          expect(originalBlocks.map(block => block.id)).not.toContain(insurance!.id);
          const extend = async (basis: ProposalToolCreationResultV1, blockId: string, oldText: string, newText: string) => {
            const read = await run('read', { path: filePath, source: 'blocks',
              proposal: { contractVersion: 1, proposalId: basis.proposalId, expectedScope: basis.scope } });
            expect(read.isError).not.toBe(true);
            expect(read.details?.structure?.nextOffset).toBeNull();
            expect(read.details?.structure?.blocks.map(block => block.id)).toEqual([
              originalBlocks[0]!.id, originalBlocks[1]!.id, insurance!.id, originalBlocks[2]!.id,
            ]);
            const proof = parseProposalToolReadResultV1(read.details?.proposal);
            expect(proof.source.kind).toBe('proposal');
            if (proof.source.kind !== 'proposal') throw new Error('A dependent ordinary edit must retain its explicit source.');
            const result = await edit({ document: read.details!.document, blockId,
              expectedSha256: proof.contentSha256, oldText, newText,
              proposal: { contractVersion: 1, creationKind: 'extends', source: proof.source,
                expectedParentCandidateHash: proof.source.candidateHash,
                expectedParentCasVersion: proof.source.proposalCasVersion, replaces: null, choice: null } });
            expect(result.relationships).toEqual({ dependency: { proposalId: basis.proposalId, candidateHash: basis.candidateHash },
              replacesProposalId: null, choiceGroupId: null });
            return result;
          };
          const second = await extend(parent, insurance!.id, '100 EUR', '150 EUR');
          const third = scenario.chain
            ? await extend(second, insurance!.id, '150 EUR', '175 EUR')
            : await extend(parent, originalBlocks[2]!.id, '5 Tage', '3 Tage');
          const proposals = [parent, second, third];
          const ids = proposals.map(proposal => proposal.proposalId);
          expect(new Set(ids).size).toBe(3);
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(before);

          const review = async (selection: ProposalReviewSessionRequestV1['selection']) => {
            const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
              headers, data: { contractVersion: 1, target, selection },
            });
            expect(response.ok()).toBeTruthy();
            const session = await response.json() as ProposalReviewSessionResponseV1;
            expect(session.mode).toBe('graph');
            if (session.mode !== 'graph') throw new Error('Shared ancestors require graph review.');
            return session;
          };
          const open = async (proposal: ProposalToolCreationResultV1) => {
            await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
              selectedEntry: { kind: 'agent_operation', id: proposal.operationId }, initialView: 'reviews', source: 'deep_link' }));
            await expect(page.getByTestId('graph-review-comparison')).toBeVisible({ timeout: 30_000 });
          };
          const graph = page.getByTestId('graph-review-comparison');
          let actionPosts = 0;
          page.on('request', request => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
          });
          const receipts: ProposalActionReceiptV1[] = [];
          const accept = async (batch: boolean, selectedIds: string[], applyIds: string[], closureIds: string[]) => {
            await graph.getByRole('button', { name: batch ? 'Accept all changes' : 'Accept change', exact: true }).click();
            const pending = page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === ACTION_PATH);
            await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
            const response = await pending;
            expect(response.ok()).toBeTruthy();
            const request = response.request().postDataJSON();
            expect([...request.action.fence.selectedProposalIds].sort()).toEqual([...selectedIds].sort());
            expect(new Set(request.action.fence.closure.map((entry: { proposalId: string }) => entry.proposalId)).size)
              .toBe(closureIds.length);
            expect(request.action.fence.closure.map((entry: { proposalId: string }) => entry.proposalId).sort()).toEqual([...closureIds].sort());
            expect([...request.action.fence.applyProposalIds].sort()).toEqual([...applyIds].sort());
            const receipt = await response.json() as ProposalActionReceiptV1;
            expect(receipt.phase).toBe('succeeded');
            expect(receipt.actionType).toBe(batch ? 'batch_accept' : 'accept');
            expect(receipt.result?.kind).toBe('content_changed');
            expect([...receipt.affectedProposalIds].sort()).toEqual([...closureIds].sort());
            const resolutions = applyIds.map(proposalId => ({ proposalId, lifecycle: selectedIds.includes(proposalId) ? 'applied' : 'included' }));
            expect(receipt.result?.resolutions).toHaveLength(resolutions.length);
            expect(receipt.result?.resolutions).toEqual(expect.arrayContaining(resolutions));
            const retry = await context.request.post(ACTION_PATH, { headers, data: request });
            expect(retry.ok()).toBeTruthy();
            expect(await retry.json()).toEqual(receipt);
            receipts.push(receipt);
          };

          // Inspect leaf-only closure as well as the actual UI all-selection below.
          const leaves = scenario.chain ? [third.proposalId] : [second.proposalId, third.proposalId];
          const initialReview = await review({ kind: 'proposals', proposalIds: leaves });
          expect(initialReview.status).toBe(scenario.chain ? 'clean' : 'clean_rebased');
          expect([...initialReview.context!.selectedProposalIds].sort()).toEqual([...leaves].sort());
          expect(initialReview.context!.dependencyProposalIds).toEqual(scenario.chain ? [parent.proposalId, second.proposalId] : [parent.proposalId]);
          expect([...initialReview.context!.applyProposalIds].sort()).toEqual([...ids].sort());
          expect(initialReview.actions.accept!.fence.closure).toHaveLength(3);
          expect(initialReview.actions.accept!.fence.applyProposalIds[0]).toBe(parent.proposalId);

          if (scenario.parentFirst) {
            await open(parent);
            await accept(false, [parent.proposalId], [parent.proposalId], [parent.proposalId]);
            expect(await content()).toBe(AFTER_PARENT);
            expect(await revisionCount()).toBe(before + 1);
          }
          const selectedIds = scenario.batch ? scenario.parentFirst ? leaves : ids : leaves;
          const applyIds = scenario.parentFirst ? [second.proposalId, third.proposalId] : ids;
          const ready = await review({ kind: 'proposals', proposalIds: selectedIds });
          expect(ready.status).toBe(scenario.chain ? 'clean' : 'clean_rebased');
          expect([...ready.context!.applyProposalIds].sort()).toEqual([...applyIds].sort());
          expect(ready.actions.accept!.fence.closure).toHaveLength(3);
          expect(ready.actions.accept!.fence.closure.filter(entry => entry.proposalId === parent.proposalId)).toHaveLength(1);
          const additions = ready.compare!.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'addition').map(line => line.text);
          expect(additions).toContain(scenario.chain ? 'Deckung: 175 EUR' : 'Deckung: 150 EUR');
          expect(additions).not.toContain('Deckung: 100 EUR');
          if (scenario.chain) expect(additions).not.toContain('Deckung: 150 EUR');
          if (scenario.parentFirst) expect(ready.context!.dependencyProposalIds).toEqual([parent.proposalId]);
          await open(third);
          if (scenario.batch) await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
          await expect(graph).toContainText(`${selectedIds.length} proposal${selectedIds.length === 1 ? '' : 's'} selected`);
          await expect(graph.getByTestId('graph-review-hunks')).toContainText(scenario.chain ? 'Deckung: 175 EUR' : 'Deckung: 150 EUR');
          await info.attach('ordinary-closure-before-accept.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
          await accept(scenario.batch, selectedIds, applyIds, ids);
          expect(await content()).toBe(scenario.final);
          expect(await revisionCount()).toBe(before + (scenario.parentFirst ? 2 : 1));
          const live = await run('read', { path: filePath, source: 'blocks' });
          expect(live.isError).not.toBe(true);
          expect(live.details?.document).toEqual(source.details!.document);
          expect(live.details?.structure?.nextOffset).toBeNull();
          expect(live.details!.structure!.blocks.map(block => [block.id, block.text])).toEqual([
            [originalBlocks[0]!.id, 'Versand'], [originalBlocks[1]!.id, 'Kosten: 12 EUR'],
            [insurance!.id, scenario.chain ? 'Deckung: 175 EUR' : 'Deckung: 150 EUR'],
            [originalBlocks[2]!.id, scenario.chain ? 'Lieferzeit: 5 Tage' : 'Lieferzeit: 3 Tage'],
          ]);
          const lifecycles = scenario.batch ? ['applied', 'applied', 'applied'] : ['included', 'included', 'applied'];
          for (const [index, proposal] of proposals.entries()) {
            const closed = await review({ kind: 'operation', operationId: proposal.operationId });
            expect(closed.context!.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle).toBe(lifecycles[index]);
            expect(Object.keys(closed.actions)).toHaveLength(0);
          }
          await open(parent);
          await expect(graph.getByTestId('graph-review-historical-status')).toContainText(scenario.batch ? 'Applied' : 'Included');
          await expect(graph.getByRole('button', { name: /Accept change|Accept all changes|Reject proposal/u })).toHaveCount(0);
          expect(actionPosts).toBe(scenario.parentFirst ? 2 : 1);
          expect(await content()).toBe(scenario.final);
          expect(await revisionCount()).toBe(before + actionPosts);
          await info.attach('ordinary-closure-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, scenario: name, target, representation, proposalIds: ids, lifecycles,
            originalBlockIds: originalBlocks.map(block => block.id), insuranceBlockId: insurance!.id,
            expectedFinal: scenario.final, actionPosts, beforeRevisionCount: before, afterRevisionCount: before + actionPosts,
            receipts: receipts.map(receipt => ({ actionType: receipt.actionType, affectedProposalIds: receipt.affectedProposalIds,
              result: receipt.result })),
          }, null, 2) });
        }, { workspaceKind });
      });
    }
  });
}
