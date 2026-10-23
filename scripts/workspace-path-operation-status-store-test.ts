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

    // HTTP-shaped state fixtures only: no genuine auth, persistence or browser
    // discovery is claimed. Existing batch/problem/review assertions above stay.
    const preparationRequestId = '11111111-2222-3333-4444-555555555555';
    const preparationUrl = '/api/files/operations/implicit-moves/' + preparationRequestId;
    const preparationIdentity = { actorUserId: 'status-user', workspaceId, operationId: 'original-status-selection',
      requestId: preparationRequestId, selectionDigest: 'd'.repeat(64) };
    const preparationBinding = { version: 1 as const, kind: 'implicit-move-binding' as const, ...preparationIdentity };
    const selectedPaths = [{ sourcePath: 'Docs/target.md', destinationPath: 'Archive/target.md' }];
    const pendingPreparation = (status: 'reserved' | 'draining' | 'recovery_required' = 'reserved') => ({
      version: 2 as const, kind: 'implicit-move-preparation' as const, state: 'pending' as const, ...preparationIdentity,
      action: 'rename' as const, selections: selectedPaths.map(item => ({ ...item })), status,
      canResume: status !== 'recovery_required', statusUrl: preparationUrl, resumeUrl: preparationUrl,
    });
    const abortedPreparation = () => ({ version: 2 as const, kind: 'implicit-move-preparation' as const,
      state: 'aborted' as const, ...preparationIdentity, action: 'rename' as const,
      selections: selectedPaths.map(item => ({ ...item })), reason: 'precondition_failed' as const });
    const assertGet = (request: { url: string; init?: RequestInit }, url = preparationUrl) => {
      assert.equal(request.url,url); assert.equal(request.init?.method ?? 'GET','GET');
      assert.equal(request.init?.body,undefined); assert.equal(request.init?.credentials,'include');
      assert.equal(request.init?.cache,'no-store');
      assert.equal(new Headers(request.init?.headers).get(WORKSPACE_ID_HEADER),workspaceId);
    };
    const openPreparation = async () => {
      closeWorkspacePathOperationStatus(); signedIn(); useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
      const beforeOpen=requests.length;
      assert.equal(await openWorkspacePathOperationStatus({ workspaceId,preparationRequestId }),true);
      assert.equal(requests.length,beforeOpen,'navigation never resumes or reads before the mounted loader');
    };
    const loadPreparation = async (status: 'reserved' | 'draining' | 'recovery_required' = 'reserved') => {
      reply=async () => Response.json({ success:true,preparation:pendingPreparation(status) });
      await reloadWorkspacePathOperationStatus();
      assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,pendingPreparation(status));
      assertGet(requests.at(-1)!);
    };
    const invalidTargetStart=requests.length;
    for(const preparationRequestId of ['../other','NOT-A-UUID','11111111-2222-3333-4444-55555555555A']) {
      assert.equal(await openWorkspacePathOperationStatus({ workspaceId,preparationRequestId }),false);
    }
    assert.equal(requests.length,invalidTargetStart);
    await openPreparation();
    const beforeUnloadedAction=requests.length;
    await recoverWorkspacePathOperation('resume'); await recoverWorkspacePathOperation('undo');
    assert.equal(requests.length,beforeUnloadedAction,'no loaded server capability means no mutation');
    for(const status of ['reserved','draining','recovery_required'] as const) await loadPreparation(status);
    const beforeNonResumable=requests.length;
    await recoverWorkspacePathOperation('resume'); await recoverWorkspacePathOperation('undo');
    assert.equal(requests.length,beforeNonResumable,'recovery_required cannot resume or Undo');
    closeWorkspacePathOperationStatus();
    assert.equal(requests.length,beforeNonResumable,'closing never cancels or advances a saved preparation');
    await openPreparation(); await loadPreparation();
    const repeatedReads=requests.length;
    await reloadWorkspacePathOperationStatus(); await reloadWorkspacePathOperationStatus();
    assert.equal(requests.length,repeatedReads+2);
    requests.slice(repeatedReads).forEach(item=>assertGet(item));
    assert.equal(useWorkspacePathOperationStore.getState().response,null,'pending has no invented batch/progress');

    for(const mismatch of [
      {actorUserId:'another-user'},{workspaceId:'another-workspace'},{operationId:'another-original-selection'},
      {requestId:'66666666-7777-8888-9999-aaaaaaaaaaaa'},{selectionDigest:'e'.repeat(64)},
      {action:'move'},{selections:[{sourcePath:'another.md',destinationPath:'Archive/target.md'}]},
      {statusUrl:'https://foreign.test/resume'},{canResume:false},
    ]) {
      await openPreparation(); await loadPreparation();
      reply=async()=>Response.json({success:true,preparation:{...pendingPreparation(),...mismatch}});
      const before: number=requests.length; await reloadWorkspacePathOperationStatus();
      assert.equal(requests.length,before+1); assertGet(requests.at(-1)!);
      assert.equal(useWorkspacePathOperationStore.getState().error,'identity');
      assert.equal(useWorkspacePathOperationStore.getState().preparation,null,'foreign or drifting preparation is not adopted');
      const beforeAction: number=requests.length; await recoverWorkspacePathOperation('resume');
      assert.equal(requests.length,beforeAction);
    }

    await openPreparation(); await loadPreparation();
    let completePost!: (response:Response)=>void;
    reply=()=>new Promise(resolve=>{completePost=resolve;});
    const beforeExplicit=requests.length, continuing=recoverWorkspacePathOperation('resume');
    assert.equal(useWorkspacePathOperationStore.getState().busy,true);
    await recoverWorkspacePathOperation('resume'); await recoverWorkspacePathOperation('undo');
    assert.equal(requests.length,beforeExplicit+1,'one explicit Continue cannot dispatch twice while busy');
    const post=requests.at(-1)!;
    assert.equal(post.url,preparationUrl); assert.equal(post.init?.method,'POST'); assert.equal(post.init?.body,undefined);
    assert.equal(post.init?.credentials,'include'); assert.equal(post.init?.cache,'no-store');
    assert.equal(new Headers(post.init?.headers).get(WORKSPACE_ID_HEADER),workspaceId);
    completePost(Response.json({success:true,preparation:pendingPreparation('draining')},{status:202})); await continuing;
    assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,pendingPreparation('draining'));
    assert.equal(useWorkspacePathOperationStore.getState().busy,false);

    for(const code of ['UNRELATED_ABORT','IMPLICIT_MOVE_PREPARATION_ABORTED']) {
      await openPreparation(); await loadPreparation();
      reply=async()=>Response.json({success:false,code,preparation:abortedPreparation()},{status:409});
      const before: number=requests.length; await recoverWorkspacePathOperation('resume');
      assert.equal(requests.length,before+1); assert.equal(requests.at(-1)?.init?.method,'POST');
      if(code==='IMPLICIT_MOVE_PREPARATION_ABORTED') {
        assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,abortedPreparation());
        assert.equal(useWorkspacePathOperationStore.getState().error,null);
        const after: number=requests.length; await recoverWorkspacePathOperation('resume');
        assert.equal(requests.length,after,'terminal original abort cannot be resumed');
      } else {
        assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,pendingPreparation());
        assert.equal(useWorkspacePathOperationStore.getState().error,'action','an arbitrary 409 cannot resolve the preparation');
      }
    }
    await openPreparation(); await loadPreparation();
    reply=async()=>Response.json({success:false,code:'FORBIDDEN'},{status:403});
    await recoverWorkspacePathOperation('resume');
    assert.equal(useWorkspacePathOperationStore.getState().error,'access');
    assert.equal(useWorkspacePathOperationStore.getState().preparation,null);
    const afterDenied=requests.length; await recoverWorkspacePathOperation('resume');
    assert.equal(requests.length,afterDenied);

    await openPreparation(); await loadPreparation();
    let completeRead!: (response:Response)=>void;
    reply=()=>new Promise(resolve=>{completeRead=resolve;});
    const lateRead=reloadWorkspacePathOperationStatus();
    invalidateOpenedDocumentAuth();
    completeRead(Response.json({success:true,preparation:pendingPreparation('draining')})); await lateRead;
    assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,pendingPreparation(),'auth invalidation prevents a late preparation response from replacing the pinned state');
    await openPreparation(); await loadPreparation();
    reply=()=>new Promise(resolve=>{completePost=resolve;});
    const latePost=recoverWorkspacePathOperation('resume');
    useWorkspaceStore.setState({activeWorkspaceId:'foreign-workspace'});
    completePost(Response.json({success:true,preparation:pendingPreparation('draining')},{status:202})); await latePost;
    assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,pendingPreparation(),'workspace drift prevents late Continue adoption');
    closeWorkspacePathOperationStatus(); useWorkspaceStore.setState({activeWorkspaceId:workspaceId});
    await openPreparation(); await loadPreparation();
    reply=()=>new Promise(resolve=>{completeRead=resolve;});
    const closedRead=reloadWorkspacePathOperationStatus();
    const closingSignal=requests.at(-1)?.init?.signal; assert(closingSignal);
    closeWorkspacePathOperationStatus(); assert.equal(closingSignal.aborted,true);
    completeRead(Response.json({success:true,preparation:pendingPreparation()})); await closedRead;
    assert.equal(useWorkspacePathOperationStore.getState().request,null,'closing ignores late data and aborts only the client fetch');

    const implicitOperation=(status:WorkspacePathOperationPublic['status'])=>({
      ...operation(status),kind:'rename' as const,selections:selectedPaths.map(item=>({...item})),
      errorCode:null,implicitBinding:preparationBinding,
    });
    const mappedBatchUrl='/api/files/operations/batches/'+batchId;
    await openPreparation(); await loadPreparation();
    const beforeTransfer=requests.length;
    reply=async()=>Response.json(requests.at(-1)?.url===preparationUrl
      ? {success:true,operation:implicitOperation('queued')}
      : {success:true,operation:{...operation('queued'),kind:'rename',errorCode:null,selections:selectedPaths},
        recovery:{canResume:false,canUndo:false},mutation:{private:'private-secret'}});
    await reloadWorkspacePathOperationStatus();
    assert.deepEqual(requests.slice(beforeTransfer).map(item=>item.url),[preparationUrl,mappedBatchUrl]);
    requests.slice(beforeTransfer).forEach(item=>assertGet(item,item.url));
    assert.equal(useWorkspacePathOperationStore.getState().preparation,null);
    assert.deepEqual(useWorkspacePathOperationStore.getState().response?.operation.implicitBinding,preparationBinding);
    assert.equal(JSON.stringify(useWorkspacePathOperationStore.getState()).includes('private-secret'),false);
    reply=async()=>Response.json({success:true,operation:{...operation('applied'),kind:'rename',errorCode:null,selections:selectedPaths},
      recovery:{canResume:false,canUndo:false},historical:true,mutation:{oldPath:'private-secret'}});
    await reloadWorkspacePathOperationStatus(); assertGet(requests.at(-1)!,mappedBatchUrl);
    assert.deepEqual(useWorkspacePathOperationStore.getState().response?.operation.implicitBinding,preparationBinding,'ordinary batch GET retains the verified preparation pin');
    assert.deepEqual(Object.keys(useWorkspacePathOperationStore.getState().response!).sort(),['operation','recovery'],'status observations retain no historical mutation to replay');
    for(const patch of [{actorUserId:'foreign-user'},{selectionDigest:'f'.repeat(64)},{requestId:'66666666-7777-8888-9999-aaaaaaaaaaaa'}]) {
      reply=async()=>Response.json({success:true,operation:{...implicitOperation('applied'),implicitBinding:{...preparationBinding,...patch}}});
      await reloadWorkspacePathOperationStatus();
      assert.equal(useWorkspacePathOperationStore.getState().error,'identity');
      assert.equal(useWorkspacePathOperationStore.getState().response,null);
    }

    // Once the authenticated UUID proves its batch, ordinary batch GET and
    // explicit recovery must retain the same original action and every path.
    // A cold UUID may map immediately; it must establish the same strict pin.
    for (const cold of [false, true]) for (const transport of ['GET','POST'] as const) {
      for (const drift of ['kind','source','destination'] as const) {
        await openPreparation();
        if (!cold) await loadPreparation();
        reply=async()=>Response.json(requests.at(-1)?.url===preparationUrl
          ? {success:true,operation:implicitOperation('queued')}
          : {success:true,operation:{...implicitOperation('needs_recovery'),phase:'recovery',implicitBinding:undefined},
            recovery:{canResume:true,canUndo:false}});
        await reloadWorkspacePathOperationStatus();
        assert.equal(useWorkspacePathOperationStore.getState().error,null);
        const response=useWorkspacePathOperationStore.getState().response;
        assert(response);assert.equal(response.operation.kind,'rename');
        assert.deepEqual(response.operation.selections,selectedPaths);
        const {implicitBinding:_mapping,...mapped}=implicitOperation('queued');
        const changed={...mapped,...(drift==='kind'?{kind:'move'}:{selections:[{
          sourcePath:drift==='source'?'Different/source.md':selectedPaths[0].sourcePath,
          destinationPath:drift==='destination'?'Different/target.md':selectedPaths[0].destinationPath}]})};
        const before: number=requests.length;
        reply=async()=>Response.json({success:true,operation:changed,recovery:{canResume:true,canUndo:false}});
        if(transport==='GET')await reloadWorkspacePathOperationStatus();
        else await recoverWorkspacePathOperation('resume');
        assert.equal(requests.length,before+1);
        assert.equal(requests.at(-1)?.url,mappedBatchUrl);
        assert.equal(requests.at(-1)?.init?.method??'GET',transport);
        if(transport==='POST')assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)),{action:'resume',planId});
        assert.equal(useWorkspacePathOperationStore.getState().error,'identity',
          'Same batch/plan IDs cannot replace the UUID-pinned action or selection.');
        assert.equal(useWorkspacePathOperationStore.getState().response,null);
      }
    }

    const preparationNotification:NotificationItem={...notification,id:'file-path-preparation:'+preparationRequestId,unread:false,
      target:{kind:'file_path_operation',workspaceId,preparationRequestId,operationKind:'rename',status:'pending'}};
    assert.equal(new URL(notificationHref(preparationNotification),window.location.origin).searchParams.get('workspacePathPreparation'),preparationRequestId);
    const preparationSummary={items:[preparationNotification],sections:{notifications:[preparationNotification],todoAttention:[],emailAttention:[]}} as unknown as NotificationSummary;
    assert.deepEqual(homeNotificationItems(preparationSummary),[preparationNotification],'Home retains pending preparation after explicit mark-read');
    closeWorkspacePathOperationStatus(); signedIn(); useWorkspaceStore.setState({activeWorkspaceId:workspaceId});
    const beforeNoticeOpen=requests.length;
    assert.equal(await openWorkspacePathOperationNotificationTarget(preparationNotification.target as Extract<NotificationItem['target'],{kind:'file_path_operation'}>),true);
    assert.equal(useWorkspacePathOperationStore.getState().request?.preparationRequestId,preparationRequestId);
    assert.equal(requests.length,beforeNoticeOpen,'opening pending notification never automatically marks it read or advances it');
    console.log('pending preparation store: GET-only reopen/read, pinned identity, explicit Continue, exact abort, scope races and sticky real batch passed');


    // Real in-memory attempt registry + actual Status-store functions. All
    // HTTP replies below remain unit data, never evidence of a committed Move.
    const { openedDocumentAuthScope }=await import('../app/lib/collaboration/opened-document-registry');
    const {reserveWorkspacePathOperationAttempt,markWorkspacePathOperationAttemptImplicit,
      dispatchWorkspacePathOperationAttempt,bindWorkspacePathOperationAttemptImplicitPreparation,
      settleWorkspacePathOperationAttempt,abandonWorkspacePathOperationAttempt,
      observeWorkspacePathOperationAttemptImplicitMapping,observeWorkspacePathOperationAttemptPreparationAbort,
      observeWorkspacePathOperationAttemptCompletion}=await import('../app/lib/files/workspace-path-operation-attempts');
    let bridgeSerial=0;
    const bridgeAttempt=(known202=true)=>{
      closeWorkspacePathOperationStatus();signedIn();useWorkspaceStore.setState({activeWorkspaceId:workspaceId});
      const authScope=openedDocumentAuthScope();assert(authScope);
      const serial=++bridgeSerial;
      const selections=[{sourcePath:'status-bridge-'+serial+'.md',destinationPath:'status-bridge-'+serial+'-new.md'}];
      const input={workspaceId,kind:'rename' as const,selections};
      const ticket=reserveWorkspacePathOperationAttempt(input);
      markWorkspacePathOperationAttemptImplicit(ticket);dispatchWorkspacePathOperationAttempt(ticket);
      const requestId='11111111-2222-3333-4444-'+serial.toString(16).padStart(12,'0');
      const url='/api/files/operations/implicit-moves/'+requestId;
      const binding={...preparationBinding,operationId:ticket.operationId,requestId};
      const preparation={...pendingPreparation(),operationId:ticket.operationId,requestId,selections,statusUrl:url,resumeUrl:url};
      if(known202)bindWorkspacePathOperationAttemptImplicitPreparation(ticket,preparation);
      settleWorkspacePathOperationAttempt(ticket,'unknown');
      const mapped=(status:WorkspacePathOperationPublic['status'])=>({
        ...operation(status),batchId:'status-bridge-batch-'+serial.toString().padStart(8,'0'),
        kind:'rename' as const,errorCode:null,selections,implicitBinding:binding,
      });
      return {authScope,ticket,input,binding,preparation,url,mapped};
    };
    type Bridge=ReturnType<typeof bridgeAttempt>;
    const unresolvedBridge=(state:Bridge)=>{
      const retry=reserveWorkspacePathOperationAttempt(state.input);
      try{assert.equal(retry.operationId,state.ticket.operationId,'unconfirmed original attempt must keep the same key');}
      finally{abandonWorkspacePathOperationAttempt(retry);}
    };
    const retiredBridge=(state:Bridge)=>{
      const next=reserveWorkspacePathOperationAttempt(state.input);
      try{assert.notEqual(next.operationId,state.ticket.operationId,'only verified complete applied batch retires the original attempt');}
      finally{abandonWorkspacePathOperationAttempt(next);}
    };
    const cleanBridge=(state:Bridge)=>{
      closeWorkspacePathOperationStatus();signedIn();useWorkspaceStore.setState({activeWorkspaceId:workspaceId});
      // Explicit valid unit protocol cleanup, with the same original UUID and
      // metadata. No private-map clearing and no legacy fallback are available.
      if(!state.ticket.implicitBinding)bindWorkspacePathOperationAttemptImplicitPreparation(state.ticket,state.preparation);
      observeWorkspacePathOperationAttemptImplicitMapping(state.mapped('queued'),state.authScope);
      observeWorkspacePathOperationAttemptCompletion(state.mapped('applied'));
      retiredBridge(state);
    };
    const openBridge=async(state:Bridge)=>{
      assert.equal(await openWorkspacePathOperationStatus({workspaceId,preparationRequestId:state.binding.requestId}),true);
      reply=async()=>Response.json({success:true,preparation:state.preparation});
      await reloadWorkspacePathOperationStatus();
      assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,state.preparation);
    };
    const mapBridgeQueued=async(state:Bridge)=>{
      const before=requests.length;
      reply=async()=>{
        const queued=state.mapped('queued');
        if(requests.at(-1)?.url===state.url)return Response.json({success:true,operation:queued});
        const {implicitBinding:_binding,...operation}=queued;
        return Response.json({success:true,operation,recovery:{canResume:false,canUndo:false}});
      };
      await reloadWorkspacePathOperationStatus();
      assert.deepEqual(requests.slice(before).map(item=>item.url),
        [state.url,'/api/files/operations/batches/'+state.mapped('queued').batchId]);
      requests.slice(before).forEach(item=>assertGet(item,item.url));
      assert.deepEqual(useWorkspacePathOperationStore.getState().response?.operation.implicitBinding,state.binding);
      assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status,'queued');
      unresolvedBridge(state);
    };
    {
      const state=bridgeAttempt();let retired=false;
      try{
        assert.deepEqual(state.ticket.implicitBinding,state.binding);
        unresolvedBridge(state);await openBridge(state);await mapBridgeQueued(state);
        const {implicitBinding:_binding,...operation}=state.mapped('applied');
        reply=async()=>Response.json({success:true,operation,recovery:{canResume:false,canUndo:false}});
        await reloadWorkspacePathOperationStatus();
        assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status,'applied');
        assert.deepEqual(useWorkspacePathOperationStore.getState().response?.operation.implicitBinding,state.binding);
        retiredBridge(state);retired=true;
      }finally{if(!retired)cleanBridge(state);}
    }
    for(const mismatch of ['actor','workspace','uuid','operation','digest','selection','legacy'] as const){
      const state=bridgeAttempt();
      try{
        await openBridge(state);
        const valid=state.mapped('applied');
        const binding={...state.binding,...(mismatch==='actor'?{actorUserId:'another-user'}:{})
          ,...(mismatch==='workspace'?{workspaceId:'another-workspace'}:{})
          ,...(mismatch==='uuid'?{requestId:'66666666-7777-8888-9999-aaaaaaaaaaaa'}:{})
          ,...(mismatch==='operation'?{operationId:'another-original-selection'}:{})
          ,...(mismatch==='digest'?{selectionDigest:'e'.repeat(64)}:{})};
        const operation={...valid,implicitBinding:binding,
          ...(mismatch==='selection'?{selections:[{sourcePath:'foreign.md',destinationPath:state.input.selections[0].destinationPath}]}:{}),
          ...(mismatch==='legacy'?{implicitBinding:undefined,legacyImplicitReplay:{version:1,kind:'implicit-move-legacy-replay',
            actorUserId:state.authScope.userId,workspaceId,operationId:state.ticket.operationId,batchId:valid.batchId,planId:valid.planId}}:{})};
        reply=async()=>Response.json({success:true,operation});
        await reloadWorkspacePathOperationStatus();
        assert.equal(useWorkspacePathOperationStore.getState().error,'identity');
        assert.equal(useWorkspacePathOperationStore.getState().response,null);
        unresolvedBridge(state);
      }finally{cleanBridge(state);}
    }
    for(const mismatch of [{batchId:'foreign-status-batch-12345678'},{planId:'e'.repeat(64)}]){
      const state=bridgeAttempt();let retired=false;
      try{
        await openBridge(state);await mapBridgeQueued(state);
        const {implicitBinding:_binding,...operation}=state.mapped('applied');
        reply=async()=>Response.json({success:true,operation:{...operation,...mismatch}});
        await reloadWorkspacePathOperationStatus();
        assert.equal(useWorkspacePathOperationStore.getState().error,'identity');
        assert.equal(useWorkspacePathOperationStore.getState().response,null);
        unresolvedBridge(state);
        reply=async()=>Response.json({success:true,operation});
        await reloadWorkspacePathOperationStatus();
        assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status,'applied');
        retiredBridge(state);retired=true;
      }finally{if(!retired)cleanBridge(state);}
    }
    {
      const state=bridgeAttempt(false);
      try{
        assert.equal(state.ticket.implicitBinding,undefined);
        await openBridge(state);await mapBridgeQueued(state);
        const {implicitBinding:_binding,...operation}=state.mapped('applied');
        reply=async()=>Response.json({success:true,operation});
        await reloadWorkspacePathOperationStatus();
        assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status,'applied');
        assert.equal(state.ticket.implicitBinding,undefined,'a discovered UUID cannot manufacture the missing initial 202 binding');
        unresolvedBridge(state);
      }finally{cleanBridge(state);}
    }
    const abortedBridge=(state:Bridge,reason:'user_cancelled'|'precondition_failed'='precondition_failed')=>{
      const {status:_status,canResume:_canResume,statusUrl:_statusUrl,resumeUrl:_resumeUrl,...original}=state.preparation;
      return {...original,state:'aborted' as const,reason};
    };
    for(const method of ['GET','POST'] as const){
      const state=bridgeAttempt();let retired=false;
      try{
        await openBridge(state);
        const preparation=abortedBridge(state,method==='GET'?'precondition_failed':'user_cancelled');
        reply=async()=>method==='GET'?Response.json({success:true,preparation})
          :Response.json({success:false,code:'IMPLICIT_MOVE_PREPARATION_ABORTED',preparation},{status:409});
        const before: number=requests.length;
        if(method==='GET')await reloadWorkspacePathOperationStatus();else await recoverWorkspacePathOperation('resume');
        assert.equal(requests.length,before+1);assert.equal(requests.at(-1)?.url,state.url);
        assert.equal(requests.at(-1)?.init?.method??'GET',method);
        assert.equal(useWorkspacePathOperationStore.getState().error,null);
        assert.deepEqual(useWorkspacePathOperationStore.getState().preparation,preparation);
        const next=reserveWorkspacePathOperationAttempt(state.input);
        try{assert.notEqual(next.operationId,state.ticket.operationId,
          'An exact terminal abort of a known 202 allows a newly requested action to get a new UUID.');}
        finally{abandonWorkspacePathOperationAttempt(next);}
        retired=true;
        const after: number=requests.length;await recoverWorkspacePathOperation('resume');await recoverWorkspacePathOperation('undo');
        assert.equal(requests.length,after,'Displaying a terminal abort never advances or repeats it.');
      }finally{if(!retired)cleanBridge(state);else closeWorkspacePathOperationStatus();}
    }
    for(const mismatch of ['actor','workspace','uuid','operation','digest','action','source','destination'] as const){
      const state=bridgeAttempt();
      try{
        await openBridge(state);
        const valid=abortedBridge(state),preparation={...valid,
          ...(mismatch==='actor'?{actorUserId:'another-user'}:{}),
          ...(mismatch==='workspace'?{workspaceId:'another-workspace'}:{}),
          ...(mismatch==='uuid'?{requestId:'66666666-7777-8888-9999-aaaaaaaaaaaa'}:{}),
          ...(mismatch==='operation'?{operationId:'another-original-operation'}:{}),
          ...(mismatch==='digest'?{selectionDigest:'e'.repeat(64)}:{}),
          ...(mismatch==='action'?{action:'move'}:{}),
          ...(['source','destination'].includes(mismatch)?{selections:[{
            sourcePath:mismatch==='source'?'Different/source.md':state.input.selections[0].sourcePath,
            destinationPath:mismatch==='destination'?'Different/target.md':state.input.selections[0].destinationPath}]}:{})};
        reply=async()=>Response.json({success:true,preparation});await reloadWorkspacePathOperationStatus();
        assert.equal(useWorkspacePathOperationStore.getState().error,'identity');
        assert.equal(useWorkspacePathOperationStore.getState().preparation,null);unresolvedBridge(state);
      }finally{cleanBridge(state);}
    }
    for(const method of ['GET','POST'] as const){
      const state=bridgeAttempt(false);
      try{
        await openBridge(state);const preparation=abortedBridge(state);
        reply=async()=>method==='GET'?Response.json({success:true,preparation})
          :Response.json({success:false,code:'IMPLICIT_MOVE_PREPARATION_ABORTED',preparation},{status:409});
        if(method==='GET')await reloadWorkspacePathOperationStatus();else await recoverWorkspacePathOperation('resume');
        assert.equal(useWorkspacePathOperationStore.getState().error,null);
        assert.equal(useWorkspacePathOperationStore.getState().preparation?.state,'aborted');
        assert.equal(state.ticket.implicitBinding,undefined,'Discovery cannot supply the absent original 202 proof.');
        unresolvedBridge(state);
      }finally{cleanBridge(state);}
    }
    {
      const state=bridgeAttempt();
      try{
        await openBridge(state);await mapBridgeQueued(state);
        observeWorkspacePathOperationAttemptPreparationAbort(abortedBridge(state),state.authScope);
        unresolvedBridge(state);assert.equal(useWorkspacePathOperationStore.getState().response?.operation.status,'queued',
          'A mapped batch cannot turn back into a preparation abort.');
      }finally{cleanBridge(state);}
    }

    console.log('pending Status attempt bridge: known 202 original pins on queued mapping, retires on complete applied GET only, rejects identity drift and keeps unknown UUID unresolved');

    observeOpenedDocumentAuth(null);
    assert.equal(await openWorkspacePathOperationStatus({ workspaceId, batchId }), false, 'signed-out navigation cannot select private details');
    console.log('workspace path status store: scoped identity, safe metadata, real recovery outcomes, request races and notification navigation passed');
  } finally {
    closeWorkspacePathOperationStatus(); globalThis.fetch = originalFetch; useWorkspaceStore.setState(originalWorkspace); dom.window.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
