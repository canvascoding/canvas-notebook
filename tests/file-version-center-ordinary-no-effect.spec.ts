import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1,
  type ProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary no-effect Markdown proposals (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');

    test('identical independent effects close once without approving a child with different authored identities', async ({ browser }, info) => {
      test.setTimeout(180_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
        agentContext, content, revisionCount }) => {
        expect(representation).toBe('tiptap_blocks');
        const before = await revisionCount();
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-twin-${randomUUID()}`, params, context: agentContext });
        const source = await run('read', { path: filePath, source: 'blocks' });
        expect(source.isError).not.toBe(true);
        expect(source.details?.collaboration).toMatchObject({ documentId: target.documentId,
          representation: 'tiptap_blocks', source: 'live_yjs' });
        expect(source.details?.structure?.nextOffset).toBeNull();
        const blocks = source.details!.structure!.blocks;
        const create = async (params: Record<string, unknown>) => {
          const result = await run('edit_file', { path: filePath, ...params });
          expect(result.isError).not.toBe(true);
          expect(result.details?.outcome).toBe('review_required');
          return parseProposalToolCreationResultV1(result.details?.proposal);
        };
        const mutation = { document: source.details!.document, blockId: blocks[1]!.id,
          expectedSha256: source.details!.sha256, oldText: '10 EUR', newText: '12 EUR' };
        const b = await create(mutation);
        const c = await create(mutation);
        expect(b.proposalId).not.toBe(c.proposalId);
        expect(b.source).toEqual(c.source);
        const parentRead = await run('read', { path: filePath, source: 'blocks',
          proposal: { contractVersion: 1, proposalId: b.proposalId, expectedScope: b.scope } });
        expect(parentRead.isError).not.toBe(true);
        const parentSource = parseProposalToolReadResultV1(parentRead.details?.proposal);
        if (parentSource.source.kind !== 'proposal') throw new Error('The child requires the exact B source.');
        const child = await create({ document: parentRead.details!.document, blockId: blocks[1]!.id,
          expectedSha256: parentSource.contentSha256, oldText: '12 EUR', newText: '14 EUR',
          proposal: { contractVersion: 1, creationKind: 'extends', source: parentSource.source,
            expectedParentCandidateHash: parentSource.source.candidateHash,
            expectedParentCasVersion: parentSource.source.proposalCasVersion, replaces: null, choice: null } });
        const review = async (selected: ProposalToolCreationResultV1) => {
          const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
            headers: { 'x-canvas-workspace-id': target.workspaceId },
            data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: selected.operationId } },
          });
          expect(response.ok()).toBeTruthy();
          const session = parseProposalReviewSessionResponseV1(await response.json());
          if (session.mode !== 'graph') throw new Error('Ordinary proposals require graph review.');
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
        const graph = page.getByTestId('graph-review-comparison');
        const decide = async (selected: ProposalToolCreationResultV1, button: string) => {
          await page.goto(link(selected));
          await expect(graph.getByRole('button', { name: button, exact: true })).toBeEnabled({ timeout: 30_000 });
          await graph.getByRole('button', { name: button, exact: true }).click();
          const pending = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
          await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
          const response = await pending;
          expect(response.ok()).toBeTruthy();
          const receipt = await response.json() as ProposalActionReceiptV1;
          expect(receipt.phase).toBe('succeeded');
          const retry = await context.request.post('/api/files/version-center/v1/proposals/actions', {
            headers: { 'x-canvas-workspace-id': target.workspaceId }, data: response.request().postDataJSON(),
          });
          expect(retry.ok()).toBeTruthy();
          expect(await retry.json()).toEqual(receipt);
          return receipt;
        };
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        const accepted = await decide(c, 'Accept change');
        expect(accepted.result?.kind).toBe('content_changed');
        expect(accepted.result?.resolutions).toEqual([{ proposalId: c.proposalId, lifecycle: 'applied' }]);
        const afterC = await review(b);
        expect(afterC.status).toBe('satisfied_elsewhere');
        expect(afterC.compare?.diagnosis).toEqual({ availability: 'available', reasonCode: null });
        expect(afterC.compare?.candidate.noEffect).toBe(true);
        expect(afterC.compare?.hunks).toEqual([]);
        expect(afterC.actions.accept).toBeUndefined();
        expect(afterC.actions.completeSatisfied).toBeTruthy();
        const blockedBefore = await review(child);
        expect(blockedBefore.status).toBe('prerequisite_lost');
        expect(blockedBefore.actions.accept).toBeUndefined();
        expect(blockedBefore.actions.completeSatisfied).toBeUndefined();
        await page.goto(link(b));
        await expect(graph.getByTestId('graph-review-no-effect')).toContainText('already present', { timeout: 30_000 });
        await expect(graph.getByRole('button', { name: 'Close without changes', exact: true })).toHaveCount(0);
        await info.attach('ordinary-twin-no-effect.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        const completed = await decide(b, 'Mark as already present');
        expect(completed.result?.kind).toBe('metadata_only');
        expect(completed.result?.revisionId).toBeNull();
        expect(completed.result?.resolutions).toEqual([{ proposalId: b.proposalId, lifecycle: 'satisfied_elsewhere' }]);
        const blockedAfter = await review(child);
        expect(blockedAfter.status).toBe('prerequisite_lost');
        expect(blockedAfter.actions.accept).toBeUndefined();
        expect(blockedAfter.actions.completeSatisfied).toBeUndefined();
        expect(blockedAfter.context?.proposals.find(proposal => proposal.proposalId === child.proposalId)?.lifecycle).toBe('open');
        expect(blockedAfter.compare?.binding?.current).toEqual(afterC.compare?.binding?.current);
        for (const [proposal, lifecycle] of [[b, 'satisfied_elsewhere'], [c, 'applied']] as const) {
          const historical = await review(proposal);
          expect(historical.context?.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle).toBe(lifecycle);
          expect(historical.actions).toEqual({});
        }
        await page.goto(link(child));
        await expect(graph.getByTestId('graph-review-blocked')).toBeVisible({ timeout: 30_000 });
        await expect(graph.getByTestId('graph-review-no-effect')).toHaveCount(0);
        await info.attach('ordinary-twin-child-blocked.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        expect(await content()).toBe(INITIAL.replace('10 EUR', '12 EUR'));
        expect(await revisionCount()).toBe(before + 1);
        const live = await run('read', { path: filePath, source: 'blocks' });
        expect(live.isError).not.toBe(true);
        expect(live.details!.structure!.blocks.map(block => [block.id, block.text])).toEqual(
          blocks.map(block => [block.id, block.text.replace('10 EUR', '12 EUR')]));
        expect(actionPosts).toBe(2);
        await info.attach('ordinary-twin-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, target, representation, bId: b.proposalId, cId: c.proposalId, childId: child.proposalId,
          beforeRevisionCount: before, afterRevisionCount: await revisionCount(), actionPosts,
          unchangedFullCurrentProofAfterMetadata: true, childStatusBefore: blockedBefore.status, childStatusAfter: blockedAfter.status,
          receipts: [accepted, completed].map(receipt => ({ actionType: receipt.actionType, phase: receipt.phase, result: receipt.result })),
        }, null, 2) });
      }, { workspaceKind });
    });

    test('empty parent-child chain closes only the selected leaf without a content revision', async ({ browser }, info) => {
      test.setTimeout(180_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
        agentContext, content, revisionCount }) => {
        expect(representation).toBe('tiptap_blocks');
        const before = await revisionCount();
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-no-effect-${randomUUID()}`, params, context: agentContext });
        const source = await run('read', { path: filePath, source: 'blocks' });
        expect(source.isError).not.toBe(true);
        expect(source.details?.collaboration).toMatchObject({ documentId: target.documentId,
          representation: 'tiptap_blocks', source: 'live_yjs' });
        expect(source.details?.structure?.nextOffset).toBeNull();
        const blocks = source.details!.structure!.blocks;
        expect(blocks.map(block => block.text)).toEqual(['Versand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage']);
        const create = async (params: Record<string, unknown>) => {
          const result = await run('edit_file', { path: filePath, ...params });
          expect(result.isError).not.toBe(true);
          expect(result.details?.outcome).toBe('review_required');
          expect(result.details?.collaboration).toMatchObject({ reviewRequired: true,
            operationStatus: 'needs_review', durability: 'not_applied' });
          return parseProposalToolCreationResultV1(result.details?.proposal);
        };
        const parent = await create({ document: source.details!.document, blockId: blocks[1]!.id,
          expectedSha256: source.details!.sha256, oldText: '10 EUR', newText: '12 EUR' });
        const parentRead = await run('read', { path: filePath, source: 'blocks',
          proposal: { contractVersion: 1, proposalId: parent.proposalId, expectedScope: parent.scope } });
        expect(parentRead.isError).not.toBe(true);
        const parentSource = parseProposalToolReadResultV1(parentRead.details?.proposal);
        expect(parentSource.source.kind).toBe('proposal');
        if (parentSource.source.kind !== 'proposal') throw new Error('The child requires the immutable parent source.');
        expect(parentSource.source.authoredCandidateHash).toBe(parent.candidateHash);
        const child = await create({ document: parentRead.details!.document, blockId: blocks[1]!.id,
          expectedSha256: parentSource.contentSha256, oldText: '12 EUR', newText: '10 EUR',
          proposal: { contractVersion: 1, creationKind: 'extends', source: parentSource.source,
            expectedParentCandidateHash: parentSource.source.candidateHash,
            expectedParentCasVersion: parentSource.source.proposalCasVersion, replaces: null, choice: null } });
        expect(child.relationships.dependency?.proposalId).toBe(parent.proposalId);
        const review = async (selected: ProposalToolCreationResultV1 | 'all') => {
          const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
            headers: { 'x-canvas-workspace-id': target.workspaceId },
            data: { contractVersion: 1, target, selection: selected === 'all' ? { kind: 'all' }
              : { kind: 'operation', operationId: selected.operationId } },
          });
          expect(response.ok()).toBeTruthy();
          const session = parseProposalReviewSessionResponseV1(await response.json());
          expect(session.mode).toBe('graph');
          if (session.mode !== 'graph') throw new Error('Ordinary proposals require graph review.');
          return session;
        };
        const link = (selected: ProposalToolCreationResultV1) => buildFileVersionCenterDeepLinkV1('/en', {
          contractVersion: 1, target, selectedEntry: { kind: 'agent_operation', id: selected.operationId },
          initialView: 'reviews', source: 'deep_link',
        });
        const leaf = await review(child);
        const all = await review('all');
        await info.attach('ordinary-empty-preflight.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, target, leaf: { status: leaf.status, reasonCode: leaf.reasonCode,
            diagnosis: leaf.compare?.diagnosis, actionNames: Object.keys(leaf.actions) },
          all: { status: all.status, reasonCode: all.reasonCode,
            diagnosis: all.compare?.diagnosis, actionNames: Object.keys(all.actions) },
        }, null, 2) });
        await page.goto(link(child));
        const graph = page.getByTestId('graph-review-comparison');
        await expect(graph).toBeVisible({ timeout: 30_000 });
        await info.attach('ordinary-empty-initial.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        for (const session of [leaf, all]) {
          expect(session.status).toBe('empty_effect');
          expect(session.reasonCode).toBeNull();
          expect(session.compare?.diagnosis).toEqual({ availability: 'available', reasonCode: null });
          expect(session.compare?.candidate.noEffect).toBe(true);
          expect(session.compare?.hunks).toEqual([]);
          expect(session.compare?.summary).toEqual({ additions: 0, deletions: 0, unchanged: 0 });
          expect(session.actions.accept).toBeUndefined();
          expect(session.context?.proposals.filter(proposal => proposal.lifecycle === 'open')).toHaveLength(2);
        }
        expect(leaf.actions.completeSatisfied).toBeTruthy();
        expect(all.actions.completeSatisfied).toBeUndefined();
        expect(leaf.context?.applyProposalIds).toEqual([parent.proposalId, child.proposalId]);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        await expect(graph.getByTestId('graph-review-no-effect')).toBeVisible();
        await expect(graph.getByTestId('graph-review-blocked')).toHaveCount(0);
        await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
        await expect(graph).toContainText('2 proposals selected');
        await expect(graph.getByTestId('graph-review-no-effect')).toBeVisible();
        await expect(graph.getByRole('button', { name: /Accept change|Accept all changes|Mark as already present|Close without changes/u })).toHaveCount(0);
        await expect(graph.getByTestId('graph-review-no-effect')).toContainText('Nothing has been applied or closed.');
        await info.attach('ordinary-empty-batch.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        await page.goto(link(child));
        await expect(graph.getByTestId('graph-review-no-effect')).toBeVisible({ timeout: 30_000 });
        let actionPosts = 0;
        page.on('request', request => {
          if (request.method() === 'POST'
            && new URL(request.url()).pathname === '/api/files/version-center/v1/proposals/actions') actionPosts += 1;
        });
        await graph.getByRole('button', { name: 'Close without changes', exact: true }).click();
        await expect(graph.getByTestId('graph-review-confirmation')).toContainText('Close only this proposal without changing the document?');
        const pending = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
        await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
        const response = await pending;
        expect(response.ok()).toBeTruthy();
        const receipt = await response.json() as ProposalActionReceiptV1;
        expect(receipt.phase).toBe('succeeded');
        expect(receipt.actionType).toBe('complete_satisfied');
        expect(receipt.result?.kind).toBe('metadata_only');
        expect(receipt.result?.revisionId).toBeNull();
        expect(receipt.result?.resolutions).toEqual([{ proposalId: child.proposalId, lifecycle: 'satisfied_elsewhere' }]);
        const retry = await context.request.post('/api/files/version-center/v1/proposals/actions', {
          headers: { 'x-canvas-workspace-id': target.workspaceId }, data: response.request().postDataJSON(),
        });
        expect(retry.ok()).toBeTruthy();
        expect(await retry.json()).toEqual(receipt);
        const parentAfter = await review(parent);
        const childAfter = await review(child);
        expect(parentAfter.status).toBe('clean');
        expect(parentAfter.actions.accept).toBeTruthy();
        expect(parentAfter.context?.proposals.find(proposal => proposal.proposalId === parent.proposalId)?.lifecycle).toBe('open');
        expect(childAfter.context?.proposals.find(proposal => proposal.proposalId === child.proposalId)?.lifecycle).toBe('satisfied_elsewhere');
        expect(childAfter.actions).toEqual({});
        expect(parentAfter.compare?.binding?.current).toEqual(leaf.compare?.binding?.current);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(before);
        const live = await run('read', { path: filePath, source: 'blocks' });
        expect(live.isError).not.toBe(true);
        expect(live.details!.structure!.blocks.map(block => [block.id, block.text])).toEqual(blocks.map(block => [block.id, block.text]));
        expect(actionPosts).toBe(1);
        await info.attach('ordinary-empty-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, target, representation, parentId: parent.proposalId, childId: child.proposalId,
          beforeRevisionCount: before, afterRevisionCount: await revisionCount(), actionPosts,
          leafStatus: leaf.status, allStatus: all.status, unchangedFullCurrentProof: true,
          parentLifecycle: 'open', childLifecycle: 'satisfied_elsewhere',
          receipt: { actionType: receipt.actionType, phase: receipt.phase, result: receipt.result },
        }, null, 2) });
      }, { workspaceKind });
    });
  });
}
