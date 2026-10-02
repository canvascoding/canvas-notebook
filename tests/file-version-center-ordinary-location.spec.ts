import { expect } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { randomUUID } from 'node:crypto';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { parseProposalToolCreationResultV1, parseProposalToolReadResultV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import type { FileVersionCenterTargetV1, FileVersionTimelineResponseV1 } from '../app/lib/file-version-center/contracts/v1';
import { uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { withOrdinaryAgentDocument } from './helpers/ordinary-agent-document';
import { runOrdinaryAgentTool } from './helpers/ordinary-agent-tool';

const INITIAL = '# Versand\n\nKosten: 10 EUR\n\nLieferzeit: 5 Tage\n';
const FINAL = '# Versand\n\nKosten: 12 EUR\n\nLieferzeit: 3 Tage\n';
const REPLACEMENT = '# Neue Datei\n\nKein Vorschlag gehoert zu dieser Datei.\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';
const REVIEW_PATH = '/api/files/version-center/v1/proposals/review';

for (const workspaceKind of ['personal', 'team'] as const) {
  test.describe(`Ordinary proposal document identity (${workspaceKind})`, () => {
    test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');
    test('rename and move retain the merge while path reuse and copies cannot inherit it', async ({ browser }, info) => {
      test.setTimeout(240_000);
      await withOrdinaryAgentDocument(browser, INITIAL, async ({ context, page, filePath, target, representation,
        agentContext, revisionCount }) => {
        page.setDefaultTimeout(20_000);
        expect(representation).toBe('tiptap_blocks');
        const headers = { 'x-canvas-workspace-id': target.workspaceId };
        const renamedPath = filePath.replace(/\.md$/u, '-renamed.md');
        const folder = filePath.replace(/\.md$/u, '-archive');
        const movedPath = `${folder}/${renamedPath}`;
        let currentPath = filePath;
        let createdFolder = false;
        const extraFiles: Array<{ workspaceId: string; path: string }> = [];
        const run = (toolName: 'read' | 'edit_file', params: Record<string, unknown>) =>
          runOrdinaryAgentTool({ toolName, toolCallId: `ordinary-location-${randomUUID()}`, params, context: agentContext });
        const readContent = async (workspaceId: string, path: string) => {
          const response = await context.request.get('/api/files/read', { headers: { 'x-canvas-workspace-id': workspaceId }, params: { path } });
          expect(response.ok()).toBeTruthy();
          return (await response.json()).data.content as string;
        };
        const timeline = async (selectedTarget: FileVersionCenterTargetV1) => {
          const response = await context.request.post('/api/files/version-center/v1/resolve', {
            headers: { 'x-canvas-workspace-id': selectedTarget.workspaceId },
            data: { contractVersion: 1, target: selectedTarget, initialView: 'reviews', source: 'deep_link' },
          });
          expect(response.ok()).toBeTruthy();
          return await response.json() as FileVersionTimelineResponseV1;
        };
        const rename = async (newPath: string) => {
          const response = await context.request.post('/api/files/rename', {
            headers, data: { oldPath: currentPath, newPath, updateLinks: false },
          });
          expect(response.ok(), `Scoped fixture rename: ${response.status()}`).toBeTruthy();
          currentPath = newPath;
        };
        const remove = async (workspaceId: string, path: string) => {
          const response = await context.request.delete('/api/files/delete', {
            headers: { 'x-canvas-workspace-id': workspaceId }, data: { path },
          });
          expect(response.ok(), `Scoped fixture cleanup: ${response.status()}`).toBeTruthy();
        };
        try {
          const source = await run('read', { path: filePath, source: 'blocks' });
          expect(source.isError).not.toBe(true);
          expect(source.details?.structure?.nextOffset).toBeNull();
          const blocks = source.details!.structure!.blocks;
          expect(blocks.map(block => block.text)).toEqual(['Versand', 'Kosten: 10 EUR', 'Lieferzeit: 5 Tage']);
          const rootResult = await run('edit_file', { path: filePath, expectedSha256: source.details!.sha256,
            oldText: 'Kosten: 10 EUR', newText: 'Kosten: 12 EUR' });
          expect(rootResult.isError).not.toBe(true);
          const root = parseProposalToolCreationResultV1(rootResult.details?.proposal);
          const rootRead = await run('read', { path: filePath, source: 'blocks',
            proposal: { contractVersion: 1, proposalId: root.proposalId, expectedScope: root.scope } });
          expect(rootRead.isError).not.toBe(true);
          const basis = parseProposalToolReadResultV1(rootRead.details?.proposal);
          if (basis.source.kind !== 'proposal') throw new Error('An exact parent proposal source is required.');
          const childResult = await run('edit_file', { path: filePath, document: rootRead.details!.document,
            blockId: blocks[2]!.id, oldText: '5 Tage', newText: '3 Tage', expectedSha256: basis.contentSha256,
            proposal: { contractVersion: 1, creationKind: 'extends', source: basis.source,
              expectedParentCandidateHash: basis.source.candidateHash, expectedParentCasVersion: basis.source.proposalCasVersion,
              replaces: null, choice: null } });
          expect(childResult.isError).not.toBe(true);
          const child = parseProposalToolCreationResultV1(childResult.details?.proposal);
          expect(child.relationships.dependency).toEqual({ proposalId: root.proposalId, candidateHash: root.candidateHash });
          expect(child.scope).toEqual(root.scope);
          const before = await revisionCount();
          const lineageTarget = { kind: 'lineage' as const, workspaceId: target.workspaceId, lineageId: root.scope.lineageId };
          const originalLink = buildFileVersionCenterDeepLinkV1('/en', { contractVersion: 1, target: lineageTarget,
            selectedEntry: { kind: 'agent_operation', id: child.operationId }, initialView: 'reviews', source: 'deep_link' });
          await page.goto(originalLink);
          await expect(page.getByTestId('file-version-center')).toContainText(filePath, { timeout: 30_000 });
          await expect(page.getByTestId('graph-review-comparison').getByText('Ready to apply', { exact: true })).toBeVisible();
          const review = async () => {
            const response = await context.request.post(REVIEW_PATH, {
              headers, data: { contractVersion: 1, target: lineageTarget, selection: { kind: 'operation', operationId: child.operationId } },
            });
            expect(response.ok()).toBeTruthy();
            const result = parseProposalReviewSessionResponseV1(await response.json());
            if (result.mode !== 'graph') throw new Error('The ordinary dependency must remain graph-backed.');
            return result;
          };
          const beforeReview = await review();
          expect(beforeReview.status).toBe('clean');
          const assertIdentity = async () => {
            for (const selectedTarget of [target, lineageTarget]) {
              const resolved = await timeline(selectedTarget);
              expect(resolved.document).toEqual({ workspaceId: target.workspaceId,
                lineageId: root.scope.lineageId, documentId: target.documentId, path: currentPath });
              expect(resolved.entries.filter(entry => entry.kind === 'agent_operation').map(entry => entry.id).sort())
                .toEqual([root.operationId, child.operationId].sort());
            }
            const result = await review();
            expect(result.status).toBe('clean');
            expect(result.context?.scope).toEqual(root.scope);
            expect(result.context?.graphRevision).toBe(beforeReview.context!.graphRevision);
            expect(result.context?.applyProposalIds).toEqual([root.proposalId, child.proposalId]);
            expect(result.actions.accept).toBeTruthy();
            expect(await readContent(target.workspaceId, currentPath)).toBe(INITIAL);
            expect(await revisionCount()).toBe(before);
            return result;
          };
          await page.goto('about:blank');
          await rename(renamedPath);
          await assertIdentity();
          const directory = await context.request.post('/api/files/create', { headers, data: { path: folder, type: 'directory' } });
          expect(directory.ok()).toBeTruthy();
          createdFolder = true;
          await rename(movedPath);
          const movedReview = await assertIdentity();

          await uploadWorkspaceTextFile({ request: context.request, workspaceId: target.workspaceId, filePath, content: REPLACEMENT });
          extraFiles.push({ workspaceId: target.workspaceId, path: filePath });
          const workspaceResponse = await context.request.get('/api/workspaces');
          expect(workspaceResponse.ok()).toBeTruthy();
          const other = ((await workspaceResponse.json()).workspaces as Array<{ id: string; type: string; legacy?: boolean;
            permissions: { canRead: boolean; canWrite: boolean; canDelete: boolean } }>).find(workspace =>
            workspace.id !== target.workspaceId && !workspace.legacy && workspace.permissions.canRead
            && workspace.permissions.canWrite && workspace.permissions.canDelete
            && (workspaceKind === 'personal' ? ['team', 'organization'].includes(workspace.type) : workspace.type === 'personal'));
          expect(other, 'A second writable workspace with fixture cleanup rights is required.').toBeTruthy();
          for (const workspaceId of [target.workspaceId, other!.id]) {
            const response = await context.request.post('/api/files/copy', { headers,
              data: { sources: [movedPath], destDir: '.', sourceWorkspaceId: target.workspaceId, targetWorkspaceId: workspaceId } });
            expect(response.ok()).toBeTruthy();
            const result = await response.json() as { copied: string[]; failed: unknown[]; skipped: unknown[] };
            for (const path of result.copied) extraFiles.push({ workspaceId, path });
            expect(result.failed).toEqual([]);
            expect(result.skipped).toEqual([]);
            expect(result.copied).toEqual([renamedPath]);
          }
          const isolated: Array<{ path: string; target: FileVersionCenterTargetV1; lineageId: string; beforeRevisions: number }> = [];
          for (const entry of extraFiles) {
            const isolatedHeaders = { 'x-canvas-workspace-id': entry.workspaceId };
            const session = await context.request.post('/api/files/collaboration/session', { headers: isolatedHeaders,
              data: { path: entry.path, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES } });
            expect(session.ok()).toBeTruthy();
            const documentId = (await session.json()).documentId as string;
            expect(documentId).toBeTruthy();
            const isolatedTarget = { kind: 'document' as const, workspaceId: entry.workspaceId, documentId };
            const resolved = await timeline(isolatedTarget);
            expect(resolved.document.lineageId).not.toBe(root.scope.lineageId);
            expect(documentId).not.toBe(target.documentId);
            expect(resolved.entries.filter(item => item.kind === 'agent_operation')).toEqual([]);
            const invalidRead = await context.request.post(REVIEW_PATH, { headers: isolatedHeaders,
              data: { contractVersion: 1, target: isolatedTarget, selection: { kind: 'operation', operationId: child.operationId } } });
            expect(invalidRead.status()).toBe(404);
            expect((await invalidRead.json()).error.code).toBe(Codes.sourceInvalid);
            const invalidApply = await context.request.post(ACTION_PATH, { headers: isolatedHeaders,
              data: { contractVersion: 1, target: isolatedTarget, action: { contractVersion: 1,
                ...movedReview.actions.accept!, idempotencyKey: randomUUID(), creation: null } } });
            expect(invalidApply.status()).toBe(400);
            expect((await invalidApply.json()).error.code).toBe(Codes.scopeMismatch);
            isolated.push({ path: entry.path, target: isolatedTarget, lineageId: resolved.document.lineageId,
              beforeRevisions: resolved.entries.filter(item => item.kind === 'revision').length });
            await page.goto(buildFileVersionCenterDeepLinkV1('/en', {
              contractVersion: 1, target: isolatedTarget, initialView: 'reviews', source: 'deep_link',
            }));
            await expect(page.getByTestId('file-version-center')).toContainText(entry.path, { timeout: 30_000 });
            await expect(page.getByText('No agent changes need review.', { exact: true })).toBeVisible();
            await expect(page.getByTestId('graph-review-comparison')).toHaveCount(0);
            await expect(page.getByRole('button', { name: /Accept change|Accept all changes/u })).toHaveCount(0);
          }
          expect(new Set([root.scope.lineageId, ...isolated.map(entry => entry.lineageId)]).size).toBe(4);
          await assertIdentity();
          await page.goto(originalLink);
          const graph = page.getByTestId('graph-review-comparison');
          await expect(page.getByTestId('file-version-center')).toContainText(movedPath, { timeout: 30_000 });
          await expect(graph.getByText('Ready to apply', { exact: true })).toBeVisible();
          await expect(graph.getByTestId('graph-review-context')).toContainText('1 prerequisite included');
          await expect(page.getByText('This comparison is no longer current', { exact: true })).toHaveCount(0);
          await info.attach('ordinary-location-before-accept.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
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
          expect(receipt.affectedProposalIds).toEqual([root.proposalId, child.proposalId]);
          expect(receipt.result?.resolutions).toEqual([
            { proposalId: root.proposalId, lifecycle: 'included' }, { proposalId: child.proposalId, lifecycle: 'applied' },
          ]);
          expect(await readContent(target.workspaceId, movedPath)).toBe(FINAL);
          expect(await revisionCount()).toBe(before + 1);
          const retry = await context.request.post(ACTION_PATH, { headers, data: accepted.request().postDataJSON() });
          expect(retry.ok()).toBeTruthy();
          expect(await retry.json()).toEqual(receipt);
          expect(actionPosts).toBe(1);
          const live = await run('read', { path: movedPath, source: 'blocks' });
          expect(live.isError).not.toBe(true);
          expect(live.details?.document).toEqual(source.details!.document);
          expect(live.details?.structure?.nextOffset).toBeNull();
          expect(live.details?.structure?.blocks.map(block => [block.id, block.text])).toEqual([
            [blocks[0]!.id, 'Versand'], [blocks[1]!.id, 'Kosten: 12 EUR'], [blocks[2]!.id, 'Lieferzeit: 3 Tage'],
          ]);
          for (const entry of isolated) {
            expect(await readContent(entry.target.workspaceId, entry.path)).toBe(entry.path === filePath ? REPLACEMENT : INITIAL);
            const resolved = await timeline(entry.target);
            expect(resolved.document.lineageId).toBe(entry.lineageId);
            expect(resolved.entries.filter(item => item.kind === 'agent_operation')).toEqual([]);
            expect(resolved.entries.filter(item => item.kind === 'revision')).toHaveLength(entry.beforeRevisions);
          }
          const terminal = await review();
          expect(terminal.selectedProposalIds).toEqual([child.proposalId]);
          expect(terminal.context?.proposals.find(item => item.proposalId === child.proposalId)?.lifecycle).toBe('applied');
          expect(terminal.actions).toEqual({});
          expect(await revisionCount()).toBe(before + 1);
          await info.attach('ordinary-location-evidence.json', { contentType: 'application/json', body: JSON.stringify({
            workspaceKind, target, lineageTarget, originalLink, originalPath: filePath, renamedPath, movedPath,
            rootProposalId: root.proposalId, childProposalId: child.proposalId, isolated, actionPosts,
            finalText: FINAL, beforeRevisionCount: before, afterRevisionCount: before + 1,
            finalBlockIds: live.details!.structure!.blocks.map(block => block.id), receipt,
          }, null, 2) });
        } finally {
          await page.goto('about:blank').catch(() => undefined);
          for (const entry of extraFiles.reverse()) await remove(entry.workspaceId, entry.path);
          // Restore the exact original fixture so the shared helper owns its final cleanup.
          if (currentPath !== filePath) await rename(filePath);
          if (createdFolder) await remove(target.workspaceId, folder);
        }
      }, { workspaceKind });
    });
  });
}
