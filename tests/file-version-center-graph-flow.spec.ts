import { expect, request as requestFactory, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { getFileDisplayName } from '../app/lib/files/display-name';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { PROPOSAL_GRAPH_ERROR_CODES, type ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewGraphSessionV1, ProposalReviewActionStatusResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { withOwnedTestCleanup } from './helpers/owned-test-cleanup';
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
type TestScope = { context: BrowserContext; cleanup: APIRequestContext; page: Page; workspaceId: string; filePath: string; fixture: Fixture };
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
  let cleanup: APIRequestContext | undefined;
  const filePath = `fvrc-1006-${randomUUID()}.md`;
  let workspaceId: string | null = null;
  let uploaded = false;
  await withOwnedTestCleanup(async () => {
    cleanup = await requestFactory.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000',
      storageState: await context.storageState(), timeout: 15_000 });
    const page = await context.newPage();
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
    const upload = await context.request.post('/api/files/upload', {
      headers: { [WORKSPACE_ID_HEADER]: workspaceId },
      multipart: { path: '.', files: { name: filePath, mimeType: 'text/markdown', buffer: Buffer.from(BASE_TEXT) } },
    });
    uploaded = upload.ok();
    expect(upload.status(), 'The dedicated graph flow fixture upload must succeed.').toBe(200);
    expect(await upload.json()).toMatchObject({ success: true, count: 1, files: [filePath] });
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
    await run({ context, cleanup, page, workspaceId, filePath, fixture });
  }, [
    { label: 'graph flow pages', run: async () => {
      const results = await Promise.allSettled(context.pages().map(page => page.close()));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Owned graph flow pages failed to close.');
    } },
    { label: 'graph flow document', run: async () => {
      if (uploaded && workspaceId && cleanup) {
        const deleted = await cleanup.delete('/api/files/delete', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
        });
        expect(deleted.status(), 'Could not remove the dedicated graph flow fixture.').toBe(200);
        expect(await deleted.json()).toMatchObject({ success: true, deleted: [filePath], failed: [] });
      }
    } },
    { label: 'graph flow context', run: () => context.close() },
    { label: 'graph flow cleanup API', run: async () => { await cleanup?.dispose(); } },
    { label: 'graph flow server observer', run: assertNoServerErrors },
  ]);
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

  test('FVRC-1007 persisted chat file references preserve historical identity and offer explicit successor choices', async ({ browser }, testInfo) => {
    await withFixture(browser, async (scope) => {
      // Bound individual UI waits so failed selectors cannot consume teardown time.
      scope.page.setDefaultTimeout(20_000);
      const parent = proposal(scope.fixture, 'A');
      const chosen = proposal(scope.fixture, 'B2');
      const session = await (await scope.context.request.get('/api/auth/get-session')).json() as {
        user: { id: string; role: string } };
      const fixtureTitle = `FVRC-1007 browser review ${randomUUID()}`;
      let ownedChat: { sessionId: string; agentId: string } | undefined;
      await withOwnedTestCleanup(async () => {
        const createdChat = await scope.context.request.post('/api/sessions', {
          headers: { [WORKSPACE_ID_HEADER]: scope.workspaceId },
          data: { title: fixtureTitle, workspaceId: scope.workspaceId, agentId: 'bradley' },
        });
        const createdChatBody = await createdChat.json() as { session: { sessionId: string; agentId: string } };
        if (typeof createdChatBody.session?.sessionId === 'string' && createdChatBody.session.sessionId
          && typeof createdChatBody.session.agentId === 'string' && createdChatBody.session.agentId) {
          ownedChat = { sessionId: createdChatBody.session.sessionId, agentId: createdChatBody.session.agentId };
        }
        expect(createdChat.ok(), 'The real session creation route must authorize the test chat.').toBeTruthy();
        expect(ownedChat, 'The test chat needs its exact session creation receipt before the native fixture runs.').toBeDefined();
        const encoded = Buffer.from(JSON.stringify({ userId: session.user.id, role: session.user.role,
          workspaceId: scope.workspaceId, documentId: scope.fixture.scope.documentId,
          lineageId: scope.fixture.scope.lineageId, operationId: parent.operationId, filePath: scope.filePath,
          sessionId: createdChatBody.session.sessionId, fixtureTitle,
        })).toString('base64url');
        let chat: { sessionId: string; agentId: string; groupId: string;
          app: import('../app/lib/tool-apps/types').BuiltinToolAppDescriptor };
        try {
          const created = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
            '--conditions', 'react-server', 'scripts/fvrc-1007-chat-fixture.ts', encoded,
          ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 });
          chat = JSON.parse(String(created.stdout).trim().split('\n').at(-1)!);
        } catch (error) {
          const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
            ? error.stderr : '';
          const code = /FVRC_CHAT_FIXTURE_FAILED=([a-z_]+:[A-Z0-9_]+)/u.exec(stderr)?.[1] ?? 'load';
          throw new Error(`The dedicated persisted chat fixture failed (${code}); arguments and private output are redacted.`);
        }
        expect(chat.sessionId).toBe(createdChatBody.session.sessionId);
        expect(chat.agentId).toBe(createdChatBody.session.agentId);
        expect(chat.app.entityId).toBe(chat.groupId);
        const summaryResponsePromise = scope.page.waitForResponse((response) => {
          if (response.request().method() !== 'POST'
            || new URL(response.url()).pathname !== '/api/chat/file-changes') return false;
          const request = response.request().postDataJSON() as {
            sessionId: string; agentId: string; apps: Array<{ entityId: string }> };
          return request.sessionId === chat.sessionId && request.agentId === chat.agentId
            && request.apps.some((app) => app.entityId === chat.groupId);
        });
        await scope.page.goto(`/en/notebook?workspaceId=${scope.workspaceId}&chat=open&session=${chat.sessionId}`);
        const summaryResponse = await summaryResponsePromise;
        expect(summaryResponse.status()).toBe(200);
        expect(summaryResponse.request().postDataJSON()).toEqual({
          sessionId: chat.sessionId, agentId: chat.agentId, apps: [chat.app],
        });
        const summary = await summaryResponse.json() as { success: boolean;
          data: { groups: unknown[]; unavailable: unknown[] } };
        expect(summary.success).toBe(true);
        expect(summary.data.unavailable).toEqual([]);
        expect(summary.data.groups).toHaveLength(1);
        const { readFileChangeAppData } = await import('../app/lib/tool-apps/file-change-data');
        const group = readFileChangeAppData(summary.data.groups[0]);
        if (!group) throw new Error('The persisted chat needs a valid authorized file-change summary.');
        expect(group.id).toBe(chat.groupId);
        expect(group.workspaceId).toBe(scope.workspaceId);
        expect(group.entries).toHaveLength(1);
        const entry = group.entries[0];
        expect(entry.pathHint).toBe(scope.filePath);
        expect(entry.operationId).toBe(parent.operationId);
        expect(entry.state).toBe('review_required');
        expect(entry.proposal?.proposalId).toBe(parent.proposalId);
        expect(entry.proposal?.rootProposalId).toBe(parent.proposalId);
        expect(entry.proposal?.lineageId).toBe(scope.fixture.scope.lineageId);
        expect(entry.proposal?.moreSuccessors).toBe(false);
        const alternatives = [proposal(scope.fixture, 'B1'), chosen];
        expect(entry.proposal?.successors.map((successor) => ({
          proposalId: successor.proposalId, operationId: successor.operationId,
        })).sort((left, right) => left.proposalId.localeCompare(right.proposalId))).toEqual(
          alternatives.map((successor) => ({ proposalId: successor.proposalId, operationId: successor.operationId }))
            .sort((left, right) => left.proposalId.localeCompare(right.proposalId)));

        const references = scope.page.getByTestId('chat-file-references').filter({
          has: scope.page.getByTestId('chat-file-reference-item').and(scope.page.locator(`[data-path="${scope.filePath}"]`)),
        });
        await expect(references).toHaveCount(1);
        const row = references.locator('li').filter({
          has: scope.page.getByTestId('chat-file-reference-item').and(scope.page.locator(`[data-path="${scope.filePath}"]`)),
        });
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId('chat-file-reference-status')).toHaveText('Review required');
        const viewChanges = row.getByRole('button', { name: `View changes: ${scope.filePath}`, exact: true });
        await expect(viewChanges).toHaveCount(1);
        await viewChanges.click();
        const graph = scope.page.getByTestId('graph-review-comparison');
        await expect(graph).toBeVisible();
        expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBe(parent.operationId);
        expect(new URL(scope.page.url()).searchParams.get('fvrcRef')).toBe(chat.groupId);
        expect(new URL(scope.page.url()).searchParams.get('fvrcChangeEntry')).toBe(entry.id);
        expect(new URL(scope.page.url()).searchParams.get('fvrcWorkspace')).toBe(scope.workspaceId);
        const center = scope.page.getByTestId('file-version-center');
        for (const alternative of alternatives) {
          await expect(center.locator(`button[data-operation-id="${alternative.operationId}"]`)).toHaveCount(1);
          await expect(center.locator(`button[data-operation-id="${alternative.operationId}"]`)).toBeVisible();
        }
        const choices = graph.getByTestId('graph-review-context').getByRole('button', {
          name: 'Review this alternative', exact: true,
        });
        await expect(choices).toHaveCount(2);
        await testInfo.attach('chat-explicit-successors.png', { body: await center.screenshot(), contentType: 'image/png' });
        const chosenCard = center.locator(`button[data-operation-id="${chosen.operationId}"]`);
        await chosenCard.click();
        await expect(chosenCard).toHaveAttribute('aria-pressed', 'true');
        await expect(graph).toBeVisible();
        expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBe(chosen.operationId);
        expect(new URL(scope.page.url()).searchParams.get('fvrcTarget')).toBe('change_group');
        expect(new URL(scope.page.url()).searchParams.get('fvrcRef')).toBe(chat.groupId);
        expect(new URL(scope.page.url()).searchParams.get('fvrcChangeEntry')).toBe(entry.id);
        const receipt = await confirmAction(graph, scope.page, 'Accept change');
        expect(receipt.result?.resolutions).toEqual(expect.arrayContaining([
          { proposalId: parent.proposalId, lifecycle: 'included' },
          { proposalId: chosen.proposalId, lifecycle: 'applied' },
        ]));
        await expect.poll(() => content(scope)).toBe('# Graph flow fixture\n\nA1|B2\n');
        await scope.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
        await references.getByRole('button', { name: 'Reload changes', exact: true }).click();
        await expect(row.getByTestId('chat-file-reference-status')).toHaveText('Included with another proposal', { timeout: 30_000 });
        await scope.page.reload();
        await expect(row.getByTestId('chat-file-reference-status')).toHaveText('Included with another proposal', { timeout: 30_000 });
        await viewChanges.click();
        await expect(scope.page.getByTestId('graph-review-comparison')).toBeVisible();
        expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBe(parent.operationId);
        expect(new URL(scope.page.url()).searchParams.get('fvrcRef')).toBe(chat.groupId);
        expect(new URL(scope.page.url()).searchParams.get('fvrcChangeEntry')).toBe(entry.id);
        await expect(scope.page.getByTestId('graph-review-historical-status')).toContainText('Included');
        await expect(scope.page.locator(`button[data-operation-id="${parent.operationId}"]`))
          .toHaveAttribute('data-entry-status', 'included');
        await expect(scope.page.getByText('The relationship review is blocked', { exact: true })).toHaveCount(0);
        await expect(scope.page.getByTestId('graph-review-comparison').getByRole('button', { name: 'Accept change', exact: true })).toHaveCount(0);
        await testInfo.attach('historical-chat-link-readonly.png', {
          body: await scope.page.getByRole('dialog').screenshot(), contentType: 'image/png' });
      }, [{ label: 'graph flow persisted chat', run: async () => {
        if (ownedChat) {
          const deleted = await scope.cleanup.delete('/api/sessions', { params: ownedChat });
          expect(deleted.status(), 'The dedicated test chat must be removed.').toBe(200);
          expect(await deleted.json()).toMatchObject({ success: true, deleted: ownedChat.sessionId });
        }
      } }]);
    });
  });

  test('FVRC-1007 editor agent and file browser entries require explicit proposal selection', async ({ browser }) => {
    await withFixture(browser, async (scope) => {
      scope.page.setDefaultTimeout(20_000);
      const firstChild = proposal(scope.fixture, 'B1');
      const secondChild = proposal(scope.fixture, 'B2');
      let actionPosts = 0;
      scope.page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === ACTION_PATH) actionPosts += 1;
      });

      await scope.page.goto(`/en/notebook?path=${encodeURIComponent(scope.filePath)}`, { waitUntil: 'domcontentloaded' });
      await scope.page.getByRole('group', { name: 'Document view' })
        .getByRole('button', { name: 'Edit', exact: true }).click();
      const agentEntry = scope.page.getByRole('button', { name: /Open agent changes: [2-9]\d*/u });
      await expect(agentEntry).toBeVisible({ timeout: 30_000 });
      const beforeRevisions = await revisionCount(scope);
      expect(await content(scope)).toBe(BASE_TEXT);

      await agentEntry.click();
      const center = scope.page.getByTestId('file-version-center');
      await expect(center).toBeVisible();
      await expect(center.getByTestId('file-version-review-picker')).toBeVisible();
      expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBeNull();
      await expect(center.locator('button[data-operation-id][aria-pressed="true"]')).toHaveCount(0);
      await center.locator(`button[data-operation-id="${secondChild.operationId}"]`).click();
      await expect(center.getByTestId('graph-review-comparison').getByTestId('graph-review-hunks'))
        .toContainText('A1|B2');
      expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBe(secondChild.operationId);

      await center.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(center).toBeHidden();
      const showSidebar = scope.page.getByRole('button', { name: 'Show sidebar', exact: true });
      if (await showSidebar.isVisible()) await showSidebar.click();
      const fileRow = scope.page.locator(`[data-file-path="${scope.filePath}"]`).first();
      await expect(fileRow).toBeVisible();
      const displayName = getFileDisplayName({ name: scope.filePath, type: 'file' });
      await fileRow.getByRole('button', { name: `More actions for ${displayName}`, exact: true }).click();
      const versionItem = scope.page.locator('[role="menu"]:visible').last().getByTestId('file-version-menu-item');
      await expect(versionItem).toHaveAttribute('data-file-version-capability', 'full', { timeout: 30_000 });
      await versionItem.click();
      await expect(center).toBeVisible();
      expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBeNull();
      await expect(center.getByTestId('graph-review-comparison')).toHaveCount(0);

      for (const [child, expectedCandidate] of [[firstChild, 'A1|B1'], [secondChild, 'A1|B2']] as const) {
        const card = center.locator(`button[data-operation-id="${child.operationId}"]`);
        await expect(card).toBeVisible();
        await card.click();
        await expect(card).toHaveAttribute('aria-pressed', 'true');
        await expect(center.getByTestId('graph-review-comparison').getByTestId('graph-review-hunks'))
          .toContainText(expectedCandidate);
        expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBe(child.operationId);
      }
      expect(actionPosts).toBe(0);
      expect(await content(scope)).toBe(BASE_TEXT);
      expect(await revisionCount(scope)).toBe(beforeRevisions);
    });
  });

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
      scope.page.setDefaultTimeout(20_000);
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
      const historicalChild = proposal(scope.fixture, 'B1');
      await openReview(scope, historicalChild.operationId);
      await scope.page.reload();
      await expect(scope.page.getByTestId('graph-review-historical-status')).toContainText('Rejected');
      expect(new URL(scope.page.url()).searchParams.get('fvrcSelectedId')).toBe(historicalChild.operationId);
      await expect(scope.page.locator(`button[data-operation-id="${historicalChild.operationId}"]`))
        .toHaveAttribute('data-entry-status', 'rejected');
      await expect(scope.page.getByTestId('graph-review-comparison').getByRole('button', {
        name: /Accept change|Reject branch|Reject proposal|Mark as already present/u,
      })).toHaveCount(0);
      await expect(scope.page.getByText('The relationship review is blocked', { exact: true })).toHaveCount(0);
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
