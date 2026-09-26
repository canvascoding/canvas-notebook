import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';

const execFileAsync = promisify(execFile);
const BASE_TEXT = '# Ordinary agent edits\n\nA0|B0|C0|D0|E0|F0|G0|H0|I0|J0\n';
const FINAL_TEXT = '# Ordinary agent edits\n\nA1|B1|C1|D1|E1|F1|G1|H1|I1|J1\n';
type ToolDetails = { sha256?: string; code?: string; outcome?: string; editIndex?: number;
  proposal?: { proposalId: string; operationId: string; creationKind: string; source: { kind: string } };
  collaboration?: { operationId: string; operationStatus: string; durability: string; reviewRequired: boolean } };
type ToolResult = { isError?: boolean; details?: ToolDetails & { results?: ToolDetails[] } };

async function runTool(input: { toolName: 'read' | 'write' | 'edit_file' | 'apply_patch'; toolCallId: string;
  params: Record<string, unknown>; context: Record<string, unknown> }, options?: { graphMode: 'off' }): Promise<ToolResult> {
  let stdout: string;
  try {
    const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
      ['--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts',
        Buffer.from(JSON.stringify(input)).toString('base64url')],
      { cwd: process.cwd(), env: options ? { ...process.env, CANVAS_PROPOSAL_GRAPH_MODE: options.graphMode } : process.env,
        maxBuffer: 2 * 1024 * 1024, timeout: 60_000 });
    stdout = result.stdout;
  } catch {
    // Command arguments contain the scoped agent context; never put them or
    // stderr into a browser report. The test's own fixture is the sole target.
    throw new Error('The ordinary agent tool driver failed; no command arguments or stderr were included.');
  }
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const result = JSON.parse(line) as ToolResult;
      if (result.details) return result;
    } catch { /* Structured runtime observations can precede the final result. */ }
  }
  throw new Error('The ordinary tool returned no structured result.');
}

for (const workspaceKind of ['personal', 'team'] as const) test.describe(`Ordinary Markdown tools through the proposal graph (${workspaceKind})`, () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');

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
});
