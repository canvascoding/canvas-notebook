import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const SECTIONS = 65;
const INITIAL = '# Versand\n\n' + Array.from({ length: SECTIONS }, (_, i) => {
  const number = String(i + 1).padStart(2, '0');
  return [`Position ${number}: vorher`, ...Array.from({ length: 4 }, (_, j) => `Notiz ${number}-${j + 1}: unverändert`)]
    .join('\n\n');
}).join('\n\n') + '\n\nKontrolle: offen\n';
const PROPOSED = INITIAL.replaceAll(': vorher', ': nachher');

for (const workspaceKind of ['personal', 'team'] as const) {
  test(`Ordinary paginated diff (${workspaceKind}) binds every page and requires the complete preview before acceptance`, async ({ browser }, info) => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    test.setTimeout(240_000);
    await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target,
      representation, agentContext, content, revisionCount }) => {
      expect(representation).toBe('tiptap_blocks');
      const before = await revisionCount();
      const source = await runOrdinaryAgentTool({ toolName: 'read', toolCallId: `page-read-${randomUUID()}`,
        params: { path: filePath }, context: agentContext });
      expect(source.isError).not.toBe(true);
      expect(source.details?.collaboration).toMatchObject({ documentId: target.documentId, source: 'live_yjs' });
      const write = await runOrdinaryAgentTool({ toolName: 'write', toolCallId: `page-write-${randomUUID()}`,
        params: { path: filePath, expectedSha256: source.details!.sha256, content: PROPOSED }, context: agentContext });
      expect(write.isError).not.toBe(true);
      expect(write.details?.outcome).toBe('review_required');
      expect(write.details?.collaboration).toMatchObject({ reviewRequired: true, durability: 'not_applied' });
      const proposal = parseProposalToolCreationResultV1(write.details?.proposal);
      const headers = { 'x-canvas-workspace-id': target.workspaceId };
      const review = async (operationId = proposal.operationId) => {
        const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
          headers, data: { contractVersion: 1, target, selection: { kind: 'operation', operationId } },
        });
        expect(response.ok()).toBeTruthy();
        const session = parseProposalReviewSessionResponseV1(await response.json());
        if (session.mode !== 'graph') throw new Error('Ordinary proposals must use graph review.');
        return session;
      };
      const session = await review();
      expect(session.status).toBe('clean');
      expect(session.compare?.hunks).toHaveLength(64);
      expect(session.compare?.page.hasMore).toBe(true);
      expect(session.compare?.summary.additions).toBe(SECTIONS);
      expect(session.compare?.summary.deletions).toBe(SECTIONS);
      const link = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
        selectedEntry: { kind: 'agent_operation', id: proposal.operationId }, initialView: 'reviews', source: 'deep_link' });
      if (workspaceKind === 'team') await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(link);
      const graph = page.getByTestId('graph-review-comparison');
      const hunks = graph.getByTestId('graph-review-hunks');
      const accept = graph.getByRole('button', { name: 'Accept change', exact: true });
      const more = graph.getByRole('button', { name: 'Load more changes', exact: true });
      await expect(more).toBeVisible({ timeout: 30_000 });
      await expect(hunks).toContainText('Position 64: nachher');
      await expect(hunks).not.toContainText('Position 65: nachher');
      await info.attach('ordinary-diff-pages-initial.json', { contentType: 'application/json', body: JSON.stringify({
        workspaceKind, target, representation, firstPageHunks: session.compare!.hunks.length,
        hasMore: session.compare!.page.hasMore, summary: session.compare!.summary,
        acceptEnabledBeforeLastPage: await accept.isEnabled(),
      }, null, 2) });
      await expect(accept).toBeDisabled();
      let actionPosts = 0;
      page.on('request', request => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname === '/api/files/version-center/v1/proposals/actions') actionPosts += 1;
      });
      const pageResponse = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/compare');
      await more.click();
      const loaded = await pageResponse;
      expect(loaded.ok()).toBeTruthy();
      const next = await loaded.json();
      expect(next.diagnosis).toEqual({ availability: 'available', reasonCode: null });
      expect(next.hunks).toHaveLength(1);
      expect(next.page).toEqual({ hasMore: false, nextCursor: null });
      expect(next.binding).toEqual(loaded.request().postDataJSON().binding);
      await expect(hunks).toContainText('Position 65: vorher');
      await expect(hunks).toContainText('Position 65: nachher');
      await expect(accept).toBeEnabled();
      expect(await content()).toBe(INITIAL);
      expect(await revisionCount()).toBe(before);
      const completeText = await hunks.innerText();
      for (let index = 1; index <= SECTIONS; index += 1) {
        const number = String(index).padStart(2, '0');
        expect(completeText).toContain(`Position ${number}: vorher`);
        expect(completeText).toContain(`Position ${number}: nachher`);
      }

      // Delay only the real next-page request. A second ordinary proposal changes
      // the graph, not the document, while this exact first page is on screen.
      await page.goto(link);
      await expect(more).toBeVisible({ timeout: 30_000 });
      await expect(accept).toBeDisabled();
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const requested = new Promise<void>(resolve => { entered = resolve; });
      const compareRoute = '**/api/files/version-center/v1/proposals/compare';
      await page.route(compareRoute, async route => { entered(); await held; await route.continue(); });
      const stalePageResponse = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/compare');
      await more.click();
      await requested;
      await expect(accept).toBeDisabled();
      const other = await runOrdinaryAgentTool({ toolName: 'edit_file', toolCallId: `page-graph-drift-${randomUUID()}`,
        params: { path: filePath, expectedSha256: source.details!.sha256,
          oldText: 'Kontrolle: offen', newText: 'Kontrolle: geprüft' }, context: agentContext }).finally(release);
      const stalePage = await stalePageResponse;
      await page.unroute(compareRoute);
      expect(other.isError).not.toBe(true);
      expect(other.details?.outcome).toBe('review_required');
      expect(other.details?.collaboration).toMatchObject({ reviewRequired: true, durability: 'not_applied' });
      const otherProposal = parseProposalToolCreationResultV1(other.details?.proposal);
      expect(otherProposal.source.kind).toBe('authoritative');
      expect(otherProposal.relationships.dependency).toBeNull();
      expect(stalePage.ok()).toBeTruthy();
      const stalePageBody = await stalePage.json();
      expect(stalePageBody.diagnosis).toEqual({ availability: 'unavailable', reasonCode: Codes.candidateChanged });
      const fresh = await review();
      expect(fresh.compare?.binding?.graphRevision).toBeGreaterThan(session.compare!.binding!.graphRevision);
      expect(fresh.compare?.binding?.current).toEqual(session.compare?.binding?.current);
      expect(await content()).toBe(INITIAL);
      expect(await revisionCount()).toBe(before);
      const staleAccept = await context.request.post('/api/files/version-center/v1/proposals/actions', {
        headers, data: { contractVersion: 1, target, action: { contractVersion: 1, ...session.actions.accept!,
          idempotencyKey: randomUUID(), creation: null } },
      });
      expect(staleAccept.status()).toBe(409);
      expect((await staleAccept.json()).error.code).toBe(Codes.graphChanged);
      await expect(graph.getByTestId('graph-review-incomplete').getByRole('alert')).toBeVisible();
      await expect(accept).toBeDisabled();
      await expect(hunks).not.toContainText('Position 65: nachher');
      expect(actionPosts).toBe(0);
      await info.attach('ordinary-diff-pages-stale-footer.png', { contentType: 'image/png',
        body: await graph.getByTestId('graph-review-footer').screenshot() });
      await graph.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
      await expect(graph.getByTestId('graph-review-incomplete').getByRole('alert')).toHaveCount(0);
      await expect(more).toBeEnabled({ timeout: 30_000 });
      await expect(accept).toBeDisabled();
      await expect(hunks).not.toContainText('Position 65: nachher');
      await more.click();
      await expect(hunks).toContainText('Position 65: nachher');
      await expect(accept).toBeEnabled();
      await expect(graph.getByTestId('graph-review-incomplete')).toHaveCount(0);
      await accept.scrollIntoViewIfNeeded();
      await expect(accept).toBeInViewport();
      const footer = graph.getByTestId('graph-review-footer');
      const viewportWidth = page.viewportSize()!.width;
      const buttonBoxes = await footer.getByRole('button').evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect(); return { x: rect.x, right: rect.right };
      }));
      expect(buttonBoxes.every(box => box.x >= -1 && box.right <= viewportWidth + 1)).toBe(true);
      await info.attach('ordinary-diff-pages-complete.png', { contentType: 'image/png', body: await page.screenshot() });
      await accept.click();
      const pending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/files/version-center/v1/proposals/actions');
      await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
      const response = await pending;
      expect(response.ok()).toBeTruthy();
      const receipt = await response.json() as ProposalActionReceiptV1;
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.result?.kind).toBe('content_changed');
      expect(receipt.result?.resolutions).toEqual([{ proposalId: proposal.proposalId, lifecycle: 'applied' }]);
      expect(await content()).toBe(PROPOSED);
      expect(await revisionCount()).toBe(before + 1);
      const openOther = await review(otherProposal.operationId);
      expect(openOther.context?.proposals.find(item => item.proposalId === otherProposal.proposalId)?.lifecycle).toBe('open');
      const retry = await context.request.post('/api/files/version-center/v1/proposals/actions', {
        headers, data: response.request().postDataJSON(),
      });
      expect(retry.ok()).toBeTruthy();
      expect(await retry.json()).toEqual(receipt);
      expect(await revisionCount()).toBe(before + 1);
      expect(actionPosts).toBe(1);
      await info.attach('ordinary-diff-pages-evidence.json', { contentType: 'application/json', body: JSON.stringify({
        workspaceKind, target, representation, proposalId: proposal.proposalId, sections: SECTIONS,
        firstPageHunks: session.compare!.hunks.length, lastPageHunks: next.hunks.length,
        unchangedCurrentDuringGraphDrift: fresh.compare!.binding!.current,
        graphBefore: session.compare!.binding!.graphRevision, graphAfter: fresh.compare!.binding!.graphRevision,
        oldPageDiagnosis: stalePageBody.diagnosis, oldAcceptStatus: staleAccept.status(),
        otherProposalId: otherProposal.proposalId, otherProposalLifecycle: 'open', viewportWidth,
        beforeRevisionCount: before, afterRevisionCount: await revisionCount(), actionPosts,
        expectedFinal: PROPOSED, actualFinal: await content(),
        receipt: { actionType: receipt.actionType, phase: receipt.phase, result: receipt.result },
      }, null, 2) });
    }, { workspaceKind });
  });
}
