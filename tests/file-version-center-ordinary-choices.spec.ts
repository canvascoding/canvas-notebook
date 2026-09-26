import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionRequestV1, ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1,
  type ProposalToolCreationResultV1, type ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n\nDeckung: 100 EUR\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary exclusive proposal branches (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    for (const scenario of ['choose-descendant', 'replace-then-reject'] as const) {
      test(`${scenario} preserves exact prerequisites and never reopens losing branches`, async ({ browser }, info) => {
        test.setTimeout(240_000);
        await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
          agentContext, content, revisionCount }) => {
          page.setDefaultTimeout(20_000);
          expect(representation).toBe('tiptap_blocks');
          const before = await revisionCount();
          const headers = { 'x-canvas-workspace-id': target.workspaceId };
          const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>, toolCallId = `ordinary-choice-${randomUUID()}`) =>
            runOrdinaryAgentTool({ toolName, toolCallId, params, context: agentContext });
          const source = await run('read', { path: filePath, source: 'blocks' });
          expect(source.isError).not.toBe(true);
          expect(source.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
          expect(source.details?.structure?.nextOffset).toBeNull();
          const blocks = source.details!.structure!.blocks;
          expect(blocks.map(block => block.text)).toEqual(['Versand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage', 'Deckung: 100 EUR']);
          const rootResult = await run('edit_file', { path: filePath, expectedSha256: source.details!.sha256,
            oldText: 'Kosten: 10 EUR', newText: 'Kosten: 12 EUR' });
          expect(rootResult.isError).not.toBe(true);
          const root = parseProposalToolCreationResultV1(rootResult.details?.proposal);
          const read = async (proposal: ProposalToolCreationResultV1) => {
            const result = await run('read', { path: filePath, source: 'blocks',
              proposal: { contractVersion: 1, proposalId: proposal.proposalId, expectedScope: proposal.scope } });
            expect(result.isError, result.details?.code).not.toBe(true);
            expect(result.details?.structure?.nextOffset).toBeNull();
            expect(result.details?.structure?.blocks.map(block => block.id)).toEqual(blocks.map(block => block.id));
            const proof = parseProposalToolReadResultV1(result.details?.proposal);
            expect(proof.source.kind).toBe('proposal');
            if (proof.source.kind !== 'proposal') throw new Error('An explicit parent source is required.');
            expect(proof.source.proposalId).toBe(proposal.proposalId);
            return { result, proof, source: proof.source };
          };
          const create = async (parent: ProposalToolCreationResultV1, blockIndex: number, oldText: string, newText: string,
            relations: Pick<ProposalToolEditV1, 'choice' | 'replaces'> = { choice: null, replaces: null }) => {
            const basis = await read(parent);
            const toolCallId = `ordinary-choice-${randomUUID()}`;
            const params = { path: filePath, document: basis.result.details!.document, blockId: blocks[blockIndex]!.id,
              oldText, newText, expectedSha256: basis.proof.contentSha256,
              proposal: { contractVersion: 1, creationKind: relations.replaces ? 'replacement' : 'extends', source: basis.source,
                expectedParentCandidateHash: basis.source.candidateHash, expectedParentCasVersion: basis.source.proposalCasVersion,
                ...relations } };
            const result = await run('edit_file', params, toolCallId);
            expect(result.isError, result.details?.code).not.toBe(true);
            expect(result.details?.outcome).toBe('review_required');
            const proposal = parseProposalToolCreationResultV1(result.details?.proposal);
            expect(proposal.relationships.dependency).toEqual({ proposalId: parent.proposalId, candidateHash: parent.candidateHash });
            expect(proposal.reviewRequired).toBe(true);
            return { proposal, params, toolCallId };
          };
          const first = (await create(root, 2, '5 Tage', '3 Tage')).proposal;
          const alternative = (await create(root, 2, '5 Tage', '2 Tage', { replaces: null,
            choice: { kind: 'alternative_to', proposalId: first.proposalId,
              expectedCasVersion: first.casVersion, expectedCandidateHash: first.candidateHash } })).proposal;
          const groupId = alternative.relationships.choiceGroupId;
          expect(groupId).toBeTruthy();
          const firstChild = (await create(first, 3, '100 EUR', '150 EUR')).proposal;
          const alternativeChild = (await create(alternative, 3, '100 EUR', '175 EUR')).proposal;
          const all = [root, first, alternative, firstChild, alternativeChild];
          expect(new Set(all.map(proposal => proposal.proposalId)).size).toBe(5);
          const review = async (selection: ProposalReviewSessionRequestV1['selection']) => {
            const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
              headers, data: { contractVersion: 1, target, selection },
            });
            expect(response.ok()).toBeTruthy();
            const result = await response.json() as ProposalReviewSessionResponseV1;
            expect(result.mode).toBe('graph');
            if (result.mode !== 'graph') throw new Error('Exclusive choices require graph review.');
            return result;
          };
          const exact = (proposal: ProposalToolCreationResultV1) => review({ kind: 'operation', operationId: proposal.operationId });
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
          const decide = async (label: string) => {
            await graph.getByRole('button', { name: label, exact: true }).click();
            const pending = page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === ACTION_PATH);
            await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
            const response = await pending;
            expect(response.ok()).toBeTruthy();
            const request = response.request().postDataJSON();
            const receipt = await response.json() as ProposalActionReceiptV1;
            expect(receipt.phase).toBe('succeeded');
            const retry = await context.request.post(ACTION_PATH, { headers, data: request });
            expect(retry.ok()).toBeTruthy();
            expect(await retry.json()).toEqual(receipt);
            return { receipt, fence: request.action.fence };
          };
          const mixed = await review({ kind: 'proposals', proposalIds: [firstChild.proposalId, alternative.proposalId] });
          expect(mixed.diagnosis.reasonCode).toBe(Codes.choiceConflict);
          expect(mixed.actions.accept).toBeUndefined();
          await open(firstChild);
          await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
          await expect(graph).toContainText('5 proposals selected');
          await expect(graph.getByTestId('graph-review-blocked')).toBeVisible();
          await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
          expect(actionPosts).toBe(0);
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(before);
          await info.attach('ordinary-choice-batch-blocked.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });

          let replacement: ProposalToolCreationResultV1 | null = null;
          if (scenario === 'replace-then-reject') {
            const firstNow = await read(first);
            expect(firstNow.source.proposalCasVersion).toBeGreaterThan(first.casVersion);
            const created = await create(root, 2, '5 Tage', '4 Tage', { choice: null,
              replaces: { proposalId: first.proposalId, expectedCasVersion: firstNow.source.proposalCasVersion,
                expectedCandidateHash: first.candidateHash } });
            replacement = created.proposal;
            expect(replacement.creationKind).toBe('replacement');
            expect(replacement.relationships).toEqual({ dependency: { proposalId: root.proposalId, candidateHash: root.candidateHash },
              replacesProposalId: first.proposalId, choiceGroupId: groupId });
            const retried = await run('edit_file', created.params, created.toolCallId);
            expect(retried.isError).not.toBe(true);
            expect(parseProposalToolCreationResultV1(retried.details?.proposal)).toEqual(replacement);
            expect((await exact(first)).context!.proposals.find(p => p.proposalId === first.proposalId)?.lifecycle).toBe('superseded');
            expect((await exact(firstChild)).diagnosis.reasonCode).toBe(Codes.dependencyBlocked);
            expect(await content()).toBe(INITIAL);
            expect(await revisionCount()).toBe(before);
            await open(replacement);
            const rejected = await decide('Reject proposal');
            expect(rejected.receipt.actionType).toBe('reject');
            expect(rejected.receipt.result).toMatchObject({ kind: 'metadata_only', revisionId: null,
              resolutions: [{ proposalId: replacement.proposalId, lifecycle: 'rejected' }] });
            expect(await content()).toBe(INITIAL);
            expect(await revisionCount()).toBe(before);
          }
          const chosen = replacement ? alternativeChild : firstChild;
          const chosenParent = replacement ? alternative : first;
          const losingChild = replacement ? firstChild : alternativeChild;
          const appliedIds = [root.proposalId, chosenParent.proposalId, chosen.proposalId];
          const closingIds = replacement ? [] : [alternative.proposalId];
          const ready = await exact(chosen);
          expect(ready.status).toBe('clean');
          expect(ready.context!.dependencyProposalIds).toEqual([root.proposalId, chosenParent.proposalId]);
          expect(ready.context!.applyProposalIds).toEqual(appliedIds);
          expect(ready.context!.closingAlternativeProposalIds).toEqual(closingIds);
          await open(chosen);
          await expect(graph.getByTestId('graph-review-context')).toContainText('2 prerequisites included');
          await info.attach('ordinary-choice-before-accept.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
          const accepted = await decide('Accept change');
          expect(accepted.fence.selectedProposalIds).toEqual([chosen.proposalId]);
          expect(accepted.fence.applyProposalIds).toEqual(appliedIds);
          expect(accepted.fence.choiceResolutions).toEqual([{ groupId, groupRevision: expect.any(Number),
            chosenProposalId: chosenParent.proposalId, closingProposalIds: closingIds }]);
          expect([...accepted.receipt.affectedProposalIds].sort()).toEqual([...appliedIds, ...closingIds].sort());
          expect(accepted.receipt.result?.resolutions).toEqual(expect.arrayContaining([
            { proposalId: root.proposalId, lifecycle: 'included' }, { proposalId: chosenParent.proposalId, lifecycle: 'included' },
            { proposalId: chosen.proposalId, lifecycle: 'applied' },
            ...closingIds.map(proposalId => ({ proposalId, lifecycle: 'alternative_not_selected' })),
          ]));
          expect(accepted.receipt.result?.resolutions).toHaveLength(appliedIds.length + closingIds.length);
          const finalText = `# Versand\n\nKosten: 12 EUR\n\nLieferzeit: ${replacement ? '2' : '3'} Tage\n\nDeckung: ${replacement ? '175' : '150'} EUR\n`;
          expect(await content()).toBe(finalText);
          expect(await revisionCount()).toBe(before + 1);
          const blocked = await exact(losingChild);
          expect(blocked.status).toBe('blocked_by_parent');
          expect(blocked.diagnosis.reasonCode).toBe(Codes.dependencyBlocked);
          expect(blocked.actions.accept).toBeUndefined();
          expect(blocked.context!.proposals.find(p => p.proposalId === losingChild.proposalId)?.lifecycle).toBe('open');
          const terminal = replacement ? [[first, 'superseded'], [replacement, 'rejected']] as const
            : [[alternative, 'alternative_not_selected']] as const;
          for (const [proposal, lifecycle] of terminal) {
            const closed = await exact(proposal);
            expect(closed.selectedProposalIds).toEqual([proposal.proposalId]);
            expect(closed.context!.proposals.find(p => p.proposalId === proposal.proposalId)?.lifecycle).toBe(lifecycle);
            expect(Object.keys(closed.actions)).toHaveLength(0);
          }
          await open(losingChild);
          await expect(graph.getByTestId('graph-review-blocked')).toContainText('Blocked by a dependency');
          await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
          const live = await run('read', { path: filePath, source: 'blocks' });
          expect(live.isError).not.toBe(true);
          expect(live.details?.document).toEqual(source.details!.document);
          expect(live.details?.structure?.blocks.map(block => [block.id, block.text])).toEqual([
            [blocks[0]!.id, 'Versand'], [blocks[1]!.id, 'Kosten: 12 EUR'],
            [blocks[2]!.id, `Lieferzeit: ${replacement ? '2' : '3'} Tage`], [blocks[3]!.id, `Deckung: ${replacement ? '175' : '150'} EUR`],
          ]);
          expect(actionPosts).toBe(replacement ? 2 : 1);
          expect(await content()).toBe(finalText);
          expect(await revisionCount()).toBe(before + 1);
          await info.attach('ordinary-choice-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, scenario, target, representation, proposalIds: all.map(p => p.proposalId),
            replacementProposalId: replacement?.proposalId ?? null, groupId, chosenProposalId: chosen.proposalId,
            finalText, actionPosts, beforeRevisionCount: before, afterRevisionCount: before + 1,
            receipt: { affectedProposalIds: accepted.receipt.affectedProposalIds, result: accepted.receipt.result },
            losingChildStatus: blocked.status, losingChildReason: blocked.diagnosis.reasonCode,
          }, null, 2) });
        }, { workspaceKind });
      });
    }
  });
}
