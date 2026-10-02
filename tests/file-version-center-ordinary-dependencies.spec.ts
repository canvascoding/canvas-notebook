import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1,
  type ProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const AFTER_P1 = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 100 EUR\n\nLieferzeit: 5 Tage\n';
const AFTER_Q = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 3 Tage\n';
const AFTER_P1_Q = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 100 EUR\n\nLieferzeit: 3 Tage\n';
const AFTER_P2 = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 150 EUR\n\nLieferzeit: 5 Tage\n';
const FINAL = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 150 EUR\n\nLieferzeit: 3 Tage\n';
const ORDERS = {
  'parent-independent-child': [['P1', AFTER_P1], ['Q', AFTER_P1_Q], ['P2', FINAL]],
  'child-independent': [['P2', AFTER_P2], ['Q', FINAL]],
  'independent-child': [['Q', AFTER_Q], ['P2', FINAL]],
  batch: [['P2', FINAL]],
} as const;

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary dependent Markdown proposals (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');

    for (const order of Object.keys(ORDERS) as Array<keyof typeof ORDERS>) {
      test(`${order} preserves the child anchor and independent effect`, async ({ browser }, info) => {
        test.setTimeout(240_000);
        await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
          agentContext, content, revisionCount }) => {
          expect(representation).toBe('tiptap_blocks');
          const before = await revisionCount();
          const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
            runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-dependency-${randomUUID()}`, params, context: agentContext });
          const source = await run('read', { path: filePath, source: 'blocks' });
          expect(source.isError).not.toBe(true);
          expect(source.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
          expect(source.details?.collaboration).toMatchObject({ documentId: target.documentId,
            representation: 'tiptap_blocks', source: 'live_yjs' });
          expect(source.details?.structure?.nextOffset).toBeNull();
          const originalBlocks = source.details!.structure!.blocks;
          expect(originalBlocks.map(block => [block.type, block.text])).toEqual([
            ['heading', 'Versand'], ['paragraph', 'Kosten: 10 EUR'], ['paragraph', 'Lieferzeit: 5 Tage'],
          ]);
          const create = async (params: Record<string, unknown>) => {
            const result = await run('edit_file', { path: filePath, ...params });
            expect(result.isError).not.toBe(true);
            expect(result.details?.outcome).toBe('review_required');
            expect(result.details?.collaboration).toMatchObject({ reviewRequired: true,
              operationStatus: 'needs_review', durability: 'not_applied' });
            return parseProposalToolCreationResultV1(result.details?.proposal);
          };
          const p1 = await create({ expectedSha256: source.details!.sha256,
            oldText: 'Kosten: 10 EUR', newText: 'Kosten: 12 EUR\n\nDeckung: 100 EUR' });
          expect(p1.creationKind).toBe('independent');
          expect(p1.source.kind).toBe('authoritative');

          const parentRead = await run('read', { path: filePath, source: 'blocks',
            proposal: { contractVersion: 1, proposalId: p1.proposalId, expectedScope: p1.scope } });
          expect(parentRead.isError).not.toBe(true);
          expect(parentRead.details?.document).toEqual(source.details!.document);
          expect(parentRead.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'proposal_source' });
          expect(parentRead.details?.structure?.nextOffset).toBeNull();
          const candidateBlocks = parentRead.details!.structure!.blocks;
          expect(candidateBlocks.map(block => block.text)).toEqual(['Versand', 'Kosten: 12 EUR', 'Deckung: 100 EUR', 'Lieferzeit: 5 Tage']);
          const insuranceBlock = candidateBlocks[2]!;
          expect(insuranceBlock.type).toBe('paragraph');
          expect(candidateBlocks.filter(block => block.id !== insuranceBlock.id).map(block => block.id))
            .toEqual(originalBlocks.map(block => block.id));
          const parentSource = parseProposalToolReadResultV1(parentRead.details?.proposal);
          expect(parentSource.source.kind).toBe('proposal');
          if (parentSource.source.kind !== 'proposal') throw new Error('The child requires the exact parent candidate source.');
          expect(parentSource.source.proposalId).toBe(p1.proposalId);
          expect(parentSource.source.proposalCasVersion).toBe(p1.casVersion);
          expect(parentSource.source.authoredCandidateHash).toBe(p1.candidateHash);
          const p2 = await create({ document: parentRead.details!.document, blockId: insuranceBlock.id,
            expectedSha256: parentSource.contentSha256, oldText: '100 EUR', newText: '150 EUR',
            proposal: { contractVersion: 1, creationKind: 'extends', source: parentSource.source,
              expectedParentCandidateHash: parentSource.source.candidateHash,
              expectedParentCasVersion: parentSource.source.proposalCasVersion, replaces: null, choice: null } });
          expect(p2.creationKind).toBe('extends');
          expect(p2.relationships).toEqual({ dependency: { proposalId: p1.proposalId, candidateHash: p1.candidateHash },
            replacesProposalId: null, choiceGroupId: null });
          const q = await create({ expectedSha256: source.details!.sha256, oldText: 'Lieferzeit: 5 Tage', newText: 'Lieferzeit: 3 Tage' });
          expect(q.creationKind).toBe('independent');
          expect(q.source).toEqual(p1.source);
          expect(q.relationships.dependency).toBeNull();
          const proposals = { P1: p1, P2: p2, Q: q };
          expect(new Set(Object.values(proposals).map(proposal => proposal.proposalId)).size).toBe(3);
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(before);

          const review = async (selected: ProposalToolCreationResultV1) => {
            const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
              headers: { 'x-canvas-workspace-id': target.workspaceId },
              data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: selected.operationId } },
            });
            expect(response.ok()).toBeTruthy();
            const session = await response.json() as ProposalReviewSessionResponseV1;
            expect(session.mode).toBe('graph');
            if (session.mode !== 'graph') throw new Error('Dependent ordinary proposals require graph review.');
            expect(session.selectedProposalIds).toEqual([selected.proposalId]);
            return session;
          };
          const link = (selected: ProposalToolCreationResultV1) => buildFileVersionCenterDeepLinkV1('/en', {
            contractVersion: 1, target, selectedEntry: { kind: 'agent_operation', id: selected.operationId },
            initialView: 'reviews', source: 'deep_link',
          });
          let actionPosts = 0;
          page.on('request', request => {
            if (request.method() === 'POST'
              && new URL(request.url()).pathname === '/api/files/version-center/v1/proposals/actions') actionPosts += 1;
          });
          const receipts: ProposalActionReceiptV1[] = [];
          const lifecycles = new Map(Object.values(proposals).map(proposal => [proposal.proposalId, 'open']));
          const steps = ORDERS[order];
          for (const [index, [label, expected]] of steps.entries()) {
            const selected = proposals[label];
            const session = await review(selected);
            expect(session.status).toBe(index === 0 ? 'clean' : 'clean_rebased');
            const applyIds = label === 'P2' && order !== 'parent-independent-child'
              ? [p1.proposalId, p2.proposalId] : [selected.proposalId];
            expect(session.context?.dependencyProposalIds).toEqual(label === 'P2' ? [p1.proposalId] : []);
            expect(session.context?.applyProposalIds).toEqual(applyIds);
            expect(session.actions.accept?.fence.applyProposalIds).toEqual(applyIds);
            const changed = session.compare!.hunks.flatMap(hunk => hunk.lines)
              .filter(line => line.kind !== 'context').map(line => [line.kind, line.text]);
            if (label === 'Q') {
              expect(changed).toEqual([['deletion', 'Lieferzeit: 5 Tage'], ['addition', 'Lieferzeit: 3 Tage']]);
            } else if (label === 'P2' && order === 'parent-independent-child') {
              expect(changed).toEqual([['deletion', 'Deckung: 100 EUR'], ['addition', 'Deckung: 150 EUR']]);
            } else {
              expect(changed).toContainEqual(['deletion', 'Kosten: 10 EUR']);
              expect(changed).toContainEqual(['addition', 'Kosten: 12 EUR']);
              expect(changed).toContainEqual(['addition', label === 'P1' ? 'Deckung: 100 EUR' : 'Deckung: 150 EUR']);
              expect(changed.some(([, text]) => text.startsWith('Lieferzeit:'))).toBe(false);
            }
            await page.goto(link(selected));
            const graph = page.getByTestId('graph-review-comparison');
            await expect(graph.getByText(index === 0 ? 'Ready to apply' : 'Ready after rebase', { exact: true }))
              .toBeVisible({ timeout: 30_000 });
            if (label === 'P2') await expect(graph.getByTestId('graph-review-context')).toContainText('1 prerequisite included');
            if (order === 'batch') {
              await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
              await expect(graph).toContainText('3 proposals selected');
              await expect(graph.getByTestId('graph-review-hunks')).toContainText('Deckung: 150 EUR');
              await expect(graph.getByTestId('graph-review-hunks')).toContainText('Lieferzeit: 3 Tage');
              await expect(graph.getByTestId('graph-review-hunks')).not.toContainText('Deckung: 100 EUR');
            }
            await graph.getByRole('button', { name: order === 'batch' ? 'Accept all changes' : 'Accept change', exact: true }).click();
            const pending = page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
            await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
            const response = await pending;
            expect(response.ok()).toBeTruthy();
            const receipt = await response.json() as ProposalActionReceiptV1;
            expect(receipt.phase).toBe('succeeded');
            expect(receipt.actionType).toBe(order === 'batch' ? 'batch_accept' : 'accept');
            expect(receipt.result?.kind).toBe('content_changed');
            const closureIds = order === 'batch' ? [p1.proposalId, p2.proposalId, q.proposalId]
              : label === 'P2' ? [p1.proposalId, p2.proposalId] : [selected.proposalId];
            const resolutionIds = order === 'batch' ? [p1.proposalId, p2.proposalId, q.proposalId] : applyIds;
            expect([...receipt.affectedProposalIds].sort()).toEqual([...closureIds].sort());
            const expectedResolutions = resolutionIds.map(proposalId => ({ proposalId,
              lifecycle: proposalId === p1.proposalId && label === 'P2' && order !== 'batch' ? 'included' : 'applied' }));
            expect(receipt.result?.resolutions).toHaveLength(expectedResolutions.length);
            expect(receipt.result?.resolutions).toEqual(expect.arrayContaining(expectedResolutions));
            for (const resolution of expectedResolutions) lifecycles.set(resolution.proposalId, resolution.lifecycle);
            for (const proposal of Object.values(proposals)) {
              const state = await review(proposal);
              expect(state.context?.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle)
                .toBe(lifecycles.get(proposal.proposalId));
            }
            receipts.push(receipt);
            expect(await content()).toBe(expected);
            expect(await revisionCount()).toBe(before + index + 1);
            const live = await run('read', { path: filePath, source: 'blocks' });
            expect(live.isError).not.toBe(true);
            expect(live.details?.document).toEqual(source.details!.document);
            expect(live.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
            expect(live.details?.structure?.nextOffset).toBeNull();
            const hasParent = expected !== AFTER_Q;
            const hasChild = expected === AFTER_P2 || expected === FINAL;
            const hasQ = expected === AFTER_Q || expected === AFTER_P1_Q || expected === FINAL;
            expect(live.details!.structure!.blocks.map(block => [block.id, block.text])).toEqual([
              [originalBlocks[0]!.id, 'Versand'],
              [originalBlocks[1]!.id, hasParent ? 'Kosten: 12 EUR' : 'Kosten: 10 EUR'],
              ...(hasParent ? [[insuranceBlock.id, hasChild ? 'Deckung: 150 EUR' : 'Deckung: 100 EUR']] : []),
              [originalBlocks[2]!.id, hasQ ? 'Lieferzeit: 3 Tage' : 'Lieferzeit: 5 Tage'],
            ]);
          }

          const parentLifecycle = order === 'parent-independent-child' || order === 'batch' ? 'applied' : 'included';
          for (const proposal of Object.values(proposals)) {
            const closed = await review(proposal);
            expect(closed.context?.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle)
              .toBe(proposal.proposalId === p1.proposalId ? parentLifecycle : 'applied');
            expect(Object.keys(closed.actions)).toHaveLength(0);
          }
          await page.goto(link(p1));
          const historical = page.getByTestId('graph-review-comparison');
          await expect(historical.getByTestId('graph-review-historical-status'))
            .toContainText(parentLifecycle === 'included' ? 'Included' : 'Applied', { timeout: 30_000 });
          await expect(historical.getByRole('button', { name: /Accept change|Accept all changes|Reject proposal/u })).toHaveCount(0);
          expect(actionPosts).toBe(steps.length);
          expect(await content()).toBe(FINAL);
          expect(await revisionCount()).toBe(before + steps.length);
          await info.attach('ordinary-dependency-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, order, target, representation, originalBlockIds: originalBlocks.map(block => block.id),
            insuranceBlockId: insuranceBlock.id, parentLifecycle, expectedFinal: FINAL,
            proposalIds: Object.fromEntries(Object.entries(proposals).map(([label, proposal]) => [label, proposal.proposalId])),
            beforeRevisionCount: before, afterRevisionCount: before + steps.length, actionPosts,
            receipts: receipts.map(receipt => ({ actionType: receipt.actionType, affectedProposalIds: receipt.affectedProposalIds,
              resolutions: receipt.result?.resolutions })),
          }, null, 2) });
          await info.attach('ordinary-dependency-parent-history.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        }, { workspaceKind });
      });
    }
  });
}
