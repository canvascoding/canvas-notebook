import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { ProposalReviewGraphSessionV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const execFileAsync = promisify(execFile);
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const BASE_TEXT = '# Graph flow fixture\n\nA0|B0\n';
const SUMMARY_PATH = '/api/notifications/summary';
const REVIEW_PATH = '/api/files/version-center/v1/proposals/review';
const ACTION_PATH = '/api/files/version-center/v1/proposals/actions';

type Fixture = {
  scope: { workspaceId: string; lineageId: string; documentId: string };
  proposals: Array<{ label: string; proposalId: string; operationId: string }>;
  choiceGroupId: string;
};
type Workspace = {
  id: string;
  type: string;
  legacy?: boolean;
  permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean };
};
type TestScope = { context: BrowserContext; page: Page; workspaceId: string; filePath: string; fixture: Fixture };
type Notification = {
  id: string;
  workspaceId: string;
  target: { kind: string; lineageId?: string; operationId?: string; branch?: { rootProposalId: string; itemId: string; revision: string } };
};
type SummaryResponse = { success: boolean; data?: { sections?: { notifications?: Notification[] }; items?: Notification[] } };

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

async function readContent(scope: TestScope): Promise<string> {
  const response = await scope.context.request.get('/api/files/read', {
    headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId }, params: { path: scope.filePath },
  });
  const body = await response.json() as { data?: { content?: string }; error?: string };
  expect(response.ok(), body.error ?? 'Could not read the fixture document.').toBeTruthy();
  return body.data?.content ?? '';
}

async function readRevisionCount(scope: TestScope): Promise<number> {
  const response = await scope.context.request.post('/api/files/version-center/v1/resolve', {
    headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId },
    data: { contractVersion: 1, target: { kind: 'path', workspaceId: scope.workspaceId, pathHint: scope.filePath },
      initialView: 'history', source: 'file_browser' },
  });
  const body = await response.json() as { entries?: Array<{ kind: string }> ; error?: { message?: string } };
  expect(response.ok(), body.error?.message ?? 'Could not resolve the fixture timeline.').toBeTruthy();
  return body.entries?.filter((entry) => entry.kind === 'revision').length ?? 0;
}

test.describe('FVRC-1007 graph notification entry points', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the authorized managed local graph-review browser stack.');
  test.setTimeout(180_000);

  test('keeps an applied parent as the notification anchor while its open children remain explicitly selectable', async ({ browser }, testInfo) => {
    await withFixture(browser, async (scope) => {
      scope.page.setDefaultTimeout(20_000);
      const parent = proposal(scope.fixture, 'A');
      const first = proposal(scope.fixture, 'B1');
      const second = proposal(scope.fixture, 'B2');
      const summaryBefore = await scope.context.request.get(SUMMARY_PATH);
      const before = await summaryBefore.json() as SummaryResponse;
      expect(summaryBefore.ok()).toBeTruthy();
      const original = (before.data?.sections?.notifications ?? before.data?.items ?? [])
        .find(item => item.target.lineageId === scope.fixture.scope.lineageId);
      expect(original?.target.branch?.rootProposalId).toBe(parent.proposalId);
      const initialRevisions = await readRevisionCount(scope);
      const rootLink = buildFileVersionCenterDeepLinkV1('/en', {
        contractVersion: 1, source: 'deep_link', initialView: 'reviews',
        target: { kind: 'lineage', workspaceId: scope.workspaceId, lineageId: scope.fixture.scope.lineageId },
        selectedEntry: { kind: 'agent_operation', id: parent.operationId },
      });
      await scope.page.goto(rootLink);
      const graph = scope.page.getByTestId('graph-review-comparison');
      await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
      await expect(graph.getByTestId('graph-review-confirmation')).toBeVisible();
      const applied = scope.page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === ACTION_PATH);
      await graph.getByRole('button', { name: 'Confirm action' }).click();
      const appliedResponse = await applied;
      expect(appliedResponse.ok()).toBeTruthy();
      expect(await appliedResponse.json()).toMatchObject({ phase: 'succeeded', affectedProposalIds: [parent.proposalId] });
      await expect.poll(() => readContent(scope)).toBe('# Graph flow fixture\n\nA1|B0\n');
      expect(await readRevisionCount(scope)).toBe(initialRevisions + 1);

      const summaryAfter = await scope.context.request.get(SUMMARY_PATH);
      const after = await summaryAfter.json() as SummaryResponse;
      expect(summaryAfter.ok()).toBeTruthy();
      const remaining = (after.data?.sections?.notifications ?? after.data?.items ?? [])
        .filter(item => item.target.lineageId === scope.fixture.scope.lineageId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(original!.id);
      expect(remaining[0]?.target.operationId).toBe(parent.operationId);
      expect(remaining[0]?.target.branch?.rootProposalId).toBe(parent.proposalId);
      expect(remaining[0]?.target.branch?.revision).not.toBe(original!.target.branch!.revision);

      await scope.page.goto('/en');
      const entry = scope.page.locator(`a[href*="fvrcRef=${scope.fixture.scope.lineageId}"]`)
        .filter({ hasText: 'File change needs review' });
      await expect(entry).toHaveCount(1);
      await entry.click();
      const overview = scope.page.getByTestId('graph-review-branch-overview');
      await expect(overview).toBeVisible();
      await expect(overview.locator('[data-proposal-id]')).toHaveCount(3);
      await expect(overview.locator(`[data-proposal-id="${parent.proposalId}"]`)).toHaveText('Inspect historical proposal');
      for (const child of [first, second]) {
        await expect(overview.locator(`[data-proposal-id="${child.proposalId}"]`)).toHaveText('Review this proposal');
      }
      expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBe(parent.operationId);
      await expect(scope.page.getByRole('dialog').getByRole('button', { name: /Accept change|Reject proposal/u })).toHaveCount(0);
      await testInfo.attach('applied-parent-open-children.png', {
        body: await scope.page.getByRole('dialog').screenshot(), contentType: 'image/png' });
      const selectedReview = scope.page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === REVIEW_PATH);
      await overview.locator(`[data-proposal-id="${second.proposalId}"]`).click();
      const selectedResponse = await selectedReview;
      expect(selectedResponse.ok()).toBeTruthy();
      const selected = await selectedResponse.json() as ProposalReviewGraphSessionV1;
      expect(selected.selectedProposalIds).toEqual([second.proposalId]);
      expect(selected.actions.accept?.fence.applyProposalIds).toEqual([second.proposalId]);
      expect(selected.compare?.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind === 'addition').map(line => line.text)))
        .toContain('A1|B2');
      expect(await readContent(scope)).toBe('# Graph flow fixture\n\nA1|B0\n');
      expect(await readRevisionCount(scope)).toBe(initialRevisions + 1);
    });
  });

  test('groups a proposal branch, opens exact Home and Bell reviews, and acknowledges only its observed revision', async ({ browser }, testInfo) => {
    await withFixture(browser, async (scope) => {
      scope.page.setDefaultTimeout(20_000);
      const clientErrors: string[] = [];
      const consoleErrors: string[] = [];
      scope.page.on('pageerror', error => clientErrors.push(error.message));
      scope.page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      const parent = proposal(scope.fixture, 'A');
      const first = proposal(scope.fixture, 'B1');
      const second = proposal(scope.fixture, 'B2');
      const summaryResponse = await scope.context.request.get(SUMMARY_PATH);
      const summary = await summaryResponse.json() as SummaryResponse;
      expect(summaryResponse.ok()).toBeTruthy();
      expect(summary.success).toBe(true);
      const notifications = summary.data?.sections?.notifications ?? summary.data?.items ?? [];
      const fixtureNotifications = notifications.filter((item) => item.target.kind === 'file_change'
        && item.target.lineageId === scope.fixture.scope.lineageId);
      expect(fixtureNotifications).toHaveLength(1);
      const grouped = fixtureNotifications[0]!;
      expect(grouped.target.branch).toMatchObject({ rootProposalId: parent.proposalId });
      expect(grouped.target.operationId).toBe(parent.operationId);
      expect(notifications.filter((item) => item.target.kind === 'file_change'
        && [parent.operationId, first.operationId, second.operationId].includes(item.target.operationId ?? '')
        && !item.target.branch)).toHaveLength(0);
      const expectedRevision = grouped.target.branch!.revision;

      const mobileDefaultResponse = await scope.context.request.get('/api/mobile/v1/inbox', {
        headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId },
        params: { filter: 'notifications', limit: '100' },
      });
      const mobileDefault = await mobileDefaultResponse.json() as { items?: Notification[]; success?: boolean };
      expect(mobileDefaultResponse.ok()).toBeTruthy();
      expect(mobileDefault.success).toBe(true);
      expect(mobileDefault.items?.filter((item) => item.target.kind === 'file_change'
        && item.target.lineageId === scope.fixture.scope.lineageId)).toHaveLength(0);
      const mobileOptInResponse = await scope.context.request.get('/api/mobile/v1/inbox', {
        headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId },
        params: { filter: 'notifications', limit: '100', capability: 'inbox.file_changes.v1' },
      });
      const mobileOptIn = await mobileOptInResponse.json() as { items?: Notification[]; success?: boolean };
      expect(mobileOptInResponse.ok()).toBeTruthy();
      expect(mobileOptIn.success).toBe(true);
      const mobileBranchItems = mobileOptIn.items?.filter((item) => item.target.kind === 'file_change'
        && item.target.lineageId === scope.fixture.scope.lineageId) ?? [];
      expect(mobileBranchItems).toHaveLength(1);
      expect(mobileBranchItems[0]?.target.branch).toMatchObject({ rootProposalId: parent.proposalId,
        revision: expectedRevision });

      const initialContent = await readContent(scope);
      const initialRevisions = await readRevisionCount(scope);
      expect(initialContent).toBe(BASE_TEXT);

      const mutations: Array<Record<string, unknown>> = [];
      const actionCalls: string[] = [];
      scope.page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'PATCH' && url.pathname === SUMMARY_PATH) {
          try { mutations.push(request.postDataJSON() as Record<string, unknown>); } catch { /* malformed requests remain unrecorded */ }
        }
        if (request.method() === 'POST' && url.pathname === ACTION_PATH) actionCalls.push(url.pathname);
      });

      await scope.page.goto('/en');
      const homeNotifications = scope.page.getByRole('heading', { name: 'Notifications' }).locator('xpath=..');
      const targetLink = scope.page.locator(`a[href*="fvrcRef=${scope.fixture.scope.lineageId}"]`)
        .filter({ hasText: 'File change needs review' });
      await expect(homeNotifications).toBeVisible({ timeout: 30_000 });
      await expect(targetLink).toHaveCount(1, { timeout: 30_000 });
      const groupHref = await targetLink.getAttribute('href');
      expect(groupHref).toContain('fvrcBranch=1');
      await targetLink.click();

      const overview = scope.page.getByTestId('graph-review-branch-overview');
      await expect(overview).toBeVisible({ timeout: 30_000 });
      await expect(overview.locator('[data-proposal-id]')).toHaveCount(3, { timeout: 30_000 });
      const proposalIds = await overview.locator('[data-proposal-id]').evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('data-proposal-id')).filter((id): id is string => Boolean(id)));
      expect(proposalIds.sort()).toEqual([parent.proposalId, first.proposalId, second.proposalId].sort());
      await expect(overview.getByRole('button', { name: /Accept change|Reject proposal|Complete as already present/u })).toHaveCount(0);
      await testInfo.attach('branch-overview-desktop.png', {
        body: await scope.page.getByRole('dialog').screenshot(), contentType: 'image/png' });

      await expect.poll(() => mutations.length, { timeout: 30_000 }).toBe(1);
      expect(mutations).toEqual([{ action: 'mark_item_read', itemId: grouped.id, workspaceId: scope.workspaceId,
        expectedRevision }]);
      const reviewUrl = new URL(scope.page.url());
      expect(reviewUrl.searchParams.get('fvrcBranch')).toBe('1');
      const revisionBeforeReload = await readRevisionCount(scope);
      expect(revisionBeforeReload).toBe(initialRevisions);
      await scope.page.reload();
      await expect(scope.page.getByTestId('graph-review-branch-overview')).toBeVisible({ timeout: 30_000 });
      expect(actionCalls).toHaveLength(0);
      expect(mutations).toHaveLength(1);
      expect(await readContent(scope)).toBe(initialContent);
      expect(await readRevisionCount(scope)).toBe(initialRevisions);

      const selectedReview = scope.page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === REVIEW_PATH);
      await scope.page.getByTestId('graph-review-branch-overview').locator(`[data-proposal-id="${first.proposalId}"]`).click();
      const selectedResponse = await selectedReview;
      const selectedSession = await selectedResponse.json() as ProposalReviewGraphSessionV1;
      expect(selectedResponse.ok()).toBeTruthy();
      expect(selectedSession.mode).toBe('graph');
      expect(selectedSession.selectedProposalIds).toEqual([first.proposalId]);

      await scope.page.setViewportSize({ width: 320, height: 800 });
      await scope.page.goto(groupHref!);
      const mobileOverview = scope.page.getByTestId('graph-review-branch-overview');
      await expect(mobileOverview).toBeVisible({ timeout: 30_000 });
      await expect(mobileOverview.locator('[data-proposal-id]')).toHaveCount(3, { timeout: 30_000 });
      const hasHorizontalOverflow = await scope.page.evaluate(() =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth);
      expect(hasHorizontalOverflow).toBe(false);
      await testInfo.attach('branch-overview-mobile320.png', {
        body: await scope.page.getByRole('dialog').screenshot(), contentType: 'image/png' });
      expect(actionCalls).toHaveLength(0);
      expect(await readContent(scope)).toBe(initialContent);
      expect(await readRevisionCount(scope)).toBe(initialRevisions);

      // Mobile mutations use the same revision fence. A stale observed item
      // cannot mark a fresh group read; resetting our own exact fixture is safe.
      const staleMobileAck = await scope.context.request.patch('/api/mobile/v1/inbox?capability=inbox.file_changes.v1', {
        headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId }, data: {
          action: 'mark_item_read', itemId: grouped.id, expectedRevision: '0'.repeat(64),
        },
      });
      expect(staleMobileAck.status()).toBe(404);
      const unread = await scope.context.request.patch('/api/mobile/v1/inbox?capability=inbox.file_changes.v1', {
        headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId }, data: {
          action: 'set_item_read_state', itemId: grouped.id, expectedRevision, read: false,
        },
      });
      expect(unread.ok()).toBeTruthy();
      await scope.page.setViewportSize({ width: 1500, height: 950 });
      await scope.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await scope.page.getByTestId('notification-bell').click();
      await scope.page.locator(`button[data-notification-id="${grouped.id}"]`).click();
      await expect(scope.page.getByTestId('graph-review-branch-overview')).toBeVisible();
      await expect.poll(() => mutations.length).toBe(2);
      expect(mutations[1]).toEqual({ action: 'mark_item_read', itemId: grouped.id,
        workspaceId: scope.workspaceId, expectedRevision });
      expect(actionCalls).toHaveLength(0);
      await testInfo.attach('client-diagnostics.json', { body: JSON.stringify({ clientErrors, consoleErrors }),
        contentType: 'application/json' });
      expect(clientErrors).toEqual([]);
    });
  });
});
