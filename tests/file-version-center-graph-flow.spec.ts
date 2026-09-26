import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewGraphSessionV1, ProposalReviewActionStatusResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const execFileAsync = promisify(execFile);
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const BASE_TEXT = '# Graph flow fixture\n\nA0|B0\n';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';
const STATUS_PATH = `${ACTION_PATH}/status`;

type Fixture = { scope: { workspaceId: string; lineageId: string; documentId: string };
  proposals: Array<{ label: string; proposalId: string; operationId: string }>; choiceGroupId: string };
type Workspace = { id: string; type: string; legacy?: boolean;
  permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean } };
type TestScope = { context: BrowserContext; page: Page; workspaceId: string; filePath: string; fixture: Fixture };
type Timeline = { entries: Array<{ kind: string; source?: string; revisionId?: string; id?: string }> };

function proposal(fixture: Fixture, label: string): Fixture['proposals'][number] {
  const item = fixture.proposals.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`Fixture proposal ${label} is missing.`);
  return item;
}

async function createFixture(input: { userId: string; role: string; workspaceId: string; documentId: string; filePath: string }): Promise<Fixture> {
  if (!/^(owner|admin|member|external)$/u.test(input.role)) throw new Error('The authenticated actor role is unavailable.');
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
  let stdout: string;
  try {
    const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
      '--conditions', 'react-server', 'scripts/fvrc-1006-graph-flow-fixture.ts', encoded,
    ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 });
    stdout = String(result.stdout);
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr : '';
    const code = /FVRC_GRAPH_FLOW_FIXTURE_CODE=([A-Z][A-Z0-9_]{0,79})/u.exec(stderr)?.[1] ?? 'UNKNOWN';
    throw new Error(`The dedicated graph flow fixture failed (${code}); process arguments and stderr are redacted.`);
  }
  for (const line of stdout.trim().split('\n').reverse()) {
    try { return JSON.parse(line) as Fixture; } catch { /* Only the final driver receipt is JSON. */ }
  }
  throw new Error('The dedicated graph flow fixture returned no receipt.');
}

async function withFixture(browser: Browser, run: (scope: TestScope) => Promise<void>): Promise<void> {
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
  const assertNoServerErrors = observeProposalReviewServerErrors(context);
  const page = await context.newPage();
  const filePath = `fvrc-1006-${randomUUID()}.md`;
  let workspaceId: string | null = null;
  let uploaded = false;
  try {
    const sessionResponse = await context.request.get('/api/auth/get-session');
    const session = await sessionResponse.json() as { user?: { id?: string; role?: string } };
    expect(sessionResponse.ok()).toBeTruthy();
    expect(session.user?.id).toBeTruthy();
    const workspaceResponse = await context.request.get('/api/workspaces');
    const workspaceBody = await workspaceResponse.json() as { workspaces?: Workspace[] };
    expect(workspaceResponse.ok()).toBeTruthy();
    const workspace = workspaceBody.workspaces?.find((candidate) => candidate.type === 'personal' && !candidate.legacy
      && candidate.permissions.canRead && candidate.permissions.canWrite && candidate.permissions.canRunAgent);
    expect(workspace, 'A writable Personal workspace is required.').toBeTruthy();
    workspaceId = workspace!.id;
    await context.addInitScript((id) => {
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
    expect(collaboration.ok(), collaborationBody.error ?? 'Could not initialize the fixture document.').toBeTruthy();
    expect(collaborationBody.documentId).toBeTruthy();
    const fixture = await createFixture({ userId: session.user!.id!, role: session.user!.role ?? 'member',
      workspaceId, documentId: collaborationBody.documentId!, filePath });
    expect(fixture.scope.workspaceId).toBe(workspaceId);
    expect(fixture.scope.documentId).toBe(collaborationBody.documentId);
    expect(fixture.proposals.map((item) => item.label)).toEqual(['A', 'B1', 'B2']);
    await run({ context, page, workspaceId, filePath, fixture });
  } finally {
    try {
      if (uploaded && workspaceId) {
        const deleted = await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.ok(), 'Could not remove the dedicated graph flow fixture.').toBeTruthy();
      }
    } finally {
      await context.close();
      assertNoServerErrors();
    }
  }
}

async function review(scope: TestScope, operationId: string): Promise<ProposalReviewGraphSessionV1> {
  const response = await scope.context.request.post('/api/files/version-center/v1/proposals/review', {
    headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId },
    data: { contractVersion: 1, target: { kind: 'document', workspaceId: scope.workspaceId,
      documentId: scope.fixture.scope.documentId }, selection: { kind: 'operation', operationId } },
  });
  const body = await response.json() as ProposalReviewGraphSessionV1 & { error?: { message?: string } };
  expect(response.ok(), body.error?.message ?? 'Could not read the exact graph review.').toBeTruthy();
  expect(body.mode).toBe('graph');
  return body;
}

function reviewLink(scope: TestScope, operationId: string): string {
  const request: FileVersionCenterRequestV1 = { contractVersion: 1,
    target: { kind: 'lineage', workspaceId: scope.workspaceId, lineageId: scope.fixture.scope.lineageId },
    selectedEntry: { kind: 'agent_operation', id: operationId }, initialView: 'reviews', source: 'deep_link' };
  return buildFileVersionCenterDeepLinkV1('/en', request);
}

async function openReview(scope: TestScope, operationId: string) {
  await scope.page.goto(reviewLink(scope, operationId));
  const graph = scope.page.getByTestId('graph-review-comparison');
  await expect(graph).toBeVisible({ timeout: 30_000 });
  return graph;
}

async function content(scope: TestScope): Promise<string> {
  const response = await scope.context.request.get('/api/files/read', {
    headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId }, params: { path: scope.filePath },
  });
  const body = await response.json() as { data?: { content?: string }; error?: string };
  expect(response.ok(), body.error ?? 'Could not read the fixture document.').toBeTruthy();
  return body.data?.content ?? '';
}

async function revisionCount(scope: TestScope): Promise<number> {
  const response = await scope.context.request.post('/api/files/version-center/v1/resolve', {
    headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId },
    data: { contractVersion: 1, target: { kind: 'path', workspaceId: scope.workspaceId, pathHint: scope.filePath },
      initialView: 'history', source: 'file_browser' },
  });
  const body = await response.json() as Timeline & { error?: { message?: string } };
  expect(response.ok(), body.error?.message ?? 'Could not read the fixture timeline.').toBeTruthy();
  return body.entries.filter((entry) => entry.kind === 'revision').length;
}

async function confirmAction(graph: ReturnType<Page['getByTestId']>, page: Page, name: string): Promise<ProposalActionReceiptV1> {
  await graph.getByRole('button', { name }).click();
  await expect(graph.getByTestId('graph-review-confirmation')).toBeVisible();
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === ACTION_PATH);
  await graph.getByRole('button', { name: 'Confirm action' }).click();
  const response = await responsePromise;
  const body = await response.text();
  expect(response.ok(), `Graph action failed (${response.status()}): ${body.slice(0, 500)}`).toBeTruthy();
  return JSON.parse(body) as ProposalActionReceiptV1;
}

test.describe('FVRC-1006 dependency, choice, and recovery browser flows', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the authorized managed local graph-review browser stack.');
  test.setTimeout(180_000);

  test('parent-only acceptance leaves both child alternatives open and the chosen child has a separate remaining diff', async ({ browser }, testInfo) => {
    await withFixture(browser, async (scope) => {
      const parent = proposal(scope.fixture, 'A');
      const chosen = proposal(scope.fixture, 'B1');
      const alternative = proposal(scope.fixture, 'B2');
      const beforeRevisions = await revisionCount(scope);

      // An explicit all-alternatives selection must never silently choose one.
      const ambiguousResponse = await scope.context.request.post('/api/files/version-center/v1/proposals/review', {
        headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId },
        data: { contractVersion: 1, target: { kind: 'document', workspaceId: scope.workspaceId,
          documentId: scope.fixture.scope.documentId },
        selection: { kind: 'proposals', proposalIds: [chosen.proposalId, alternative.proposalId] } },
      });
      const ambiguous = await ambiguousResponse.json() as ProposalReviewGraphSessionV1;
      expect(ambiguousResponse.ok()).toBeTruthy();
      expect(ambiguous.reasonCode).toBe(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict);
      expect(ambiguous.actions.accept).toBeUndefined();

      const parentSession = await review(scope, parent.operationId);
      expect(parentSession.actions.accept?.fence.applyProposalIds).toEqual([parent.proposalId]);
      expect(parentSession.actions.accept?.fence.choiceResolutions).toEqual([]);
      const parentGraph = await openReview(scope, parent.operationId);
      const parentReceipt = await confirmAction(parentGraph, scope.page, 'Accept change');
      expect(parentReceipt.phase).toBe('succeeded');
      expect(parentReceipt.affectedProposalIds).toEqual([parent.proposalId]);
      await expect.poll(() => content(scope), { timeout: 30_000 }).toBe('# Graph flow fixture\n\nA1|B0\n');
      expect(await revisionCount(scope)).toBe(beforeRevisions + 1);

      const childSession = await review(scope, chosen.operationId);
      expect(childSession.selectedProposalIds).toEqual([chosen.proposalId]);
      expect(childSession.context?.dependencyProposalIds).toEqual([parent.proposalId]);
      expect(childSession.context?.applyProposalIds).toEqual([chosen.proposalId]);
      expect(childSession.context?.closingAlternativeProposalIds).toEqual([alternative.proposalId]);
      expect(childSession.context?.proposals.find((item) => item.proposalId === chosen.proposalId)?.lifecycle).toBe('open');
      expect(childSession.context?.proposals.find((item) => item.proposalId === alternative.proposalId)?.lifecycle).toBe('open');
      expect(childSession.actions.accept?.fence.applyProposalIds).toEqual([chosen.proposalId]);
      expect(childSession.compare?.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === 'deletion').map((line) => line.text)))
        .toContain('A1|B0');
      expect(childSession.compare?.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === 'addition').map((line) => line.text)))
        .toContain('A1|B1');
      await testInfo.attach('parent-first-child-rest-diff.json', { body: JSON.stringify({
        selectedProposalIds: childSession.selectedProposalIds,
        dependencyProposalIds: childSession.context?.dependencyProposalIds,
        applyProposalIds: childSession.context?.applyProposalIds,
        closingAlternativeProposalIds: childSession.context?.closingAlternativeProposalIds,
        comparisonSummary: childSession.compare?.summary,
      }, null, 2), contentType: 'application/json' });

      const childGraph = await openReview(scope, chosen.operationId);
      const childReceipt = await confirmAction(childGraph, scope.page, 'Accept change');
      expect(childReceipt.phase).toBe('succeeded');
      expect(childReceipt.actionType).toBe('accept');
      expect(childReceipt.result?.resolutions).toEqual(expect.arrayContaining([
        { proposalId: chosen.proposalId, lifecycle: 'applied' },
        { proposalId: alternative.proposalId, lifecycle: 'alternative_not_selected' },
      ]));
      await expect.poll(() => content(scope), { timeout: 30_000 }).toBe('# Graph flow fixture\n\nA1|B1\n');
      expect(await revisionCount(scope)).toBe(beforeRevisions + 2);
    });
  });

  test('selected child includes its parent, closes the unchosen alternative, and leaves closed links read-only', async ({ browser }, testInfo) => {
    await withFixture(browser, async (scope) => {
      const parent = proposal(scope.fixture, 'A');
      const chosen = proposal(scope.fixture, 'B1');
      const alternative = proposal(scope.fixture, 'B2');
      const beforeRevisions = await revisionCount(scope);
      const parentSession = await review(scope, parent.operationId);
      expect(parentSession.selectedProposalIds).toEqual([parent.proposalId]);
      expect(parentSession.context?.applyProposalIds).toEqual([parent.proposalId]);
      expect(parentSession.context?.closingAlternativeProposalIds).toEqual([]);
      const childSession = await review(scope, chosen.operationId);
      expect(childSession.selectedProposalIds).toEqual([chosen.proposalId]);
      expect(childSession.context?.dependencyProposalIds).toEqual([parent.proposalId]);
      expect(childSession.context?.applyProposalIds).toEqual([parent.proposalId, chosen.proposalId]);
      expect(childSession.context?.closingAlternativeProposalIds).toEqual([alternative.proposalId]);
      expect(childSession.context?.proposals.find((item) => item.proposalId === chosen.proposalId)?.relationships.choiceGroupId)
        .toBe(scope.fixture.choiceGroupId);
      expect(childSession.context?.proposals.find((item) => item.proposalId === alternative.proposalId)?.relationships.choiceGroupId)
        .toBe(scope.fixture.choiceGroupId);
      expect(childSession.actions.accept?.fence.choiceResolutions[0]?.closingProposalIds).toEqual([alternative.proposalId]);

      const graph = await openReview(scope, chosen.operationId);
      await expect(graph.getByTestId('graph-review-context')).toContainText('1 prerequisite included');
      await expect(graph.getByTestId('graph-review-context')).toContainText('1 alternative closes');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('A1');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('B1');
      await testInfo.attach('child-choice-preview.png', { body: await scope.page.screenshot({ fullPage: true }), contentType: 'image/png' });
      const receipt = await confirmAction(graph, scope.page, 'Accept change');
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.actionType).toBe('accept');
      expect(receipt.result?.kind).toBe('content_changed');
      expect(receipt.affectedProposalIds.slice().sort()).toEqual([parent.proposalId, chosen.proposalId, alternative.proposalId].sort());
      expect(receipt.result?.resolutions).toEqual(expect.arrayContaining([
        { proposalId: parent.proposalId, lifecycle: 'included' },
        { proposalId: chosen.proposalId, lifecycle: 'applied' },
        { proposalId: alternative.proposalId, lifecycle: 'alternative_not_selected' },
      ]));
      await expect.poll(() => content(scope), { timeout: 30_000 }).toBe('# Graph flow fixture\n\nA1|B1\n');
      expect(await revisionCount(scope)).toBe(beforeRevisions + 1);

      const parentClosed = await review(scope, parent.operationId);
      const chosenClosed = await review(scope, chosen.operationId);
      const alternativeClosed = await review(scope, alternative.operationId);
      expect(parentClosed.context?.proposals.find((item) => item.proposalId === parent.proposalId)?.lifecycle).toBe('included');
      expect(chosenClosed.context?.proposals.find((item) => item.proposalId === chosen.proposalId)?.lifecycle).toBe('applied');
      expect(alternativeClosed.context?.proposals.find((item) => item.proposalId === alternative.proposalId)?.lifecycle).toBe('alternative_not_selected');
      for (const closed of [parentClosed, chosenClosed, alternativeClosed]) expect(Object.keys(closed.actions)).toHaveLength(0);
      const closedGraph = await openReview(scope, alternative.operationId);
      await expect(closedGraph.getByRole('button', { name: /Accept change|Reject branch|Reject proposal|Mark as already present/u })).toHaveCount(0);
      await testInfo.attach('closed-choice-readonly.png', { body: await scope.page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
  });

  test('reject branch closes the selected parent and both dependent alternatives without a live write', async ({ browser }, testInfo) => {
    await withFixture(browser, async (scope) => {
      const parent = proposal(scope.fixture, 'A');
      const affected = scope.fixture.proposals.map((item) => item.proposalId).sort();
      const beforeRevisions = await revisionCount(scope);
      const graph = await openReview(scope, parent.operationId);
      await expect(graph.getByRole('button', { name: 'Reject branch' })).toBeEnabled();
      const parentSession = await review(scope, parent.operationId);
      expect(parentSession.actions.branchReject?.fence.closure.map((item) => item.proposalId).sort()).toEqual(affected);
      await graph.getByRole('button', { name: 'Reject branch' }).click();
      await expect(graph.getByTestId('graph-review-confirmation')).toContainText('2 related branch members');
      const responsePromise = scope.page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === ACTION_PATH);
      await graph.getByRole('button', { name: 'Confirm action' }).click();
      const response = await responsePromise;
      const body = await response.text();
      expect(response.ok(), `Branch rejection failed (${response.status()}): ${body.slice(0, 500)}`).toBeTruthy();
      const receipt = JSON.parse(body) as ProposalActionReceiptV1;
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.actionType).toBe('branch_reject');
      expect(receipt.result?.kind).toBe('metadata_only');
      expect(receipt.result?.revisionId).toBeNull();
      expect(receipt.affectedProposalIds.slice().sort()).toEqual(affected);
      expect(receipt.result?.resolutions.slice().sort((left, right) => left.proposalId.localeCompare(right.proposalId)))
        .toEqual(affected.map((proposalId) => ({ proposalId, lifecycle: 'rejected' })));
      expect(await content(scope)).toBe(BASE_TEXT);
      expect(await revisionCount(scope)).toBe(beforeRevisions);
      for (const item of scope.fixture.proposals) {
        const closed = await review(scope, item.operationId);
        expect(closed.context?.proposals.find((node) => node.proposalId === item.proposalId)?.lifecycle).toBe('rejected');
        expect(Object.keys(closed.actions)).toHaveLength(0);
      }
      await testInfo.attach('branch-reject-receipt.json', { body: JSON.stringify({ phase: receipt.phase,
        actionType: receipt.actionType, affectedProposalIds: receipt.affectedProposalIds,
        revisionCountBefore: beforeRevisions, revisionCountAfter: await revisionCount(scope) }, null, 2),
      contentType: 'application/json' });
    });
  });

  test('lost HTTP response recovers by status after closing and reopening without a second apply', async ({ browser }, testInfo) => {
    await withFixture(browser, async (scope) => {
      const parent = proposal(scope.fixture, 'A');
      const beforeRevisions = await revisionCount(scope);
      let actionPosts = 0;
      let statusReads = 0;
      let allowStatus = false;
      const appliedReceipt: { current: ProposalActionReceiptV1 | null } = { current: null };
      await scope.page.route((url) => url.pathname === STATUS_PATH, async (route) => {
        statusReads += 1;
        if (allowStatus) await route.continue();
        else await route.abort();
      });
      await scope.page.route((url) => url.pathname === ACTION_PATH, async (route) => {
        actionPosts += 1;
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        appliedReceipt.current = await response.json() as ProposalActionReceiptV1;
        // The durable server action completed; only its browser response is lost.
        await route.abort();
      });
      const graph = await openReview(scope, parent.operationId);
      await graph.getByRole('button', { name: 'Accept change' }).click();
      await expect(graph.getByTestId('graph-review-confirmation')).toBeVisible();
      await graph.getByRole('button', { name: 'Confirm action' }).click();
      await expect.poll(() => appliedReceipt.current?.phase, { timeout: 30_000 }).toBe('succeeded');
      expect(appliedReceipt.current?.actionType).toBe('accept');
      expect(appliedReceipt.current?.affectedProposalIds).toEqual([parent.proposalId]);
      expect(appliedReceipt.current?.result?.kind).toBe('content_changed');
      expect(actionPosts).toBe(1);
      await expect.poll(() => content(scope), { timeout: 30_000 }).toBe('# Graph flow fixture\n\nA1|B0\n');
      expect(await revisionCount(scope)).toBe(beforeRevisions + 1);

      // Closing the center navigates away but retains this tab's safe status identity.
      await scope.page.goto('/en');
      allowStatus = true;
      const recoveredResponse = scope.page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === STATUS_PATH && response.ok());
      await scope.page.goto(reviewLink(scope, parent.operationId));
      const recovered = await recoveredResponse;
      const status = await recovered.json() as ProposalReviewActionStatusResponseV1;
      expect(status.receipt?.phase).toBe('succeeded');
      expect(status.receipt?.actionId).toBe(appliedReceipt.current?.actionId);
      expect(status.receipt?.requestDigest).toBe(appliedReceipt.current?.requestDigest);
      expect(status.receipt?.result).toEqual(appliedReceipt.current?.result);
      expect(statusReads).toBeGreaterThan(0);
      await expect(scope.page.getByTestId('graph-review-pending-action')).toHaveCount(0, { timeout: 30_000 });
      expect(actionPosts).toBe(1);
      expect(await revisionCount(scope)).toBe(beforeRevisions + 1);
      await testInfo.attach('lost-reply-status-receipt.json', { body: JSON.stringify({
        actionId: status.receipt?.actionId, phase: status.receipt?.phase,
        actionPosts, statusReads, revisionCountBefore: beforeRevisions,
        revisionCountAfter: await revisionCount(scope),
      }, null, 2), contentType: 'application/json' });
    });
  });
});
