import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewActionApiRequestV1, ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool as runTool, type OrdinaryAgentToolDetails as ToolDetails } from './helpers/ordinary-agent-tool';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const BASE_TEXT = '# Ordinary agent edits\n\nA0|B0|C0|D0|E0|F0|G0|H0|I0|J0\n';
const FINAL_TEXT = '# Ordinary agent edits\n\nA1|B1|C1|D1|E1|F1|G1|H1|I1|J1\n';

for (const workspaceKind of ['personal', 'team'] as const) test.describe(`Ordinary Markdown tools through the proposal graph (${workspaceKind})`, () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');

  for (const order of ['p1-q', 'q-p1', 'batch'] as const) test(`independent shipping proposals ${order} preserve inserted paragraphs and the other effect`, async ({ browser }, info) => {
    test.setTimeout(180_000);
    const initial = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
    const afterP1 = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 100 EUR\n\nLieferzeit: 5 Tage\n';
    const afterQ = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 3 Tage\n';
    const final = '# Versand\n\nKosten: 12 EUR\n\nDeckung: 100 EUR\n\nLieferzeit: 3 Tage\n';
    await withOrdinaryAgentDocument(browser, initial, async ({ context, page, filePath, target, representation,
      agentContext, content, revisionCount }) => {
      expect(representation).toBe('tiptap_blocks');
      const before = await revisionCount();
      const source = await runTool({ toolName: 'read', toolCallId: `shipping-read-${randomUUID()}`,
        params: { path: filePath, source: 'blocks' }, context: agentContext });
      expect(source.isError).not.toBe(true);
      expect(source.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(source.details?.collaboration).toMatchObject({ documentId: target.documentId,
        representation: 'tiptap_blocks', source: 'live_yjs' });
      expect(source.details?.structure?.nextOffset).toBeNull();
      const originalBlocks = source.details!.structure!.blocks;
      expect(originalBlocks.map(block => [block.type, block.text])).toEqual([
        ['heading', 'Versand'], ['paragraph', 'Kosten: 10 EUR'], ['paragraph', 'Lieferzeit: 5 Tage'],
      ]);
      let insuranceBlockId: string | undefined;
      const proposals: Array<NonNullable<ToolDetails['proposal']>> = [];
      for (const edit of [
        { oldText: 'Kosten: 10 EUR', newText: 'Kosten: 12 EUR\n\nDeckung: 100 EUR' },
        { oldText: 'Lieferzeit: 5 Tage', newText: 'Lieferzeit: 3 Tage' },
      ]) {
        const result = await runTool({ toolName: 'edit_file', toolCallId: `shipping-edit-${randomUUID()}`,
          params: { path: filePath, expectedSha256: source.details!.sha256, ...edit }, context: agentContext });
        expect(result.isError).not.toBe(true);
        expect(result.details?.proposal).toMatchObject({ creationKind: 'independent', source: { kind: 'authoritative' } });
        expect(result.details?.collaboration).toMatchObject({ reviewRequired: true, operationStatus: 'needs_review', durability: 'not_applied' });
        proposals.push(result.details!.proposal!);
      }
      expect(proposals[0]!.proposalId).not.toBe(proposals[1]!.proposalId);
      expect(await content()).toBe(initial);
      expect(await revisionCount()).toBe(before);
      const headers = { 'x-canvas-workspace-id': target.workspaceId };
      const review = async (selected: NonNullable<ToolDetails['proposal']>) => {
        const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
          headers, data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: selected.operationId } },
        });
        expect(response.ok()).toBeTruthy();
        const session = await response.json() as ProposalReviewSessionResponseV1;
        expect(session.mode).toBe('graph');
        if (session.mode !== 'graph') throw new Error('An ordinary shipping proposal must use graph review.');
        expect(session.selectedProposalIds).toEqual([selected.proposalId]);
        return session;
      };
      let actionPosts = 0;
      page.on('request', request => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname === '/api/files/version-center/v1/proposals/actions') actionPosts += 1;
      });
      const selectedOrder = order === 'q-p1' ? [proposals[1]!, proposals[0]!]
        : order === 'p1-q' ? proposals : [proposals[0]!];
      const receipts: Array<{ actionType: string; affectedProposalIds: string[] }> = [];
      for (const [index, selected] of selectedOrder.entries()) {
        const session = await review(selected);
        expect(session.status).toBe(index === 0 ? 'clean' : 'clean_rebased');
        expect(session.context?.dependencyProposalIds).toEqual([]);
        expect(session.context?.applyProposalIds).toEqual([selected.proposalId]);
        const changed = session.compare!.hunks.flatMap(hunk => hunk.lines)
          .filter(line => line.kind !== 'context').map(line => [line.kind, line.text]);
        if (selected.proposalId === proposals[1]!.proposalId) {
          expect(changed).toEqual([['deletion', 'Lieferzeit: 5 Tage'], ['addition', 'Lieferzeit: 3 Tage']]);
        } else {
          expect(changed).toContainEqual(['deletion', 'Kosten: 10 EUR']);
          expect(changed).toContainEqual(['addition', 'Kosten: 12 EUR']);
          expect(changed).toContainEqual(['addition', 'Deckung: 100 EUR']);
          expect(changed.some(([, line]) => line.startsWith('Lieferzeit:'))).toBe(false);
        }
        await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
          selectedEntry: { kind: 'agent_operation', id: selected.operationId }, initialView: 'reviews', source: 'deep_link' }));
        const graph = page.getByTestId('graph-review-comparison');
        await expect(graph.getByText(index === 0 ? 'Ready to apply' : 'Ready after rebase', { exact: true }))
          .toBeVisible({ timeout: 30_000 });
        if (order === 'batch') {
          await graph.getByRole('button', { name: 'Review all changes', exact: true }).click();
          await expect(graph).toContainText('2 proposals selected');
          await expect(graph.getByTestId('graph-review-hunks')).toContainText('Deckung: 100 EUR');
          await expect(graph.getByTestId('graph-review-hunks')).toContainText('Lieferzeit: 3 Tage');
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
        expect([...receipt.affectedProposalIds].sort()).toEqual((order === 'batch'
          ? proposals.map(proposal => proposal.proposalId) : [selected.proposalId]).sort());
        receipts.push(receipt);
        expect(await content()).toBe(order === 'batch' || index === 1 ? final : order === 'p1-q' ? afterP1 : afterQ);
        expect(await revisionCount()).toBe(before + index + 1);
        const live = await runTool({ toolName: 'read', toolCallId: `shipping-live-${randomUUID()}`,
          params: { path: filePath, source: 'blocks' }, context: agentContext });
        expect(live.isError).not.toBe(true);
        expect(live.details?.document).toEqual(source.details!.document);
        expect(live.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
        expect(live.details?.structure?.nextOffset).toBeNull();
        const blocks = live.details!.structure!.blocks;
        const hasP1 = order !== 'q-p1' || index === 1;
        const hasQ = order !== 'p1-q' || index === 1;
        if (hasP1) {
          const insurance = blocks.find(block => block.text === 'Deckung: 100 EUR');
          expect(insurance?.type).toBe('paragraph');
          insuranceBlockId ??= insurance!.id;
          expect(insurance!.id).toBe(insuranceBlockId);
        }
        expect(blocks.map(block => [block.id, block.text])).toEqual([
          [originalBlocks[0]!.id, 'Versand'],
          [originalBlocks[1]!.id, hasP1 ? 'Kosten: 12 EUR' : 'Kosten: 10 EUR'],
          ...(hasP1 ? [[insuranceBlockId, 'Deckung: 100 EUR']] : []),
          [originalBlocks[2]!.id, hasQ ? 'Lieferzeit: 3 Tage' : 'Lieferzeit: 5 Tage'],
        ]);
        const decided = await review(selected);
        expect(decided.context?.proposals.find(proposal => proposal.proposalId === selected.proposalId)?.lifecycle).toBe('applied');
        expect(decided.actions.accept).toBeUndefined();
      }
      for (const selected of proposals) {
        const decided = await review(selected);
        expect(decided.context?.proposals.find(proposal => proposal.proposalId === selected.proposalId)?.lifecycle).toBe('applied');
        expect(decided.actions.accept).toBeUndefined();
      }
      expect(actionPosts).toBe(order === 'batch' ? 1 : 2);
      expect(await content()).toBe(final);
      expect(await revisionCount()).toBe(before + (order === 'batch' ? 1 : 2));
      const completed = page.getByRole('dialog', { name: 'Versions & changes' });
      await expect(completed.getByRole('region', { name: 'Agent reviews', exact: true }))
        .toContainText('No agent changes need review.', { timeout: 30_000 });
      await expect(completed.getByRole('heading', { name: 'Current version', exact: true })).toBeVisible();
      await expect(completed.getByRole('button', { name: /^Current version Current/u }))
        .toHaveAttribute('aria-pressed', 'true');
      await info.attach('ordinary-shipping-evidence.json', { contentType: 'application/json', body: JSON.stringify({
        workspaceKind, order, target, filePath, representation, proposals, expected: final,
        originalBlockIds: originalBlocks.map(block => block.id), insuranceBlockId,
        beforeRevisionCount: before, afterRevisionCount: before + (order === 'batch' ? 1 : 2), actionPosts,
        receipts: receipts.map(receipt => ({ actionType: receipt.actionType, affectedProposalIds: receipt.affectedProposalIds })),
      }, null, 2) });
      await info.attach('ordinary-shipping-final.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
    }, { workspaceKind });
  });

  test('ten ordinary edit_file roots: three singles then seven in one batch preserve exact content and four revisions', async ({ browser }, info) => {
    test.setTimeout(240_000);
    await withOrdinaryAgentDocument(browser, BASE_TEXT, async ({ page, filePath, agentContext, target, content, revisionCount }) => {
      expect(await content()).toBe(BASE_TEXT);
      const beforeRevisionCount = await revisionCount();
      const read = await runTool({ toolName: 'read', toolCallId: `ordinary-read-${randomUUID()}`,
        params: { path: filePath }, context: agentContext });
      expect(read.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const proposals: Array<{ operationId: string; proposalId: string }> = [];
      let firstIntent: Parameters<typeof runTool>[0] | undefined;
      for (const label of 'ABCDEFGHIJ') {
        const intent: Parameters<typeof runTool>[0] = { toolName: 'edit_file', toolCallId: `ordinary-edit-${randomUUID()}`,
          params: { path: filePath, expectedSha256: read.details!.sha256, oldText: `${label}0`, newText: `${label}1` },
          context: agentContext };
        firstIntent ??= intent;
        const edited = await runTool(intent);
        expect(edited.isError).not.toBe(true);
        expect(edited.details?.collaboration).toMatchObject({ reviewRequired: true,
          operationStatus: 'needs_review', durability: 'not_applied' });
        expect(edited.details?.proposal).toMatchObject({ creationKind: 'independent', source: { kind: 'authoritative' } });
        expect(edited.details!.proposal!.operationId).toBe(edited.details!.collaboration!.operationId);
        proposals.push(edited.details!.proposal!);
      }
      expect(new Set(proposals.map(item => item.proposalId)).size).toBe(10);
      expect(await content()).toBe(BASE_TEXT);
      expect(await revisionCount()).toBe(beforeRevisionCount);
      const receipts: Array<{ actionType: string; phase: string; affectedProposalIds: string[] }> = [];
      // Use a non-prefix order to expose index/offset-dependent acceptance bugs.
      for (const [round, selected] of [proposals[7]!, proposals[2]!, proposals[0]!, proposals[9]!].entries()) {
        await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
          selectedEntry: { kind: 'agent_operation', id: selected.operationId }, initialView: 'reviews', source: 'deep_link' }));
        const graph = page.getByTestId('graph-review-comparison');
        await expect(graph).toBeVisible({ timeout: 30_000 });
        if (round === 3) {
          await graph.getByRole('button', { name: 'Review all changes' }).click();
          await expect(graph).toContainText('7 proposals selected');
        }
        await expect(graph.getByText('Ready to apply').or(graph.getByText('Ready after rebase'))).toBeVisible();
        await graph.getByRole('button', { name: round === 3 ? 'Accept all changes' : 'Accept change', exact: true }).click();
        const pending = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
        await graph.getByRole('button', { name: 'Confirm action' }).click();
        const response = await pending;
        expect(response.ok()).toBeTruthy();
        const receipt = await response.json();
        expect(receipt.phase).toBe('succeeded');
        expect(receipt.result?.kind).toBe('content_changed');
        expect(receipt.actionType).toBe(round === 3 ? 'batch_accept' : 'accept');
        const expectedIds = round === 3
          ? proposals.filter((_proposal, index) => ![7, 2, 0].includes(index)).map(proposal => proposal.proposalId)
          : [selected.proposalId];
        expect([...receipt.affectedProposalIds].sort()).toEqual(expectedIds.sort());
        receipts.push(receipt);
      }
      expect(await content()).toBe(FINAL_TEXT);
      expect(await revisionCount()).toBe(beforeRevisionCount + 4);
      // Retry the original intent after current advanced: preserve identity and
      // historical receipt instead of matching the now-missing A0 again.
      const retry = await runTool(firstIntent!);
      expect(retry.details?.proposal?.proposalId).toBe(proposals[0]!.proposalId);
      expect(retry.details?.collaboration?.operationId).toBe(proposals[0]!.operationId);
      expect(retry.details?.collaboration?.reviewRequired).toBe(false);
      expect(retry.details?.outcome).toBe('unchanged');
      // This separate real tool process has its feature gate off. The running
      // server remains unchanged; this is not a server-restart rollback test.
      const offRetry = await runTool(firstIntent!, { graphMode: 'off' });
      expect(offRetry.isError).not.toBe(true);
      expect(offRetry.details?.proposal?.proposalId).toBe(proposals[0]!.proposalId);
      expect(offRetry.details?.collaboration?.operationId).toBe(proposals[0]!.operationId);
      expect(offRetry.details?.collaboration?.reviewRequired).toBe(false);
      expect(offRetry.details?.outcome).toBe('unchanged');
      const changedRetry = await runTool({ ...firstIntent!, params: { ...firstIntent!.params, newText: 'A2' } },
        { graphMode: 'off' });
      expect(changedRetry.isError).toBe(true);
      expect(changedRetry.details?.code).toBe('PROPOSAL_IDEMPOTENCY_MISMATCH');
      expect(await content()).toBe(FINAL_TEXT);
      expect(await revisionCount()).toBe(beforeRevisionCount + 4);
      await info.attach('ordinary-tool-graph-evidence.json', { contentType: 'application/json',
        body: JSON.stringify({ workspaceKind, filePath, target, proposals, expected: FINAL_TEXT,
          beforeRevisionCount, afterRevisionCount: beforeRevisionCount + 4,
          actionTypes: receipts.map(receipt => receipt.actionType) }, null, 2) });
      await info.attach('ordinary-tool-graph-final.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
    }, { workspaceKind });
  });

  test('ordinary write and ten-edit apply_patch preserve Markdown and apply only after review', async ({ browser }, info) => {
    test.setTimeout(180_000);
    const initial = [
      '---', 'title: Ordinary tool matrix', 'tags:', '  - qa', '---',
      '# A0 – Werkzeugprüfung', '', '**B0** mit Umlaut ä und Emoji 🧪.', '',
      '- [ ] C0', '- D0', '', '1. E0', '', '> F0', '',
      '[Link G0](https://example.invalid/docs)', '', '`H0`', '',
      '```text', 'I0', '```', '', '| Spalte |', '| --- |', '| J0 |', '',
    ].join('\n');
    const rewritten = initial.replace('title: Ordinary tool matrix', 'title: Ordinary tool matrix reviewed')
      + '\n## Nachtrag\n\nNur über write.\n';
    const final = rewritten.replace(/([A-J])0/gu, (_match, letter: string) => `${letter}1`);
    await withOrdinaryAgentDocument(browser, initial, async ({ context, page, filePath, agentContext, target,
      representation, content, revisionCount }) => {
      expect(await content()).toBe(initial);
      const before = await revisionCount();
      const read = () => runTool({ toolName: 'read', toolCallId: `ordinary-read-${randomUUID()}`,
        params: { path: filePath }, context: agentContext });
      const proposalIds: string[] = [];
      const accept = async (proposal: NonNullable<ToolDetails['proposal']>) => {
        proposalIds.push(proposal.proposalId);
        await page.goto(buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
          selectedEntry: { kind: 'agent_operation', id: proposal.operationId }, initialView: 'reviews', source: 'deep_link' }));
        const graph = page.getByTestId('graph-review-comparison');
        await expect(graph).toBeVisible({ timeout: 30_000 });
        await expect(graph.getByText('Ready to apply').or(graph.getByText('Ready after rebase'))).toBeVisible();
        await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
        const pending = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
        await graph.getByRole('button', { name: 'Confirm action' }).click();
        const response = await pending;
        expect(response.ok()).toBeTruthy();
        const receipt = await response.json();
        expect(receipt.phase).toBe('succeeded');
        expect(receipt.result?.kind).toBe('content_changed');
        expect(receipt.affectedProposalIds).toEqual([proposal.proposalId]);
      };
      const assertOpen = (details: ToolDetails | undefined) => {
        expect(details?.outcome).toBe('review_required');
        expect(details?.collaboration).toMatchObject({ reviewRequired: true,
          operationStatus: 'needs_review', durability: 'not_applied' });
        expect(details?.proposal).toMatchObject({ creationKind: 'independent', source: { kind: 'authoritative' } });
      };
      const source = await read();
      const writeIntent: Parameters<typeof runTool>[0] = { toolName: 'write', toolCallId: `ordinary-write-${randomUUID()}`,
        params: { path: filePath, content: rewritten, expectedSha256: source.details!.sha256 }, context: agentContext };
      const written = await runTool(writeIntent);
      expect(written.isError).not.toBe(true);
      assertOpen(written.details);
      expect(await content()).toBe(initial);
      expect(await revisionCount()).toBe(before);
      await accept(written.details!.proposal!);
      expect(await content()).toBe(rewritten);
      expect(await revisionCount()).toBe(before + 1);

      const patchSource = await read();
      const edits = [...'ABCDEFGHIJ'].map(letter => ({ oldText: `${letter}0`, newText: `${letter}1` }));
      const operations = async () => {
        const response = await context.request.post('/api/files/version-center/v1/resolve', {
          headers: { 'x-canvas-workspace-id': target.workspaceId },
          data: { contractVersion: 1, target, initialView: 'reviews', source: 'deep_link' },
        });
        expect(response.ok()).toBeTruthy();
        return ((await response.json()).entries as Array<{ kind: string; id: string }>)
          .filter(entry => entry.kind === 'agent_operation').map(entry => entry.id).sort();
      };
      const beforeInvalid = await operations();
      // All earlier edits are valid. Failure of the final edit must not create
      // an operation, a partial content change or a history revision.
      const invalid = await runTool({ toolName: 'apply_patch', toolCallId: `ordinary-invalid-${randomUUID()}`,
        params: { files: [{ path: filePath, expectedSha256: patchSource.details!.sha256,
          edits: [...edits.slice(0, 9), { oldText: 'absent-final-target', newText: 'must-not-apply' }] }] }, context: agentContext });
      expect(invalid.isError).toBe(true);
      expect(invalid.details?.code).toBe('EXACT_TEXT_OCCURRENCE_MISMATCH');
      expect(invalid.details?.editIndex).toBe(9);
      expect(await operations()).toEqual(beforeInvalid);
      expect(await content()).toBe(rewritten);
      expect(await revisionCount()).toBe(before + 1);

      const patchIntent: Parameters<typeof runTool>[0] = { toolName: 'apply_patch', toolCallId: `ordinary-patch-${randomUUID()}`,
        params: { files: [{ path: filePath, expectedSha256: patchSource.details!.sha256, edits }] }, context: agentContext };
      const patched = await runTool(patchIntent);
      expect(patched.isError).not.toBe(true);
      expect(patched.details?.results).toHaveLength(1);
      const patchResult = patched.details!.results![0]!;
      assertOpen(patchResult);
      expect(await content()).toBe(rewritten);
      expect(await revisionCount()).toBe(before + 1);
      await accept(patchResult.proposal!);
      expect(await content()).toBe(final);
      expect(await revisionCount()).toBe(before + 2);
      // Both ordinary wrappers preserve their own original identity, even
      // after later content changes and after the tool's graph gate closes.
      for (const intent of [writeIntent, patchIntent]) {
        const retry = await runTool(intent, { graphMode: 'off' });
        expect(retry.isError).not.toBe(true);
        const value = intent.toolName === 'apply_patch' ? retry.details?.results?.[0] : retry.details;
        expect(value?.proposal?.proposalId).toBe(intent.toolName === 'write' ? proposalIds[0] : proposalIds[1]);
        expect(value?.collaboration?.reviewRequired).toBe(false);
        expect(value?.outcome).toBe('unchanged');
      }
      expect(await content()).toBe(final);
      expect(await revisionCount()).toBe(before + 2);
      await info.attach('ordinary-write-patch-evidence.json', { contentType: 'application/json',
        body: JSON.stringify({ workspaceKind, filePath, target, representation, proposalIds, expected: final,
          beforeRevisionCount: before, afterRevisionCount: before + 2, editsInOneProposal: 10 }, null, 2) });
      await info.attach('ordinary-write-patch-final.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
    }, { workspaceKind });
  });

  test('ordinary overlapping siblings: accepting C leaves B open with a concrete conflict, not a timeline error', async ({ browser }, info) => {
    test.setTimeout(120_000);
    const initial = '# Ordinary competing edits\n\nPlan: 100 USD.\n';
    const expected = '# Ordinary competing edits\n\nPlan: 130 USD.\n';
    await withOrdinaryAgentDocument(browser, initial, async ({ context, page, filePath, agentContext, target,
      representation, content, revisionCount }) => {
      const before = await revisionCount();
      const read = await runTool({ toolName: 'read', toolCallId: `ordinary-read-${randomUUID()}`,
        params: { path: filePath }, context: agentContext });
      expect(read.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const proposals: Array<NonNullable<ToolDetails['proposal']>> = [];
      for (const newText of ['120', '130']) {
        const result = await runTool({ toolName: 'edit_file', toolCallId: `ordinary-overlap-${randomUUID()}`,
          params: { path: filePath, expectedSha256: read.details!.sha256, oldText: '100', newText }, context: agentContext });
        expect(result.isError).not.toBe(true);
        expect(result.details?.collaboration).toMatchObject({ reviewRequired: true,
          operationStatus: 'needs_review', durability: 'not_applied' });
        expect(result.details?.proposal).toMatchObject({ creationKind: 'independent', source: { kind: 'authoritative' } });
        proposals.push(result.details!.proposal!);
      }
      const [b, c] = proposals;
      expect(b!.proposalId).not.toBe(c!.proposalId);
      expect(await content()).toBe(initial);
      expect(await revisionCount()).toBe(before);
      let actionPosts = 0;
      page.on('request', request => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname === '/api/files/version-center/v1/proposals/actions') actionPosts += 1;
      });
      const open = (operationId: string) => page.goto(buildFileVersionCenterDeepLinkV1('/en', {
        contractVersion: 1, target, selectedEntry: { kind: 'agent_operation', id: operationId },
        initialView: 'reviews', source: 'deep_link',
      }));
      await open(c!.operationId);
      const graph = page.getByTestId('graph-review-comparison');
      await expect(graph.getByText('Ready to apply')).toBeVisible({ timeout: 30_000 });
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('130');
      await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
      const pending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
      await graph.getByRole('button', { name: 'Confirm action' }).click();
      const response = await pending;
      expect(response.ok()).toBeTruthy();
      const receipt = await response.json();
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.result?.kind).toBe('content_changed');
      expect(receipt.affectedProposalIds).toEqual([c!.proposalId]);
      expect(await content()).toBe(expected);
      expect(await revisionCount()).toBe(before + 1);

      await open(b!.operationId);
      await expect(graph.getByTestId('graph-review-blocked')).toContainText('Conflicting changes', { timeout: 30_000 });
      await expect(graph.getByRole('button', { name: /^Accept (change|all changes)$/u })).toHaveCount(0);
      await expect(graph.getByRole('button', { name: 'Confirm action' })).toHaveCount(0);
      await expect(graph).not.toContainText(/No remaining change|\+0|−0/u);
      await expect(page.getByText('This comparison is no longer current', { exact: true })).toHaveCount(0);
      const bCard = page.locator(`button[data-operation-id="${b!.operationId}"]`);
      await expect(bCard).toHaveAttribute('data-entry-status', 'conflicted');
      const review = await context.request.post('/api/files/version-center/v1/proposals/review', {
        headers: { 'x-canvas-workspace-id': target.workspaceId },
        data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: b!.operationId } },
      });
      expect(review.ok()).toBeTruthy();
      const session = await review.json() as ProposalReviewSessionResponseV1;
      expect(session.mode).toBe('graph');
      if (session.mode !== 'graph') throw new Error('An ordinary conflicting proposal must not fall back to legacy review.');
      expect(session.status).toBe('conflicted');
      expect(session.selectedProposalIds).toEqual([b!.proposalId]);
      expect(session.context?.proposals.find(proposal => proposal.proposalId === b!.proposalId)?.lifecycle).toBe('open');
      expect(session.actions.accept).toBeUndefined();
      expect(session.compare?.candidate.noEffect).not.toBe(true);
      expect(actionPosts).toBe(1);
      expect(await content()).toBe(expected);
      expect(await revisionCount()).toBe(before + 1);
      await info.attach('ordinary-sibling-conflict-evidence.json', { contentType: 'application/json',
        body: JSON.stringify({ workspaceKind, filePath, target, representation,
          acceptedProposalId: c!.proposalId, remainingProposalId: b!.proposalId,
          status: session.status, reasonCode: session.reasonCode, expected,
          beforeRevisionCount: before, afterRevisionCount: before + 1, actionPosts }, null, 2) });
      await info.attach('ordinary-sibling-conflict.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
    }, { workspaceKind });
  });

  for (const otherAction of ['accept', 'reject'] as const) test(`concurrent accept versus ${otherAction} has exactly one decision`, async ({ browser }, info) => {
    test.setTimeout(150_000);
    const initial = '# Concurrent ordinary review\n\nValue: 100\n';
    const accepted = '# Concurrent ordinary review\n\nValue: 130\n';
    const adminIdentity = { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD };
    expect(Boolean(adminIdentity.email && adminIdentity.password), 'Configure the managed bootstrap administrator.').toBe(true);
    const identity = workspaceKind === 'team' ? {
      email: process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL,
      password: process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD,
    } : adminIdentity;
    expect(Boolean(identity.email && identity.password), 'Configure the managed test account.').toBe(true);
    await withOrdinaryAgentDocument(browser, initial, async ({ context, page, filePath, target,
      agentContext, content, revisionCount }) => {
      const other = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } }, adminIdentity);
      const assertOtherErrors = observeProposalReviewServerErrors(other);
      let releaseRequests = () => {};
      try {
        const otherAuthResponse = await other.request.get('/api/auth/get-session');
        expect(otherAuthResponse.ok()).toBeTruthy();
        const otherUserId = (await otherAuthResponse.json()).user.id as string;
        if (workspaceKind === 'team') expect(otherUserId).not.toBe(agentContext.userId);
        else expect(otherUserId).toBe(agentContext.userId);
        await other.addInitScript(id => {
          localStorage.setItem('canvas.activeWorkspaceId', id);
          localStorage.setItem('canvas.notebook.chatVisible', 'false');
        }, target.workspaceId);
        const otherPage = await other.newPage();
        const pages = [page, otherPage];
        const before = await revisionCount();
        const read = await runTool({ toolName: 'read', toolCallId: `race-read-${randomUUID()}`,
          params: { path: filePath }, context: agentContext });
        expect(read.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
        const result = await runTool({ toolName: 'edit_file', toolCallId: `race-edit-${randomUUID()}`,
          params: { path: filePath, expectedSha256: read.details!.sha256, oldText: '100', newText: '130' }, context: agentContext });
        expect(result.isError).not.toBe(true);
        expect(result.details?.collaboration?.reviewRequired).toBe(true);
        const proposal = result.details!.proposal!;
        const href = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
          selectedEntry: { kind: 'agent_operation', id: proposal.operationId }, initialView: 'reviews', source: 'deep_link' });
        for (const view of pages) {
          await view.goto(href);
          const graph = view.getByTestId('graph-review-comparison');
          await expect(graph.getByText('Ready to apply')).toBeVisible({ timeout: 30_000 });
          await expect(graph.getByTestId('graph-review-hunks')).toContainText('130');
        }
        expect(await content()).toBe(initial);
        expect(await revisionCount()).toBe(before);

        // Hold both real POSTs until both independently rendered confirmations
        // have been clicked. Only timing is controlled, never server responses.
        const held: Array<{ index: number; body: ProposalReviewActionApiRequestV1 }> = [];
        const released = new Promise<void>(resolve => { releaseRequests = resolve; });
        const actionPath = '/api/files/version-center/v1/proposals/actions';
        for (const [index, view] of pages.entries()) {
          await view.route(`**${actionPath}`, async route => {
            if (route.request().method() === 'POST') {
              held.push({ index, body: route.request().postDataJSON() as ProposalReviewActionApiRequestV1 });
              await released;
            }
            await route.continue();
          });
          const graph = view.getByTestId('graph-review-comparison');
          await graph.getByRole('button', { name: index === 1 && otherAction === 'reject' ? 'Reject proposal' : 'Accept change', exact: true }).click();
          await expect(graph.getByTestId('graph-review-confirmation')).toBeVisible();
        }
        const responsePromises = pages.map(view => view.waitForResponse(response =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === actionPath));
        await Promise.all(pages.map(view => view.getByTestId('graph-review-comparison')
          .getByRole('button', { name: 'Confirm action', exact: true }).click()));
        await expect.poll(() => held.length).toBe(2);
        expect(new Set(held.map(item => item.body.action.idempotencyKey)).size).toBe(2);
        expect(new Set(held.map(item => item.body.action.fence.graphRevision)).size).toBe(1);
        for (const request of held) {
          expect(request.body.action.fence.selectedProposalIds).toEqual([proposal.proposalId]);
          expect(request.body.action.fence.actionType).toBe(request.index === 1 ? otherAction : 'accept');
        }
        releaseRequests();
        const responses = await Promise.all(responsePromises);
        const outcomes = await Promise.all(responses.map(async (response, index) => {
          const body = await response.json();
          return { index, status: response.status(), receipt: response.ok() ? body as ProposalActionReceiptV1 : null,
            errorCode: response.ok() ? body.errorCode as string | null : body.error?.code as string | undefined };
        }));
        const winners = outcomes.filter(outcome => outcome.receipt?.phase === 'succeeded');
        expect(winners).toHaveLength(1);
        const winner = winners[0]!;
        const receipt = winner.receipt!;
        expect(receipt.affectedProposalIds).toEqual([proposal.proposalId]);
        const loser = outcomes.find(outcome => outcome.index !== winner.index)!;
        expect(loser.status).toBe(409);
        expect(loser.receipt).toBeNull();
        expect([Codes.graphChanged, Codes.recoveryRequired]).toContain(loser.errorCode);
        const rejected = winner.index === 1 && otherAction === 'reject';
        expect(receipt.actionType).toBe(rejected ? 'reject' : 'accept');
        expect(receipt.result?.kind).toBe(rejected ? 'metadata_only' : 'content_changed');
        expect(await content()).toBe(rejected ? initial : accepted);
        expect(await revisionCount()).toBe(before + (rejected ? 0 : 1));

        const losingGraph = pages[loser.index]!.getByTestId('graph-review-comparison');
        await info.attach('ordinary-review-race-before-reload.png', {
          contentType: 'image/png', body: await pages[loser.index]!.screenshot({ fullPage: true }),
        });
        await expect(losingGraph.getByTestId('graph-review-historical-status')).toBeVisible({ timeout: 15_000 });
        await expect(losingGraph.getByTestId('graph-review-pending-action')).toHaveCount(0, { timeout: 15_000 });

        // Each actor must converge to the same terminal, non-actionable proposal
        // after reloading; a losing stale request is never silently reapplied.
        for (const [index, view] of pages.entries()) {
          await view.goto(href);
          const graph = view.getByTestId('graph-review-comparison');
          await expect(graph.getByTestId('graph-review-historical-status')).toBeVisible({ timeout: 30_000 });
          await expect(graph.getByRole('button', { name: /^(Accept change|Reject proposal|Confirm action)$/u })).toHaveCount(0);
          const currentReview = await (index === 0 ? context : other).request.post('/api/files/version-center/v1/proposals/review', {
            headers: { 'x-canvas-workspace-id': target.workspaceId },
            data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: proposal.operationId } },
          });
          expect(currentReview.ok()).toBeTruthy();
          const review = await currentReview.json() as ProposalReviewSessionResponseV1;
          expect(review.mode).toBe('graph');
          if (review.mode !== 'graph') throw new Error('A raced proposal must retain its graph identity.');
          expect(review.context?.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle)
            .toBe(rejected ? 'rejected' : 'applied');
          expect(review.actions.accept).toBeUndefined();
          expect(review.actions.reject).toBeUndefined();
        }
        expect(held).toHaveLength(2);
        expect(await content()).toBe(rejected ? initial : accepted);
        expect(await revisionCount()).toBe(before + (rejected ? 0 : 1));
        await info.attach('ordinary-review-race-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, distinctUsers: workspaceKind === 'team', otherAction, target, filePath,
          proposalId: proposal.proposalId, winnerAction: receipt.actionType,
          outcomes: outcomes.map(outcome => ({ status: outcome.status, phase: outcome.receipt?.phase ?? null, errorCode: outcome.errorCode })),
          expected: rejected ? initial : accepted, beforeRevisionCount: before,
          afterRevisionCount: before + (rejected ? 0 : 1), actionPosts: held.length,
        }, null, 2) });
        await info.attach('ordinary-review-race-final.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
      } finally {
        releaseRequests();
        await other.close();
        assertOtherErrors();
      }
    }, { workspaceKind, identity, cleanupIdentity: workspaceKind === 'team' ? adminIdentity : undefined });
  });
});
