import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewSummaryResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-summary-v1';
import {
  createAuthenticatedContext,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const execFileAsync = promisify(execFile);
const BASE_TEXT = '# Proposal review fixture\n\nPlan: 100 USD.\n';
const BATCH_BASE_TEXT = '# Proposal batch fixture\n\nA0|B0|C0|D0|E0|F0|G0|H0|I0|J0\n';
const BATCH_FINAL_TEXT = '# Proposal batch fixture\n\nA1|B1|C1|D1|E1|F1|G1|H1|I1|J1\n';
const LARGE_BATCH_BASE_TEXT = `# Proposal paginated fixture\n\n${Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}0`).join('|')}|LATE_PENDING\n`;
const LARGE_BATCH_FINAL_TEXT = `# Proposal paginated fixture\n\n${Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}1`).join('|')}|LATE_PENDING\n`;

type Workspace = {
  id: string;
  type: string;
  name?: string;
  legacy?: boolean;
  permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean };
};
type AuthPayload = { user?: { id?: string; role?: string } | null };
type Fixture = {
  contractVersion: 1;
  scope: { workspaceId: string; lineageId: string; documentId: string; lifecycleGeneration: number; schemaVersion: number };
  proposals: Array<{ label: string; proposalId: string; operationId: string; candidateHash: string }>;
};
type Timeline = { entries: Array<{ kind: string; source?: string; id?: string; revisionId?: string }>;
  page?: { hasMore: boolean; nextCursor: string | null } };
type ReviewSession = { mode: 'legacy' } | {
  mode: 'graph'; status: string; compare: { candidate: { noEffect: boolean } } | null;
  selectedProposalIds?: string[];
  context?: { proposals: Array<{ proposalId: string; lifecycle: string }> } | null;
};

function enabled(): boolean {
  return process.env.COLLABORATION_E2E === '1';
}

function agentApplyRevisionCount(value: Timeline): number {
  return value.entries.filter((entry) => entry.kind === 'revision' && entry.source === 'agent_apply').length;
}

function revisionCount(value: Timeline): number {
  return value.entries.filter((entry) => entry.kind === 'revision').length;
}

async function expectReviewReady(graph: import('@playwright/test').Locator): Promise<void> {
  await expect(graph.getByText('Ready to apply').or(graph.getByText('Ready after rebase'))).toBeVisible();
}

async function acceptReviewedAction(input: {
  graph: import('@playwright/test').Locator;
  page: import('@playwright/test').Page;
  testInfo: import('@playwright/test').TestInfo;
  evidenceName: string;
}): Promise<ProposalActionReceiptV1> {
  await input.graph.getByRole('button', { name: 'Accept change' }).or(
    input.graph.getByRole('button', { name: 'Accept all changes' })).click();
  const responsePromise = input.page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions'));
  await input.graph.getByRole('button', { name: 'Confirm action' }).click();
  const response = await responsePromise;
  const responseBody = await response.text();
  expect(response.ok(), `Graph action failed (${response.status()}): ${responseBody.slice(0, 700)}`).toBeTruthy();
  const receipt = JSON.parse(responseBody) as ProposalActionReceiptV1;
  expect(receipt.phase).toBe('succeeded');
  expect(receipt.result?.kind).toBe('content_changed');
  await input.testInfo.attach(`${input.evidenceName}-receipt.json`, {
    body: JSON.stringify({ actionId: receipt.actionId, actionType: receipt.actionType, phase: receipt.phase,
      affectedProposalIds: receipt.affectedProposalIds, result: receipt.result }, null, 2),
    contentType: 'application/json',
  });
  return receipt;
}

async function runIndependentBatchWorkspace(input: {
  context: BrowserContext;
  page: import('@playwright/test').Page;
  testInfo: import('@playwright/test').TestInfo;
  userId: string;
  role: string;
  workspace: Workspace;
  mode: 'three-plus-seven' | 'all-ten';
}): Promise<void> {
  const { context, page, testInfo, userId, role, workspace, mode } = input;
  const filePath = `fvrc-1006-${randomUUID()}.md`;
  let uploaded = false;
  try {
    await context.addInitScript((id) => {
      window.localStorage.setItem('canvas.activeWorkspaceId', id);
      window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspace.id);
    await uploadWorkspaceTextFile({ request: context.request, workspaceId: workspace.id,
      filePath, content: BATCH_BASE_TEXT });
    uploaded = true;
    const session = await context.request.post('/api/files/collaboration/session', {
      headers: { [WORKSPACE_ID_HEADER]: workspace.id },
      data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
    });
    const sessionPayload = await session.json() as { success?: boolean; documentId?: string; error?: string };
    expect(session.ok(), sessionPayload.error ?? `Could not initialize ${workspace.type} fixture collaboration.`).toBeTruthy();
    expect(sessionPayload.documentId).toBeTruthy();

    const fixture = await createFixture({ scenario: 'batch', userId, role, workspaceId: workspace.id,
      documentId: sessionPayload.documentId!, filePath });
    expect(fixture.scope.workspaceId).toBe(workspace.id);
    expect(fixture.scope.documentId).toBe(sessionPayload.documentId);
    expect(fixture.proposals.map((proposal) => proposal.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);

    const beforeTimeline = await timeline(context.request, workspace.id, filePath);
    const beforeRevisionCount = revisionCount(beforeTimeline);
    const beforeAppliedCount = agentApplyRevisionCount(beforeTimeline);
    const receipts: ProposalActionReceiptV1[] = [];
    const singleLabels = mode === 'three-plus-seven' ? ['A', 'B', 'C'] : [];
    for (const label of singleLabels) {
      const proposal = fixture.proposals.find((candidate) => candidate.label === label)!;
      await openProposalReview({ page, href: '/en', workspaceId: workspace.id, lineageId: fixture.scope.lineageId,
        operationId: proposal.operationId });
      const graph = page.getByTestId('graph-review-comparison');
      await expectReviewReady(graph);
      await expect(graph.getByTestId('graph-review-hunks')).toContainText(`${label}1`);
      if (label === 'A') {
        await testInfo.attach(`${workspace.type}-single-preview.png`, {
          body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
        });
      }
      const receipt = await acceptReviewedAction({ graph, page, testInfo,
        evidenceName: `${workspace.type}-single-${label}` });
      expect(receipt.actionType).toBe('accept');
      expect(receipt.affectedProposalIds).toEqual([proposal.proposalId]);
      receipts.push(receipt);
    }

    const firstOpenProposal = fixture.proposals.find((candidate) => candidate.label === 'J')!;
    await openProposalReview({ page, href: '/en', workspaceId: workspace.id, lineageId: fixture.scope.lineageId,
      operationId: firstOpenProposal.operationId });
    const graph = page.getByTestId('graph-review-comparison');
    await expectReviewReady(graph);
    await graph.getByRole('button', { name: 'Review all changes' }).click();
    const batchCount = mode === 'three-plus-seven' ? 7 : 10;
    await expect(graph).toContainText(`${batchCount} proposals selected`);
    if (mode === 'three-plus-seven') await expect(graph.getByTestId('graph-review-hunks')).toContainText('D1');
    else await expect(graph.getByTestId('graph-review-hunks')).toContainText('A1');
    await expect(graph.getByTestId('graph-review-hunks')).toContainText('J1');
    await testInfo.attach(`${workspace.type}-batch-preview.png`, {
      body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
    });
    const batchReceipt = await acceptReviewedAction({ graph, page, testInfo,
      evidenceName: `${workspace.type}-batch-${batchCount}` });
    expect(batchReceipt.actionType).toBe('batch_accept');
    const expectedBatchIds = fixture.proposals.filter((proposal) => mode === 'all-ten'
      || !['A', 'B', 'C'].includes(proposal.label))
      .map((proposal) => proposal.proposalId).sort();
    expect(batchReceipt.affectedProposalIds.slice().sort()).toEqual(expectedBatchIds);
    receipts.push(batchReceipt);

    await expect.poll(() => fileContent(context.request, workspace.id, filePath), { timeout: 30_000 })
      .toBe(BATCH_FINAL_TEXT);
    const afterTimeline = await timeline(context.request, workspace.id, filePath);
    const expectedRevisionDelta = mode === 'three-plus-seven' ? 4 : 1;
    expect(agentApplyRevisionCount(afterTimeline)).toBe(beforeAppliedCount + expectedRevisionDelta);
    expect(revisionCount(afterTimeline)).toBe(beforeRevisionCount + expectedRevisionDelta);
    const actionRevisionIds = receipts.map((receipt) => {
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.result?.kind).toBe('content_changed');
      if (receipt.phase !== 'succeeded' || receipt.result.kind !== 'content_changed') {
        throw new Error('FVRC-1006 expected a successful content revision receipt.');
      }
      return receipt.result.revisionId;
    });
    expect(new Set(actionRevisionIds).size).toBe(expectedRevisionDelta);
    const timelineRevisionIds = afterTimeline.entries.filter((entry) => entry.kind === 'revision'
      && entry.source === 'agent_apply').map((entry) => entry.revisionId ?? entry.id).filter((id): id is string => Boolean(id));
    expect(timelineRevisionIds.slice().sort()).toEqual(actionRevisionIds.slice().sort());
  } finally {
    if (uploaded) {
      const deleted = await context.request.delete('/api/files/delete', {
        headers: { [WORKSPACE_ID_HEADER]: workspace.id }, data: { path: filePath },
      });
      expect(deleted.ok(), `Could not remove the FVRC-1006 fixture ${filePath}.`).toBeTruthy();
    }
  }
}

async function createFixture(input: {
  scenario: 'conflict' | 'same-effect' | 'batch' | 'large-batch' | 'append-late';
  userId: string;
  role: string;
  workspaceId: string;
  documentId: string;
  filePath: string;
}): Promise<Fixture> {
  if (!/^(owner|admin|member|external)$/u.test(input.role)) throw new Error('Authenticated user role is unavailable.');
  const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
      '--conditions', 'react-server', 'scripts/fvrc-1006-browser-fixture.ts', encoded,
    ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 });
  } catch {
    throw new Error('FVRC-1006 fixture driver failed; details are intentionally redacted.');
  }
  for (const line of String(result.stdout).trim().split('\n').reverse()) {
    try { return JSON.parse(line) as Fixture; } catch { /* only the driver JSON line is a fixture receipt */ }
  }
  throw new Error('FVRC-1006 proposal fixture returned no JSON receipt.');
}

async function timeline(request: APIRequestContext, workspaceId: string, filePath: string, cursor?: string): Promise<Timeline> {
  const response = await request.post('/api/files/version-center/v1/timeline', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { contractVersion: 1, target: { kind: 'path', workspaceId, pathHint: filePath }, ...(cursor ? { cursor } : {}) },
  });
  const payload = await response.json() as Timeline & { error?: { code?: string; message?: string } };
  expect(response.ok(), payload.error?.message ?? 'Could not read the file timeline.').toBeTruthy();
  return payload;
}

async function fullTimeline(request: APIRequestContext, workspaceId: string, filePath: string): Promise<Timeline> {
  let page = await timeline(request, workspaceId, filePath);
  const entries = [...page.entries];
  const seenCursors = new Set<string>();
  while (page.page?.hasMore) {
    const cursor = page.page.nextCursor;
    expect(cursor, 'A paginated timeline must provide its next cursor.').toBeTruthy();
    if (!cursor || seenCursors.has(cursor)) throw new Error('FVRC-1006 timeline pagination cursor repeated.');
    seenCursors.add(cursor);
    page = await timeline(request, workspaceId, filePath, cursor);
    entries.push(...page.entries);
  }
  return { ...page, entries };
}

async function fileContent(request: APIRequestContext, workspaceId: string, filePath: string): Promise<string> {
  const response = await request.get('/api/files/read', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId }, params: { path: filePath },
  });
  const payload = await response.json() as { data?: { content?: string }; error?: string };
  expect(response.ok(), payload.error ?? 'Could not read the fixture document.').toBeTruthy();
  return payload.data?.content ?? '';
}

async function reviewProposal(request: APIRequestContext, workspaceId: string, documentId: string,
  operationId: string): Promise<ReviewSession> {
  const response = await request.post('/api/files/version-center/v1/proposals/review', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { contractVersion: 1, target: { kind: 'document', workspaceId, documentId },
      selection: { kind: 'operation', operationId } },
  });
  const result = await response.json() as ReviewSession & { error?: { message?: string } };
  expect(response.ok(), result.error?.message ?? 'Could not inspect the created proposal.').toBeTruthy();
  return result;
}

async function openProposalReview(input: {
  page: import('@playwright/test').Page;
  href: string;
  workspaceId: string;
  lineageId: string;
  operationId: string;
}): Promise<void> {
  const request: FileVersionCenterRequestV1 = {
    contractVersion: 1,
    target: { kind: 'lineage', workspaceId: input.workspaceId, lineageId: input.lineageId },
    selectedEntry: { kind: 'agent_operation', id: input.operationId },
    initialView: 'reviews',
    source: 'deep_link',
  };
  await input.page.goto(buildFileVersionCenterDeepLinkV1(input.href, request));
  await expect(input.page.getByTestId('file-version-center')).toBeVisible();
  await expect(input.page.getByTestId('graph-review-comparison')).toBeVisible({ timeout: 30_000 });
}

test.describe('FVRC-1006 graph review actions', () => {
  test.skip(!enabled(), 'Set COLLABORATION_E2E=1 to run the managed local graph-review browser test.');
  test.setTimeout(180_000);

for (const acceptedLabel of ['C', 'B'] as const) {
  test(`accepts ${acceptedLabel} through the review UI and preserves a concrete conflict for ${acceptedLabel === 'C' ? 'B' : 'C'}`,
    async ({ browser }, testInfo) => {
    const context: BrowserContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const assertNoServerErrors = observeProposalReviewServerErrors(context);
    const page = await context.newPage();
    const suffix = randomUUID();
    const filePath = `fvrc-1006-${suffix}.md`;
    let actionPosts = 0;
    let workspaceId: string | null = null;
    let uploaded = false;
    try {
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions')) {
          actionPosts += 1;
        }
      });
      const sessionResponse = await context.request.get('/api/auth/get-session');
      const auth = await sessionResponse.json() as AuthPayload;
      expect(sessionResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await context.request.get('/api/workspaces');
      const workspacePayload = await workspaceResponse.json() as { workspaces?: Workspace[] };
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = workspacePayload.workspaces?.find((candidate) => candidate.type === 'personal'
        && !candidate.legacy && candidate.permissions.canRead && candidate.permissions.canWrite);
      expect(workspace, 'A writable, non-legacy personal workspace is required.').toBeTruthy();
      workspaceId = workspace!.id;
      await context.addInitScript((id) => {
        window.localStorage.setItem('canvas.activeWorkspaceId', id);
        window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: BASE_TEXT });
      uploaded = true;

      const session = await context.request.post('/api/files/collaboration/session', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      const sessionPayload = await session.json() as { success?: boolean; documentId?: string; error?: string };
      expect(session.ok(), sessionPayload.error ?? 'Could not initialize the fixture collaboration document.').toBeTruthy();
      expect(sessionPayload.documentId).toBeTruthy();

      const fixture = await createFixture({ scenario: 'conflict', userId: auth.user!.id!, role: auth.user!.role ?? 'member',
        workspaceId, documentId: sessionPayload.documentId!, filePath });
      expect(fixture.contractVersion).toBe(1);
      expect(fixture.scope.workspaceId).toBe(workspaceId);
      expect(fixture.scope.documentId).toBe(sessionPayload.documentId);
      expect(fixture.proposals.map((proposal) => proposal.label)).toEqual(['B', 'C']);
      const proposalB = fixture.proposals.find((proposal) => proposal.label === 'B')!;
      const proposalC = fixture.proposals.find((proposal) => proposal.label === 'C')!;
      const acceptedProposal = acceptedLabel === 'C' ? proposalC : proposalB;
      const remainingProposal = acceptedLabel === 'C' ? proposalB : proposalC;
      const acceptedValue = acceptedLabel === 'C' ? '130' : '120';

      const beforeTimeline = await timeline(context.request, workspaceId, filePath);
      const beforeRevisionCount = revisionCount(beforeTimeline);
      const beforeAppliedRevisionCount = agentApplyRevisionCount(beforeTimeline);
      await openProposalReview({ page, href: '/en', workspaceId, lineageId: fixture.scope.lineageId,
        operationId: acceptedProposal.operationId });
      const graph = page.getByTestId('graph-review-comparison');
      await expect(graph.getByText('Ready to apply')).toBeVisible();
      await expect(graph.getByTestId('graph-review-hunks')).toContainText(acceptedValue);

      await graph.getByRole('button', { name: 'Review all changes' }).click();
      await expect(graph).toContainText('2 proposals selected');
      await expect(graph.getByTestId('graph-review-blocked')).toBeVisible();
      await expect(graph.getByTestId('graph-review-blocked')).toContainText('Conflicting changes');
      await expect(graph.getByRole('button', { name: /^Accept (change|all changes)$/u })).toHaveCount(0);
      await expect(graph.getByRole('button', { name: 'Confirm action' })).toHaveCount(0);
      expect(actionPosts, 'Reviewing a conflicted B+C selection must not POST an action.').toBe(0);
      expect(await fileContent(context.request, workspaceId, filePath)).toBe(BASE_TEXT);
      const blockedTimeline = await timeline(context.request, workspaceId, filePath);
      expect(revisionCount(blockedTimeline)).toBe(beforeRevisionCount);
      expect(agentApplyRevisionCount(blockedTimeline)).toBe(beforeAppliedRevisionCount);

      // Re-open C explicitly after proving the aggregate B+C selection is blocked.
      await openProposalReview({ page, href: '/en', workspaceId, lineageId: fixture.scope.lineageId,
        operationId: acceptedProposal.operationId });
      const acceptedGraph = page.getByTestId('graph-review-comparison');
      await expect(acceptedGraph.getByText('Ready to apply')).toBeVisible();
      await expect(acceptedGraph.getByTestId('graph-review-hunks')).toContainText(acceptedValue);
      await testInfo.attach(`personal-conflict-${acceptedLabel}-preview.png`, {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });
      const actionReceipt = await acceptReviewedAction({ graph: acceptedGraph, page, testInfo,
        evidenceName: `personal-conflict-${acceptedLabel}` });
      expect(actionReceipt.phase).toBe('succeeded');
      expect(actionReceipt.affectedProposalIds).toEqual([acceptedProposal.proposalId]);

      await expect.poll(() => fileContent(context.request, workspaceId!, filePath), { timeout: 30_000 })
        .toBe(`# Proposal review fixture\n\nPlan: ${acceptedValue} USD.\n`);
      const afterTimeline = await timeline(context.request, workspaceId, filePath);
      expect(revisionCount(afterTimeline)).toBe(beforeRevisionCount + 1);
      expect(agentApplyRevisionCount(afterTimeline)).toBe(beforeAppliedRevisionCount + 1);

      const currentCard = page.locator('button[data-entry-kind="current"]');
      await currentCard.click();
      await expect(currentCard).toHaveAttribute('aria-pressed', 'true');
      const remainingSummaryCard = page.locator(`button[data-operation-id="${remainingProposal.operationId}"]`);
      await expect(remainingSummaryCard).toHaveAttribute('aria-pressed', 'false');
      await expect(remainingSummaryCard).toHaveAttribute('data-entry-status', 'conflicted', { timeout: 30_000 });
      await expect(remainingSummaryCard).toContainText('Conflicting changes');
      await testInfo.attach(`personal-conflict-${acceptedLabel}-remaining-unselected.png`, {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });

      const remainingSession = await reviewProposal(context.request, workspaceId, fixture.scope.documentId,
        remainingProposal.operationId);
      expect(remainingSession.mode).toBe('graph');
      if (remainingSession.mode !== 'graph') throw new Error('Remaining proposal unexpectedly fell back to the legacy review path.');
      expect(remainingSession.status).toBe('conflicted');
      expect(remainingSession.compare?.candidate.noEffect).not.toBe(true);

      await openProposalReview({ page, href: '/en', workspaceId, lineageId: fixture.scope.lineageId,
        operationId: remainingProposal.operationId });
      const remainingGraph = page.getByTestId('graph-review-comparison');
      await expect(remainingGraph.getByTestId('graph-review-blocked')).toContainText('Conflicting changes');
      await expect(remainingGraph).not.toContainText('No remaining change');
      await expect(remainingGraph.getByRole('button', { name: /^Accept (change|all changes)$/u })).toHaveCount(0);
      await expect(remainingGraph).not.toContainText(/\+0|−0/u);
      await testInfo.attach(`personal-conflict-${acceptedLabel}-remaining-blocked.png`, {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });
      expect(await fileContent(context.request, workspaceId, filePath))
        .toBe(`# Proposal review fixture\n\nPlan: ${acceptedValue} USD.\n`);
    } finally {
      if (uploaded && workspaceId) {
        const deleted = await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.ok(), `Could not remove the FVRC-1006 fixture ${filePath}.`).toBeTruthy();
      }
      await context.close();
      assertNoServerErrors();
    }
    });
}

  test('ignores a delayed B review response after selection changes to C', async ({ browser }, testInfo) => {
    const context: BrowserContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const assertNoServerErrors = observeProposalReviewServerErrors(context);
    const page = await context.newPage();
    const filePath = `fvrc-1006-${randomUUID()}.md`;
    let workspaceId: string | null = null;
    let uploaded = false;
    let proposalBOperationId: string | null = null;
    let actionPosts = 0;
    let oldResponseFetched = false;
    let oldResponseStatus: number | null = null;
    let notifyOldResponseFetched!: () => void;
    const oldResponseFetchedPromise = new Promise<void>((resolve) => { notifyOldResponseFetched = resolve; });
    let releaseOldResponse!: () => void;
    const oldResponseReleasePromise = new Promise<void>((resolve) => { releaseOldResponse = resolve; });
    let notifyOldRouteFinished!: () => void;
    const oldRouteFinishedPromise = new Promise<void>((resolve) => { notifyOldRouteFinished = resolve; });

    try {
      page.on('request', (request) => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions')) actionPosts += 1;
      });
      const sessionResponse = await context.request.get('/api/auth/get-session');
      const auth = await sessionResponse.json() as AuthPayload;
      expect(sessionResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await context.request.get('/api/workspaces');
      const workspacePayload = await workspaceResponse.json() as { workspaces?: Workspace[] };
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = workspacePayload.workspaces?.find((candidate) => candidate.type === 'personal'
        && !candidate.legacy && candidate.permissions.canRead && candidate.permissions.canWrite);
      expect(workspace, 'A writable, non-legacy personal workspace is required.').toBeTruthy();
      workspaceId = workspace!.id;
      await context.addInitScript((id) => {
        window.localStorage.setItem('canvas.activeWorkspaceId', id);
        window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: BASE_TEXT });
      uploaded = true;

      const session = await context.request.post('/api/files/collaboration/session', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      const sessionPayload = await session.json() as { documentId?: string; error?: string };
      expect(session.ok(), sessionPayload.error ?? 'Could not initialize the delayed-review fixture collaboration.').toBeTruthy();
      expect(sessionPayload.documentId).toBeTruthy();
      const fixture = await createFixture({ scenario: 'conflict', userId: auth.user!.id!, role: auth.user!.role ?? 'member',
        workspaceId, documentId: sessionPayload.documentId!, filePath });
      const proposalB = fixture.proposals.find((proposal) => proposal.label === 'B')!;
      const proposalC = fixture.proposals.find((proposal) => proposal.label === 'C')!;
      proposalBOperationId = proposalB.operationId;
      expect(proposalBOperationId).toBeTruthy();

      await page.route('**/api/files/version-center/v1/proposals/review', async (route) => {
        const request = route.request();
        let selection: { kind?: string; operationId?: string } | undefined;
        try {
          selection = (request.postDataJSON() as { selection?: typeof selection }).selection;
        } catch {
          selection = undefined;
        }
        if (!oldResponseFetched && selection?.kind === 'operation' && selection.operationId === proposalBOperationId) {
          const response = await route.fetch();
          oldResponseStatus = response.status();
          oldResponseFetched = true;
          notifyOldResponseFetched();
          try {
            await oldResponseReleasePromise;
            // Selection changes may abort this real response while held. In either
            // case, the route handler must settle before the test exits.
            await route.fulfill({ response });
          } catch (error) {
            // A browser-aborted review is a valid stale-response outcome; other
            // route failures must not disappear behind the race assertion.
            const failure = route.request().failure() ?? '';
            const detail = error instanceof Error ? error.message : '';
            if (!/abort|cancel/iu.test(`${failure} ${detail}`)) throw error;
          } finally {
            notifyOldRouteFinished();
          }
          return;
        }
        await route.continue();
      });

      const beforeTimeline = await timeline(context.request, workspaceId, filePath);
      const beforeRevisionCount = revisionCount(beforeTimeline);
      const beforeAppliedRevisionCount = agentApplyRevisionCount(beforeTimeline);
      const delayedRequest: FileVersionCenterRequestV1 = { contractVersion: 1,
        target: { kind: 'lineage', workspaceId, lineageId: fixture.scope.lineageId },
        selectedEntry: { kind: 'agent_operation', id: proposalB.operationId }, initialView: 'reviews', source: 'deep_link' };
      await page.goto(buildFileVersionCenterDeepLinkV1('/en', delayedRequest));
      await expect(page.getByTestId('file-version-center')).toBeVisible();
      await oldResponseFetchedPromise;
      const graph = page.getByTestId('graph-review-comparison');
      const proposalCCard = page.locator(`button[data-operation-id="${proposalC.operationId}"]`);
      await expect(proposalCCard).toBeVisible();
      const cResponsePromise = page.waitForResponse(async (response) => {
        if (response.request().method() !== 'POST'
          || !new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/review')) return false;
        try {
          const body = response.request().postDataJSON() as { selection?: { kind?: string; operationId?: string } };
          return body.selection?.kind === 'operation' && body.selection.operationId === proposalC.operationId;
        } catch {
          return false;
        }
      });
      await proposalCCard.click();
      const cResponse = await cResponsePromise;
      expect(cResponse.ok(), 'The selected C evaluation must complete before the stale B response is released.').toBeTruthy();
      await expect(proposalCCard).toHaveAttribute('aria-pressed', 'true');
      await expect(graph.getByText('Ready to apply')).toBeVisible();
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('130');
      await expect(graph.getByTestId('graph-review-hunks')).not.toContainText('120');

      releaseOldResponse();
      await oldRouteFinishedPromise;
      expect(oldResponseStatus).toBe(200);
      await expect(proposalCCard).toHaveAttribute('aria-pressed', 'true');
      await expect(graph.getByText('Ready to apply')).toBeVisible();
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('130');
      await expect(graph.getByTestId('graph-review-hunks')).not.toContainText('120');
      expect(actionPosts, 'A stale review response must not post or arm an action for the old B selection.').toBe(0);
      expect(await fileContent(context.request, workspaceId, filePath)).toBe(BASE_TEXT);
      expect(revisionCount(await timeline(context.request, workspaceId, filePath))).toBe(beforeRevisionCount);

      await testInfo.attach('proposal-review-late-B-response-keeps-C-selection.png', {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });
      const receipt = await acceptReviewedAction({ graph, page, testInfo, evidenceName: 'proposal-review-late-B-response-C' });
      expect(receipt.actionType).toBe('accept');
      expect(receipt.affectedProposalIds).toEqual([proposalC.proposalId]);
      expect(actionPosts).toBe(1);
      await expect.poll(() => fileContent(context.request, workspaceId!, filePath), { timeout: 30_000 })
        .toBe('# Proposal review fixture\n\nPlan: 130 USD.\n');
      const afterTimeline = await timeline(context.request, workspaceId, filePath);
      expect(revisionCount(afterTimeline)).toBe(beforeRevisionCount + 1);
      expect(agentApplyRevisionCount(afterTimeline)).toBe(beforeAppliedRevisionCount + 1);
    } finally {
      releaseOldResponse();
      if (uploaded && workspaceId) {
        const deleted = await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.ok(), `Could not remove the FVRC-1006 fixture ${filePath}.`).toBeTruthy();
      }
      await context.close();
      assertNoServerErrors();
    }
  });

  test('marks a second independently authored identical effect already present without another content revision',
    async ({ browser }, testInfo) => {
      const context: BrowserContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
      const assertNoServerErrors = observeProposalReviewServerErrors(context);
      const page = await context.newPage();
      const filePath = `fvrc-1006-${randomUUID()}.md`;
      let workspaceId: string | null = null;
      let uploaded = false;
      let actionPosts = 0;
      try {
        page.on('request', (request) => {
          if (request.method() === 'POST'
            && new URL(request.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions')) actionPosts += 1;
        });
        const sessionResponse = await context.request.get('/api/auth/get-session');
        const auth = await sessionResponse.json() as AuthPayload;
        expect(sessionResponse.ok()).toBeTruthy();
        expect(auth.user?.id).toBeTruthy();
        const workspaceResponse = await context.request.get('/api/workspaces');
        const workspacePayload = await workspaceResponse.json() as { workspaces?: Workspace[] };
        expect(workspaceResponse.ok()).toBeTruthy();
        const workspace = workspacePayload.workspaces?.find((candidate) => candidate.type === 'personal'
          && !candidate.legacy && candidate.permissions.canRead && candidate.permissions.canWrite);
        expect(workspace, 'A writable, non-legacy personal workspace is required.').toBeTruthy();
        workspaceId = workspace!.id;
        await context.addInitScript((id) => {
          window.localStorage.setItem('canvas.activeWorkspaceId', id);
          window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
        }, workspaceId);
        await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: BASE_TEXT });
        uploaded = true;

        const collaboration = await context.request.post('/api/files/collaboration/session', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
        });
        const collaborationPayload = await collaboration.json() as { documentId?: string; error?: string };
        expect(collaboration.ok(), collaborationPayload.error ?? 'Could not initialize the identical-effect fixture.').toBeTruthy();
        expect(collaborationPayload.documentId).toBeTruthy();
        const fixture = await createFixture({ scenario: 'same-effect', userId: auth.user!.id!, role: auth.user!.role ?? 'member',
          workspaceId, documentId: collaborationPayload.documentId!, filePath });
        expect(fixture.proposals.map((proposal) => proposal.label)).toEqual(['B', 'C']);
        const proposalB = fixture.proposals.find((proposal) => proposal.label === 'B')!;
        const proposalC = fixture.proposals.find((proposal) => proposal.label === 'C')!;
        expect(proposalB.proposalId).not.toBe(proposalC.proposalId);

        const beforeTimeline = await timeline(context.request, workspaceId, filePath);
        const beforeRevisionCount = revisionCount(beforeTimeline);
        const beforeAppliedRevisionCount = agentApplyRevisionCount(beforeTimeline);
        await openProposalReview({ page, href: '/en', workspaceId, lineageId: fixture.scope.lineageId,
          operationId: proposalC.operationId });
        const cGraph = page.getByTestId('graph-review-comparison');
        await expect(cGraph.getByText('Ready to apply')).toBeVisible();
        await expect(cGraph.getByTestId('graph-review-hunks')).toContainText('120');
        const cReceipt = await acceptReviewedAction({ graph: cGraph, page, testInfo, evidenceName: 'identical-effect-C' });
        expect(cReceipt.affectedProposalIds).toEqual([proposalC.proposalId]);
        expect(cReceipt.result?.kind).toBe('content_changed');
        await expect.poll(() => fileContent(context.request, workspaceId!, filePath), { timeout: 30_000 })
          .toBe('# Proposal review fixture\n\nPlan: 120 USD.\n');
        const afterContentTimeline = await timeline(context.request, workspaceId, filePath);
        expect(revisionCount(afterContentTimeline)).toBe(beforeRevisionCount + 1);
        expect(agentApplyRevisionCount(afterContentTimeline)).toBe(beforeAppliedRevisionCount + 1);
        expect(actionPosts).toBe(1);

        const bReview = await reviewProposal(context.request, workspaceId, fixture.scope.documentId, proposalB.operationId);
        expect(bReview.mode).toBe('graph');
        if (bReview.mode !== 'graph') throw new Error('The identical proposal unexpectedly fell back to legacy review.');
        expect(bReview.status).toBe('satisfied_elsewhere');
        expect(bReview.compare?.candidate.noEffect).toBe(true);
        await openProposalReview({ page, href: '/en', workspaceId, lineageId: fixture.scope.lineageId,
          operationId: proposalB.operationId });
        const bGraph = page.getByTestId('graph-review-comparison');
        await expect(bGraph.getByTestId('graph-review-no-effect').getByText('Already present', { exact: true })).toBeVisible();
        await expect(bGraph.getByTestId('graph-review-blocked')).toHaveCount(0);
        await expect(bGraph.getByRole('button', { name: 'Refresh timeline', exact: true })).toHaveCount(0);
        await expect(bGraph).not.toContainText('The current document changed. Refresh the review.');
        await expect(bGraph.getByRole('button', { name: 'Mark as already present' })).toBeEnabled();
        await expect(bGraph.getByRole('button', { name: 'Accept change' })).toHaveCount(0);
        await expect(bGraph.getByText('No changed lines appear in this comparison.', { exact: true })).toBeVisible();

        const secondActionResponse = page.waitForResponse((response) => response.request().method() === 'POST'
          && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions'));
        await bGraph.getByRole('button', { name: 'Mark as already present' }).click();
        await expect(bGraph.getByTestId('graph-review-confirmation')).toBeVisible();
        await bGraph.getByRole('button', { name: 'Confirm action' }).click();
        const satisfiedResponse = await secondActionResponse;
        expect(satisfiedResponse.ok()).toBeTruthy();
        const satisfiedReceipt = JSON.parse(await satisfiedResponse.text()) as ProposalActionReceiptV1;
        expect(satisfiedReceipt.phase).toBe('succeeded');
        expect(satisfiedReceipt.actionType).toBe('complete_satisfied');
        expect(satisfiedReceipt.affectedProposalIds).toEqual([proposalB.proposalId]);
        expect(satisfiedReceipt.result?.kind).toBe('metadata_only');
        if (satisfiedReceipt.result?.kind !== 'metadata_only') throw new Error('Satisfied completion must be metadata-only.');
        expect(satisfiedReceipt.result.revisionId).toBeNull();
        expect(satisfiedReceipt.result.resolutions).toContainEqual({ proposalId: proposalB.proposalId, lifecycle: 'satisfied_elsewhere' });
        expect(actionPosts).toBe(2);
        expect(await fileContent(context.request, workspaceId, filePath)).toBe('# Proposal review fixture\n\nPlan: 120 USD.\n');
        const afterSatisfiedTimeline = await timeline(context.request, workspaceId, filePath);
        expect(revisionCount(afterSatisfiedTimeline)).toBe(beforeRevisionCount + 1);
        expect(agentApplyRevisionCount(afterSatisfiedTimeline)).toBe(beforeAppliedRevisionCount + 1);
        await testInfo.attach('identical-effect-B-completed-no-content-revision.json', {
          body: JSON.stringify({ actionType: satisfiedReceipt.actionType, phase: satisfiedReceipt.phase,
            result: satisfiedReceipt.result }, null, 2), contentType: 'application/json',
        });
      } finally {
        if (uploaded && workspaceId) {
          const deleted = await context.request.delete('/api/files/delete', {
            headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
          });
          expect(deleted.ok(), `Could not remove the FVRC-1006 fixture ${filePath}.`).toBeTruthy();
        }
        await context.close();
        assertNoServerErrors();
      }
    });

  for (const workspaceKind of ['personal', 'team'] as const) {
    test(`accepts 3 singles and one 7-proposal batch in the ${workspaceKind} workspace`, async ({ browser }, testInfo) => {
      const context: BrowserContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
      const assertNoServerErrors = observeProposalReviewServerErrors(context);
      const page = await context.newPage();
      try {
        const sessionResponse = await context.request.get('/api/auth/get-session');
        const auth = await sessionResponse.json() as AuthPayload;
        expect(sessionResponse.ok()).toBeTruthy();
        expect(auth.user?.id).toBeTruthy();
        const workspaceResponse = await context.request.get('/api/workspaces');
        const workspacePayload = await workspaceResponse.json() as { workspaces?: Workspace[] };
        expect(workspaceResponse.ok()).toBeTruthy();
        const permitted = (candidate: Workspace) => !candidate.legacy && candidate.permissions.canRead
          && candidate.permissions.canWrite && candidate.permissions.canRunAgent;
        // The managed local Team workspace is exposed as `organization` by the workspace API.
        const workspace = workspacePayload.workspaces?.find((candidate) => workspaceKind === 'personal'
          ? candidate.type === 'personal' && permitted(candidate)
          : ['team', 'organization'].includes(candidate.type) && permitted(candidate));
        expect(workspace, `A permitted writable ${workspaceKind} workspace is required. Available workspace capabilities: ${JSON.stringify(
          workspacePayload.workspaces?.map((candidate) => ({ type: candidate.type, legacy: candidate.legacy,
            permissions: candidate.permissions })),
        )}`).toBeTruthy();
        await runIndependentBatchWorkspace({ context, page, testInfo, userId: auth.user!.id!, role: auth.user?.role ?? 'member',
          workspace: workspace!, mode: 'three-plus-seven' });
      } finally {
        await context.close();
        assertNoServerErrors();
      }
    });
  }

  test('accepts all 10 independent proposals as one batch and creates exactly one content revision', async ({ browser }, testInfo) => {
    const context: BrowserContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const assertNoServerErrors = observeProposalReviewServerErrors(context);
    const page = await context.newPage();
    try {
      const sessionResponse = await context.request.get('/api/auth/get-session');
      const auth = await sessionResponse.json() as AuthPayload;
      expect(sessionResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await context.request.get('/api/workspaces');
      const workspacePayload = await workspaceResponse.json() as { workspaces?: Workspace[] };
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = workspacePayload.workspaces?.find((candidate) => candidate.type === 'personal'
        && !candidate.legacy && candidate.permissions.canRead && candidate.permissions.canWrite
        && candidate.permissions.canRunAgent);
      expect(workspace, 'A writable, agent-capable Personal workspace is required.').toBeTruthy();
      await runIndependentBatchWorkspace({ context, page, testInfo, userId: auth.user!.id!,
        role: auth.user?.role ?? 'member', workspace: workspace!, mode: 'all-ten' });
    } finally {
      await context.close();
      assertNoServerErrors();
    }
  });

  test('freezes all 26 proposals across timeline pages when a 27th proposal arrives during preview', async ({ browser }, testInfo) => {
    const context: BrowserContext = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const assertNoServerErrors = observeProposalReviewServerErrors(context);
    const page = await context.newPage();
    const filePath = `fvrc-1006-${randomUUID()}.md`;
    let workspaceId: string | null = null;
    let uploaded = false;
    try {
      const sessionResponse = await context.request.get('/api/auth/get-session');
      const auth = await sessionResponse.json() as AuthPayload;
      expect(sessionResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await context.request.get('/api/workspaces');
      const workspacePayload = await workspaceResponse.json() as { workspaces?: Workspace[] };
      expect(workspaceResponse.ok()).toBeTruthy();
      const workspace = workspacePayload.workspaces?.find((candidate) => candidate.type === 'personal'
        && !candidate.legacy && candidate.permissions.canRead && candidate.permissions.canWrite
        && candidate.permissions.canRunAgent);
      expect(workspace, 'A writable, agent-capable Personal workspace is required.').toBeTruthy();
      workspaceId = workspace!.id;
      await context.addInitScript((id) => {
        window.localStorage.setItem('canvas.activeWorkspaceId', id);
        window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: LARGE_BATCH_BASE_TEXT });
      uploaded = true;

      const collaboration = await context.request.post('/api/files/collaboration/session', {
        headers: { [WORKSPACE_ID_HEADER]: workspaceId },
        data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      const collaborationPayload = await collaboration.json() as { documentId?: string; error?: string };
      expect(collaboration.ok(), collaborationPayload.error ?? 'Could not initialize the paginated fixture.').toBeTruthy();
      expect(collaborationPayload.documentId).toBeTruthy();

      const fixture = await createFixture({ scenario: 'large-batch', userId: auth.user!.id!, role: auth.user!.role ?? 'member',
        workspaceId, documentId: collaborationPayload.documentId!, filePath });
      const expectedLabels = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
      expect(fixture.proposals.map((proposal) => proposal.label)).toEqual(expectedLabels);
      const firstTimelinePage = await timeline(context.request, workspaceId, filePath);
      const firstPageProposalCount = firstTimelinePage.entries.filter((entry) => entry.kind === 'agent_operation').length;
      expect(firstPageProposalCount).toBeLessThan(fixture.proposals.length);
      expect(firstTimelinePage.entries.some((entry) => entry.kind === 'current'),
        'The current authoritative entry must remain anchored on the first timeline page.').toBe(true);
      expect(firstTimelinePage.page?.hasMore).toBe(true);
      const beforeTimeline = await fullTimeline(context.request, workspaceId, filePath);
      const beforeRevisionCount = revisionCount(beforeTimeline);
      const beforeAppliedRevisionCount = agentApplyRevisionCount(beforeTimeline);

      await openProposalReview({ page, href: '/en', workspaceId, lineageId: fixture.scope.lineageId,
        operationId: fixture.proposals[0]!.operationId });
      const graph = page.getByTestId('graph-review-comparison');
      const timelineNav = page.getByRole('navigation', { name: 'Document versions and proposed changes' });
      const currentVersion = timelineNav.locator('section[aria-labelledby="version-center-current"] button[data-entry-kind="current"]');
      await expect(currentVersion).toBeVisible();
      await expect(timelineNav.getByText('Review status unavailable', { exact: true })).toHaveCount(0);
      await expectReviewReady(graph);
      await graph.getByRole('button', { name: 'Review all changes' }).click();
      await expect(graph).toContainText('26 proposals selected');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('A1');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('Z1');
      const frozenProposalIds = fixture.proposals.map((proposal) => proposal.proposalId);

      const lateFixture = await createFixture({ scenario: 'append-late', userId: auth.user!.id!, role: auth.user!.role ?? 'member',
        workspaceId, documentId: fixture.scope.documentId, filePath });
      expect(lateFixture.proposals).toHaveLength(1);
      expect(lateFixture.proposals[0]?.label).toBe('LATE');
      expect(frozenProposalIds).not.toContain(lateFixture.proposals[0]!.proposalId);
      expect(await fileContent(context.request, workspaceId, filePath)).toBe(LARGE_BATCH_BASE_TEXT);

      // Return to the real focus listener after the new graph node arrives and
      // await both its authoritative graph review and timeline summary reads.
      const refreshedSelection = page.waitForResponse((response) => {
        const request = response.request();
        if (request.method() !== 'POST' || !new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/review')) return false;
        try {
          const body = request.postDataJSON() as { selection?: { kind?: string; proposalIds?: string[] } };
          return body.selection?.kind === 'proposals';
        } catch { return false; }
      });
      const refreshedSummary = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/summary'));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const fixedSelectionResponse = await refreshedSelection;
      expect(fixedSelectionResponse.ok(), `Graph review refresh returned ${fixedSelectionResponse.status()}.`).toBeTruthy();
      const fixedSelectionRequest = fixedSelectionResponse.request();
      const fixedSelectionBody = fixedSelectionRequest.postDataJSON() as { selection: { kind: string; proposalIds: string[] } };
      expect(fixedSelectionBody.selection.proposalIds.slice().sort()).toEqual(frozenProposalIds.slice().sort());
      const refreshedReview = await fixedSelectionResponse.json() as ReviewSession;
      expect(refreshedReview.mode).toBe('graph');
      if (refreshedReview.mode !== 'graph') throw new Error('Refreshed batch unexpectedly fell back to legacy review.');
      expect(refreshedReview.selectedProposalIds?.slice().sort()).toEqual(frozenProposalIds.slice().sort());
      expect(['clean', 'clean_rebased']).toContain(refreshedReview.status);
      const summaryResponse = await refreshedSummary;
      expect(summaryResponse.ok(), `Review summary refresh returned ${summaryResponse.status()}.`).toBeTruthy();
      const summaryRequest = summaryResponse.request().postDataJSON() as { operationIds: string[] };
      const summary = await summaryResponse.json() as ProposalReviewSummaryResponseV1;
      expect(summary.current).toBeTruthy();
      expect(summary.graphRevision).not.toBeNull();
      expect(summary.items.map((item) => item.operationId).slice().sort()).toEqual(summaryRequest.operationIds.slice().sort());
      expect(summary.items.every((item) => item.mode === 'graph'
        && ['clean', 'clean_rebased'].includes(item.status))).toBe(true);
      await expect(graph).toContainText('26 proposals selected', { timeout: 30_000 });
      await expectReviewReady(graph);
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('A1');
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('Z1');
      await expect(graph).not.toContainText('LATE_APPLIED');
      await expect(currentVersion).toBeVisible();
      await expect(timelineNav.getByText('Review status unavailable', { exact: true })).toHaveCount(0);
      const firstProposalCard = timelineNav.locator(`button[data-operation-id="${fixture.proposals[0]!.operationId}"]`);
      await expect(firstProposalCard).toHaveAttribute('data-entry-status', /^(?:clean|clean_rebased)$/u, { timeout: 30_000 });
      await testInfo.attach('large-batch-26-frozen-preview.png', {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      });

      const receipt = await acceptReviewedAction({ graph, page, testInfo, evidenceName: 'large-batch-26-frozen' });
      expect(receipt.actionType).toBe('batch_accept');
      expect(receipt.affectedProposalIds.slice().sort()).toEqual(frozenProposalIds.slice().sort());
      expect(receipt.affectedProposalIds).not.toContain(lateFixture.proposals[0]!.proposalId);
      await expect.poll(() => fileContent(context.request, workspaceId!, filePath), { timeout: 30_000 })
        .toBe(LARGE_BATCH_FINAL_TEXT);
      const afterTimeline = await fullTimeline(context.request, workspaceId, filePath);
      expect(revisionCount(afterTimeline)).toBe(beforeRevisionCount + 1);
      expect(agentApplyRevisionCount(afterTimeline)).toBe(beforeAppliedRevisionCount + 1);
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.result?.kind).toBe('content_changed');

      const lateReview = await reviewProposal(context.request, workspaceId, fixture.scope.documentId,
        lateFixture.proposals[0]!.operationId);
      expect(lateReview.mode).toBe('graph');
      if (lateReview.mode !== 'graph') throw new Error('The late proposal unexpectedly used the legacy path.');
      expect(['clean', 'clean_rebased']).toContain(lateReview.status);
      expect(lateReview.context?.proposals).toContainEqual(expect.objectContaining({
        proposalId: lateFixture.proposals[0]!.proposalId, lifecycle: 'open',
      }));
    } finally {
      if (uploaded && workspaceId) {
        const deleted = await context.request.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.ok(), `Could not remove the FVRC-1006 paginated fixture ${filePath}.`).toBeTruthy();
      }
      await context.close();
      assertNoServerErrors();
    }
  });
});
