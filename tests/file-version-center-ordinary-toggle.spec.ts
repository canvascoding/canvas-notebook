import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1,
  type ProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n\nDeckung: 100 EUR\n\nNotiz: offen\n';
const AFTER_DEFAULT = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n\nDeckung: 100 EUR\n\nNotiz: gelesen\n';
const AFTER_DIRECT = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 3 Tage\n\nDeckung: 100 EUR\n\nNotiz: gelesen\n';
const FINAL = '# Versand\n\nKosten: 12 EUR\n\nLieferzeit: 3 Tage\n\nDeckung: 175 EUR\n\nNotiz: bereit\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';

for (const workspaceKind of ['personal', 'team'] as const) {
  test(`Ordinary review toggle (${workspaceKind}) preserves open dependencies and invalidates stale preview after safe direct`, async ({ browser }, info) => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    test.setTimeout(240_000);
    await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
      agentContext, content, revisionCount }) => {
      page.setDefaultTimeout(20_000);
      expect(representation).toBe('tiptap_blocks');
      const headers = { 'x-canvas-workspace-id': target.workspaceId };
      const before = await revisionCount();
      const policy = page.locator('[data-file-review-policy]').getByRole('switch');
      await expect(policy).not.toBeChecked();
      const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>, toolCallId = `ordinary-toggle-${randomUUID()}`) =>
        runOrdinaryAgentTool({ toolName, toolCallId, params, context: agentContext }, { inProcess: true });
      const live = async () => {
        const result = await run('read', { path: filePath, source: 'blocks' });
        expect(result.isError, result.details?.code).not.toBe(true);
        expect(result.details?.collaboration).toMatchObject({ source: 'live_yjs', representation: 'tiptap_blocks' });
        expect(result.details?.structure?.nextOffset).toBeNull();
        return result;
      };
      const original = await live();
      const blockIds = original.details!.structure!.blocks.map(block => block.id);
      const ordinary = async (oldText: string, newText: string) => {
        const source = await live();
        const params = { path: filePath, expectedSha256: source.details!.sha256, oldText, newText };
        const toolCallId = `ordinary-toggle-${randomUUID()}`;
        const result = await run('edit_file', params, toolCallId);
        expect(result.isError, result.details?.code).not.toBe(true);
        return { result, params, toolCallId };
      };
      const directDefault = await ordinary('Notiz: offen', 'Notiz: gelesen');
      await info.attach('ordinary-default-direct-result.json', { contentType: 'application/json',
        body: JSON.stringify(directDefault.result) });
      expect(directDefault.result.details?.collaboration, JSON.stringify(directDefault.result.details?.collaboration)).toMatchObject({ operationStatus: 'persisted_yjs',
        reviewRequired: false, durability: 'persisted_yjs' });
      expect(directDefault.result.details?.proposal).toBeUndefined();
      expect(await content()).toBe(AFTER_DEFAULT);
      expect(await revisionCount()).toBe(before + 1);
      await policy.click();
      await expect(policy).toBeChecked();
      const createdRoot = await ordinary('Kosten: 10 EUR', 'Kosten: 12 EUR');
      expect(createdRoot.result.details?.outcome).toBe('review_required');
      const root = parseProposalToolCreationResultV1(createdRoot.result.details?.proposal);
      const extend = async (parent: ProposalToolCreationResultV1, oldText: string, newText: string) => {
        const result = await run('read', { path: filePath, source: 'blocks',
          proposal: { contractVersion: 1, proposalId: parent.proposalId, expectedScope: parent.scope } });
        expect(result.isError, result.details?.code).not.toBe(true);
        expect(result.details?.structure?.blocks.map(block => block.id)).toEqual(blockIds);
        const proof = parseProposalToolReadResultV1(result.details?.proposal);
        expect(proof.source.kind).toBe('proposal');
        if (proof.source.kind !== 'proposal') throw new Error('An exact parent source is required.');
        const edit = await run('edit_file', { path: filePath, document: result.details!.document,
          blockId: blockIds[3], oldText, newText, expectedSha256: proof.contentSha256,
          proposal: { contractVersion: 1, creationKind: 'extends', source: proof.source,
            expectedParentCandidateHash: proof.source.candidateHash,
            expectedParentCasVersion: proof.source.proposalCasVersion, choice: null, replaces: null } });
        expect(edit.isError, edit.details?.code).not.toBe(true);
        expect(edit.details?.outcome).toBe('review_required');
        const proposal = parseProposalToolCreationResultV1(edit.details?.proposal);
        expect(proposal.relationships.dependency).toEqual({ proposalId: parent.proposalId, candidateHash: parent.candidateHash });
        return proposal;
      };
      const child = await extend(root, '100 EUR', '150 EUR');
      const review = async (proposal: ProposalToolCreationResultV1) => {
        const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
          headers, data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: proposal.operationId } },
        });
        expect(response.ok()).toBeTruthy();
        const result = await response.json() as ProposalReviewSessionResponseV1;
        expect(result.mode).toBe('graph');
        if (result.mode !== 'graph') throw new Error('Pending dependencies require graph review.');
        return result;
      };
      const pendingBeforeOff = await review(child);
      await policy.click();
      await expect(policy).not.toBeChecked();
      const pendingAfterOff = await review(child);
      expect(pendingAfterOff.selectedProposalIds).toEqual([child.proposalId]);
      expect(pendingAfterOff.context?.graphRevision).toBe(pendingBeforeOff.context?.graphRevision);
      expect(pendingAfterOff.context?.applyProposalIds).toEqual([root.proposalId, child.proposalId]);
      expect(pendingAfterOff.context?.proposals.every(p => p.lifecycle === 'open')).toBe(true);
      const retriedRoot = await run('edit_file', createdRoot.params, createdRoot.toolCallId);
      expect(retriedRoot.isError).not.toBe(true);
      expect(retriedRoot.details?.outcome).toBe('review_required');
      expect(parseProposalToolCreationResultV1(retriedRoot.details?.proposal)).toEqual(root);
      expect(await content()).toBe(AFTER_DEFAULT);
      expect(await revisionCount()).toBe(before + 1);
      // Explicit dependency remains review-only even when future ordinary edits are direct.
      const leaf = await extend(child, '150 EUR', '175 EUR');
      expect(await content()).toBe(AFTER_DEFAULT);
      expect(await revisionCount()).toBe(before + 1);
      const staleReview = await review(leaf);
      expect(staleReview.context?.applyProposalIds).toEqual([root.proposalId, child.proposalId, leaf.proposalId]);
      expect(staleReview.actions.accept).toBeTruthy();
      const staleRequest = { contractVersion: 1, target, action: { contractVersion: 1,
        ...staleReview.actions.accept!, idempotencyKey: randomUUID(), creation: null } };
      const direct = await ordinary('Lieferzeit: 5 Tage', 'Lieferzeit: 3 Tage');
      expect(direct.result.details?.collaboration).toMatchObject({ operationStatus: 'persisted_yjs',
        reviewRequired: false, durability: 'persisted_yjs' });
      expect(direct.result.details?.proposal).toBeUndefined();
      expect(await content()).toBe(AFTER_DIRECT);
      expect(await revisionCount()).toBe(before + 2);
      const staleResponse = await context.request.post(ACTION_PATH, { headers, data: staleRequest });
      expect(staleResponse.status()).toBe(409);
      expect((await staleResponse.json()).error.code).toBe(Codes.currentChanged);
      expect(await content()).toBe(AFTER_DIRECT);
      expect(await revisionCount()).toBe(before + 2);
      const fresh = await review(leaf);
      expect(fresh.status).toBe('clean_rebased');
      expect(fresh.context?.proposals.every(p => p.lifecycle === 'open')).toBe(true);
      await policy.click();
      await expect(policy).toBeChecked();
      const note = await ordinary('Notiz: gelesen', 'Notiz: bereit');
      expect(note.result.details?.outcome).toBe('review_required');
      const other = parseProposalToolCreationResultV1(note.result.details?.proposal);
      expect(other.relationships.dependency).toBeNull();
      expect(await content()).toBe(AFTER_DIRECT);
      expect(await revisionCount()).toBe(before + 2);
      let actionPosts = 0;
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
      });
      await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
        selectedEntry: { kind: 'agent_operation', id: leaf.operationId }, initialView: 'reviews', source: 'deep_link' }));
      const graph = page.getByTestId('graph-review-comparison');
      await expect(graph.getByTestId('graph-review-context')).toContainText('2 prerequisites included');
      await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
      await expect(graph).toContainText('4 proposals selected');
      await info.attach('ordinary-toggle-before-accept.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
      await graph.getByRole('button', { name: 'Accept all changes', exact: true }).click();
      const pendingAction = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === ACTION_PATH);
      await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
      const response = await pendingAction;
      expect(response.ok()).toBeTruthy();
      const request = response.request().postDataJSON();
      const receipt = await response.json() as ProposalActionReceiptV1;
      const ids = [root.proposalId, child.proposalId, leaf.proposalId, other.proposalId];
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.actionType).toBe('batch_accept');
      expect(receipt.result?.kind).toBe('content_changed');
      expect([...request.action.fence.selectedProposalIds].sort()).toEqual([...ids].sort());
      expect([...request.action.fence.applyProposalIds].sort()).toEqual([...ids].sort());
      expect([...receipt.affectedProposalIds].sort()).toEqual([...ids].sort());
      expect(receipt.result?.resolutions).toHaveLength(4);
      expect(receipt.result?.resolutions).toEqual(expect.arrayContaining(ids.map(proposalId => ({ proposalId, lifecycle: 'applied' }))));
      const retry = await context.request.post(ACTION_PATH, { headers, data: request });
      expect(retry.ok()).toBeTruthy();
      expect(await retry.json()).toEqual(receipt);
      expect(await content()).toBe(FINAL);
      expect(await revisionCount()).toBe(before + 3);
      expect(actionPosts).toBe(1);
      const finalBlocks = await live();
      expect(finalBlocks.details?.structure?.blocks.map(block => block.id)).toEqual(blockIds);
      expect(finalBlocks.details?.structure?.blocks.map(block => block.text))
        .toEqual(['Versand', 'Kosten: 12 EUR', 'Lieferzeit: 3 Tage', 'Deckung: 175 EUR', 'Notiz: bereit']);
      await info.attach('ordinary-toggle-evidence.json', { contentType: 'application/json', body: JSON.stringify({
        workspaceKind, target, proposalIds: ids, defaultDirectOperationId: directDefault.result.details?.collaboration?.operationId,
        directOperationId: direct.result.details?.collaboration?.operationId, staleReason: Codes.currentChanged,
        actionPosts, beforeRevisionCount: before, afterRevisionCount: before + 3, finalText: FINAL, blockIds,
        receipt: { affectedProposalIds: receipt.affectedProposalIds, result: receipt.result },
      }, null, 2) });
    }, { workspaceKind, initialReviewRequired: false, bindToolSessionToFixture: true });
  });
}
