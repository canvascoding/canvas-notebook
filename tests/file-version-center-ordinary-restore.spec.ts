import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { FileVersionCenterSelectionV1, FileVersionRestoreRequestV1, FileVersionRestoreResponseV1,
  FileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const AFTER_PARENT = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 100 EUR\n\nLieferzeit: 5 Tage\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';
const RESTORE_PATH = '/api/files/version-center/v1/restore';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary proposal prerequisite restore (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    for (const roundtrip of [false, true]) {
      test(`${roundtrip ? 'restored equal text' : 'restored original version'} cannot resurrect the child prerequisite`, async ({ browser }, info) => {
        test.setTimeout(240_000);
        await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
          agentContext, content, revisionCount }) => {
          page.setDefaultTimeout(20_000);
          expect(representation).toBe('tiptap_blocks');
          const headers = { 'x-canvas-workspace-id': target.workspaceId };
          const timeline = async () => {
            const response = await context.request.post('/api/files/version-center/v1/resolve', {
              headers, data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
            });
            expect(response.ok()).toBeTruthy();
            return await response.json() as FileVersionTimelineResponseV1;
          };
          const start = await timeline();
          const originals = start.entries.filter(entry => entry.kind === 'revision');
          expect(originals).toHaveLength(1);
          const original = originals[0]!;
          expect(original.restorable).toBe(true);
          const before = await revisionCount();
          const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
            runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-restore-${randomUUID()}`, params, context: agentContext });
          const source = await run('read', { path: filePath, source: 'blocks' });
          expect(source.isError).not.toBe(true);
          expect(source.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
          const parentResult = await run('edit_file', { path: filePath, expectedSha256: source.details!.sha256,
            oldText: 'Kosten: 10 EUR', newText: 'Kosten: 12 EUR\n\nDeckung: 100 EUR' });
          expect(parentResult.isError).not.toBe(true);
          expect(parentResult.details?.outcome).toBe('review_required');
          const parent = parseProposalToolCreationResultV1(parentResult.details?.proposal);
          const parentRead = await run('read', { path: filePath, source: 'blocks',
            proposal: { contractVersion: 1, proposalId: parent.proposalId, expectedScope: parent.scope } });
          expect(parentRead.isError).not.toBe(true);
          const parentSource = parseProposalToolReadResultV1(parentRead.details?.proposal);
          expect(parentSource.source.kind).toBe('proposal');
          if (parentSource.source.kind !== 'proposal') throw new Error('The child must retain its exact parent source.');
          expect(parentRead.details?.structure?.blocks.map(block => block.text))
            .toEqual(['Versand', 'Kosten: 12 EUR', 'Deckung: 100 EUR', 'Lieferzeit: 5 Tage']);
          const insuranceId = parentRead.details!.structure!.blocks[2]!.id;
          const childResult = await run('edit_file', { path: filePath, document: parentRead.details!.document,
            blockId: insuranceId, expectedSha256: parentSource.contentSha256, oldText: '100 EUR', newText: '150 EUR',
            proposal: { contractVersion: 1, creationKind: 'extends', source: parentSource.source,
              expectedParentCandidateHash: parentSource.source.candidateHash,
              expectedParentCasVersion: parentSource.source.proposalCasVersion, replaces: null, choice: null } });
          expect(childResult.isError).not.toBe(true);
          expect(childResult.details?.outcome).toBe('review_required');
          const child = parseProposalToolCreationResultV1(childResult.details?.proposal);
          expect(child.relationships.dependency).toEqual({ proposalId: parent.proposalId, candidateHash: parent.candidateHash });
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(before);
          const link = (selectedEntry: FileVersionCenterSelectionV1) => buildFileVersionCenterDeepLinkV1('/en', {
            contractVersion: 1, target, selectedEntry, initialView: selectedEntry.kind === 'revision' ? 'history' : 'reviews', source: 'deep_link',
          });
          const review = async (operationId: string) => {
            const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
              headers, data: { contractVersion: 1, target, selection: { kind: 'operation', operationId } },
            });
            expect(response.ok()).toBeTruthy();
            const session = await response.json() as ProposalReviewSessionResponseV1;
            expect(session.mode).toBe('graph');
            if (session.mode !== 'graph') throw new Error('Ordinary dependency restore requires graph review.');
            return session;
          };
          let actionPosts = 0;
          let restorePosts = 0;
          page.on('request', request => {
            if (request.method() !== 'POST') return;
            const pathname = new URL(request.url()).pathname;
            if (pathname === ACTION_PATH) actionPosts += 1;
            if (pathname === RESTORE_PATH) restorePosts += 1;
          });
          await page.goto(link({ kind: 'agent_operation', id: parent.operationId }));
          const graph = page.getByTestId('graph-review-comparison');
          await expect(graph.getByText('Ready to apply', { exact: true })).toBeVisible({ timeout: 30_000 });
          await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
          const acceptedResponse = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === ACTION_PATH);
          await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
          const accepted = await acceptedResponse;
          expect(accepted.ok()).toBeTruthy();
          const receipt = await accepted.json() as ProposalActionReceiptV1;
          expect(receipt.phase).toBe('succeeded');
          expect(receipt.result?.resolutions).toEqual([{ proposalId: parent.proposalId, lifecycle: 'applied' }]);
          expect(await content()).toBe(AFTER_PARENT);
          expect(await revisionCount()).toBe(before + 1);
          const parentRevisionId = receipt.result!.revisionId!;
          const ready = await review(child.operationId);
          expect(ready.status).toBe('clean_rebased');
          expect(ready.context?.applyProposalIds).toEqual([child.proposalId]);
          expect(ready.actions.accept).toBeTruthy();
          const staleRequest = { contractVersion: 1, target, action: { contractVersion: 1,
            ...ready.actions.accept!, idempotencyKey: randomUUID(), creation: null } };
          const restores: FileVersionRestoreResponseV1[] = [];
          const restore = async (revisionId: string, expectedContent: string) => {
            await page.goto(link({ kind: 'revision', id: revisionId }));
            await page.getByRole('button', { name: 'Restore version', exact: true }).click();
            const pending = page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === RESTORE_PATH);
            await page.getByRole('button', { name: 'Restore as new version', exact: true }).click();
            const response = await pending;
            expect(response.ok()).toBeTruthy();
            const restored = await response.json() as FileVersionRestoreResponseV1;
            expect(restored.outcome).toBe('restored');
            expect(restored.restoredRevisionId).not.toBe(revisionId);
            expect(await content()).toBe(expectedContent);
            restores.push(restored);
            expect(await revisionCount()).toBe(before + 1 + restores.length);
            const retry = await context.request.post(RESTORE_PATH, {
              headers, data: response.request().postDataJSON() as FileVersionRestoreRequestV1,
            });
            expect(retry.ok()).toBeTruthy();
            expect(await retry.json()).toEqual({ ...restored, outcome: 'already_restored' });
            expect(await revisionCount()).toBe(before + 1 + restores.length);
            return restored;
          };
          const assertLost = async () => {
            const lost = await review(child.operationId);
            expect(lost.selectedProposalIds).toEqual([child.proposalId]);
            expect(lost.status).toBe('prerequisite_lost');
            expect(lost.diagnosis.reasonCode).toBe(Codes.prerequisiteLost);
            expect(lost.actions.accept).toBeUndefined();
            expect(lost.context?.proposals.find(item => item.proposalId === parent.proposalId)?.lifecycle).toBe('applied');
            expect(lost.context?.proposals.find(item => item.proposalId === child.proposalId)?.lifecycle).toBe('open');
            await page.goto(link({ kind: 'agent_operation', id: child.operationId }));
            await expect(graph.getByTestId('graph-review-blocked').getByText('Required basis is missing', { exact: true }))
              .toBeVisible({ timeout: 30_000 });
            await expect(graph.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
            await expect(page.getByText('This comparison is no longer current', { exact: true })).toHaveCount(0);
            return lost;
          };
          await restore(original.revisionId, INITIAL);
          await assertLost();
          const stale = await context.request.post(ACTION_PATH, { headers, data: staleRequest });
          expect(stale.status()).toBe(409);
          expect((await stale.json()).error.code).toBe(Codes.currentChanged);
          expect(await content()).toBe(INITIAL);
          expect(await revisionCount()).toBe(before + 2);
          if (roundtrip) {
            await restore(parentRevisionId, AFTER_PARENT);
            await assertLost();
          }
          const live = await run('read', { path: filePath, source: 'blocks' });
          expect(live.isError).not.toBe(true);
          expect(live.details?.document).toEqual(source.details!.document);
          expect(live.details?.structure?.nextOffset).toBeNull();
          expect(live.details?.structure?.blocks.map(block => block.text)).toEqual(roundtrip
            ? ['Versand', 'Kosten: 12 EUR', 'Deckung: 100 EUR', 'Lieferzeit: 5 Tage']
            : ['Versand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage']);
          expect(live.details!.structure!.blocks.map(block => block.id)).not.toContain(insuranceId);
          expect(await content()).toBe(roundtrip ? AFTER_PARENT : INITIAL);
          expect(await revisionCount()).toBe(before + (roundtrip ? 3 : 2));
          expect(actionPosts).toBe(1);
          expect(restorePosts).toBe(roundtrip ? 2 : 1);
          await info.attach('ordinary-restore-prerequisite-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, roundtrip, target, representation, originalRevisionId: original.revisionId, parentRevisionId,
            parentProposalId: parent.proposalId, childProposalId: child.proposalId, originalInsuranceId: insuranceId,
            finalBlockIds: live.details!.structure!.blocks.map(block => block.id),
            expectedFinal: roundtrip ? AFTER_PARENT : INITIAL, actionPosts, restorePosts,
            beforeRevisionCount: before, afterRevisionCount: before + (roundtrip ? 3 : 2),
            status: 'prerequisite_lost', reasonCode: Codes.prerequisiteLost,
            staleAcceptStatus: stale.status(), restores,
          }, null, 2) });
          await info.attach('ordinary-restore-prerequisite.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
        }, { workspaceKind });
      });
    }
  });
}
