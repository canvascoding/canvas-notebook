import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { COLLABORATION_CLIENT_CAPABILITIES } from '../../app/lib/collaboration/types';
import { createAuthenticatedContext, uploadWorkspaceTextFile, type AuthenticatedContextIdentity } from './managed-test-context';
import { observeProposalReviewServerErrors, type ProposalReviewServerErrorExpectation } from './proposal-review-server-errors';
import { withOwnedTestCleanup } from './owned-test-cleanup';

type Workspace = { id: string; name: string; type: string; legacy?: boolean; rootRelativePath: string;
  organizationId?: string | null; customerId?: string | null; projectId?: string | null;
  permissions: { canRead: boolean; canWrite: boolean; canRunAgent: boolean; canDelete: boolean; canCreatePublicLinks: boolean } };

export type OrdinaryAgentDocument = {
  context: BrowserContext;
  page: Page;
  filePath: string;
  target: { kind: 'document'; workspaceId: string; documentId: string };
  representation: string;
  agentContext: Record<string, unknown>;
  content(): Promise<string>;
  revisionCount(): Promise<number>;
};

/** Uses normal authenticated APIs; every invocation owns and removes only its UUID fixture. */
export async function withOrdinaryAgentDocument(browser: Browser, initialContent: string,
  run: (fixture: OrdinaryAgentDocument) => Promise<void>,
  options: { workspaceKind?: 'personal' | 'team'; identity?: AuthenticatedContextIdentity;
    workspaceId?: string;
    cleanupIdentity?: AuthenticatedContextIdentity; initialReviewRequired?: boolean;
    navigationTimeoutMs?: number;
    retryStaleCleanup?: boolean;
    bindToolSessionToFixture?: boolean;
    expectedReviewServerErrors?: ReadonlyArray<ProposalReviewServerErrorExpectation> } = {}): Promise<void> {
  const workspaceKind = options.workspaceKind ?? 'personal';
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1500, height: 950 } }, options.identity);
  const assertNoServerErrors = observeProposalReviewServerErrors(context, options.expectedReviewServerErrors);
  let ownedPage: Page | undefined;
  let cleanupContext: BrowserContext | undefined;
  const filePath = `fvrc-1008-ordinary-${randomUUID()}.md`;
  let workspaceId: string | undefined;
  let sessionId: string | undefined;
  let agentId: string | undefined;
  let uploaded = false;
  await withOwnedTestCleanup(async () => {
    const page = await context.newPage();
    ownedPage = page;
    const authResponse = await context.request.get('/api/auth/get-session');
    expect(authResponse.ok()).toBeTruthy();
    const auth = await authResponse.json() as { user: { id: string } };
    const workspacesResponse = await context.request.get('/api/workspaces');
    expect(workspacesResponse.ok()).toBeTruthy();
    const workspace = ((await workspacesResponse.json()).workspaces as Workspace[]).find(item =>
      (workspaceKind === 'personal' ? item.type === 'personal' : ['team', 'organization'].includes(item.type))
      && (!options.workspaceId || item.id === options.workspaceId)
      && !item.legacy && item.permissions.canWrite && item.permissions.canRunAgent);
    expect(workspace, `A writable ${workspaceKind} workspace is required.`).toBeTruthy();
    expect(Boolean(workspace!.permissions.canDelete || options.cleanupIdentity),
      'A fixture without delete rights requires an explicit cleanup identity.').toBe(true);
    workspaceId = workspace!.id;
    const headers = { 'x-canvas-workspace-id': workspaceId };
    await uploadWorkspaceTextFile({ request: context.request, workspaceId, filePath, content: initialContent });
    uploaded = true;
    await context.addInitScript(id => {
      localStorage.setItem('canvas.activeWorkspaceId', id);
      localStorage.setItem('canvas.notebook.chatVisible', 'false');
    }, workspaceId);
    await page.goto(`/en/notebook?path=${encodeURIComponent(filePath)}`, { timeout: options.navigationTimeoutMs });
    const policy = page.getByRole('switch', {
      name: /Require review for agent changes|Edit directly when safe|Review für Agentenänderungen erforderlich|Direkt bearbeiten, wenn sicher/u,
    });
    if (options.initialReviewRequired === false) {
      const availability = await context.request.get('/api/document-review/availability');
      expect(availability.ok()).toBeTruthy();
      const { data } = await availability.json() as { data: { documentReviewEnabled: boolean } };
      expect(typeof data.documentReviewEnabled).toBe('boolean');
      if (data.documentReviewEnabled) await expect(policy).not.toBeChecked({ timeout: 30_000 });
      else await expect(policy).toHaveCount(0);
    } else {
      await expect(policy).not.toBeChecked({ timeout: 30_000 });
      await policy.click();
      await expect(policy).toBeChecked();
    }
    const collaboration = await context.request.post('/api/files/collaboration/session', {
      headers, data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES },
    });
    expect(collaboration.ok()).toBeTruthy();
    const { documentId, representation } = await collaboration.json() as { documentId: string; representation: string };
    expect(documentId).toBeTruthy();
    const sessionResponse = await context.request.post('/api/sessions', {
      headers, data: { agentId: 'canvas-agent', workspaceId,
        title: options.bindToolSessionToFixture ? `FVRC ordinary graph tool acceptance:${filePath}`
          : 'FVRC ordinary graph tool acceptance' },
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
    await run({ context, page, filePath, target, representation, agentContext, content, revisionCount });
  }, [
    { label: 'document page', run: async () => { await ownedPage?.close(); } },
    { label: 'agent session', run: async () => {
      if (sessionId && agentId) {
        const response = await context.request.delete('/api/sessions', { params: { sessionId, agentId } });
        expect(response.ok(), 'Remove only the scoped synthetic agent session.').toBeTruthy();
      }
    } },
    { label: 'document file', run: async () => {
      if (uploaded && workspaceId) {
        const cleanup = options.cleanupIdentity
          ? (cleanupContext = await createAuthenticatedContext(browser, {}, options.cleanupIdentity)) : context;
        for (let attempt = 0; attempt < (options.retryStaleCleanup ? 3 : 1); attempt++) {
          const response = await cleanup.request.delete('/api/files/delete', {
            headers: { 'x-canvas-workspace-id': workspaceId }, data: { path: filePath },
            timeout: options.retryStaleCleanup ? 15_000 : undefined,
          });
          if (response.ok()) return;
          const payload = await response.json() as { code?: string };
          if (options.retryStaleCleanup && response.status() === 409 && payload.code === 'PREVIEW_STALE' && attempt < 2) {
            // Adopt the exact current proof before replanning the same owned deletion.
            const current = await cleanup.request.post('/api/files/collaboration/session', {
              headers: { 'x-canvas-workspace-id': workspaceId },
              data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES }, timeout: 15_000,
            });
            expect(current.ok(), 'Read the owned document proof for stale cleanup.').toBeTruthy();
            const proof = await current.json() as { token: string; stateVector: string; stateProof: string };
            const checkpoint = await cleanup.request.post('/api/files/collaboration/checkpoint', {
              headers: { 'x-canvas-workspace-id': workspaceId },
              data: { token: proof.token, stateVector: proof.stateVector, stateProof: proof.stateProof }, timeout: 15_000,
            });
            expect(checkpoint.ok(), 'Checkpoint the exact owned document proof before cleanup retry.').toBeTruthy();
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          expect(response.ok(), `Remove only the scoped synthetic Markdown document (${response.status()}, ${payload.code ?? 'unknown'}).`)
            .toBeTruthy();
        }
      }
    } },
    { label: 'cleanup identity context', run: async () => { await cleanupContext?.close(); } },
    { label: 'document context', run: () => context.close() },
    { label: 'proposal server observer', run: assertNoServerErrors },
  ]);
}
