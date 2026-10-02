import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewGraphSessionV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import type { ProposalReviewTransformResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-transform-v1';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const execFileAsync = promisify(execFile);
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const BASE_TEXT = '# Proposal batch fixture\n\nA0|B0|C0|D0|E0|F0|G0|H0|I0|J0\n';
const AFTER_A_TEXT = BASE_TEXT.replace('A0', 'A1');
type Kind = 'detach' | 'replace';
type Fixture = { scope: { lineageId: string; documentId: string };
  proposals: Array<{ label: string; proposalId: string; operationId: string }> };
type Timeline = { entries: Array<{ kind: string; source?: string }> };

async function attachJson(testInfo: import('@playwright/test').TestInfo, name: string, value: unknown): Promise<void> {
  const file = testInfo.outputPath(name);
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  await testInfo.attach(name, { path: file, contentType: 'application/json' });
}

async function fixture(input: { userId: string; role: string; workspaceId: string; documentId: string; filePath: string }): Promise<Fixture> {
  const encoded = Buffer.from(JSON.stringify({ scenario: 'batch', ...input })).toString('base64url');
  const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
    '--conditions', 'react-server', 'scripts/fvrc-1006-browser-fixture.ts', encoded,
  ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 });
  for (const line of result.stdout.trim().split('\n').reverse()) {
    try { return JSON.parse(line) as Fixture; } catch { /* Only the driver receipt is JSON. */ }
  }
  throw new Error('The managed proposal fixture returned no receipt.');
}

async function openReview(page: Page, input: { workspaceId: string; lineageId: string; operationId: string }) {
  const request: FileVersionCenterRequestV1 = { contractVersion: 1,
    target: { kind: 'lineage', workspaceId: input.workspaceId, lineageId: input.lineageId },
    selectedEntry: { kind: 'agent_operation', id: input.operationId }, initialView: 'reviews', source: 'deep_link' };
  await page.goto(buildFileVersionCenterDeepLinkV1('/en', request));
  const graph = page.getByTestId('graph-review-comparison');
  await expect(graph).toBeVisible({ timeout: 30_000 });
  return graph;
}

async function content(request: APIRequestContext, workspaceId: string, filePath: string): Promise<string> {
  const response = await request.get('/api/files/read', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId }, params: { path: filePath },
  });
  const body = await response.json() as { data?: { content?: string }; error?: string };
  expect(response.ok(), body.error ?? 'Could not read the collaboration document.').toBeTruthy();
  return body.data?.content ?? '';
}

async function timeline(request: APIRequestContext, workspaceId: string, filePath: string): Promise<Timeline> {
  const response = await request.post('/api/files/version-center/v1/resolve', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { contractVersion: 1, target: { kind: 'path', workspaceId, pathHint: filePath },
      initialView: 'history', source: 'file_browser' },
  });
  const body = await response.json() as Timeline & { error?: { message?: string } };
  expect(response.ok(), body.error?.message ?? 'Could not read the document history.').toBeTruthy();
  return body;
}

async function review(request: APIRequestContext, workspaceId: string, documentId: string,
  selection: { kind: 'operation'; operationId: string } | { kind: 'proposals'; proposalIds: string[] }): Promise<ProposalReviewGraphSessionV1> {
  const response = await request.post('/api/files/version-center/v1/proposals/review', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { contractVersion: 1, target: { kind: 'document', workspaceId, documentId }, selection },
  });
  const body = await response.json() as ProposalReviewGraphSessionV1 & { error?: { message?: string } };
  expect(response.ok(), body.error?.message ?? 'Could not inspect the created proposal.').toBeTruthy();
  expect(body.mode).toBe('graph');
  return body;
}

async function accept(graph: ReturnType<Page['getByTestId']>, page: Page): Promise<ProposalActionReceiptV1> {
  await graph.getByRole('button', { name: 'Accept change' }).click();
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions'));
  await graph.getByRole('button', { name: 'Confirm action' }).click();
  const response = await responsePromise;
  const body = await response.text();
  expect(response.ok(), `Graph acceptance failed (${response.status()}): ${body.slice(0, 500)}`).toBeTruthy();
  const receipt = JSON.parse(body) as ProposalActionReceiptV1;
  expect(receipt.phase).toBe('succeeded');
  expect(receipt.result?.kind).toBe('content_changed');
  return receipt;
}

test.describe('FVRC-1006 review-only proposal transformations', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local graph-review stack.');
  test.setTimeout(180_000);

  for (const kind of ['detach', 'replace'] as const satisfies readonly Kind[]) {
    test(`${kind} creates an exact review proposal without changing live content or history`, async ({ browser }, testInfo) => {
      const context = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
      const assertNoServerErrors = observeProposalReviewServerErrors(context);
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const filePath = `fvrc-1006-${randomUUID()}.md`;
      let workspaceId: string | null = null;
      let uploaded = false;
      try {
        const sessionResponse = await context.request.get('/api/auth/get-session');
        const session = await sessionResponse.json() as { user?: { id?: string; role?: string } };
        expect(sessionResponse.ok()).toBeTruthy();
        expect(session.user?.id).toBeTruthy();
        const workspaceResponse = await context.request.get('/api/workspaces');
        const workspaces = await workspaceResponse.json() as { workspaces?: Array<{ id: string; type: string; legacy?: boolean;
          permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean } }> };
        expect(workspaceResponse.ok()).toBeTruthy();
        const workspace = workspaces.workspaces?.find(item => item.type === 'personal' && !item.legacy
          && item.permissions.canRead && item.permissions.canWrite && item.permissions.canRunAgent);
        expect(workspace, 'A permitted personal workspace is required.').toBeTruthy();
        workspaceId = workspace!.id;
        await context.addInitScript(id => {
          localStorage.setItem('canvas.activeWorkspaceId', id);
          localStorage.setItem('canvas.notebook.chatVisible', 'false');
        }, workspaceId);
        await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: BASE_TEXT });
        uploaded = true;
        const collaboration = await context.request.post('/api/files/collaboration/session', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
        });
        const collaborationBody = await collaboration.json() as { documentId?: string; error?: string };
        expect(collaboration.ok(), collaborationBody.error ?? 'Could not initialize collaboration.').toBeTruthy();
        expect(collaborationBody.documentId).toBeTruthy();
        const graphFixture = await fixture({ userId: session.user!.id!, role: session.user!.role ?? 'member',
          workspaceId, documentId: collaborationBody.documentId!, filePath });
        const proposalA = graphFixture.proposals.find(item => item.label === 'A')!;
        const proposalB = graphFixture.proposals.find(item => item.label === 'B')!;

        const graphA = await openReview(page, { workspaceId, lineageId: graphFixture.scope.lineageId,
          operationId: proposalA.operationId });
        await expect(graphA.getByText('Ready to apply')).toBeVisible();
        await accept(graphA, page);
        await expect.poll(() => content(context.request, workspaceId!, filePath), { timeout: 30_000 }).toBe(AFTER_A_TEXT);
        const before = await timeline(context.request, workspaceId, filePath);
        const beforeRevisions = before.entries.filter(entry => entry.kind === 'revision').length;
        const beforeApplied = before.entries.filter(entry => entry.kind === 'revision' && entry.source === 'agent_apply').length;

        const graphB = await openReview(page, { workspaceId, lineageId: graphFixture.scope.lineageId,
          operationId: proposalB.operationId });
        await expect(graphB.getByText('Ready after rebase')).toBeVisible();
        const previewPromise = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/transform/preview'));
        await graphB.getByRole('button', { name: kind === 'detach'
          ? 'Check a separate proposal' : 'Check a replacement proposal against the current document' }).click();
        const previewResponse = await previewPromise;
        const previewBody = await previewResponse.text();
        expect(previewResponse.ok(), `Transformation preview failed (${previewResponse.status()}): ${previewBody.slice(0, 500)}`).toBeTruthy();
        const preview = JSON.parse(previewBody) as ProposalReviewTransformResponseV1;
        expect(preview.kind).toBe(kind);
        expect(preview.sourceProposalId).toBe(proposalB.proposalId);
        expect(preview.beforeContent).toBe(AFTER_A_TEXT);
        expect(preview.proposedContent).toBe(AFTER_A_TEXT.replace('B0', 'B1'));
        expect(preview.prepared.creation.proposalId).not.toBe(proposalB.proposalId);
        expect(preview.prepared.creation.operationId).not.toBe(proposalB.operationId);
        await expect(graphB.getByTestId('graph-review-transform-preview')).toBeVisible();
        await expect(graphB.getByTestId('graph-review-transform-full-content')).toContainText('A1|B1');
        const screenshot = testInfo.outputPath(`${kind}-preview.png`);
        await graphB.screenshot({ path: screenshot });
        await testInfo.attach(`${kind}-preview.png`, { path: screenshot, contentType: 'image/png' });

        const actionPromise = page.waitForResponse(response => response.request().method() === 'POST'
          && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions'));
        await graphB.getByRole('button', { name: kind === 'detach'
          ? 'Create separate proposal' : 'Create replacement proposal' }).click();
        const actionResponse = await actionPromise;
        const actionBody = await actionResponse.text();
        expect(actionResponse.ok(), `Transformation action failed (${actionResponse.status()}): ${actionBody.slice(0, 500)}`).toBeTruthy();
        const receipt = JSON.parse(actionBody) as ProposalActionReceiptV1;
        expect(receipt.phase).toBe('succeeded');
        expect(receipt.actionType).toBe(kind);
        expect(receipt.result?.kind).toBe('metadata_only');
        expect(receipt.result?.createdProposalIds).toEqual([preview.prepared.creation.proposalId]);
        expect(receipt.result?.revisionId).toBeNull();
        expect(await content(context.request, workspaceId, filePath)).toBe(AFTER_A_TEXT);
        const after = await timeline(context.request, workspaceId, filePath);
        expect(after.entries.filter(entry => entry.kind === 'revision')).toHaveLength(beforeRevisions);
        expect(after.entries.filter(entry => entry.kind === 'revision' && entry.source === 'agent_apply')).toHaveLength(beforeApplied);

        const createdSession = await review(context.request, workspaceId, graphFixture.scope.documentId,
          { kind: 'proposals', proposalIds: [preview.prepared.creation.proposalId] });
        const createdNode = createdSession.context?.proposals.find(item => item.proposalId === preview.prepared.creation.proposalId);
        expect(createdNode?.operationId).toBe(preview.prepared.creation.operationId);
        expect(createdNode?.lifecycle).toBe('open');
        expect(createdNode?.relationships.replacesProposalId).toBe(kind === 'replace' ? proposalB.proposalId : null);
        expect(createdNode?.relationships.dependency).toBeNull();
        const originalSession = await review(context.request, workspaceId, graphFixture.scope.documentId,
          { kind: 'operation', operationId: proposalB.operationId });
        const originalNode = originalSession.context?.proposals.find(item => item.proposalId === proposalB.proposalId);
        expect(originalNode?.lifecycle).toBe(kind === 'replace' ? 'superseded' : 'open');
        await attachJson(testInfo, `${kind}-receipt.json`, { actionType: receipt.actionType,
          phase: receipt.phase, createdProposalIds: receipt.result?.createdProposalIds, originalLifecycle: originalNode?.lifecycle,
          createdLifecycle: createdNode?.lifecycle, revisionCountBefore: beforeRevisions,
          revisionCountAfter: after.entries.filter(entry => entry.kind === 'revision').length });

        if (kind === 'replace') {
          let historicalActionPosts = 0;
          let historicalTransformPreviews = 0;
          page.on('request', request => {
            if (request.method() !== 'POST') return;
            const pathname = new URL(request.url()).pathname;
            if (pathname.endsWith('/api/files/version-center/v1/proposals/actions')) historicalActionPosts += 1;
            if (pathname.endsWith('/api/files/version-center/v1/proposals/transform/preview')) historicalTransformPreviews += 1;
          });
          const actionsBeforeHistorical = historicalActionPosts;
          const previewsBeforeHistorical = historicalTransformPreviews;
          const historicalGraph = await openReview(page, { workspaceId, lineageId: graphFixture.scope.lineageId,
            operationId: proposalB.operationId });
          await expect(historicalGraph.getByTestId('graph-review-historical-status')).toContainText('Superseded');
          await expect(historicalGraph.getByTestId('graph-review-blocked')).toHaveCount(0);
          expect(new URL(page.url()).searchParams.get('fvrcSelectedId')).toBe(proposalB.operationId);
          await expect(historicalGraph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
          await expect(historicalGraph.getByRole('button', { name: 'Reject proposal', exact: true })).toHaveCount(0);
          await expect(historicalGraph.getByRole('button', { name: 'Reject branch', exact: true })).toHaveCount(0);
          await expect(historicalGraph.getByRole('button', { name: 'Mark as already present', exact: true })).toHaveCount(0);
          for (const name of ['Check a separate proposal', 'Check a replacement proposal against the current document']) {
            const transformButton = historicalGraph.getByRole('button', { name, exact: true });
            if (await transformButton.count()) await expect(transformButton).toBeDisabled();
          }
          await expect(historicalGraph.getByTestId('graph-review-transform-preview')).toHaveCount(0);
          expect(await content(context.request, workspaceId, filePath)).toBe(AFTER_A_TEXT);
          expect((await timeline(context.request, workspaceId, filePath)).entries.filter(entry => entry.kind === 'revision'))
            .toHaveLength(after.entries.filter(entry => entry.kind === 'revision').length);

          await page.reload();
          const reloadedHistoricalGraph = page.getByTestId('graph-review-comparison');
          await expect(reloadedHistoricalGraph).toBeVisible({ timeout: 30_000 });
          await expect(reloadedHistoricalGraph.getByTestId('graph-review-historical-status')).toContainText('Superseded');
          await expect(reloadedHistoricalGraph.getByTestId('graph-review-blocked')).toHaveCount(0);
          expect(new URL(page.url()).searchParams.get('fvrcSelectedId')).toBe(proposalB.operationId);
          await expect(reloadedHistoricalGraph.getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
          await expect(reloadedHistoricalGraph.getByRole('button', { name: 'Reject proposal', exact: true })).toHaveCount(0);
          await expect(reloadedHistoricalGraph.getByRole('button', { name: 'Reject branch', exact: true })).toHaveCount(0);
          await expect(reloadedHistoricalGraph.getByRole('button', { name: 'Mark as already present', exact: true })).toHaveCount(0);
          for (const name of ['Check a separate proposal', 'Check a replacement proposal against the current document']) {
            const transformButton = reloadedHistoricalGraph.getByRole('button', { name, exact: true });
            if (await transformButton.count()) await expect(transformButton).toBeDisabled();
          }
          await expect(reloadedHistoricalGraph.getByTestId('graph-review-transform-preview')).toHaveCount(0);
          expect(historicalActionPosts).toBe(actionsBeforeHistorical);
          expect(historicalTransformPreviews).toBe(previewsBeforeHistorical);
          expect(await content(context.request, workspaceId, filePath)).toBe(AFTER_A_TEXT);
          expect((await timeline(context.request, workspaceId, filePath)).entries.filter(entry => entry.kind === 'revision'))
            .toHaveLength(after.entries.filter(entry => entry.kind === 'revision').length);
        }

        const createdGraph = await openReview(page, { workspaceId, lineageId: graphFixture.scope.lineageId,
          operationId: preview.prepared.creation.operationId });
        await expect(createdGraph.getByRole('button', { name: 'Accept change' })).toBeEnabled();
        const accepted = await accept(createdGraph, page);
        expect(accepted.affectedProposalIds).toContain(preview.prepared.creation.proposalId);
        await expect.poll(() => content(context.request, workspaceId!, filePath), { timeout: 30_000 })
          .toBe(AFTER_A_TEXT.replace('B0', 'B1'));
        const afterAccept = await timeline(context.request, workspaceId, filePath);
        expect(afterAccept.entries.filter(entry => entry.kind === 'revision')).toHaveLength(beforeRevisions + 1);
        expect(afterAccept.entries.filter(entry => entry.kind === 'revision' && entry.source === 'agent_apply'))
          .toHaveLength(beforeApplied + 1);
        await attachJson(testInfo, `${kind}-accepted-receipt.json`, { actionType: accepted.actionType,
          phase: accepted.phase, affectedProposalIds: accepted.affectedProposalIds, result: accepted.result,
          revisionCountAfterAcceptance: afterAccept.entries.filter(entry => entry.kind === 'revision').length });
      } finally {
        if (uploaded && workspaceId) {
          const deleted = await context.request.delete('/api/files/delete', {
            headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
          });
          expect(deleted.ok(), `Could not remove the dedicated ${kind} fixture.`).toBeTruthy();
        }
        await context.close();
        assertNoServerErrors();
      }
    });
  }
});
