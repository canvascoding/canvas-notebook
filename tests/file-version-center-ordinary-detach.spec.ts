import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import type { ProposalReviewTransformResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-transform-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const FINAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 3 Tage\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';
const PREVIEW_PATH = '/api/files/version-center/v1/proposals/transform/preview';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary rejected prerequisite recovery (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    test('explicit detach applies only the disjoint child after parent rejection', async ({ browser }, info) => {
      test.setTimeout(240_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
        agentContext, content, revisionCount }) => {
        page.setDefaultTimeout(20_000);
        expect(representation).toBe('tiptap_blocks');
        const headers = { 'x-canvas-workspace-id': target.workspaceId };
        const before = await revisionCount();
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-detach-${randomUUID()}`, params, context: agentContext });
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
        const parentRead = await run('read', { path: filePath, source: 'blocks',
          proposal: { contractVersion: 1, proposalId: parent.proposalId, expectedScope: parent.scope } });
        expect(parentRead.isError).not.toBe(true);
        expect(parentRead.details?.structure?.blocks.map(block => block.id)).toEqual(originalBlocks.map(block => block.id));
        const parentSource = parseProposalToolReadResultV1(parentRead.details?.proposal);
        expect(parentSource.source.kind).toBe('proposal');
        if (parentSource.source.kind !== 'proposal') throw new Error('The disjoint child must explicitly retain its parent source.');
        const childResult = await run('edit_file', { path: filePath, document: parentRead.details!.document,
          blockId: originalBlocks[2]!.id, expectedSha256: parentSource.contentSha256,
          oldText: '5 Tage', newText: '3 Tage',
          proposal: { contractVersion: 1, creationKind: 'extends', source: parentSource.source,
            expectedParentCandidateHash: parentSource.source.candidateHash,
            expectedParentCasVersion: parentSource.source.proposalCasVersion, replaces: null, choice: null } });
        expect(childResult.isError).not.toBe(true);
        expect(childResult.details?.outcome).toBe('review_required');
        const child = parseProposalToolCreationResultV1(childResult.details?.proposal);
        expect(child.relationships.dependency).toEqual({ proposalId: parent.proposalId, candidateHash: parent.candidateHash });
        const review = async (operationId: string) => {
          const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
            headers, data: { contractVersion: 1, target, selection: { kind: 'operation', operationId } },
          });
          expect(response.ok()).toBeTruthy();
          const session = await response.json() as ProposalReviewSessionResponseV1;
          expect(session.mode).toBe('graph');
          if (session.mode !== 'graph') throw new Error('Ordinary dependency recovery must use graph review.');
          return session;
        };
        const open = async (operationId: string) => {
          await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
            selectedEntry: { kind: 'agent_operation', id: operationId }, initialView: 'reviews', source: 'deep_link' }));
          await expect(page.getByTestId('graph-review-comparison')).toBeVisible({ timeout: 30_000 });
        };
        const graph = page.getByTestId('graph-review-comparison');
        const decide = async (label: string) => {
          await graph.getByRole('button', { name: label, exact: true }).click();
          const pending = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === ACTION_PATH);
          await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
          const response = await pending;
          expect(response.ok()).toBeTruthy();
          const receipt = await response.json() as ProposalActionReceiptV1;
          expect(receipt.phase).toBe('succeeded');
          return receipt;
        };
        const ready = await review(child.operationId);
        expect(ready.status).toBe('clean');
        expect(ready.context?.dependencyProposalIds).toEqual([parent.proposalId]);
        expect(ready.context?.applyProposalIds).toEqual([parent.proposalId, child.proposalId]);
        expect(ready.actions.accept?.fence.applyProposalIds).toEqual([parent.proposalId, child.proposalId]);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        let actionPosts = 0;
        let previewPosts = 0;
        page.on('request', request => {
          if (request.method() !== 'POST') return;
          const pathname = new URL(request.url()).pathname;
          if (pathname === ACTION_PATH) actionPosts += 1;
          if (pathname === PREVIEW_PATH) previewPosts += 1;
        });
        await open(parent.operationId);
        const rejected = await decide('Reject proposal');
        expect(rejected.actionType).toBe('reject');
        expect(rejected.affectedProposalIds).toEqual([parent.proposalId]);
        expect(rejected.result).toMatchObject({ kind: 'metadata_only', revisionId: null,
          resolutions: [{ proposalId: parent.proposalId, lifecycle: 'rejected' }] });
        const assertBlocked = async () => {
          const blocked = await review(child.operationId);
          expect(blocked.selectedProposalIds).toEqual([child.proposalId]);
          expect(blocked.status).toBe('blocked_by_parent');
          expect(blocked.diagnosis.reasonCode).toBe(Codes.dependencyBlocked);
          expect(blocked.actions.accept).toBeUndefined();
          expect(blocked.context?.proposals.find(item => item.proposalId === child.proposalId)?.lifecycle).toBe('open');
          expect(blocked.context?.proposals.find(item => item.proposalId === parent.proposalId)?.lifecycle).toBe('rejected');
          return blocked;
        };
        const blocked = await assertBlocked();
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        await open(child.operationId);
        await expect(graph.getByTestId('graph-review-blocked')).toContainText('Blocked by a dependency');
        await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
        await expect(graph.getByRole('button', { name: 'Check a separate proposal', exact: true })).toBeEnabled();
        await expect(graph.getByRole('button', { name: /Check a replacement proposal/u })).toBeDisabled();
        const pendingPreview = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === PREVIEW_PATH);
        await graph.getByRole('button', { name: 'Check a separate proposal', exact: true }).click();
        const previewResponse = await pendingPreview;
        expect(previewResponse.ok()).toBeTruthy();
        const preview = await previewResponse.json() as ProposalReviewTransformResponseV1;
        expect(preview.kind).toBe('detach');
        expect(preview.sourceProposalId).toBe(child.proposalId);
        expect(preview.beforeContent).toBe(INITIAL);
        expect(preview.proposedContent).toBe(FINAL);
        const creation = preview.prepared.creation;
        expect(creation.proposalId).not.toBe(child.proposalId);
        expect(creation.operationId).not.toBe(child.operationId);
        expect(creation.creationKind).toBe('detached');
        expect(creation.detachedFromProposalId).toBe(child.proposalId);
        expect(creation.reviewRequired).toBe(true);
        expect(creation.source.kind).toBe('authoritative');
        expect(creation.relationships).toEqual({ dependency: null, replacesProposalId: null, choiceGroupId: null });
        await expect(graph.getByTestId('graph-review-transform-preview')).toBeVisible();
        await expect(graph.getByTestId('graph-review-transform-full-content')).toContainText('Kosten: 10 EUR');
        await expect(graph.getByTestId('graph-review-transform-full-content')).toContainText('Lieferzeit: 3 Tage');
        await expect(graph.getByTestId('graph-review-transform-full-content')).not.toContainText('Kosten: 12 EUR');
        expect((await assertBlocked()).context?.graphRevision).toBe(blocked.context!.graphRevision);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        await info.attach('ordinary-detach-preview.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        const pendingCreation = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === ACTION_PATH);
        await graph.getByRole('button', { name: 'Create separate proposal', exact: true }).click();
        const creationResponse = await pendingCreation;
        expect(creationResponse.ok()).toBeTruthy();
        const detached = await creationResponse.json() as ProposalActionReceiptV1;
        expect(detached.phase).toBe('succeeded');
        expect(detached.actionType).toBe('detach');
        expect(detached.affectedProposalIds).toEqual([child.proposalId]);
        expect(detached.result).toMatchObject({ kind: 'metadata_only', revisionId: null,
          createdProposalIds: [creation.proposalId], resolutions: [] });
        const retry = await context.request.post(ACTION_PATH, { headers, data: creationResponse.request().postDataJSON() });
        expect(retry.ok()).toBeTruthy();
        expect(await retry.json()).toEqual(detached);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        await assertBlocked();
        const independent = await review(creation.operationId);
        expect(independent.selectedProposalIds).toEqual([creation.proposalId]);
        expect(independent.status).toBe('clean');
        expect(independent.context?.dependencyProposalIds).toEqual([]);
        expect(independent.context?.applyProposalIds).toEqual([creation.proposalId]);
        expect(independent.compare!.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind !== 'context')
          .map(line => [line.kind, line.text])).toEqual([['deletion', 'Lieferzeit: 5 Tage'], ['addition', 'Lieferzeit: 3 Tage']]);
        await open(creation.operationId);
        const accepted = await decide('Accept change');
        expect(accepted.actionType).toBe('accept');
        expect(accepted.affectedProposalIds).toEqual([creation.proposalId]);
        expect(accepted.result).toMatchObject({ kind: 'content_changed',
          resolutions: [{ proposalId: creation.proposalId, lifecycle: 'applied' }] });
        expect(await content()).toBe(FINAL);
        expect(await revisionCount()).toBe(before + 1);
        const live = await run('read', { path: filePath, source: 'blocks' });
        expect(live.isError).not.toBe(true);
        expect(live.details?.document).toEqual(source.details!.document);
        expect(live.details?.structure?.nextOffset).toBeNull();
        expect(live.details!.structure!.blocks.map(block => [block.id, block.text])).toEqual([
          [originalBlocks[0]!.id, 'Versand'], [originalBlocks[1]!.id, 'Kosten: 10 EUR'],
          [originalBlocks[2]!.id, 'Lieferzeit: 3 Tage'],
        ]);
        await assertBlocked();
        await open(parent.operationId);
        await expect(graph.getByTestId('graph-review-historical-status')).toContainText('Rejected');
        await expect(graph.getByRole('button', { name: /Accept change|Reject proposal/u })).toHaveCount(0);
        expect(actionPosts).toBe(3);
        expect(previewPosts).toBe(1);
        expect(await content()).toBe(FINAL);
        expect(await revisionCount()).toBe(before + 1);
        await info.attach('ordinary-detach-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, target, representation, parentProposalId: parent.proposalId, childProposalId: child.proposalId,
          detachedProposalId: creation.proposalId, detachedFromProposalId: creation.detachedFromProposalId,
          blockIds: originalBlocks.map(block => block.id), expectedFinal: FINAL, actionPosts, previewPosts,
          beforeRevisionCount: before, afterRevisionCount: before + 1,
          receipts: [rejected, detached, accepted].map(receipt => ({ actionType: receipt.actionType,
            affectedProposalIds: receipt.affectedProposalIds, result: receipt.result })),
        }, null, 2) });
        await info.attach('ordinary-detach-rejected-parent.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
      }, { workspaceKind });
    });
  });
}
