import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { NotificationItem } from '../app/components/notifications/notification-summary';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';

const dom = new JSDOM('<!doctype html><html><body><button id="origin">Open</button><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook?workspaceId=workspace-one&chat=open#document-heading',
});
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'DOMException', 'HTMLButtonElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'SVGElement', 'NodeFilter', 'getComputedStyle',
] as const) {
  const value = key === 'window' ? dom.window : key === 'getComputedStyle'
    ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key];
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });

const request = {
  contractVersion: 1 as const,
  target: { kind: 'lineage' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  selectedEntry: { kind: 'revision' as const, id: 'revision-one' },
  initialView: 'history' as const,
  source: 'editor' as const,
};

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
}

async function main() {
  const { FileVersionCenterHost } = await import('../app/components/file-version-center/FileVersionCenterHost');
  const {
    closeVersionCenter,
    claimFileChangeReviewAcknowledgement,
    openVersionCenter,
    openVersionCenterFromNotification,
    selectVersionCenterEntry,
    syncVersionCenterFromLocation,
    useFileVersionCenterStore,
  } = await import('../app/store/file-version-center-store');
  const { openFileChangeReviewNotification } = await import('../app/components/notifications/notification-actions');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const responses = new Map<string, () => void>();
  const notificationMutations: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    const url = new URL(String(_input), window.location.origin);
    const body = JSON.parse(String(init?.body)) as FileVersionCenterRequestV1;
    if (url.pathname === '/api/notifications/summary') {
      notificationMutations.push(body);
      return Response.json({ success: true });
    }
    if (body.target.workspaceId === 'workspace-delayed') {
      await new Promise<void>((resolve) => responses.set('delayed', resolve));
    }
    if (body.target.workspaceId === 'workspace-denied'
      || body.selectedEntry?.id === 'operation-denied') {
      return Response.json({ contractVersion: 1, success: false, error: {
        code: 'FVRC_ACCESS_DENIED', message: 'Access was removed.', retryable: false,
      } }, { status: 403 });
    }
    return Response.json({
      contractVersion: 1,
      document: { workspaceId: body.target.workspaceId, lineageId: body.target.kind === 'lineage' ? body.target.lineageId : 'lineage-one', documentId: 'document-one', path: 'Notes/current.md' },
      capabilities: { contractVersion: 1, history: true, compare: body.selectedEntry?.kind !== 'agent_operation', restore: true, agentReviewPolicy: true, preview: 'markdown' },
      policy: { contractVersion: 1, requestedMode: 'safe_direct', effectiveMode: 'safe_direct', revision: 0, locked: false, reason: 'default_safe_direct' },
      entries: [
        ...(body.selectedEntry?.kind === 'agent_operation' ? [{
          kind: 'agent_operation', id: body.selectedEntry.id, operationId: body.selectedEntry.id,
          createdAt: new Date(0).toISOString(), actor: { type: 'agent', displayName: 'Canvas Agent' },
          status: body.selectedEntry.id === 'operation-direct-failed' ? 'failed' : 'needs_review',
          actionsAllowed: body.selectedEntry.id !== 'operation-direct-failed',
        }] : []),
        { kind: 'current', id: 'current', observedAt: new Date(0).toISOString(), revisionId: null, sha256: 'a'.repeat(64), sizeBytes: 10 },
      ],
      page: { hasMore: false, nextCursor: null },
    });
  };

  const origin = document.getElementById('origin') as HTMLButtonElement;
  origin.focus();
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <FileVersionCenterHost />
    </NextIntlClientProvider>,
  ));

  await act(async () => { openVersionCenter(request); });
  await settle();
  assert.ok(document.querySelector('[role="dialog"]'), 'one global host opens from the shared store');
  assert.match(document.body.textContent ?? '', /Notes\/current\.md/u);
  assert.equal(new URL(window.location.href).searchParams.get('chat'), 'open');
  assert.equal(new URL(window.location.href).hash, '#document-heading');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcRef'), 'lineage-one');
  assert.deepEqual(JSON.parse(JSON.stringify(useFileVersionCenterStore.getState().request)), request,
    'open state remains serializable and contains no fetched document content');

  await act(async () => { closeVersionCenter(); });
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, origin, 'programmatic close restores the invoking focus');
  assert.equal(new URL(window.location.href).searchParams.get('chat'), 'open');
  assert.equal(new URL(window.location.href).searchParams.get('fvrc'), null);
  assert.equal(new URL(window.location.href).hash, '#document-heading');

  window.history.replaceState(window.history.state, '', '/en/notebook?foreign=yes&fvrc=1&fvrcTarget=lineage&fvrcWorkspace=workspace-one&fvrcRef=lineage-one&fvrcView=reviews#kept');
  await act(async () => {
    assert.equal(syncVersionCenterFromLocation(window.location.search)?.source, 'deep_link');
  });
  await settle();
  assert.ok(document.querySelector('[role="dialog"]'), 'reload intent rehydrates the same host');

  await act(async () => {
    openVersionCenter({ ...request, target: { ...request.target, workspaceId: 'workspace-delayed' } });
    openVersionCenter({ ...request, target: { ...request.target, workspaceId: 'workspace-one' } });
  });
  await settle();
  await act(async () => { responses.get('delayed')?.(); });
  await settle();
  assert.match(document.body.textContent ?? '', /Notes\/current\.md/u,
    'a late response from another workspace cannot replace the active document');

  await act(async () => {
    openVersionCenter({ ...request, target: { ...request.target, workspaceId: 'workspace-denied' } });
  });
  await settle();
  assert.ok(document.querySelector('[role="alert"]'));
  assert.match(document.body.textContent ?? '', /Access was removed/u);

  await act(async () => { closeVersionCenter(); });
  window.history.replaceState(window.history.state, '', '/en/notebook?workspaceId=workspace-one&fvrc=1&fvrcTarget=lineage&fvrcWorkspace=workspace-one&fvrcRef=lineage-one&fvrcView=reviews&fvrcSelectedKind=agent_operation&fvrcSelectedId=operation-one&fvrcSource=notification');
  await act(async () => { syncVersionCenterFromLocation(window.location.search); });
  await settle();
  assert.equal(useFileVersionCenterStore.getState().request?.source, 'deep_link');
  assert.equal(notificationMutations.length, 0, 'a spoofed notification URL never acknowledges an Inbox item');

  const workspace = {
    id: 'workspace-one', type: 'personal' as const, name: 'One', description: '',
    organizationId: 'org', customerId: null, projectId: null, ownerUserId: 'owner',
    color: '#475569' as const, status: 'active' as const, isDefault: true,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
    legacy: false,
  };
  useWorkspaceStore.setState({ activeWorkspaceId: workspace.id, workspaces: [workspace], initialized: true });
  const notificationTarget = {
    kind: 'file_change' as const,
    workspaceId: workspace.id,
    lineageId: 'lineage-one',
    operationId: 'operation-one',
  };
  const notification: NotificationItem = {
    id: 'file-change:operation-one', type: 'file.change_review_required', title: 'Untrusted server copy', detail: null,
    occurredAt: new Date(0).toISOString(), unread: true, priority: 'normal', workspaceId: workspace.id,
    workspaceName: workspace.name, fileChangeReason: 'needs_review',
    target: notificationTarget,
  };
  await act(async () => {
    assert.equal(await openFileChangeReviewNotification(notification), true);
  });
  await settle();
  assert.equal(new URL(window.location.href).searchParams.get('workspaceId'), 'workspace-one');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), 'operation-one');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSource'), 'notification',
    'an unrelated query parameter is preserved but cannot create trust');
  assert.deepEqual(notificationMutations, [{
    action: 'mark_item_read', itemId: 'file-change:operation-one', workspaceId: 'workspace-one',
  }], 'the exact visibly selected operation is acknowledged once');

  await act(async () => { selectVersionCenterEntry(null); });
  await act(async () => { selectVersionCenterEntry({ kind: 'agent_operation', id: 'operation-one' }); });
  await settle();
  assert.equal(notificationMutations.length, 1, 'manual navigation cannot re-acknowledge the notification');

  await act(async () => {
    await openFileChangeReviewNotification({
      ...notification,
      id: 'file-change:operation-denied',
      target: { ...notificationTarget, operationId: 'operation-denied' },
    });
  });
  await settle();
  assert.equal(notificationMutations.length, 1, 'access failures never acknowledge an Inbox item');

  await act(async () => { closeVersionCenter(); });
  let trustedRequest!: ReturnType<typeof openVersionCenterFromNotification>;
  await act(async () => {
    trustedRequest = openVersionCenterFromNotification(notificationTarget, { syncLocation: false });
    selectVersionCenterEntry(null);
  });
  assert.equal(claimFileChangeReviewAcknowledgement({
    request: useFileVersionCenterStore.getState().request!,
    workspaceId: workspace.id,
    lineageId: 'lineage-one',
    operationId: 'operation-one',
  }), null, 'leaving the initial operation discards the trusted one-shot intent');
  assert.notEqual(useFileVersionCenterStore.getState().request, trustedRequest);

  await act(async () => root.unmount());
  assert.equal(document.querySelector('[role="dialog"]'), null, 'the host unmount removes its portal');

  let releaseFirstOpen!: () => void;
  let hydrationCalls = 0;
  useWorkspaceStore.setState({
    activeWorkspaceId: 'workspace-one',
    hydrateWorkspaces: async () => {
      hydrationCalls += 1;
      if (hydrationCalls === 1) await new Promise<void>((resolve) => { releaseFirstOpen = resolve; });
    },
    setActiveWorkspace: async (workspaceId: string) => {
      useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
      return true;
    },
  });
  const firstOpen = openFileChangeReviewNotification({
    ...notification,
    id: 'file-change:operation-first',
    workspaceId: 'workspace-first',
    target: { kind: 'file_change', workspaceId: 'workspace-first', lineageId: 'lineage-first', operationId: 'operation-first' },
  });
  await Promise.resolve();
  const latestOpen = openFileChangeReviewNotification({
    ...notification,
    id: 'file-change:operation-latest',
    workspaceId: 'workspace-latest',
    target: { kind: 'file_change', workspaceId: 'workspace-latest', lineageId: 'lineage-latest', operationId: 'operation-latest' },
  });
  assert.equal(await latestOpen, true);
  releaseFirstOpen();
  assert.equal(await firstOpen, true, 'a superseded click is handled without rolling back the newer request');
  assert.equal(useFileVersionCenterStore.getState().request?.target.workspaceId, 'workspace-latest');
  assert.equal(useFileVersionCenterStore.getState().request?.selectedEntry?.id, 'operation-latest');
  assert.equal(new URL(window.location.href).searchParams.get('workspaceId'), 'workspace-latest');
  assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), 'operation-latest');

  closeVersionCenter({ syncLocation: false });
  window.history.replaceState(window.history.state, '', '/en/notebook?workspaceId=workspace-one&chat=open');
  hydrationCalls = 0;
  useWorkspaceStore.setState({
    activeWorkspaceId: 'workspace-one',
    hydrateWorkspaces: async () => {
      hydrationCalls += 1;
      if (hydrationCalls === 1) await new Promise<void>((resolve) => { releaseFirstOpen = resolve; });
    },
    setActiveWorkspace: async () => false,
  });
  const pendingOpen = openFileChangeReviewNotification({
    ...notification,
    id: 'file-change:operation-pending',
    workspaceId: 'workspace-pending',
    target: { kind: 'file_change', workspaceId: 'workspace-pending', lineageId: 'lineage-pending', operationId: 'operation-pending' },
  });
  await Promise.resolve();
  const failedLatestOpen = openFileChangeReviewNotification({
    ...notification,
    id: 'file-change:operation-missing',
    workspaceId: 'workspace-missing',
    target: { kind: 'file_change', workspaceId: 'workspace-missing', lineageId: 'lineage-missing', operationId: 'operation-missing' },
  });
  assert.equal(await failedLatestOpen, false);
  releaseFirstOpen();
  assert.equal(await pendingOpen, true);
  assert.equal(useFileVersionCenterStore.getState().request, null);
  assert.equal(new URL(window.location.href).searchParams.get('workspaceId'), 'workspace-one');
  assert.equal(new URL(window.location.href).searchParams.get('fvrc'), null,
    'a failed superseding click restores the non-transient baseline URL');
  console.log('file-version-center-open-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
