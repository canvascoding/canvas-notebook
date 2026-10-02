import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionRequestV1, ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const FINAL = '# Versand\n\nKosten: 12 EUR\n\nLieferzeit: 3 Tage\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary conflicting siblings (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    test('conflicting batch leaves parent untouched before an explicit child selection', async ({ browser }, info) => {
      test.setTimeout(240_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
        agentContext, content, revisionCount }) => {
        page.setDefaultTimeout(20_000);
        expect(representation).toBe('tiptap_blocks');
        const before = await revisionCount();
        const headers = { 'x-canvas-workspace-id': target.workspaceId };
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-sibling-${randomUUID()}`, params, context: agentContext });
        const source = await run('read', { path: filePath, source: 'blocks' });
        expect(source.isError).not.toBe(true);
        expect(source.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
        expect(source.details?.structure?.nextOffset).toBeNull();
        const originalBlocks = source.details!.structure!.blocks;
        expect(originalBlocks.map(block => block.text)).toEqual(['Versand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage']);
        const parentResult = await run('edit_file', { path: filePath, expectedSha256: source.details!.sha256,
          oldText: 'Kosten: 10 EUR', newText: 'Kosten: 12 EUR' });
        expect(parentResult.isError).not.toBe(true);
        expect(parentResult.details?.outcome).toBe('review_required');
        const parent = parseProposalToolCreationResultV1(parentResult.details?.proposal);
        const children = [];
        for (const newText of ['3 Tage', '2 Tage']) {
          // Creation advances the graph revision; read the same P1 candidate
          // again to obtain a fresh evaluation, never a different parent.
          const parentRead = await run('read', { path: filePath, source: 'blocks',
            proposal: { contractVersion: 1, proposalId: parent.proposalId, expectedScope: parent.scope } });
          expect(parentRead.isError).not.toBe(true);
          expect(parentRead.details?.structure?.nextOffset).toBeNull();
          expect(parentRead.details?.structure?.blocks.map(block => [block.id, block.text])).toEqual([
            [originalBlocks[0]!.id, 'Versand'], [originalBlocks[1]!.id, 'Kosten: 12 EUR'], [originalBlocks[2]!.id, 'Lieferzeit: 5 Tage'],
          ]);
          const proof = parseProposalToolReadResultV1(parentRead.details?.proposal);
          expect(proof.source.kind).toBe('proposal');
          if (proof.source.kind !== 'proposal') throw new Error('Both siblings must explicitly share P1 as their source.');
          expect(proof.source.proposalId).toBe(parent.proposalId);
          expect(proof.source.authoredCandidateHash).toBe(parent.candidateHash);
          const childParams = { path: filePath, document: parentRead.details!.document,
            blockId: originalBlocks[2]!.id, expectedSha256: proof.contentSha256, oldText: '5 Tage',
            proposal: { contractVersion: 1, creationKind: 'extends', source: proof.source,
              expectedParentCandidateHash: proof.source.candidateHash,
              expectedParentCasVersion: proof.source.proposalCasVersion, replaces: null, choice: null } };
          const result = await run('edit_file', { ...childParams, newText });
          expect(result.isError, `Sibling ${newText}: ${result.details?.code ?? result.details?.outcome ?? 'no error code'}`).not.toBe(true);
          expect(result.details?.outcome).toBe('review_required');
          const child = parseProposalToolCreationResultV1(result.details?.proposal);
          expect(child.relationships).toEqual({ dependency: { proposalId: parent.proposalId, candidateHash: parent.candidateHash },
            replacesProposalId: null, choiceGroupId: null });
          children.push(child);
        }
        const [chosen, remaining] = children;
        const ids = [parent.proposalId, chosen!.proposalId, remaining!.proposalId];
        const review = async (selection: ProposalReviewSessionRequestV1['selection']) => {
          const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
            headers, data: { contractVersion: 1, target, selection },
          });
          expect(response.ok()).toBeTruthy();
          const session = await response.json() as ProposalReviewSessionResponseV1;
          expect(session.mode).toBe('graph');
          if (session.mode !== 'graph') throw new Error('The sibling conflict must remain in graph review.');
          return session;
        };
        const open = async (operationId: string) => {
          await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
            selectedEntry: { kind: 'agent_operation', id: operationId }, initialView: 'reviews', source: 'deep_link' }));
          await expect(page.getByTestId('graph-review-comparison')).toBeVisible({ timeout: 30_000 });
        };
        const graph = page.getByTestId('graph-review-comparison');
        let actionPosts = 0;
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
        });
        const initial = await review({ kind: 'proposals', proposalIds: ids });
        expect(initial.status).toBe('conflicted');
        expect(initial.diagnosis.reasonCode).toBe(Codes.batchConflict);
        expect(initial.actions.accept).toBeUndefined();
        expect(initial.context!.proposals.filter(item => ids.includes(item.proposalId)).map(item => item.lifecycle)).toEqual(['open', 'open', 'open']);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        await open(chosen!.operationId);
        await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
        await expect(graph).toContainText('3 proposals selected');
        await expect(graph.getByTestId('graph-review-blocked')).toBeVisible();
        await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
        expect(actionPosts).toBe(0);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        await info.attach('ordinary-siblings-blocked-batch.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });

        await open(chosen!.operationId);
        await expect(graph.getByTestId('graph-review-context')).toContainText('1 prerequisite included');
        await expect(graph.getByTestId('graph-review-hunks')).toContainText('Lieferzeit: 3 Tage');
        await expect(graph.getByTestId('graph-review-hunks')).not.toContainText('Lieferzeit: 2 Tage');
        await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
        const pending = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === ACTION_PATH);
        await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
        const acceptedResponse = await pending;
        expect(acceptedResponse.ok()).toBeTruthy();
        const acceptedRequest = acceptedResponse.request().postDataJSON();
        expect(acceptedRequest.action.fence.selectedProposalIds).toEqual([chosen!.proposalId]);
        expect(acceptedRequest.action.fence.applyProposalIds).toEqual([parent.proposalId, chosen!.proposalId]);
        expect(acceptedRequest.action.fence.closure.map((item: { proposalId: string }) => item.proposalId).sort())
          .toEqual([parent.proposalId, chosen!.proposalId].sort());
        const accepted = await acceptedResponse.json() as ProposalActionReceiptV1;
        expect(accepted.phase).toBe('succeeded');
        expect(accepted.actionType).toBe('accept');
        expect([...accepted.affectedProposalIds].sort()).toEqual([parent.proposalId, chosen!.proposalId].sort());
        expect(accepted.result).toMatchObject({ kind: 'content_changed', resolutions: expect.arrayContaining([
          { proposalId: parent.proposalId, lifecycle: 'included' }, { proposalId: chosen!.proposalId, lifecycle: 'applied' },
        ]) });
        expect(accepted.result?.resolutions).toHaveLength(2);
        expect(await content()).toBe(FINAL);
        expect(await revisionCount()).toBe(before + 1);

        const pendingSibling = await review({ kind: 'operation', operationId: remaining!.operationId });
        expect(pendingSibling.selectedProposalIds).toEqual([remaining!.proposalId]);
        expect(pendingSibling.status).toBe('conflicted');
        expect(pendingSibling.diagnosis.reasonCode).toBe(Codes.batchConflict);
        expect(pendingSibling.actions.accept).toBeUndefined();
        for (const [proposal, lifecycle] of [[parent, 'included'], [chosen!, 'applied'], [remaining!, 'open']] as const) {
          // A sibling's review context need not include unrelated closed nodes.
          // Inspect every exact operation to verify its own durable lifecycle.
          const exact = await review({ kind: 'operation', operationId: proposal.operationId });
          expect(exact.selectedProposalIds).toEqual([proposal.proposalId]);
          expect(exact.context!.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle).toBe(lifecycle);
          if (lifecycle !== 'open') expect(Object.keys(exact.actions)).toHaveLength(0);
        }
        await open(remaining!.operationId);
        await expect(graph.getByTestId('graph-review-blocked')).toBeVisible();
        await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
        const live = await run('read', { path: filePath, source: 'blocks' });
        expect(live.isError).not.toBe(true);
        expect(live.details?.document).toEqual(source.details!.document);
        expect(live.details?.structure?.nextOffset).toBeNull();
        expect(live.details!.structure!.blocks.map(block => [block.id, block.text])).toEqual([
          [originalBlocks[0]!.id, 'Versand'], [originalBlocks[1]!.id, 'Kosten: 12 EUR'], [originalBlocks[2]!.id, 'Lieferzeit: 3 Tage'],
        ]);
        expect(actionPosts).toBe(1);
        expect(await content()).toBe(FINAL);
        expect(await revisionCount()).toBe(before + 1);
        await info.attach('ordinary-sibling-conflict-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, target, representation, proposalIds: ids, beforeRevisionCount: before, afterRevisionCount: before + 1,
          actionPosts, initialBatchStatus: initial.status, initialBatchReason: initial.diagnosis.reasonCode,
          remainingStatus: pendingSibling.status, remainingReason: pendingSibling.diagnosis.reasonCode,
          expectedFinal: FINAL, originalBlockIds: originalBlocks.map(block => block.id),
          receipt: { affectedProposalIds: accepted.affectedProposalIds, result: accepted.result },
        }, null, 2) });
      }, { workspaceKind });
    });
  });
}
