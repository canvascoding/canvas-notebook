import { expect, type BrowserContext } from '@playwright/test';
import { test } from './helpers/document-review-experimental';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { promisify } from 'node:util';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import {
  FILE_VERSION_HISTORY_PROVENANCE_HEADER_V1,
  parseFileVersionTimelineResponseV1,
  type FileVersionCenterRequestV1,
  type FileVersionTimelineResponseV1,
} from '../app/lib/file-version-center/contracts/v1';
import type { ProposalReviewActionApiRequestV1, ProposalReviewSessionResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const execFileAsync = promisify(execFile);
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const CONTENT = '# Proposal review fixture\n\nPlan: 100 USD.\n';

type Credentials = { email?: string; password?: string };
type Workspace = { id: string; type: string };
type AuthSession = { user?: { id?: string; role?: string } | null };
type Fixture = { scope: { workspaceId: string; lineageId: string; documentId: string };
  proposals: Array<{ label: string; proposalId: string; operationId: string }> };

function readEnvFile(name: string): Record<string, string> {
  const stateDir = process.env.CANVAS_LOCAL_TEAM_SEAT_STATE_DIR
    || path.join(os.homedir(), '.local/state/canvas-local-team-seat');
  try {
    return parseDotenv(readFileSync(path.join(stateDir, name), 'utf8'));
  } catch {
    return {};
  }
}

const hostEnv = readEnvFile('notebook-host-dev.env');
const fixturesEnv = readEnvFile('fixtures.env');
const ownerCredentials: Credentials = {
  email: process.env.BOOTSTRAP_ADMIN_EMAIL || hostEnv.BOOTSTRAP_ADMIN_EMAIL,
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD || hostEnv.BOOTSTRAP_ADMIN_PASSWORD,
};
const reviewerCredentials: Credentials = {
  email: process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL || fixturesEnv.LOCAL_TEAM_SEAT_SECONDARY_EMAIL,
  password: process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD || fixturesEnv.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD,
};
const enabled = process.env.COLLABORATION_E2E === '1'
  && Boolean(ownerCredentials.email && ownerCredentials.password && reviewerCredentials.email && reviewerCredentials.password);

async function createFixture(input: { scenario: 'conflict' | 'owner-pair'; userId: string; role: string;
  workspaceId: string; documentId: string; filePath: string }): Promise<Fixture> {
  const encoded = Buffer.from(JSON.stringify({ scenario: input.scenario, userId: input.userId, role: input.role,
    workspaceId: input.workspaceId, documentId: input.documentId, filePath: input.filePath })).toString('base64url');
  try {
    const result = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'), [
      '--conditions', 'react-server', 'scripts/fvrc-1006-browser-fixture.ts', encoded,
    ], { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 });
    for (const line of String(result.stdout).trim().split('\n').reverse()) {
      try { return JSON.parse(line) as Fixture; } catch { /* only the driver receipt is JSON */ }
    }
  } catch (error) {
    void error;
    throw new Error('FVRC-1006 permissions fixture driver failed; details are intentionally redacted.');
  }
  throw new Error('FVRC-1006 permissions fixture driver returned no receipt.');
}

async function timeline(context: BrowserContext, workspaceId: string, filePath: string): Promise<FileVersionTimelineResponseV1> {
  const response = await context.request.post('/api/files/version-center/v1/resolve', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId, [FILE_VERSION_HISTORY_PROVENANCE_HEADER_V1]: '1' },
    data: { contractVersion: 1, target: { kind: 'path', workspaceId, pathHint: filePath },
      initialView: 'history', source: 'file_browser' },
  });
  expect(response.status(), `Timeline request returned ${response.status()}.`).toBe(200);
  const result = parseFileVersionTimelineResponseV1(await response.json());
  expect(result.document.workspaceId).toBe(workspaceId);
  expect(result.document.path).toBe(filePath);
  return result;
}

async function readContent(context: BrowserContext, workspaceId: string, filePath: string): Promise<string> {
  const response = await context.request.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
  });
  expect(response.ok(), `File read returned ${response.status()}.`).toBeTruthy();
  const payload = await response.json() as { data?: { content?: string } };
  return payload.data?.content ?? '';
}

async function updateMember(owner: BrowserContext, workspaceId: string, userId: string,
  access: { canRead: boolean; canWrite: boolean }): Promise<void> {
  const response = await owner.request.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, {
    data: { userId, role: 'member', canRead: access.canRead, canWrite: access.canWrite, canManage: false },
  });
  expect(response.ok(), `Member permission update returned ${response.status()}.`).toBeTruthy();
}

test.describe('FVRC-1006 graph workspace permissions', () => {
  test.skip(!enabled, 'Requires the managed local Team Seat stack and configured owner/secondary test accounts.');
  test.setTimeout(180_000);

  test('keeps read-only review available, rejects a saved write fence, and purges review after read access is revoked',
    async ({ browser }, testInfo) => {
      const owner = await createAuthenticatedContext(browser, {}, ownerCredentials);
      const reviewer = await createAuthenticatedContext(browser, {}, reviewerCredentials);
      const assertNoOwnerErrors = observeProposalReviewServerErrors(owner);
      const assertNoReviewerErrors = observeProposalReviewServerErrors(reviewer);
      const page = await reviewer.newPage();
      const filePath = `fvrc-1006-${randomUUID()}.md`;
      let workspaceId: string | null = null;
      let reviewerId: string | null = null;
      let uploaded = false;
      try {
        const ownerResponse = await owner.request.get('/api/auth/get-session');
        const ownerSession = await ownerResponse.json() as AuthSession;
        expect(ownerResponse.ok()).toBeTruthy();
        expect(ownerSession.user?.id).toBeTruthy();
        const reviewerResponse = await reviewer.request.get('/api/auth/get-session');
        const reviewerSession = await reviewerResponse.json() as AuthSession;
        expect(reviewerResponse.ok()).toBeTruthy();
        expect(reviewerSession.user?.id).toBeTruthy();
        reviewerId = reviewerSession.user!.id!;
        expect(reviewerId).not.toBe(ownerSession.user!.id);

        const workspaceResponse = await owner.request.post('/api/workspaces', {
          data: { type: 'team', name: `FVRC permissions ${randomUUID()}`, description: 'Isolated FVRC-1006 permission fixture.' },
        });
        const workspacePayload = await workspaceResponse.json() as { workspace?: Workspace };
        expect(workspaceResponse.status()).toBe(201);
        expect(workspacePayload.workspace?.id).toBeTruthy();
        workspaceId = workspacePayload.workspace!.id;
        await updateMember(owner, workspaceId, reviewerId, { canRead: true, canWrite: true });

        await uploadWorkspaceTextFile({ request: owner.request, workspaceId, filePath, content: CONTENT });
        uploaded = true;
        const collaboration = await reviewer.request.post('/api/files/collaboration/session', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
        });
        const collaborationPayload = await collaboration.json() as { documentId?: string };
        expect(collaboration.ok(), `Collaboration session returned ${collaboration.status()}.`).toBeTruthy();
        expect(collaborationPayload.documentId).toBeTruthy();

        const fixture = await createFixture({ scenario: 'conflict', userId: reviewerId, role: 'member',
          workspaceId, documentId: collaborationPayload.documentId!, filePath });
        expect(fixture.scope.workspaceId).toBe(workspaceId);
        expect(fixture.proposals.map((proposal) => proposal.label)).toEqual(['B', 'C']);
        const ownerRole = ownerSession.user?.role;
        expect(['owner', 'admin', 'member', 'external']).toContain(ownerRole);
        if (!ownerRole || !['owner', 'admin', 'member', 'external'].includes(ownerRole)) {
          throw new Error('Authenticated workspace owner role is unavailable.');
        }
        const ownerFixture = await createFixture({ scenario: 'owner-pair', userId: ownerSession.user!.id!, role: ownerRole,
          workspaceId, documentId: fixture.scope.documentId, filePath });
        expect(ownerFixture.proposals.map((proposal) => proposal.label)).toEqual(['D', 'E']);
        const memberProposalIds = fixture.proposals.map((proposal) => proposal.proposalId);
        const managerProposalIds = ownerFixture.proposals.map((proposal) => proposal.proposalId);
        expect(new Set([...memberProposalIds, ...managerProposalIds]).size).toBe(4);
        const memberOperationIds = fixture.proposals.map((proposal) => proposal.operationId);
        const managerOperationIds = ownerFixture.proposals.map((proposal) => proposal.operationId);

        const reviewerTimeline = await timeline(reviewer, workspaceId, filePath);
        expect(reviewerTimeline.document.lineageId).toBe(fixture.scope.lineageId);
        expect(reviewerTimeline.document.documentId).toBe(fixture.scope.documentId);
        expect(reviewerTimeline.entries.some((entry) => entry.kind === 'current'),
          'Read access must keep the current document entry visible.').toBe(true);
        const currentEntries = reviewerTimeline.entries.filter((entry) => entry.kind === 'current');
        const savedEntries = reviewerTimeline.entries.filter((entry) => entry.kind === 'revision');
        expect(currentEntries).toHaveLength(1);
        expect(savedEntries).toHaveLength(1);
        const current = currentEntries[0];
        const saved = savedEntries[0];
        if (current?.kind !== 'current' || saved?.kind !== 'revision') {
          throw new Error('Read access needs the exact Current entry and its sole immutable saved revision.');
        }
        const contentHash = createHash('sha256').update(CONTENT).digest('hex');
        const contentSize = Buffer.byteLength(CONTENT, 'utf8');
        expect(current.displayRevisionId ?? current.revisionId).toBe(saved.revisionId);
        expect(saved.id).toBe(saved.revisionId);
        expect(saved.content.availability).toBe('available');
        expect(saved.content.sha256).toBe(contentHash);
        expect(saved.content.sizeBytes).toBe(contentSize);
        expect(current.sha256).toBe(contentHash);
        expect(current.sizeBytes).toBe(contentSize);
        const savedVersionProof = { id: saved.id, revisionId: saved.revisionId, revisionNumber: saved.revisionNumber,
          createdAt: saved.createdAt, source: saved.source, actor: saved.actor, content: saved.content };
        expect(reviewerTimeline.entries.filter((entry) => entry.kind === 'agent_operation')
          .map((entry) => entry.operationId).sort()).toEqual(memberOperationIds.slice().sort());
        const managerTimeline = await timeline(owner, workspaceId, filePath);
        expect(managerTimeline.document.lineageId).toBe(fixture.scope.lineageId);
        expect(managerTimeline.document.documentId).toBe(fixture.scope.documentId);
        expect(managerTimeline.entries.filter((entry) => entry.kind === 'agent_operation')
          .map((entry) => entry.operationId).sort()).toEqual([...memberOperationIds, ...managerOperationIds].sort());
        expect(managerTimeline.entries.filter((entry) => entry.kind === 'revision')).toHaveLength(1);
        expect(managerTimeline.entries.filter((entry) => entry.kind === 'revision')).toMatchObject([savedVersionProof]);

        const proposalC = fixture.proposals.find((proposal) => proposal.label === 'C')!;
        const target = { kind: 'document' as const, workspaceId, documentId: fixture.scope.documentId };
        const reviewResponse = await reviewer.request.post('/api/files/version-center/v1/proposals/review', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: proposalC.operationId } },
        });
        const review = await reviewResponse.json() as ProposalReviewSessionResponseV1;
        expect(reviewResponse.ok(), `Review request returned ${reviewResponse.status()}.`).toBeTruthy();
        expect(review.mode).toBe('graph');
        if (review.mode !== 'graph') throw new Error('Graph review unexpectedly fell back to legacy.');
        expect(review.capability.write).toBe(true);
        expect(review.actions.accept).toBeTruthy();
        const savedAction = review.actions.accept;
        if (!savedAction) throw new Error('Writable review did not prepare its accept action.');

        const request: FileVersionCenterRequestV1 = {
          contractVersion: 1,
          target: { kind: 'lineage', workspaceId, lineageId: fixture.scope.lineageId },
          selectedEntry: { kind: 'agent_operation', id: proposalC.operationId },
          initialView: 'reviews', source: 'deep_link',
        };
        const href = buildFileVersionCenterDeepLinkV1('/en', request);
        await page.goto(href);
        const graph = page.getByTestId('graph-review-comparison');
        await expect(graph).toBeVisible();
        await expect(graph.getByText('Ready to apply').or(graph.getByText('Ready after rebase'))).toBeVisible();
        await expect(graph.getByTestId('graph-review-hunks')).toContainText('130');
        const reviewerTimelineNav = page.getByRole('navigation', { name: 'Document versions and proposed changes' });
        const currentCard = reviewerTimelineNav.getByRole('region', { name: 'Current', exact: true })
          .locator('button[data-entry-kind="current"]');
        await expect(currentCard).toHaveCount(1);
        await expect(currentCard).toBeVisible();
        await expect(currentCard.getByText(`Version ${saved.revisionNumber}`, { exact: true })).toBeVisible();
        await expect(currentCard.locator('time:not(.tabular-nums)')).toHaveAttribute('datetime', saved.createdAt);
        const olderHistory = reviewerTimelineNav.getByTestId('file-version-history-section');
        await expect(olderHistory.locator('button[data-entry-kind="revision"]')).toHaveCount(0);
        await expect(olderHistory.getByText('No older saved versions.', { exact: true })).toBeVisible();
        for (const proposal of ownerFixture.proposals) {
          await expect(reviewerTimelineNav.locator(`button[data-operation-id="${proposal.operationId}"]`)).toHaveCount(0);
        }

        await updateMember(owner, workspaceId, reviewerId, { canRead: true, canWrite: false });
        const staleAction: ProposalReviewActionApiRequestV1 = {
          contractVersion: 1,
          target,
          action: { contractVersion: 1, ...savedAction, idempotencyKey: randomUUID(), creation: null },
        };
        const deniedResponse = await reviewer.request.post('/api/files/version-center/v1/proposals/actions', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: staleAction,
        });
        expect(deniedResponse.status()).toBe(403);
        expect(await readContent(reviewer, workspaceId, filePath)).toBe(CONTENT);
        const unchangedTimeline = await timeline(reviewer, workspaceId, filePath);
        expect(unchangedTimeline.entries.filter((entry) => entry.kind === 'revision')).toHaveLength(1);
        expect(unchangedTimeline.entries.filter((entry) => entry.kind === 'revision')).toMatchObject([savedVersionProof]);

        const readOnlyReviewResponse = await reviewer.request.post('/api/files/version-center/v1/proposals/review', {
          headers: { [WORKSPACE_ID_HEADER]: workspaceId },
          data: { contractVersion: 1, target, selection: { kind: 'operation', operationId: proposalC.operationId } },
        });
        const readOnlyReview = await readOnlyReviewResponse.json() as ProposalReviewSessionResponseV1;
        expect(readOnlyReviewResponse.ok()).toBeTruthy();
        expect(readOnlyReview.mode).toBe('graph');
        if (readOnlyReview.mode !== 'graph') throw new Error('Read-only graph review unexpectedly fell back to legacy.');
        expect(readOnlyReview.capability.write).toBe(false);
        expect(readOnlyReview.actions).toEqual({});
        await page.reload();
        await expect(page.getByTestId('graph-review-comparison')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Accept change' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Accept all changes' })).toHaveCount(0);
        await expect(page.getByTestId('graph-review-comparison')
          .getByText('Review is read only. Graph actions are not enabled for this document.', { exact: true })).toBeVisible();

        const currentTimeline = await timeline(reviewer, workspaceId, filePath);
        expect(currentTimeline.entries.filter((entry) => entry.kind === 'revision')).toHaveLength(1);
        expect(currentTimeline.entries.filter((entry) => entry.kind === 'revision')).toMatchObject([savedVersionProof]);
        expect(await readContent(reviewer, workspaceId, filePath)).toBe(CONTENT);
        await testInfo.attach('read-only-review.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

        const revoke = await owner.request.delete(`/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(reviewerId)}`);
        expect(revoke.ok(), `Member revocation returned ${revoke.status()}.`).toBeTruthy();
        const revokedResolve = page.waitForResponse((response) => response.request().method() === 'POST'
          && new URL(response.url()).pathname.endsWith('/api/files/version-center/v1/resolve'));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const lostReadResponse = await revokedResolve;
        expect([401, 403, 404]).toContain(lostReadResponse.status());
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(page.getByTestId('graph-review-comparison')).toHaveCount(0);
        await expect(page.locator(`[data-operation-id="${proposalC.operationId}"]`)).toHaveCount(0);
        expect(await readContent(owner, workspaceId, filePath)).toBe(CONTENT);
        const finalTimeline = await timeline(owner, workspaceId, filePath);
        expect(finalTimeline.entries.filter((entry) => entry.kind === 'revision')).toHaveLength(1);
        expect(finalTimeline.entries.filter((entry) => entry.kind === 'revision')).toMatchObject([savedVersionProof]);
        await testInfo.attach('revoked-review-cleared.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      } finally {
        if (workspaceId) {
          if (uploaded) {
            const deletedFile = await owner.request.delete('/api/files/delete', {
              headers: { [WORKSPACE_ID_HEADER]: workspaceId }, data: { path: filePath },
            });
            expect(deletedFile.ok(), `Could not remove permission fixture ${filePath}.`).toBeTruthy();
          }
          const deletedWorkspace = await owner.request.delete(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
          expect(deletedWorkspace.ok(), 'Could not remove the isolated FVRC-1006 workspace.').toBeTruthy();
        }
        await Promise.all([reviewer.close(), owner.close()]);
        assertNoReviewerErrors();
        assertNoOwnerErrors();
      }
    });
});
