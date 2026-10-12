import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WORKSPACE_ID_HEADER } from '../app/lib/workspaces/constants';
import { observeOpenedDocumentAuth, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { closeWorkspacePathOperationStatus, openWorkspacePathOperationStatus, recoverWorkspacePathOperation,
  reloadWorkspacePathOperationStatus, useWorkspacePathOperationStore } from '../app/store/workspace-path-operation-store';
import type { WorkspacePathOperationPublic } from '../app/lib/files/workspace-path-operation-public';
import { homeNotificationItems, notificationHref, openWorkspacePathOperationNotificationTarget, openWorkspaceOperationNotificationTarget,
  openFileChangeReviewNotification } from '../app/components/notifications/notification-actions';
import type { NotificationItem, NotificationSummary } from '../app/components/notifications/notification-summary';

const workspaceId = 'workspace-status';
const batchId = 'status-batch-1234567890';
const problemId = 'c'.repeat(64);
const planId = 'a'.repeat(64);
const dom = new JSDOM('<!doctype html><button id="opener">Files</button>', { url: `https://canvas.test/en/notebook?workspaceId=${workspaceId}`, pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'CustomEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const operation = (status: WorkspacePathOperationPublic['status'] = 'blocked'): WorkspacePathOperationPublic => ({
  batchId, planId, workspaceId, kind: 'move', status, errorCode: 'CURRENT_CONTENT_CHANGED',
  selections: [{ sourcePath: 'Docs/target.md', destinationPath: 'Archive/target.md' }],
  completedActions: ['applied', 'undone'].includes(status) ? 2 : 0, totalActions: 2,
  phase: ['applied', 'undone'].includes(status) ? 'complete' : 'preparing',
});
const signedIn = () => observeOpenedDocumentAuth({ data: { user: { id: 'status-user' }, session: { id: 'status-session' } } });

async function main() {
  const originalFetch = globalThis.fetch;
  const originalWorkspace = useWorkspaceStore.getState();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let reply: () => Promise<Response> = async () => Response.json({ operation: operation() });
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return reply(); };
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId, initialized: true,
    hydrateWorkspaces: async () => {}, setActiveWorkspace: async (id) => {
      if (id !== workspaceId) return false;
      useWorkspaceStore.setState({ activeWorkspaceId: id }); return true;
    } });
  signedIn();
  const open = async () => { closeWorkspacePathOperationStatus(); assert.equal(await openWorkspacePathOperationStatus({ workspaceId, batchId }), true); };
  try {
    assert.equal(await openWorkspacePathOperationStatus({ workspaceId, batchId: '../other' }), false);
    assert.equal(await openWorkspacePathOperationStatus({ workspaceId: 'missing-workspace', batchId }), false);
    assert.equal(requests.length, 0, 'invalid/unavailable navigation cannot fetch operation details');
    await open();
    reply = async () => Response.json({ operation: { ...operation(), actorUserId: 'private-user', sessionId: 'private-session',
      issues: [{ code: 'missing-source', path: 'Docs/target.md', detail: 'private diagnostic', reviewId: 'private-review' }] },
      recovery: { canUndo: false, canResume: false }, manifest: { content: 'private-document' }, rawError: 'private-path' });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status, 'blocked');
    assert.deepEqual(useWorkspacePathOperationStore.getState().response?.operation.issues, [{ code: 'missing-source', path: 'Docs/target.md' }]);
    assert.deepEqual(Object.keys(useWorkspacePathOperationStore.getState().response!).sort(), ['operation', 'recovery']);
    assert.equal(JSON.stringify(useWorkspacePathOperationStore.getState()).includes('private-'), false, 'private server fields are never retained');
    const first = requests.at(-1)!;
    assert.equal(first.url, `/api/files/operations/batches/${batchId}`);
    assert.equal(first.init?.credentials, 'include');
    assert.equal(first.init?.cache, 'no-store');
    assert.equal(new Headers(first.init?.headers).get(WORKSPACE_ID_HEADER), workspaceId);
    const beforeDeniedAction = requests.length;
    await recoverWorkspacePathOperation('resume');
    await recoverWorkspacePathOperation('undo');
    assert.equal(requests.length, beforeDeniedAction, 'blocked state without current recovery capability cannot mutate');

    for (const mismatch of [{ workspaceId: 'foreign-workspace' }, { batchId: 'foreign-batch-1234567' }, { planId: 'b'.repeat(64) },
      { selections: [{ sourcePath: '/data/private.md' }] }, { status: 'applied', phase: 'paths', completedActions: 2 },
      { status: 'applied', phase: 'complete', completedActions: 1 },
      { issues: [{ code: 'missing-source', path: '/private/secret.md' }] },
      { issues: [{ code: 'missing-source', path: '../secret.md' }] },
      { issues: [{ code: 'private diagnostic', path: 'Notes/link.md' }] },
      { issues: null }]) {
      reply = async () => Response.json({ operation: { ...operation(), ...mismatch } });
      await reloadWorkspacePathOperationStatus();
      assert.equal(useWorkspacePathOperationStore.getState().error, 'identity');
      assert.equal(useWorkspacePathOperationStore.getState().response, null);
    }
    reply = async () => Response.json({ operation: operation('needs_recovery'), recovery: { canResume: true, canUndo: false } });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().error, null);
    const beforeResume = requests.length;
    reply = async () => Response.json({ operation: operation('queued') });
    await recoverWorkspacePathOperation('resume');
    assert.equal(requests.length, beforeResume + 1);
    assert.equal(requests.at(-1)?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { action: 'resume', planId });
    assert.equal(new Headers(requests.at(-1)?.init?.headers).get(WORKSPACE_ID_HEADER), workspaceId);
    assert.equal(useWorkspacePathOperationStore.getState().busy, true, 'queued response is still running');
    assert.equal(useWorkspacePathOperationStore.getState().pendingAction, 'resume');
    reply = async () => Response.json({ operation: operation('applying') });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().busy, true);
    reply = async () => Response.json({ operation: operation('applied'), recovery: { canResume: false, canUndo: true } });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().busy, false);
    assert.equal(useWorkspacePathOperationStore.getState().pendingAction, null);
    await recoverWorkspacePathOperation('undo');
    assert.equal(useWorkspacePathOperationStore.getState().error, 'action', 'forward applied status cannot acknowledge successful Undo');
    await reloadWorkspacePathOperationStatus();
    reply = async () => Response.json({ operation: operation('undone') });
    await recoverWorkspacePathOperation('undo');
    assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status, 'undone');
    assert.equal(useWorkspacePathOperationStore.getState().error, null);

    await open();
    reply = async () => Response.json({ operation: operation('needs_review') });
    await reloadWorkspacePathOperationStatus();
    const beforeStale = requests.length;
    await recoverWorkspacePathOperation('resume');
    assert.equal(requests.length, beforeStale, 'stale requests never automatically resume');
    let finish!: (value: Response) => void;
    reply = () => new Promise((resolve) => { finish = resolve; });
    const pending = reloadWorkspacePathOperationStatus();
    invalidateOpenedDocumentAuth();
    finish(Response.json({ operation: operation('applied') }));
    await pending;
    assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status, 'needs_review', 'late responses after auth invalidation cannot overwrite state');
    closeWorkspacePathOperationStatus();
    signedIn(); await open();
    const workspacePending = reloadWorkspacePathOperationStatus();
    useWorkspaceStore.setState({ activeWorkspaceId: 'another-workspace' });
    finish(Response.json({ operation: operation('applied') }));
    await workspacePending;
    assert.equal(useWorkspacePathOperationStore.getState().response, null, 'late responses after a workspace switch are ignored');
    useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });

    closeWorkspacePathOperationStatus();
    assert.equal(await openWorkspacePathOperationStatus({ workspaceId, problemId }), true);
    const problem = { problemId, workspaceId, kind: 'delete', selections: [{ sourcePath: 'missing.md' }],
      errorCode: 'BATCH_JOURNAL_UNAVAILABLE', createdAt: 1, updatedAt: 2 };
    reply = async () => Response.json({ problem: { ...problem, actorUserId: 'private-actor' }, rawError: 'private-secret' });
    await reloadWorkspacePathOperationStatus();
    assert.deepEqual(useWorkspacePathOperationStore.getState().problem, problem);
    assert.equal(requests.at(-1)?.url, `/api/files/operations/problems/${problemId}`);
    const beforeProblemRecovery = requests.length;
    await recoverWorkspacePathOperation('resume'); await recoverWorkspacePathOperation('undo');
    assert.equal(requests.length, beforeProblemRecovery, 'standalone problems have no recovery action');
    reply = async () => Response.json({ problem: { ...problem, workspaceId: 'foreign' } });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().problem, null);
    assert.equal(useWorkspacePathOperationStore.getState().error, 'identity');
    reply = async () => Response.json({ code: 'FORBIDDEN', error: 'private-details' }, { status: 403 });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().error, 'access');
    assert.equal(useWorkspacePathOperationStore.getState().errorCode, 'FORBIDDEN');

    const notification: NotificationItem = { id: `file-path-operation:${batchId}`, type: 'file.operation_attention', title: 'Fallback', detail: null,
      occurredAt: '2026-10-03T10:00:00Z', unread: false, priority: 'normal', workspaceId, workspaceName: 'Workspace',
      target: { kind: 'file_path_operation', workspaceId, batchId, operationKind: 'move', status: 'blocked' } };
    assert.equal(new URL(notificationHref(notification), window.location.origin).searchParams.get('workspacePathBatch'), batchId);
    assert.equal(new URL(notificationHref({ ...notification, target: { kind: 'file_path_operation', workspaceId: 'foreign', batchId,
      operationKind: 'move', status: 'blocked' } }), window.location.origin).searchParams.has('workspacePathBatch'), false);
    const problemNotification: NotificationItem = { ...notification, target: { kind: 'file_path_operation', workspaceId, problemId, operationKind: 'delete', status: 'failed' } };
    assert.equal(new URL(notificationHref(problemNotification), window.location.origin).searchParams.get('workspacePathProblem'), problemId);
    const summary = { items: [notification], sections: { notifications: [notification], todoAttention: [], emailAttention: [] } } as unknown as NotificationSummary;
    assert.deepEqual(homeNotificationItems(summary), [notification], 'attention remains on Home after it is marked read');
    reply = async () => Response.json({ success: true });
    assert.equal(await openWorkspacePathOperationNotificationTarget(problemNotification.target as Extract<NotificationItem['target'], {kind: 'file_path_operation'}>), true);
    assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { action: 'mark_item_read', workspaceId, itemId: `file-path-problem:${problemId}` });

    const reviewId = 'legacy-review-status-123456';
    const legacy = { reviewId, sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId, kind: 'move', status: 'pending',
      selections: [{ sourcePath: 'old.md', destinationPath: 'new.md' }], batchId: null, errorCode: null,
      actor: { id: 'private-actor' }, preview: { content: 'private-document' } };
    assert.equal(await openWorkspaceOperationNotificationTarget({ workspaceId, reviewId }, { reviewCenterEnabled: false }), true);
    reply = async () => Response.json({ review: legacy });
    await reloadWorkspacePathOperationStatus();
    assert.deepEqual(useWorkspacePathOperationStore.getState().review, { reviewId, kind: 'move', status: 'pending',
      selections: legacy.selections, batchId: null, errorCode: null });
    assert.equal(requests.at(-1)?.url, `/api/files/operation-reviews/${reviewId}`);
    assert.equal(new Headers(requests.at(-1)?.init?.headers).get(WORKSPACE_ID_HEADER), workspaceId);
    assert.equal(JSON.stringify(useWorkspacePathOperationStore.getState()).includes('private-'), false);
    const beforePendingReview = requests.length;
    await recoverWorkspacePathOperation('resume'); await recoverWorkspacePathOperation('undo');
    assert.equal(requests.length, beforePendingReview, 'disabled pending review has no accept or recovery request');
    reply = async () => Response.json({ review: { ...legacy, sourceWorkspaceId: 'foreign' } });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().review, null);
    assert.equal(useWorkspacePathOperationStore.getState().error, 'identity');
    reply = async () => Response.json(requests.at(-1)?.url.includes('/batches/')
      ? { operation: operation('applied'), recovery: { canResume: false, canUndo: true } }
      : { review: { ...legacy, status: 'applied', batchId } });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status, 'applied', 'legacy record resolves its real durable batch while Review Center is disabled');
    assert.equal(useWorkspacePathOperationStore.getState().review, null);
    reply = async () => Response.json({ operation: operation('undone') });
    await recoverWorkspacePathOperation('undo');
    assert.equal(requests.at(-1)?.url, `/api/files/operations/batches/${batchId}`);
    assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status, 'undone', 'verified batch Undo stays available outside the experiment');
    assert.equal(await openWorkspaceOperationNotificationTarget({ workspaceId, reviewId, batchId, operationKind: 'move' }, { reviewCenterEnabled: false }), true);
    assert.equal(useWorkspacePathOperationStore.getState().request?.batchId, batchId, 'known legacy notification batch opens status directly');
    assert.equal(await openWorkspaceOperationNotificationTarget({ workspaceId, reviewId, batchId, operationKind: 'copy' }, { reviewCenterEnabled: false }), true);
    reply = async () => Response.json({ review: { ...legacy, kind: 'copy', status: 'needs_recovery', batchId, errorCode: 'LEGACY_COPY_FAILED' } });
    await reloadWorkspacePathOperationStatus();
    assert.equal(useWorkspacePathOperationStore.getState().review?.status, 'needs_recovery');
    assert.equal(useWorkspacePathOperationStore.getState().response, null, 'legacy Copy remains truthful read-only metadata');
    const docItem: NotificationItem = { ...notification, target: { kind: 'file_change', workspaceId, lineageId: 'lineage-one', operationId: 'operation-one' } };
    assert.equal(await openFileChangeReviewNotification(docItem, { reviewCenterEnabled: false }), true);
    const beforePausedDocument = requests.length;
    await reloadWorkspacePathOperationStatus(); await recoverWorkspacePathOperation('resume');
    assert.equal(requests.length, beforePausedDocument, 'disabled document-review notice cannot fetch previews or apply proposals');
    assert.equal(useWorkspacePathOperationStore.getState().request?.documentReviewPaused, true);
    observeOpenedDocumentAuth(null);
    assert.equal(await openWorkspacePathOperationStatus({ workspaceId, batchId }), false, 'signed-out navigation cannot select private details');
    console.log('workspace path status store: scoped identity, safe metadata, real recovery outcomes, request races and notification navigation passed');
  } finally {
    closeWorkspacePathOperationStatus(); globalThis.fetch = originalFetch; useWorkspaceStore.setState(originalWorkspace); dom.window.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
