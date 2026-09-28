import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalActionReceiptV1, ProposalCurrentProofV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { FileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = 'Rot bleibt. Grün entfällt.';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';
const execFileAsync = promisify(execFile);
type Stored = { canonicalContent: string; documentSequence: number; checkpointSequence: number;
  stateProof: string | null; degraded: boolean; graphProof: ProposalCurrentProofV1 };

for (const workspaceKind of ['personal', 'team'] as const) {
  for (const empty of [false, true]) {
    test(`Ordinary pure deletion (${workspaceKind}) ${empty ? 'empty document' : 'partial paragraph'} persists despite an unchanged state vector`, async ({ browser }, info) => {
      test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
      test.setTimeout(240_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target,
        representation, agentContext, content, revisionCount }) => {
        expect(representation).toBe('tiptap_blocks');
        const expected = empty ? '' : 'Rot bleibt.';
        const beforeRevisionCount = await revisionCount();
        const headers = { 'x-canvas-workspace-id': target.workspaceId };
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `deletion-${randomUUID()}`, params, context: agentContext });
        const stored = async (): Promise<Stored> => {
          let stdout: string;
          try {
            ({ stdout } = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
              ['--conditions', 'react-server', 'scripts/collaboration-e2e-storage-read.ts',
                Buffer.from(JSON.stringify({ documentId: target.documentId, workspaceId: target.workspaceId,
                  path: filePath, includeGraphProof: true })).toString('base64url')],
              { env: process.env, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 }));
          } catch { throw new Error('The scoped read-only persistence probe failed.'); }
          return JSON.parse(stdout) as Stored;
        };
        const source = await run('read', { path: filePath, source: 'blocks' });
        expect(source.isError).not.toBe(true);
        expect(source.details?.collaboration).toMatchObject({ representation: 'tiptap_blocks', source: 'live_yjs' });
        expect(source.details?.structure?.blocks).toHaveLength(1);
        const block = source.details!.structure!.blocks[0]!;
        expect(block.type).toBe('paragraph');
        expect(block.text).toBe(INITIAL);
        const beforeStorage = await stored();
        expect(beforeStorage.canonicalContent).toBe(INITIAL);
        expect(beforeStorage.stateProof).toMatch(/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u);
        expect(beforeStorage.degraded).toBe(false);
        const result = await run('edit_file', { path: filePath, document: source.details!.document,
          blockId: block.id, expectedSha256: source.details!.sha256,
          oldText: empty ? INITIAL : ' Grün entfällt.', newText: '' });
        expect(result.isError).not.toBe(true);
        expect(result.details?.outcome).toBe('review_required');
        expect(result.details?.collaboration).toMatchObject({ reviewRequired: true, durability: 'not_applied' });
        const proposal = parseProposalToolCreationResultV1(result.details?.proposal);
        expect(await content()).toBe(INITIAL);
        expect(await revisionCount()).toBe(beforeRevisionCount);
        const review = async () => {
          const response = await context.request.post('/api/files/version-center/v1/proposals/review', {
            headers, data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: proposal.operationId } },
          });
          expect(response.ok()).toBeTruthy();
          const session = parseProposalReviewSessionResponseV1(await response.json());
          if (session.mode !== 'graph') throw new Error('Ordinary deletion requires graph review.');
          return session;
        };
        const session = await review();
        expect(session.status).toBe('clean');
        expect(session.compare?.diagnosis).toEqual({ availability: 'available', reasonCode: null });
        expect(session.compare?.candidate).toEqual({ contentAvailable: true, noEffect: false });
        expect(session.compare?.summary.deletions).toBeGreaterThan(0);
        expect(session.compare?.page).toEqual({ hasMore: false, nextCursor: null });
        const beforeProof = session.compare!.binding!.current;
        expect(beforeStorage.graphProof).toMatchObject({ contentHash: beforeProof.contentHash,
          stateVectorHash: beforeProof.stateVectorHash, deleteSetHash: beforeProof.deleteSetHash });
        const link = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target,
          selectedEntry: { kind: 'agent_operation', id: proposal.operationId }, initialView: 'reviews', source: 'deep_link' });
        await page.goto(link);
        const graph = page.getByTestId('graph-review-comparison');
        const accept = graph.getByRole('button', { name: 'Accept change', exact: true });
        await expect(accept).toBeEnabled({ timeout: 30_000 });
        await expect(graph.getByTestId('graph-review-hunks')).toContainText(INITIAL);
        await expect(graph.getByRole('button', { name: /Close without changes|Mark as already present/u })).toHaveCount(0);
        await expect(page.getByText('This comparison is no longer current', { exact: true })).toHaveCount(0);
        await info.attach('ordinary-deletion-preview.png', { contentType: 'image/png', body: await page.screenshot() });
        let actionPosts = 0;
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
        });
        await accept.click();
        const pending = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname === ACTION_PATH);
        await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
        const response = await pending;
        expect(response.ok()).toBeTruthy();
        const receipt = await response.json() as ProposalActionReceiptV1;
        expect(receipt.phase).toBe('succeeded');
        expect(receipt.result?.kind).toBe('content_changed');
        expect(receipt.result?.revisionId).toBeTruthy();
        expect(receipt.result?.resolutions).toEqual([{ proposalId: proposal.proposalId, lifecycle: 'applied' }]);
        const afterProof = receipt.result!.current!;
        expect(afterProof.contentHash).toBe(createHash('sha256').update(expected).digest('hex'));
        expect(afterProof.contentHash).not.toBe(beforeProof.contentHash);
        expect(afterProof.structureHash).not.toBe(beforeProof.structureHash);
        expect(afterProof.stateVectorHash).toBe(beforeProof.stateVectorHash);
        expect(afterProof.deleteSetHash).not.toBe(beforeProof.deleteSetHash);
        expect(afterProof.fullStateHash).not.toBe(beforeProof.fullStateHash);
        expect(await content()).toBe(expected);
        expect(await revisionCount()).toBe(beforeRevisionCount + 1);
        const afterStorage = await stored();
        expect(afterStorage.canonicalContent).toBe(expected);
        expect(afterStorage.documentSequence).toBeGreaterThan(beforeStorage.documentSequence);
        expect(afterStorage.degraded).toBe(false);
        expect(afterStorage.stateProof).toMatch(/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u);
        expect(afterStorage.stateProof).not.toBe(beforeStorage.stateProof);
        expect(afterStorage.graphProof.fullStateHash).not.toBe(beforeStorage.graphProof.fullStateHash);
        expect(afterStorage.graphProof).toMatchObject({ contentHash: afterProof.contentHash,
          structureHash: afterProof.structureHash, stateVectorHash: afterProof.stateVectorHash,
          deleteSetHash: afterProof.deleteSetHash });
        const live = await run('read', { path: filePath, source: 'blocks' });
        expect(live.isError).not.toBe(true);
        expect(live.details?.document).toEqual(source.details!.document);
        expect(live.details?.structure?.blocks).toHaveLength(1);
        expect(live.details?.structure?.blocks[0]).toMatchObject({ id: block.id, type: 'paragraph', text: expected });
        const timelineResponse = await context.request.post('/api/files/version-center/v1/resolve', {
          headers, data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
        });
        expect(timelineResponse.ok()).toBeTruthy();
        const timeline = await timelineResponse.json() as FileVersionTimelineResponseV1;
        const revision = timeline.entries.find(entry => entry.kind === 'revision'
          && entry.revisionId === receipt.result!.revisionId);
        expect(revision?.kind).toBe('revision');
        if (revision?.kind !== 'revision') throw new Error('The deletion must have an available saved revision.');
        expect(revision.content).toMatchObject({ availability: 'available', sha256: afterProof.contentHash,
          sizeBytes: Buffer.byteLength(expected) });
        const retry = await context.request.post(ACTION_PATH, { headers, data: response.request().postDataJSON() });
        expect(retry.ok()).toBeTruthy();
        expect(await retry.json()).toEqual(receipt);
        expect(await content()).toBe(expected);
        expect(await revisionCount()).toBe(beforeRevisionCount + 1);
        const final = await review();
        expect(final.context?.proposals.find(item => item.proposalId === proposal.proposalId)?.lifecycle).toBe('applied');
        expect(final.actions.accept).toBeUndefined();
        await page.goto(link);
        await expect(graph.getByTestId('graph-review-historical-status')).toBeVisible({ timeout: 30_000 });
        await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
        expect(await content()).toBe(expected);
        expect(await revisionCount()).toBe(beforeRevisionCount + 1);
        expect((await stored()).stateProof).toBe(afterStorage.stateProof);
        expect(actionPosts).toBe(1);
        await info.attach('ordinary-deletion-evidence.json', { contentType: 'application/json', body: JSON.stringify({
          workspaceKind, empty, target, representation, proposalId: proposal.proposalId, blockId: block.id,
          expectedFinal: expected, actualFinal: await content(), beforeRevisionCount,
          afterRevisionCount: await revisionCount(), beforeProof, afterProof, beforeStorage, afterStorage,
          revision, actionPosts, receipt: { phase: receipt.phase, result: receipt.result },
        }, null, 2) });
      }, { workspaceKind });
    });
  }
}
