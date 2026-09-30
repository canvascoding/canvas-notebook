import assert from 'node:assert/strict';
import Module from 'node:module';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { createDocumentReviewUiFixture } from './helpers/document-review-ui-fixture';

import messages from '../messages/en.json';
import { getNotebookQueryClient } from '../app/lib/queries/client';
import type { NotificationItem } from '../app/components/notifications/notification-summary';
import type { GraphReviewCardStatus } from '../app/components/file-version-center/GraphReviewComparison';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import { fileVersionTestRouter } from './file-version-test-router';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?workspaceId=workspace-one',
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLButtonElement', 'Element', 'Node',
  'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'DOMException', 'SVGElement',
  'NodeFilter', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window
    : key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });

type StatusCallback = (status: GraphReviewCardStatus | null) => void;
let activeStatusCallback: StatusCallback | null = null;
const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => request === './GraphReviewComparison'
  && parent?.filename.endsWith('/FileVersionComparison.tsx')
  ? { GraphReviewComparison: ({ onReviewStatus }: { onReviewStatus?: StatusCallback }) => {
    activeStatusCallback = onReviewStatus ?? null;
    useEffect(() => () => { onReviewStatus?.(null); }, [onReviewStatus]);
    return <div data-testid="controlled-graph-review" />;
  } }
  : originalLoad(request, parent, isMain);

const revision = 'b'.repeat(64);
const itemId = `file-change-branch:${'a'.repeat(64)}`;
function notification(input: { workspaceId?: string; lineageId?: string; operationId?: string;
  rootProposalId?: string; itemId?: string }): NotificationItem {
  const workspaceId = input.workspaceId ?? 'workspace-one';
  return { id: input.itemId ?? itemId, type: 'file.change_review_required', title: 'Review branch',
    detail: null, occurredAt: new Date(0).toISOString(), unread: true, priority: 'normal',
    workspaceId, workspaceName: workspaceId, fileChangeReason: 'needs_review',
    target: { kind: 'file_change', workspaceId, lineageId: input.lineageId ?? 'lineage-one',
      operationId: input.operationId ?? 'operation-one', branch: {
        rootProposalId: input.rootProposalId ?? 'proposal-root', itemId: input.itemId ?? itemId, revision,
      } } };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function main(): Promise<void> {
  const { FileVersionCenterHost } = await import('../app/components/file-version-center/FileVersionCenterHost');
  const DocumentReviewUiFixture = await createDocumentReviewUiFixture();
  const { openFileChangeReviewNotification } = await import('../app/components/notifications/notification-actions');
  const { closeVersionCenter, syncVersionCenterFromLocation, useFileVersionCenterStore } = await import('../app/store/file-version-center-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-one', initialized: true,
    workspaces: ['workspace-one', 'workspace-two'].map((id) => ({ id, type: 'personal', name: id,
      description: '', organizationId: 'org', customerId: null, projectId: null, ownerUserId: 'owner',
      color: '#475569', status: 'active', isDefault: true, legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true,
        canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } })),
    hydrateWorkspaces: async () => {},
    setActiveWorkspace: async (id) => { useWorkspaceStore.setState({ activeWorkspaceId: id }); return true; } });

  const mutations: Array<Record<string, unknown>> = [];
  const acknowledgementAttempts: Array<Record<string, unknown>> = [];
  const unexpectedProposalWrites: string[] = [];
  let denyResolve = false;
  let delayResolve = false;
  let failNextAcknowledgement = false;
  let resolveCalls = 0;
  let releaseResolve: (() => void) | null = null;
  globalThis.fetch = async (resource, init) => {
    const url = new URL(String(resource), window.location.origin);
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as FileVersionCenterRequestV1;
    if (url.pathname.startsWith('/api/files/version-center/v1/proposals/')) {
      if (url.pathname.includes('/actions') || url.pathname.includes('/transform/')) {
        unexpectedProposalWrites.push(url.pathname);
      }
    }
    if (url.pathname === '/api/notifications/summary') {
      acknowledgementAttempts.push(body as unknown as Record<string, unknown>);
      if (failNextAcknowledgement) {
        failNextAcknowledgement = false;
        return Response.json({ success: false, error: 'Temporarily unavailable' }, { status: 503 });
      }
      mutations.push(body as unknown as Record<string, unknown>);
      return Response.json({ success: true });
    }
    if (url.pathname.endsWith('/proposals/summary')) return Response.json({});
    if (url.pathname.endsWith('/resolve')) resolveCalls += 1;
    if (url.pathname.endsWith('/resolve') && delayResolve) {
      await new Promise<void>((resolve) => { releaseResolve = resolve; });
    }
    if (url.pathname.endsWith('/resolve') && denyResolve) return Response.json({
      contractVersion: 1, success: false,
      error: { code: 'FVRC_ACCESS_DENIED', message: 'Access removed', retryable: false },
    }, { status: 403 });
    return Response.json({ contractVersion: 1,
      document: { workspaceId: body.target.workspaceId,
        lineageId: body.target.kind === 'lineage' ? body.target.lineageId : 'lineage-one',
        documentId: `document-${body.target.workspaceId}`, path: 'Notes/current.md' },
      capabilities: { contractVersion: 1, history: true, compare: false, restore: true,
        agentReviewPolicy: true, preview: 'markdown' },
      policy: { contractVersion: 1, requestedMode: 'safe_direct', effectiveMode: 'safe_direct',
        revision: 0, locked: false, reason: 'default_safe_direct' },
      entries: [{ kind: 'agent_operation', id: body.selectedEntry?.id ?? 'operation-one',
        operationId: body.selectedEntry?.id ?? 'operation-one', createdAt: new Date(0).toISOString(),
        actor: { type: 'agent', displayName: 'Canvas Agent' }, status: 'needs_review', actionsAllowed: true },
      { kind: 'current', id: 'current', observedAt: new Date(0).toISOString(),
        revisionId: null, sha256: 'a'.repeat(64), sizeBytes: 10 }],
      page: { hasMore: false, nextCursor: null },
    });
  };

  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <AppRouterContext.Provider value={fileVersionTestRouter}><DocumentReviewUiFixture enabled>
        <FileVersionCenterHost />
      </DocumentReviewUiFixture></AppRouterContext.Provider>
    </NextIntlClientProvider>));
    const branch = notification({});
    await act(async () => { assert.equal(await openFileChangeReviewNotification(branch), true); });
    await settle();
    assert.equal(useFileVersionCenterStore.getState().request?.branchOverview, true);
    assert.equal(new URL(window.location.href).searchParams.get('fvrcBranch'), '1');
    assert.ok(activeStatusCallback, 'the selected graph card mounts after authorized timeline resolution');
    assert.deepEqual(mutations, [], 'timeline selection alone cannot acknowledge a branch');

    await act(async () => { activeStatusCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null }); });
    await settle();
    assert.deepEqual(mutations, [], 'no graph context means no acknowledgement');
    await act(async () => { activeStatusCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'wrong-root', graphRevision: 1 } }); });
    await settle();
    assert.deepEqual(mutations, [], 'a different authorized root cannot acknowledge this item');

    await act(async () => { activeStatusCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-root', graphRevision: 1 } }); });
    await settle();
    assert.deepEqual(mutations, [{ action: 'mark_item_read', itemId, workspaceId: 'workspace-one',
      expectedRevision: revision }], 'the observed branch revision is bound to the read mutation');

    const priorCallback = activeStatusCallback;
    delayResolve = true;
    await act(async () => { assert.equal(await openFileChangeReviewNotification(branch), true); });
    await settle();
    assert.ok(releaseResolve, 'a new trusted open of the same target starts a fresh resolution');
    assert.equal(mutations.length, 1, 'cached timeline and card cannot pre-acknowledge the new request');
    await act(async () => { priorCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-root', graphRevision: 1 } }); });
    await settle();
    assert.equal(mutations.length, 1, 'an obsolete GraphReview callback cannot acknowledge the new same-target request');
    await act(async () => { activeStatusCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-root', graphRevision: 1 } }); });
    await settle();
    assert.equal(mutations.length, 1, 'new card status still waits for its fresh resolved timeline');
    denyResolve = true;
    delayResolve = false;
    await act(async () => { releaseResolve?.(); });
    await settle();
    assert.equal(mutations.length, 1, 'a denied fresh resolution never acknowledges the new same-target intent');
    denyResolve = false;
    releaseResolve = null;

    await act(async () => { closeVersionCenter(); });
    await settle();
    window.history.replaceState(window.history.state, '',
      `/en/notebook?workspaceId=workspace-one&fvrc=1&fvrcTarget=lineage&fvrcWorkspace=workspace-one&fvrcRef=lineage-one&fvrcView=reviews&fvrcSelectedKind=agent_operation&fvrcSelectedId=operation-one&fvrcBranch=1`);
    await act(async () => { syncVersionCenterFromLocation(window.location.search); });
    await settle();
    assert.equal(useFileVersionCenterStore.getState().request?.source, 'deep_link');
    await act(async () => { activeStatusCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-root', graphRevision: 1 } }); });
    await settle();
    assert.equal(mutations.length, 1, 'a historical/URL-only branch link is never a trusted notification intent');

    await act(async () => { closeVersionCenter(); });
    denyResolve = true;
    await act(async () => { assert.equal(await openFileChangeReviewNotification(branch), true); });
    await settle();
    assert.equal(mutations.length, 1, 'a failed document authorization cannot mark a branch read');
    denyResolve = false;

    await act(async () => { closeVersionCenter(); });
    const first = notification({});
    await act(async () => { assert.equal(await openFileChangeReviewNotification(first), true); });
    await settle();
    const staleCallback = activeStatusCallback;
    const second = notification({ workspaceId: 'workspace-two', lineageId: 'lineage-two',
      operationId: 'operation-two', rootProposalId: 'proposal-two',
      itemId: `file-change-branch:${'c'.repeat(64)}` });
    await act(async () => { assert.equal(await openFileChangeReviewNotification(second), true); });
    await settle();
    await act(async () => { staleCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-root', graphRevision: 1 } }); });
    await settle();
    assert.equal(mutations.length, 1, 'a late response for a superseded workspace/request cannot acknowledge it');
    await act(async () => { activeStatusCallback?.({ operationId: 'operation-two', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-two', graphRevision: 2 } }); });
    await settle();
    assert.deepEqual(mutations.at(-1), { action: 'mark_item_read', itemId: second.id,
      workspaceId: 'workspace-two', expectedRevision: revision });

    const closedCallback = activeStatusCallback;
    await act(async () => { closeVersionCenter(); });
    await settle();
    await act(async () => { closedCallback?.({ operationId: 'operation-two', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-two', graphRevision: 2 } }); });
    await settle();
    assert.equal(mutations.length, 2, 'closing the center invalidates a late graph status');

    await act(async () => { closeVersionCenter(); });
    await settle();
    const retryBranch = notification({});
    const attemptsBeforeRetry = acknowledgementAttempts.length;
    failNextAcknowledgement = true;
    await act(async () => { assert.equal(await openFileChangeReviewNotification(retryBranch), true); });
    await settle();
    assert.ok(activeStatusCallback, 'a fresh trusted open mounts a newly authorized review status callback');
    await act(async () => { activeStatusCallback?.({ operationId: retryBranch.target.kind === 'file_change'
      ? retryBranch.target.operationId : '', status: 'clean', reasonCode: null,
    branchContext: { rootProposalId: retryBranch.target.kind === 'file_change'
      ? retryBranch.target.branch?.rootProposalId ?? '' : '', graphRevision: 3 } }); });
    await settle();
    const failedAttempt = { action: 'mark_item_read', itemId: retryBranch.id,
      workspaceId: retryBranch.workspaceId, expectedRevision: revision };
    assert.deepEqual(acknowledgementAttempts.slice(attemptsBeforeRetry), [failedAttempt],
      'the first authorized acknowledgement binds the observed branch revision');
    assert.equal(mutations.length, 2, 'a failed acknowledgement is not recorded as success');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    assert.equal(acknowledgementAttempts.length, attemptsBeforeRetry + 1,
      'a failed PATCH does not start an automatic retry loop');

    await act(async () => { closeVersionCenter(); });
    await settle();
    const resolveCallsBeforeExplicitReopen = resolveCalls;
    await act(async () => { assert.equal(await openFileChangeReviewNotification(retryBranch), true); });
    await settle();
    assert.ok(resolveCalls > resolveCallsBeforeExplicitReopen, 'explicit reopen performs a fresh resolve');
    assert.ok(activeStatusCallback, 'the explicit reopen mounts a fresh review status callback');
    await act(async () => { activeStatusCallback?.({ operationId: 'operation-one', status: 'clean',
      reasonCode: null, branchContext: { rootProposalId: 'proposal-root', graphRevision: 4 } }); });
    await settle();
    const retryAttempts = acknowledgementAttempts.slice(attemptsBeforeRetry);
    assert.deepEqual(retryAttempts, [failedAttempt, failedAttempt],
      'the explicit trusted retry keeps the same observed revision fence');
    assert.deepEqual(mutations.at(-1), failedAttempt, 'the explicit reopen records exactly one successful read acknowledgement');
    assert.equal(mutations.length, 3, 'failed-then-retried acknowledgement has exactly one success');
    assert.deepEqual(unexpectedProposalWrites, [], 'opening or retrying a notification never applies or transforms a proposal');

    console.log('file-version-center-branch-notification-ack-test: ok');
  } finally {
    await act(async () => root.unmount());
    getNotebookQueryClient().clear();
    moduleInternals._load = originalLoad;
    dom.window.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
