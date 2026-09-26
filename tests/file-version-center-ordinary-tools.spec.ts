import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildFileVersionCenterDeepLinkV1 } from '../app/lib/file-version-center/contracts/deep-link-v1';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { createAuthenticatedContext, uploadWorkspaceTextFile } from './helpers/managed-test-context';
import { observeProposalReviewServerErrors } from './helpers/proposal-review-server-errors';

const execFileAsync = promisify(execFile);
const HEADER = 'x-canvas-workspace-id';
const BASE_TEXT = '# Ordinary agent edits\n\nA0|B0|C0|D0|E0|F0|G0|H0|I0|J0\n';
const FINAL_TEXT = '# Ordinary agent edits\n\nA1|B1|C1|D1|E1|F1|G1|H1|I1|J1\n';
type Workspace = { id: string; name: string; type: string; legacy?: boolean; rootRelativePath: string;
  organizationId?: string | null; customerId?: string | null; projectId?: string | null;
  permissions: { canRead: boolean; canWrite: boolean; canRunAgent: boolean; canDelete: boolean; canCreatePublicLinks: boolean } };
type ToolResult = { isError?: boolean; details?: { sha256?: string; code?: string; outcome?: string;
  proposal?: { proposalId: string; operationId: string; creationKind: string; source: { kind: string } };
  collaboration?: { operationId: string; operationStatus: string; durability: string; reviewRequired: boolean } } };

async function runTool(input: { toolName: 'read' | 'edit_file'; toolCallId: string;
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

test.describe('Ordinary Markdown tools through the proposal graph', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed PostgreSQL stack and enabled local graph policy.');

  test('ten ordinary edit_file roots: three singles then seven in one batch preserve exact content and four revisions', async ({ browser }, info) => {
    test.setTimeout(240_000);
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } });
    const assertNoServerErrors = observeProposalReviewServerErrors(context);
    const page = await context.newPage();
    const filePath = `fvrc-1008-ordinary-${randomUUID()}.md`;
    let workspaceId: string | undefined;
    let sessionId: string | undefined;
    let agentId: string | undefined;
    let uploaded = false;
    try {
      const authResponse = await context.request.get('/api/auth/get-session');
      expect(authResponse.ok()).toBeTruthy();
      const auth = await authResponse.json() as { user: { id: string } };
      const workspacesResponse = await context.request.get('/api/workspaces');
      expect(workspacesResponse.ok()).toBeTruthy();
      const workspace = ((await workspacesResponse.json()).workspaces as Workspace[]).find(item =>
        item.type === 'personal' && !item.legacy && item.permissions.canWrite && item.permissions.canRunAgent);
      expect(workspace, 'A writable personal workspace is required.').toBeTruthy();
      workspaceId = workspace!.id;
      const headers = { [HEADER]: workspaceId };
      await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: BASE_TEXT });
      uploaded = true;
      await context.addInitScript(id => {
        localStorage.setItem('canvas.activeWorkspaceId', id);
        localStorage.setItem('canvas.notebook.chatVisible', 'false');
      }, workspaceId);
      await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`);
      const policy = page.getByRole('switch', {
        name: /Require review for agent changes|Edit directly when safe|Review für Agentenänderungen erforderlich|Direkt bearbeiten, wenn sicher/u,
      });
      await expect(policy).not.toBeChecked({ timeout: 30_000 });
      await policy.click();
      await expect(policy).toBeChecked();
      const collaboration = await context.request.post('/api/files/collaboration/session', {
        headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
      });
      expect(collaboration.ok()).toBeTruthy();
      const { documentId } = await collaboration.json() as { documentId: string };
      expect(documentId).toBeTruthy();
      const sessionResponse = await context.request.post('/api/sessions', {
        headers, data: { agentId: 'canvas-agent', workspaceId, title: 'FVRC ordinary graph tool acceptance' },
      });
      expect(sessionResponse.ok()).toBeTruthy();
      const session = (await sessionResponse.json()).session as { sessionId: string; agentId: string };
      sessionId = session.sessionId;
      agentId = session.agentId;
      const agentContext = { userId: auth.user.id, sessionId, agentId, workspaceId,
        workspaceType: workspace!.type, workspaceName: workspace!.name,
        organizationId: workspace!.organizationId ?? null, customerId: workspace!.customerId ?? null,
        projectId: workspace!.projectId ?? null,
        workspaceRoot: path.resolve(process.env.DATA || 'data', workspace!.rootRelativePath),
        workspaceRootRelativePath: workspace!.rootRelativePath,
        canWrite: true, canDelete: workspace!.permissions.canDelete,
        canShare: workspace!.permissions.canCreatePublicLinks, legacy: false };
      const target = { kind: 'document' as const, workspaceId, documentId };
      const content = async () => {
        const response = await context.request.get('/api/files/read', { headers, params: { path: filePath } });
        expect(response.ok()).toBeTruthy();
        return (await response.json()).data.content as string;
      };
      const revisionCount = async () => {
        const response = await context.request.post('/api/files/version-center/v1/resolve', {
          headers, data: { contractVersion: 1, target, initialView: 'history', source: 'deep_link' },
        });
        expect(response.ok()).toBeTruthy();
        return ((await response.json()).entries as Array<{ kind: string }>).filter(entry => entry.kind === 'revision').length;
      };
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
        expect(receipt.affectedProposalIds).toHaveLength(round === 3 ? 7 : 1);
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
        body: JSON.stringify({ filePath, target, proposals, expected: FINAL_TEXT,
          beforeRevisionCount, afterRevisionCount: beforeRevisionCount + 4,
          actionTypes: receipts.map(receipt => receipt.actionType) }, null, 2) });
      await info.attach('ordinary-tool-graph-final.png', { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
    } finally {
      await page.close().catch(() => undefined);
      try {
        try {
          if (sessionId && agentId) {
            const response = await context.request.delete('/api/sessions', { params: { sessionId, agentId } });
            expect(response.ok(), 'Remove only the scoped synthetic agent session.').toBeTruthy();
          }
        } finally {
          if (uploaded && workspaceId) {
            const response = await context.request.delete('/api/files/delete', {
              headers: { [HEADER]: workspaceId }, data: { path: filePath },
            });
            expect(response.ok(), 'Remove only the scoped synthetic Markdown document.').toBeTruthy();
          }
        }
      } finally {
        await context.close();
        assertNoServerErrors();
      }
    }
  });
});
