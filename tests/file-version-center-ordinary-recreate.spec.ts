import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { FILE_VERSION_CENTER_ERROR_CODES as FileCodes, type FileVersionCenterTargetV1,
  type FileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';
import { uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const FINAL = '# Versand\n\nKosten: 14 EUR\n\nLieferzeit: 2 Tage\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';
const REVIEW_PATH = '/api/files/version-center/v1/proposals/review';
const RESOLVE_PATH = '/api/files/version-center/v1/resolve';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary proposal delete/recreate (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    test('same path and bytes never revive old proposals, but fresh proposals still merge', async ({ browser }, info) => {
      test.setTimeout(240_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation, agentContext, content }) => {
        page.setDefaultTimeout(20_000);
        expect(representation).toBe('tiptap_blocks');
        const headers = { 'x-canvas-workspace-id': target.workspaceId };
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-recreate-${randomUUID()}`, params, context: agentContext });
        const timelineRequest = (selectedTarget: FileVersionCenterTargetV1) => context.request.post(RESOLVE_PATH, {
          headers, data: { contractVersion: 1, target: selectedTarget, initialView: 'reviews', source: 'deep_link' },
        });
        const timeline = async (selectedTarget: FileVersionCenterTargetV1) => {
          const response = await timelineRequest(selectedTarget);
          expect(response.ok()).toBeTruthy();
          return await response.json() as FileVersionTimelineResponseV1;
        };
        const review = async (selectedTarget: FileVersionCenterTargetV1, operationId: string) => {
          const response = await context.request.post(REVIEW_PATH, {
            headers, data: { contractVersion: 1, target: selectedTarget, selection: { kind: 'operation', operationId } },
          });
          expect(response.ok()).toBeTruthy();
          const result = parseProposalReviewSessionResponseV1(await response.json());
          if (result.mode !== 'graph') throw new Error('Ordinary proposals must remain graph-backed.');
          return result;
        };
        const createPair = async (price: number, days: number) => {
          const source = await run('read', { path: filePath, source: 'blocks' });
          expect(source.isError).not.toBe(true);
          expect(source.details?.structure?.nextOffset).toBeNull();
          const blocks = source.details!.structure!.blocks;
          expect(blocks.map(block => block.text)).toEqual(['Versand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage']);
          const rootResult = await run('edit_file', { path: filePath, expectedSha256: source.details!.sha256,
            oldText: 'Kosten: 10 EUR', newText: `Kosten: ${price} EUR` });
          expect(rootResult.isError).not.toBe(true);
          expect(rootResult.details?.outcome).toBe('review_required');
          const root = parseProposalToolCreationResultV1(rootResult.details?.proposal);
          const rootRead = await run('read', { path: filePath, source: 'blocks',
            proposal: { contractVersion: 1, proposalId: root.proposalId, expectedScope: root.scope } });
          expect(rootRead.isError).not.toBe(true);
          const basis = parseProposalToolReadResultV1(rootRead.details?.proposal);
          if (basis.source.kind !== 'proposal') throw new Error('An exact parent proposal source is required.');
          const childResult = await run('edit_file', { path: filePath, document: rootRead.details!.document,
            blockId: blocks[2]!.id, expectedSha256: basis.contentSha256, oldText: '5 Tage', newText: `${days} Tage`,
            proposal: { contractVersion: 1, creationKind: 'extends', source: basis.source,
              expectedParentCandidateHash: basis.source.candidateHash, expectedParentCasVersion: basis.source.proposalCasVersion,
              replaces: null, choice: null } });
          expect(childResult.isError).not.toBe(true);
          expect(childResult.details?.outcome).toBe('review_required');
          const child = parseProposalToolCreationResultV1(childResult.details?.proposal);
          expect(child.scope).toEqual(root.scope);
          expect(child.relationships.dependency).toEqual({ proposalId: root.proposalId, candidateHash: root.candidateHash });
          expect(await content()).toBe(INITIAL);
          return { root, child, source, blocks };
        };
        const old = await createPair(12, 3);
        const oldLineage = { kind: 'lineage' as const, workspaceId: target.workspaceId, lineageId: old.root.scope.lineageId };
        const originalTimeline = await timeline(target);
        expect(originalTimeline.policy).toMatchObject({ requestedMode: 'review_required', effectiveMode: 'review_required' });
        const originalReview = await review(target, old.child.operationId);
        expect(originalReview.status).toBe('clean');
        expect(originalReview.actions.accept).toBeTruthy();
        const oldLink = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target: oldLineage,
          selectedEntry: { kind: 'agent_operation', id: old.child.operationId }, initialView: 'reviews', source: 'deep_link' });
        await page.goto(oldLink);
        await expect(page.getByTestId('graph-review-comparison').getByText('Ready to apply', { exact: true })).toBeVisible();
        await page.goto('about:blank');
        const removed = await context.request.delete('/api/files/delete', { headers, data: { path: filePath } });
        expect(removed.ok()).toBeTruthy();
        const deletion = await removed.json() as { deleted: string[]; failed: unknown[]; trashEntries: Array<{ id: string; originalPath: string }> };
        expect(deletion.deleted).toEqual([filePath]);
        expect(deletion.failed).toEqual([]);
        expect(deletion.trashEntries).toHaveLength(1);
        expect(deletion.trashEntries[0]!.originalPath).toBe(filePath);
        await uploadWorkspaceTextFile({ request: context.request, workspaceId: target.workspaceId, filePath, content: INITIAL });
        await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`);
        const policy = page.getByRole('switch', {
          name: /Require review for agent changes|Edit directly when safe|Review für Agentenänderungen erforderlich|Direkt bearbeiten, wenn sicher/u,
        });
        await expect(page.getByText('The linked document is no longer available. Select the current file in the file browser.',
          { exact: true })).toBeVisible();
        await expect(policy).toHaveCount(0);
        await info.attach('ordinary-recreate-pinned-tab.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        // A restored tab must keep its original identity. Only this explicit file
        // selection is allowed to open a new document at the reused path.
        await page.getByRole('treeitem', { name: filePath.replace(/\.md$/u, ''), exact: true }).click();
        await expect(policy).not.toBeChecked({ timeout: 30_000 });
        const session = await context.request.post('/api/files/collaboration/session', {
          headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
        });
        expect(session.ok()).toBeTruthy();
        const recreated = await session.json() as { documentId: string; representation: string };
        expect(recreated.documentId).toBeTruthy();
        expect(recreated.documentId).not.toBe(target.documentId);
        expect(recreated.representation).toBe('tiptap_blocks');
        const newTarget = { kind: 'document' as const, workspaceId: target.workspaceId, documentId: recreated.documentId };
        const freshTimeline = await timeline(newTarget);
        expect(freshTimeline.document.path).toBe(filePath);
        expect(freshTimeline.document.lineageId).not.toBe(old.root.scope.lineageId);
        expect(freshTimeline.policy).toMatchObject({ requestedMode: 'safe_direct', effectiveMode: 'safe_direct',
          revision: 0, reason: 'default_safe_direct' });
        expect(freshTimeline.entries.filter(entry => entry.kind === 'agent_operation')).toEqual([]);
        const freshRevisions = freshTimeline.entries.filter(entry => entry.kind === 'revision');
        expect(freshRevisions).toHaveLength(1);
        expect(originalTimeline.entries.some(entry => entry.id === freshRevisions[0]!.id)).toBe(false);
        const assertOldIdentityDenied = async () => {
          for (const oldTarget of [target, oldLineage]) {
            const response = await timelineRequest(oldTarget);
            expect(response.status()).toBe(404);
            expect((await response.json()).error.code).toBe(FileCodes.notFound);
          }
          const oldAccept = await context.request.post(ACTION_PATH, { headers,
            data: { contractVersion: 1, target, action: { contractVersion: 1,
              ...originalReview.actions.accept!, idempotencyKey: randomUUID(), creation: null } } });
          expect(oldAccept.status()).toBe(404);
          expect((await oldAccept.json()).error.code).toBe(FileCodes.notFound);
          const crossAccept = await context.request.post(ACTION_PATH, { headers,
            data: { contractVersion: 1, target: newTarget, action: { contractVersion: 1,
              ...originalReview.actions.accept!, idempotencyKey: randomUUID(), creation: null } } });
          expect(crossAccept.status()).toBe(400);
          expect((await crossAccept.json()).error.code).toBe(Codes.scopeMismatch);
          const oldOperation = await context.request.post(REVIEW_PATH, { headers,
            data: { contractVersion: 1, target: newTarget, selection: { kind: 'operation', operationId: old.child.operationId } } });
          expect(oldOperation.status()).toBe(404);
          expect((await oldOperation.json()).error.code).toBe(Codes.sourceInvalid);
        };
        await assertOldIdentityDenied();
        expect(await content()).toBe(INITIAL);
        await page.goto(oldLink);
        await expect(page.getByTestId('file-version-center').getByRole('alert')).toContainText('Document history could not be loaded.');
        await expect(page.getByTestId('graph-review-comparison')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
        await info.attach('ordinary-recreate-old-link.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        await page.goto(buildFileVersionCenterDeepLinkV1('/en', {
          contractVersion: 1, target: newTarget, initialView: 'reviews', source: 'deep_link',
        }));
        await expect(page.getByText('No agent changes need review.', { exact: true })).toBeVisible();
        await expect(page.getByTestId('graph-review-comparison')).toHaveCount(0);
        await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`);
        await expect(policy).not.toBeChecked({ timeout: 30_000 });
        await policy.click();
        await expect(policy).toBeChecked();
        const fresh = await createPair(14, 2);
        expect(fresh.root.scope.documentId).toBe(newTarget.documentId);
        expect(fresh.root.scope.lineageId).toBe(freshTimeline.document.lineageId);
        expect(fresh.source.details!.sha256).toBe(old.source.details!.sha256);
        expect(fresh.blocks.every(block => !old.blocks.some(previous => previous.id === block.id))).toBe(true);
        expect(new Set([old.root.proposalId, old.child.proposalId, fresh.root.proposalId, fresh.child.proposalId]).size).toBe(4);
        const ready = await review(newTarget, fresh.child.operationId);
        expect(ready.status).toBe('clean');
        expect(ready.context?.applyProposalIds).toEqual([fresh.root.proposalId, fresh.child.proposalId]);
        expect((await timeline(newTarget)).entries.filter(entry => entry.kind === 'agent_operation').map(entry => entry.id).sort())
          .toEqual([fresh.root.operationId, fresh.child.operationId].sort());
        expect((await timeline(newTarget)).entries.filter(entry => entry.kind === 'revision')).toHaveLength(1);
        await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target: newTarget,
          selectedEntry: { kind: 'agent_operation', id: fresh.child.operationId }, initialView: 'reviews', source: 'deep_link' }));
        const graph = page.getByTestId('graph-review-comparison');
        await expect(graph.getByText('Ready to apply', { exact: true })).toBeVisible();
        await expect(graph.getByTestId('graph-review-context')).toContainText('1 prerequisite included');
        await info.attach('ordinary-recreate-fresh-review.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        let actionPosts = 0;
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
        });
        await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
        const pending = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === ACTION_PATH);
        await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
        const accepted = await pending;
        expect(accepted.ok()).toBeTruthy();
        const receipt = await accepted.json() as ProposalActionReceiptV1;
        expect(receipt.phase).toBe('succeeded');
        expect(receipt.affectedProposalIds).toEqual([fresh.root.proposalId, fresh.child.proposalId]);
        expect(receipt.result?.resolutions).toEqual([
          { proposalId: fresh.root.proposalId, lifecycle: 'included' }, { proposalId: fresh.child.proposalId, lifecycle: 'applied' },
        ]);
        expect(await content()).toBe(FINAL);
        const retry = await context.request.post(ACTION_PATH, { headers, data: accepted.request().postDataJSON() });
        expect(retry.ok()).toBeTruthy();
        expect(await retry.json()).toEqual(receipt);
        await assertOldIdentityDenied();
        expect(await content()).toBe(FINAL);
        expect((await timeline(newTarget)).entries.filter(entry => entry.kind === 'revision')).toHaveLength(2);
        const live = await run('read', { path: filePath, source: 'blocks' });
        expect(live.isError).not.toBe(true);
        expect(live.details?.document).toEqual(fresh.source.details!.document);
        expect(live.details?.structure?.blocks.map(block => [block.id, block.text])).toEqual([
          [fresh.blocks[0]!.id, 'Versand'], [fresh.blocks[1]!.id, 'Kosten: 14 EUR'], [fresh.blocks[2]!.id, 'Lieferzeit: 2 Tage'],
        ]);
        expect(actionPosts).toBe(1);
        const terminal = await review(newTarget, fresh.child.operationId);
        expect(terminal.context?.proposals.find(entry => entry.proposalId === fresh.child.proposalId)?.lifecycle).toBe('applied');
        expect(terminal.actions).toEqual({});
        await info.attach('ordinary-recreate-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, filePath, oldTarget: target, oldLineage, oldLink, newTarget,
          newLineageId: fresh.root.scope.lineageId, defaultPolicy: freshTimeline.policy, trashEntryId: deletion.trashEntries[0]!.id,
          oldProposalIds: [old.root.proposalId, old.child.proposalId], freshProposalIds: [fresh.root.proposalId, fresh.child.proposalId],
          oldBlockIds: old.blocks.map(block => block.id), freshBlockIds: fresh.blocks.map(block => block.id),
          finalText: FINAL, actionPosts, beforeRevisionCount: 1, afterRevisionCount: 2, receipt,
        }, null, 2) });
      }, { workspaceKind });
    });
  });
}
