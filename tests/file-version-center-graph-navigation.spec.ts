import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import type { ProposalActionReceiptV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const execFileAsync = promisify(execFile);
const BASE_TEXT = '# Proposal review fixture\n\nPlan: 100 USD.\n';
const DESTINATION_TEXT = '# Proposal review fixture\n\nPlan: 100 USD.\n';

type Workspace = {
  id: string;
  type: string;
  legacy?: boolean;
  permissions: { canRead?: boolean; canWrite?: boolean; canRunAgent?: boolean };
};
type AuthPayload = { user?: { id?: string; role?: string } | null };
type Fixture = {
  scope: { workspaceId: string; lineageId: string; documentId: string };
  proposals: Array<{ label: string; proposalId: string; operationId: string }>;
};
type Timeline = { entries: Array<{ kind: string; source?: string; id?: string; revisionId?: string }> };

function enabled(): boolean {
  return process.env.COLLABORATION_E2E === '1';
}

async function createFixture(input: {
  userId: string;
  role: string;
  workspaceId: string;
  documentId: string;
  filePath: string;
}): Promise<Fixture> {
  if (!/^(owner|admin|member|external)$/u.test(input.role)) throw new Error('Authenticated user role is unavailable.');
  const encoded = Buffer.from(JSON.stringify({ scenario: 'conflict', ...input })).toString('base64url');
  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
      '--conditions', 'react-server', 'scripts/fvrc-1006-browser-fixture.ts', encoded,
    ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 });
  } catch {
    throw new Error('FVRC-1006 navigation fixture failed; details are intentionally redacted.');
  }
  for (const line of String(result.stdout).trim().split('\n').reverse()) {
    try { return JSON.parse(line) as Fixture; } catch { /* only the fixture receipt is JSON */ }
  }
  throw new Error('FVRC-1006 navigation fixture returned no receipt.');
}

async function initializeDocument(input: {
  request: APIRequestContext;
  workspaceId: string;
  filePath: string;
  userId: string;
  role: string;
}): Promise<Fixture> {
  const collaboration = await input.request.post('/api/files/collaboration/session', {
    headers: { [WORKSPACE_ID_HEADER]: input.workspaceId },
    data: { path: input.filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
  });
  const payload = await collaboration.json() as { documentId?: string; error?: string };
  expect(collaboration.ok(), payload.error ?? 'Could not initialize the navigation fixture.').toBeTruthy();
  expect(payload.documentId).toBeTruthy();
  return createFixture({ userId: input.userId, role: input.role, workspaceId: input.workspaceId,
    documentId: payload.documentId!, filePath: input.filePath });
}

async function readFile(context: BrowserContext, workspaceId: string, filePath: string): Promise<string> {
  const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
  });
  expect(response.ok(), `Fixture file read returned ${response.status()}.`).toBeTruthy();
  const payload = await response.json() as { data?: { content?: string } };
  return payload.data?.content ?? '';
}

async function timeline(context: BrowserContext, workspaceId: string, filePath: string): Promise<Timeline> {
  const response = await context.request.post('/api/files/version-center/v1/resolve', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: {
      contractVersion: 1,
      target: { kind: 'path', workspaceId, pathHint: filePath },
      initialView: 'history',
      source: 'file_browser',
    },
  });
  const payload = await response.json() as Timeline & { error?: { message?: string } };
  expect(response.ok(), payload.error?.message ?? `Timeline returned ${response.status()}.`).toBeTruthy();
  return payload;
}

async function removeFile(context: BrowserContext, workspaceId: string, filePath: string): Promise<void> {
  const response = await context.request.delete('/api/files/delete', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
  });
  expect(response.ok(), `Could not clean up the unique navigation fixture (${response.status()}).`).toBeTruthy();
}

test.describe('FVRC-1006 review response navigation fencing', () => {
  test.skip(!enabled(), 'Set COLLABORATION_E2E=1 to run the managed local graph-review browser test.');
  test.setTimeout(180_000);

  test('a delayed review cannot cross an in-app file and workspace switch', async ({ browser }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const assertNoServerErrors = observeProposalReviewServerErrors(context);
    const page = await context.newPage();
    const personalPath = `fvrc-1006-${randomUUID()}.md`;
    const teamPath = `fvrc-1006-${randomUUID()}.md`;
    let personalWorkspaceId: string | null = null;
    let teamWorkspaceId: string | null = null;
    let personalUploaded = false;
    let teamUploaded = false;
    let delayedOperationId: string | null = null;
    let delayedStatus: number | null = null;
    let responseFetched = false;
    let notifyResponseFetched!: () => void;
    const responseFetchedPromise = new Promise<void>((resolve) => { notifyResponseFetched = resolve; });
    let releaseResponse!: () => void;
    const releaseResponsePromise = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let notifyRouteFinished!: () => void;
    const routeFinishedPromise = new Promise<void>((resolve) => { notifyRouteFinished = resolve; });
    let actionPosts = 0;

    try {
      const authResponse = await context.request.get('/api/auth/get-session');
      const auth = await authResponse.json() as AuthPayload;
      expect(authResponse.ok()).toBeTruthy();
      expect(auth.user?.id).toBeTruthy();
      const workspaceResponse = await context.request.get('/api/workspaces');
      const workspacePayload = await workspaceResponse.json() as { workspaces?: Workspace[] };
      expect(workspaceResponse.ok()).toBeTruthy();
      const allowed = (workspace: Workspace) => !workspace.legacy
        && workspace.permissions.canRead && workspace.permissions.canWrite && workspace.permissions.canRunAgent;
      const personal = workspacePayload.workspaces?.find((workspace) => workspace.type === 'personal' && allowed(workspace));
      const team = workspacePayload.workspaces?.find((workspace) => ['team', 'organization'].includes(workspace.type)
        && allowed(workspace));
      expect(personal, 'A permitted writable Personal workspace is required.').toBeTruthy();
      expect(team, 'A permitted writable Team/organization workspace is required.').toBeTruthy();
      expect(team!.id).not.toBe(personal!.id);
      personalWorkspaceId = personal!.id;
      teamWorkspaceId = team!.id;

      await context.addInitScript((workspaceId) => {
        window.localStorage.setItem('canvas.activeWorkspaceId', workspaceId);
        window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, personalWorkspaceId);
      await uploadWorkspaceTextFile({ request: context.request, workspaceId: personalWorkspaceId,
        filePath: personalPath, content: BASE_TEXT });
      personalUploaded = true;
      const personalFixture = await initializeDocument({ request: context.request, workspaceId: personalWorkspaceId,
        filePath: personalPath, userId: auth.user!.id!, role: auth.user?.role ?? 'member' });
      const oldProposal = personalFixture.proposals.find((proposal) => proposal.label === 'B')!;
      expect(oldProposal).toBeTruthy();
      delayedOperationId = oldProposal.operationId;

      await uploadWorkspaceTextFile({ request: context.request, workspaceId: teamWorkspaceId,
        filePath: teamPath, content: DESTINATION_TEXT });
      teamUploaded = true;
      const teamFixture = await initializeDocument({ request: context.request, workspaceId: teamWorkspaceId,
        filePath: teamPath, userId: auth.user!.id!, role: auth.user?.role ?? 'member' });
      const destinationProposal = teamFixture.proposals.find((proposal) => proposal.label === 'C')!;
      const destinationBaseline = await timeline(context, teamWorkspaceId, teamPath);
      const destinationRevisionCount = destinationBaseline.entries.filter((entry) => entry.kind === 'revision').length;

      page.on('request', (request) => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions')) actionPosts += 1;
      });
      await page.route('**/api/files/version-center/v1/proposals/review', async (route) => {
        const request = route.request();
        let operationId: string | undefined;
        try {
          operationId = (request.postDataJSON() as { selection?: { operationId?: string } }).selection?.operationId;
        } catch { operationId = undefined; }
        if (!responseFetched && operationId === delayedOperationId) {
          const response = await route.fetch();
          delayedStatus = response.status();
          responseFetched = true;
          notifyResponseFetched();
          try {
            await releaseResponsePromise;
            await route.fulfill({ response });
          } catch (error) {
            const failure = request.failure() ?? '';
            const detail = error instanceof Error ? error.message : '';
            if (!/abort|cancel/iu.test(`${failure} ${detail}`)) throw error;
          } finally {
            notifyRouteFinished();
          }
          return;
        }
        await route.continue();
      });

      const oldRequest: FileVersionCenterRequestV1 = {
        contractVersion: 1,
        target: { kind: 'lineage', workspaceId: personalWorkspaceId, lineageId: personalFixture.scope.lineageId },
        selectedEntry: { kind: 'agent_operation', id: oldProposal.operationId },
        initialView: 'reviews',
        source: 'deep_link',
      };
      await page.goto(buildFileVersionCenterDeepLinkV1('/en/notebook', oldRequest));
      await expect(page.getByTestId('file-version-center')).toBeVisible();
      await responseFetchedPromise;
      expect(delayedStatus).toBe(200);

      // Close via the center's UI, then switch scope and open another real file
      // through the Notebook workspace switcher, explorer, editor and history button.
      await page.getByTestId('file-version-center').getByRole('button', { name: 'Close' }).click();
      await expect(page.getByTestId('file-version-center')).toHaveCount(0);
      // The file-browser toolbar also renders a workspace switcher. Bind this
      // assertion and switch to the actual global Notebook header control.
      // The modal makes the background banner aria-hidden while the new
      // review is open. Use its unique real header ancestor so we can still
      // inspect the active scope without treating it as an interactive target.
      const workspaceSwitcher = page.locator('header').getByTestId('workspace-switcher');
      await expect(workspaceSwitcher).toHaveCount(1);
      await expect(workspaceSwitcher).toBeVisible();
      await expect(workspaceSwitcher).toHaveAttribute('data-active-workspace-id', personalWorkspaceId);
      await workspaceSwitcher.click();
      await page.getByTestId(`workspace-option-${teamWorkspaceId}`).click();
      await expect(workspaceSwitcher).toHaveAttribute('data-active-workspace-id', teamWorkspaceId);
      await expect(page.getByTestId('notebook-toolbar')).toBeVisible();
      const showExplorer = page.getByRole('button', { name: 'Show sidebar', exact: true });
      if (await showExplorer.isVisible()) await showExplorer.click();
      const destinationFile = page.locator(`[data-file-path="${teamPath}"]`);
      await expect(destinationFile).toBeVisible({ timeout: 30_000 });
      await destinationFile.dblclick();
      const versionHistory = page.getByRole('tabpanel', { name: teamPath, exact: true })
        .getByRole('button', { name: 'Open agent changes: 2', exact: true });
      await expect(versionHistory).toBeVisible({ timeout: 30_000 });
      await expect(versionHistory).toBeEnabled({ timeout: 30_000 });
      await versionHistory.click();
      const center = page.getByTestId('file-version-center');
      await expect(center).toBeVisible();
      const destinationCard = center.locator(`button[data-operation-id="${destinationProposal.operationId}"]`);
      await expect(destinationCard).toBeVisible({ timeout: 30_000 });
      await destinationCard.click();
      const graph = page.getByTestId('graph-review-comparison');
      await expect(destinationCard).toHaveAttribute('aria-pressed', 'true');
      await expect(graph.getByText('Ready to apply')).toBeVisible({ timeout: 30_000 });
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('130');
      await expect(graph.getByTestId('graph-review-hunks')).not.toContainText('120');

      releaseResponse();
      await routeFinishedPromise;
      expect(delayedStatus).toBe(200);
      await expect(workspaceSwitcher).toHaveAttribute('data-active-workspace-id', teamWorkspaceId);
      await expect(destinationCard).toHaveAttribute('aria-pressed', 'true');
      await expect(graph.getByText('Ready to apply')).toBeVisible();
      await expect(graph.getByTestId('graph-review-hunks')).toContainText('130');
      await expect(graph.getByTestId('graph-review-hunks')).not.toContainText('120');
      await expect(graph.getByRole('button', { name: 'Accept change', exact: true })).toBeEnabled();
      expect(actionPosts, 'The stale review must not issue an action during navigation.').toBe(0);
      expect(await readFile(context, personalWorkspaceId, personalPath)).toBe(BASE_TEXT);
      expect(await readFile(context, teamWorkspaceId, teamPath)).toBe(DESTINATION_TEXT);
      expect((await timeline(context, teamWorkspaceId, teamPath)).entries
        .filter((entry) => entry.kind === 'revision')).toHaveLength(destinationRevisionCount);

      const actionResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/proposals/actions'));
      await graph.getByRole('button', { name: 'Accept change', exact: true }).click();
      await graph.getByRole('button', { name: 'Confirm action', exact: true }).click();
      const actionResponse = await actionResponsePromise;
      expect(actionResponse.ok(), `Exact destination action returned ${actionResponse.status()}.`).toBeTruthy();
      const receipt = JSON.parse(await actionResponse.text()) as ProposalActionReceiptV1;
      expect(receipt.phase).toBe('succeeded');
      expect(receipt.affectedProposalIds).toEqual([destinationProposal.proposalId]);
      expect(receipt.scope.workspaceId).toBe(teamWorkspaceId);
      expect(actionPosts).toBe(1);
      await expect.poll(() => readFile(context, teamWorkspaceId!, teamPath), { timeout: 30_000 })
        .toBe('# Proposal review fixture\n\nPlan: 130 USD.\n');
      expect(await readFile(context, personalWorkspaceId, personalPath)).toBe(BASE_TEXT);
      expect((await timeline(context, teamWorkspaceId, teamPath)).entries
        .filter((entry) => entry.kind === 'revision')).toHaveLength(destinationRevisionCount + 1);
      await testInfo.attach('proposal-review-navigation-keeps-destination-scope.json', {
        body: JSON.stringify({ staleResponseStatus: delayedStatus, actionType: receipt.actionType,
          affectedProposalIds: receipt.affectedProposalIds, workspaceId: receipt.scope.workspaceId }, null, 2),
        contentType: 'application/json',
      });
    } finally {
      releaseResponse();
      if (responseFetched) await routeFinishedPromise;
      if (personalUploaded && personalWorkspaceId) await removeFile(context, personalWorkspaceId, personalPath);
      if (teamUploaded && teamWorkspaceId) await removeFile(context, teamWorkspaceId, teamPath);
      await context.close();
      assertNoServerErrors();
    }
  });
});
