import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from '@hocuspocus/provider';
import { writePermissionDenied } from '@hocuspocus/common';
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from 'lib0/encoding';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import type { CurrentFile } from '../app/lib/files/types';
import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState,
  textCollaborationLegacyStatus } from '../app/lib/collaboration/client-state';
import { collaborationFailure, NATIVE_PEER_ADMISSION_BUSY_REASON } from '../app/lib/collaboration/failure';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { findOpenedLiveDocument, invalidateOpenedDocumentAuth, observeOpenedDocumentAuth, openedDocumentAuthScope,
  validateOpenedLiveDocumentSession } from '../app/lib/collaboration/opened-document-registry';
import { committedCollaborationTestDatabase } from './collaboration-client-test-storage';

type ProviderOptions = {
  token: () => Promise<string>; document: Y.Doc; name: string; awareness: { destroy: () => void };
  onAuthenticationFailed: (value: { reason: string }) => void; onSynced: () => void;
  onStatus: (value: { status: string }) => void; onUnsyncedChanges: (value: { number: number }) => void;
  onStateless: (value: { payload: string }) => void;
  onClose: (value: { event: Pick<CloseEvent, 'code' | 'reason'> }) => void;
};

async function main() {
  const seed = new Y.Doc(); seed.getText('content').insert(0, 'Synthetic native draft');
  const proof = collaborationStateProof(seed, Y)!;
  let state = createInitialTextCollaborationClientState();
  state = reduceTextCollaborationClientState(state, { type: 'indexeddb_hydrated' });
  state = reduceTextCollaborationClientState(state, { type: 'remote_synced', permission: 'write' });
  state = reduceTextCollaborationClientState(state, { type: 'unsynced_changes', count: 3 });
  const busy = reduceTextCollaborationClientState(state, { type: 'admission_busy', message: 'busy' });
  assert.equal(busy.admissionBusy, true); assert.equal(busy.ready, state.ready);
  assert.equal(busy.unsyncedChanges, 3); assert.equal(busy.connection, 'offline');
  assert.equal(busy.remoteSynced, false); assert.equal(busy.failure, null);
  assert.equal(textCollaborationLegacyStatus(busy), 'offline');
  for (const event of [
    { type: 'provider_status', status: 'connecting', permission: 'write' },
    { type: 'provider_status', status: 'connected', permission: 'write' },
    { type: 'remote_synced', permission: 'write' },
    { type: 'authoritative_snapshot', documentSequence: 4, checkpointSequence: 4, stateVector: 'synthetic',
      stateProof: proof, matchesCurrentDocument: true, projectionFinalized: true, schemaValidated: true },
    { type: 'checkpoint_requested' }, { type: 'checkpoint_failed', message: 'late' },
    { type: 'checkpoint_superseded', sequence: 4 },
  ] as const) assert.equal(reduceTextCollaborationClientState(busy, event), busy, `busy is sticky for ${event.type}`);
  assert.equal(reduceTextCollaborationClientState(busy, { type: 'unsynced_changes', count: 0 }).unsyncedChanges, 3);
  assert.equal(reduceTextCollaborationClientState(busy, { type: 'unsynced_changes', count: 4 }).unsyncedChanges, 4);
  assert.equal(reduceTextCollaborationClientState(busy, { type: 'document_changed' }).admissionBusy, true);
  const denied = reduceTextCollaborationClientState(busy, { type: 'authentication_failed', message: 'revoked' });
  assert.equal(denied.connection, 'denied'); assert.equal(denied.failure?.kind, 'authentication');
  assert.equal(reduceTextCollaborationClientState(denied, { type: 'admission_busy', message: 'busy' }).error, 'revoked');
  const reauthorized = reduceTextCollaborationClientState(busy, { type: 'admission_reauthorized', permission: 'read' });
  assert.equal(reauthorized.admissionBusy, false); assert.equal(reauthorized.connection, 'read_only');
  assert.equal(reauthorized.unsyncedChanges, 3); assert.equal(reauthorized.remoteSynced, false);
  assert.equal(reauthorized.persistedStateProof, null); assert.equal(reauthorized.checkpointStateProof, null);
  assert.equal(reduceTextCollaborationClientState(denied, { type: 'admission_reauthorized', permission: 'write' }), denied);
  assert.deepEqual(collaborationFailure(NATIVE_PEER_ADMISSION_BUSY_REASON), { kind: 'unknown', code: null },
    'the existing failure classifier is unchanged; only exact provider signals pause admission');

  const dom = new JSDOM('<!doctype html><main id="root"></main>', { url: 'https://canvas.test' });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const retryTasks = new Map<ReturnType<typeof setTimeout>, { run: () => void; cancelled: boolean }>();
  const rejoinDeadlines = new Map<ReturnType<typeof setTimeout>, { run: () => void; cancelled: boolean }>();
  let captureRetry = false;
  let captureRejoinDeadline = false;
  globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (captureRejoinDeadline && delay === 10_000) {
      const handle = {} as ReturnType<typeof setTimeout>;
      rejoinDeadlines.set(handle, { run: callback, cancelled: false }); return handle;
    }
    if (captureRetry && delay === 1000) {
      const handle = {} as ReturnType<typeof setTimeout>;
      retryTasks.set(handle, { run: callback, cancelled: false }); return handle;
    }
    return originalTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const deadline = rejoinDeadlines.get(handle);
    if (deadline) { deadline.cancelled = true; return; }
    const task = retryTasks.get(handle);
    if (task) task.cancelled = true; else originalClearTimeout(handle);
  }) as typeof clearTimeout;
  observeOpenedDocumentAuth({ data: { user: { id: 'synthetic-owner' }, session: { id: 'synthetic-login' } } });
  const authScope = openedDocumentAuthScope();
  const providers: FakeProvider[] = [];
  class FakeProvider {
    manageSocket = true;
    isAuthenticated = false;
    destroyed = false;
    connects = 0;
    socketConnects = 0;
    disconnected = 0;
    pendingCount = 0;
    tokens: string[] = [];
    acknowledgements: string[] = [];
    closeEvents: Array<{ code: number; reason: string }> = [];
    pendingUpdates: Uint8Array[] = [];
    pendingAwarenessClients = new Set<number>();
    flushTimeout: ReturnType<typeof setTimeout> | null = null;
    effectiveName: string;
    socket = { shouldConnect: true, webSocket: null, configuration: { delay: 1000 },
      cleanupWebSocket() {},
      emit: (event: string, value: { status?: string }) => {
        if (event === 'status' && value.status) this.options.onStatus({ status: value.status });
      },
      connect: async () => { this.socketConnects++; this.socket.shouldConnect = true; await this.sendToken(); },
      disconnect: () => {
        HocuspocusProviderWebsocket.prototype.disconnect.call(this.socket as unknown as HocuspocusProviderWebsocket);
        this.options.onStatus({ status: 'disconnected' });
      },
    };
    configuration = { websocketProvider: this.socket,
      onClose: (value: { event: Pick<CloseEvent, 'code' | 'reason'> }) => this.options.onClose(value) };
    update = () => this.options.onUnsyncedChanges({ number: ++this.pendingCount });
    constructor(readonly options: ProviderOptions) {
      this.effectiveName = options.name; providers.push(this); options.document.on('update', this.update);
    }
    emit(event: string, value: { reason: string }) {
      if (event === 'authenticationFailed') this.options.onAuthenticationFailed(value);
    }
    getToken() { return this.options.token(); }
    send(_message: unknown, value: { token?: string }) { if (value.token) this.tokens.push(value.token); }
    sendToken() { return HocuspocusProvider.prototype.sendToken.call(this as unknown as HocuspocusProvider); }
    connect() { this.connects++; return HocuspocusProvider.prototype.connect.call(this as unknown as HocuspocusProvider); }
    disconnect() { this.disconnected++; HocuspocusProvider.prototype.disconnect.call(this as unknown as HocuspocusProvider); }
    permissionDeniedHandler(reason: string) {
      HocuspocusProvider.prototype.permissionDeniedHandler.call(this as unknown as HocuspocusProvider, reason);
    }
    authenticatedHandler() {}
    onClose() { HocuspocusProvider.prototype.onClose.call(this as unknown as HocuspocusProvider); }
    forwardClose(value: { event: { code: number; reason: string } }) { this.closeEvents.push(value.event); }
    authDenied(reason: string) {
      const encoder = createEncoder(); writeVarString(encoder, this.effectiveName); writeVarUint(encoder, MessageType.Auth);
      writePermissionDenied(encoder, reason);
      HocuspocusProvider.prototype.onMessage.call(this as unknown as HocuspocusProvider,
        { data: toUint8Array(encoder) } as MessageEvent);
    }
    setAwarenessField() {}
    sendStateless(message: string) { this.acknowledgements.push(message); }
    destroy() { this.destroyed = true; this.options.document.off('update', this.update); this.options.awareness.destroy(); }
  }
  class Persistence {
    synced = true;
    whenSynced = Promise.resolve();
    db = committedCollaborationTestDatabase();
    constructor(_name: string, doc: Y.Doc) { Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed)); }
    destroy() {}
  }
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const runtimeRequire = createRequire(filename);
  const exported = {} as typeof Client;
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(
    (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
      : name === 'y-indexeddb' ? { IndexeddbPersistence: Persistence }
        : name === '@/app/lib/files/client' ? { workspaceHeaders: () => ({}) } : runtimeRequire(name),
    { exports: exported }, exported,
  );
  let current: Client.CollaborationDocument | null = null;
  const fixtureSession = (label: string, expired = false, guest = false): CollaborationSessionResponse => ({
    success: true, documentId: `synthetic-${label}`, documentName: `synthetic-${label}`, provider: 'yjs',
    representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3,
    permission: 'write', token: 'synthetic-token', expiresAt: new Date(Date.now() + (expired ? -1 : 600_000)).toISOString(),
    websocketUrl: '/ws/collaboration', user: { id: 'synthetic-owner', name: 'Synthetic', color: '#112233', colorLight: '#ddeeff' },
    ...(guest ? { guestAccess: { invitationId: 'synthetic-invitation', workspaceId: 'synthetic-workspace' } } : {}),
  });
  let session = fixtureSession('not-opened');
  let openedPath = 'synthetic.txt';
  let owner = 0;
  function Probe() {
    current = exported.useCollaborationDocument({ enabled: true, workspaceId: 'synthetic-workspace', path: openedPath,
      representation: 'plain_text', session, documentKey: `synthetic-view-${owner}` });
    return <output>{current?.connection}</output>;
  }
  const root = createRoot(document.getElementById('root')!);
  const get = () => { assert(current); return current as Client.CollaborationDocument; };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; !predicate() && i < 60; i++) await act(async () => { await new Promise(resolve => originalTimeout(resolve, 0)); });
    assert(predicate());
  };
  const open = async (label: string, expired = false, guest = false) => {
    owner++; openedPath = 'synthetic.txt';
    session = fixtureSession(label, expired, guest);
    if (!guest) assert(validateOpenedLiveDocumentSession('synthetic-workspace', openedPath, session));
    await act(async () => root.render(<Probe />)); await until(() => Boolean(current?.ready));
    return providers.at(-1)!;
  };
  const queueSocketRetry = async (provider: FakeProvider) => {
    captureRetry = true; const before = retryTasks.size;
    await act(async () => HocuspocusProviderWebsocket.prototype.onClose.call(
      provider.socket as unknown as HocuspocusProviderWebsocket, { event: { code: 1006 } as CloseEvent }));
    captureRetry = false; assert.equal(retryTasks.size, before + 1);
    return [...retryTasks.values()].at(-1)!;
  };
  const busyFrame = (provider: FakeProvider) => act(async () => provider.authDenied(NATIVE_PEER_ADMISSION_BUSY_REASON));
  let busyCases = 0;
  try {
    const provider = await open('draft');
    const doc = get().doc;
    const file: CurrentFile = { path: openedPath, content: '', collaboration: { path: openedPath,
      strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false, requiresRevisionCheck: false,
      latestRevision: null, activeLock: null, document: { id: session.documentId, provider: 'yjs', status: 'active', stateVersion: 1, snapshotRevisionId: null } } };
    exported.rememberOpenedCollaborationDocument(get(), file, 'synthetic-workspace');
    const cached = findOpenedLiveDocument('synthetic-workspace', openedPath, session.documentId);
    assert(cached);
    await act(async () => { doc.getText('content').insert(0, 'Local '); });
    const beforeBusy = Y.encodeStateAsUpdate(doc); const unsynced = get().clientState.unsyncedChanges;
    const socketRetry = await queueSocketRetry(provider);
    await busyFrame(provider); busyCases++;
    await act(async () => socketRetry.run());
    assert.equal(provider.socketConnects, 0, 'the installed queued onClose callback cannot create a new busy origin');
    assert.equal(get().connection, 'offline'); assert.equal(get().clientState.admissionBusy, true);
    assert.equal(get().ready, true); assert.equal(get().session?.permission, 'write');
    assert.equal(get().clientState.failure, null); assert.equal(get().clientState.unsyncedChanges, unsynced);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), beforeBusy); assert.equal(doc.isDestroyed, false);
    assert.equal(provider.socket.shouldConnect, false); assert.equal(provider.destroyed, false);
    assert.equal(openedDocumentAuthScope(), authScope);
    assert.equal(findOpenedLiveDocument('synthetic-workspace', openedPath, session.documentId), cached);
    await act(async () => {
      provider.options.onStatus({ status: 'connecting' }); provider.options.onStatus({ status: 'connected' });
      provider.options.onSynced(); provider.options.onUnsyncedChanges({ number: 0 });
      provider.options.onStateless({ payload: JSON.stringify({ type: 'durability_snapshot', documentId: session.documentId,
        lifecycleGeneration: 1, documentSequence: 2, checkpointSequence: 2, stateVector: 'synthetic',
        stateProof: collaborationStateProof(doc, Y), projectionFinalized: true, schemaValidated: true }) });
    });
    assert.equal(get().connection, 'offline'); assert.equal(get().clientState.remoteSynced, false);
    assert.equal(get().clientState.unsyncedChanges, unsynced); assert.equal(provider.acknowledgements.length, 0);
    await act(async () => doc.getText('content').insert(0, 'Later '));
    assert.equal(get().clientState.unsyncedChanges, unsynced + 1, 'local update tracking survives pause');
    let http = 0; globalThis.fetch = async () => { http++; return Response.json(session); };
    await assert.rejects(get().requestCheckpoint(), error => (error as { code: string }).code === NATIVE_PEER_ADMISSION_BUSY_REASON);
    await act(async () => { await provider.sendToken(); });
    assert.equal(http, 0); assert.equal(provider.tokens.length, 0); assert.equal(get().connection, 'offline');
    const count = providers.length;
    openedPath = 'synthetic-moved.txt'; session = { ...session, token: 'synthetic-fresh-location' };
    await act(async () => root.render(<Probe />));
    assert.equal(providers.length, count); assert.equal(get().doc, doc); assert.equal(get().provider, provider as unknown as HocuspocusProvider);
    assert.equal(get().ready, true); assert.equal(get().connection, 'offline'); assert.equal(get().canRevalidateLocation, false);
    await act(async () => provider.authDenied('unknown-denial'));
    assert.equal(get().connection, 'denied'); assert.equal(get().session?.permission, 'read');
    openedPath = 'synthetic-moved-again.txt'; session = { ...session, permission: 'write' };
    await act(async () => root.render(<Probe />));
    assert.equal(get().connection, 'denied'); assert.equal(get().session?.permission, 'read', 'late metadata cannot restore revoked writes');

    const retryProvider = await open('retry', true);
    const beforeRetries = retryTasks.size;
    captureRetry = true; globalThis.fetch = async () => { throw new TypeError('Synthetic offline transport'); };
    await act(async () => { await retryProvider.connect(); });
    assert.equal(retryTasks.size, beforeRetries + 1); const retry = [...retryTasks.values()].at(-1)!;
    await busyFrame(retryProvider); busyCases++; assert.equal(retry.cancelled, true);
    await act(async () => retry.run());
    assert.equal(retryProvider.connects, 1, 'a queued reconnect cannot create another origin after busy');
    assert.equal(get().connection, 'offline'); assert.equal(get().session?.permission, 'write'); captureRetry = false;

    const inflightProvider = await open('inflight-token', true);
    let resolveToken!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(resolve => { resolveToken = resolve; });
    const token = inflightProvider.sendToken(); await until(() => Boolean(resolveToken));
    const beforeTokenSession = get().session;
    await busyFrame(inflightProvider); busyCases++;
    await act(async () => { resolveToken(Response.json({ ...session, token: 'synthetic-late-token',
      expiresAt: new Date(Date.now() + 600_000).toISOString() })); await token; });
    assert.equal(get().session, beforeTokenSession); assert.equal(inflightProvider.tokens.length, 0);
    assert.equal(get().connection, 'offline'); assert.equal(get().session?.permission, 'write');

    const offlineProvider = await open('inflight-offline', true);
    let rejectToken!: (error: Error) => void;
    globalThis.fetch = () => new Promise<Response>((_resolve, reject) => { rejectToken = reject; });
    const offlineToken = offlineProvider.sendToken(); await until(() => Boolean(rejectToken));
    await busyFrame(offlineProvider); busyCases++;
    const timerCount = retryTasks.size; captureRetry = true;
    await act(async () => { rejectToken(new TypeError('Synthetic late network failure')); await offlineToken; });
    captureRetry = false;
    assert.equal(retryTasks.size, timerCount, 'a late token network failure cannot schedule another busy-origin attempt');
    assert.equal(get().connection, 'offline'); assert.equal(get().session?.permission, 'write');

    const checkpointProvider = await open('inflight-checkpoint');
    let resolveCheckpoint!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(resolve => { resolveCheckpoint = resolve; });
    let checkpointRejected!: Promise<void>;
    await act(async () => {
      checkpointRejected = assert.rejects(get().requestCheckpoint(),
        error => (error as { code: string }).code === NATIVE_PEER_ADMISSION_BUSY_REASON);
    });
    await until(() => Boolean(resolveCheckpoint)); await busyFrame(checkpointProvider); busyCases++;
    await act(async () => { resolveCheckpoint(Response.json({ documentId: session.documentId, lifecycleGeneration: 1,
      documentSequence: 1, checkpointSequence: 1, stateVector: 'synthetic', stateProof: collaborationStateProof(get().doc, Y) }));
    await checkpointRejected; });
    assert.equal(get().connection, 'offline'); assert.equal(get().clientState.failure, null);
    assert.equal(checkpointProvider.acknowledgements.length, 0);

    const guestProvider = await open('guest', false, true);
    await busyFrame(guestProvider); busyCases++;
    assert.equal(get().connection, 'offline'); assert.equal(get().session?.permission, 'write');
    assert.equal(get().session?.guestAccess?.invitationId, 'synthetic-invitation');
    await act(async () => guestProvider.options.onStateless({ payload: JSON.stringify({ type: 'access_revoked' }) }));
    assert.equal(get().connection, 'denied'); assert.equal(get().session?.permission, 'read');

    let unknownDenied = 0;
    for (const reason of ['unknown-denial', `${NATIVE_PEER_ADMISSION_BUSY_REASON} `, `prefix:${NATIVE_PEER_ADMISSION_BUSY_REASON}`]) {
      const unknownProvider = await open(`unknown-${++unknownDenied}`);
      await act(async () => unknownProvider.authDenied(reason));
      assert.equal(get().connection, 'denied'); assert.equal(get().session?.permission, 'read');
      assert.notEqual(get().clientState.admissionBusy, true);
    }

    const nonBusyProvider = await open('non-busy');
    const nonBusyRetry = await queueSocketRetry(nonBusyProvider);
    globalThis.fetch = async () => { http++; return Response.json(session); };
    const priorHttp = http;
    await act(async () => { nonBusyRetry.run(); await Promise.resolve(); });
    assert.equal(nonBusyProvider.socketConnects, 1); assert.equal(nonBusyProvider.tokens.length, 1);
    assert.equal(http, priorHttp, 'non-busy unexpired tickets keep the established connect contract');

    const retiredProvider = await open('retired');
    const retiredRetry = await queueSocketRetry(retiredProvider);
    openedPath = 'synthetic-retired.txt'; session = { ...session, token: 'synthetic-retired-location' };
    assert(validateOpenedLiveDocumentSession('synthetic-workspace', openedPath, session));
    await act(async () => root.render(<Probe />));
    assert.equal(retiredProvider.destroyed, true);
    await act(async () => { retiredRetry.run(); await Promise.resolve(); });
    assert.equal(retiredProvider.socketConnects, 0); assert.equal(retiredProvider.tokens.length, 0);
    assert.equal(http, priorHttp, 'a retired request scope cannot reconnect or refresh its token');

    const closedProvider = await open('closed');
    const closedDoc = get().doc; const closedRetry = await queueSocketRetry(closedProvider);
    await act(async () => root.render(null));
    await act(async () => { await new Promise(resolve => originalTimeout(resolve, 1100)); });
    assert.equal(closedDoc.isDestroyed, true);
    await act(async () => { closedRetry.run(); await Promise.resolve(); });
    assert.equal(closedProvider.socketConnects, 0); assert.equal(closedProvider.tokens.length, 0);
    assert.equal(http, priorHttp, 'a closed lifecycle cannot reconnect or refresh its token');

    for (const event of [{ code: 1013, reason: 'Synthetic ordinary retry' },
      { code: 1000, reason: 'Collaboration document transition ' }]) {
      const ordinaryProvider = await open('ordinary-close');
      await act(async () => ordinaryProvider.options.onClose({ event }));
      assert.notEqual(get().clientState.admissionBusy, true, 'a transport code or approximate reason cannot claim a transition');
    }

    // The actual installed receiver converts a document CLOSE frame to code
    // 1000. This is the server's live-room handoff path, not another AuthDenied.
    const transitionProvider = await open('transition-rejoin');
    const transitionDoc = get().doc;
    await act(async () => transitionDoc.getText('content').insert(0, 'Retained local '));
    const transitionBytes = Y.encodeStateAsUpdate(transitionDoc), transitionPending = get().clientState.unsyncedChanges;
    const transitionRetry = await queueSocketRetry(transitionProvider);
    await act(async () => {
      const encoder = createEncoder(); writeVarString(encoder, transitionProvider.effectiveName); writeVarUint(encoder, MessageType.CLOSE);
      writeVarString(encoder, 'Collaboration document transition');
      HocuspocusProvider.prototype.onMessage.call(transitionProvider as unknown as HocuspocusProvider,
        { data: toUint8Array(encoder) } as MessageEvent);
      transitionRetry.run();
    });
    assert.deepEqual(transitionProvider.closeEvents, [{ code: 1000, reason: 'Collaboration document transition' }]);
    assert.equal(get().clientState.admissionBusy, true); assert.equal(transitionProvider.socketConnects, 0);
    assert.equal(get().doc, transitionDoc); assert.deepEqual(Y.encodeStateAsUpdate(transitionDoc), transitionBytes);
    assert.equal(transitionProvider.destroyed, false);

    let rejoinHttp = 0, resolveRejoin!: (response: Response) => void;
    globalThis.fetch = async (_input, init) => {
      rejoinHttp++; assert.equal(init?.method, 'POST');
      assert.equal(JSON.parse(String(init?.body)).path, openedPath);
      return new Promise<Response>(resolve => { resolveRejoin = resolve; });
    };
    const pausedView = get(), providerCount = providers.length, retryCount = retryTasks.size;
    const firstRejoin = pausedView.requestAdmissionRejoin!(), duplicateRejoin = pausedView.requestAdmissionRejoin!();
    assert.equal(firstRejoin, duplicateRejoin);
    const busyRejoin = assert.rejects(firstRejoin, error => (error as { code: string; status: number }).code === 'NATIVE_SESSION_BUSY'
      && (error as { status: number }).status === 409);
    await until(() => rejoinHttp === 1);
    await act(async () => { resolveRejoin(Response.json({ success: false, code: 'NATIVE_SESSION_BUSY', error: 'Synthetic reservation still active' }, { status: 409 })); await busyRejoin; });
    assert.equal(get().clientState.admissionBusy, true); assert.equal(providers.length, providerCount);
    assert.equal(rejoinHttp, 1); assert.equal(retryTasks.size, retryCount, 'busy rejoin schedules no token/network retry');
    assert.equal(get().provider, transitionProvider as unknown as HocuspocusProvider);

    globalThis.fetch = async () => { rejoinHttp++; return Response.json({ ...session, token: 'synthetic-rejoin-fresh' }); };
    await act(async () => { await get().requestAdmissionRejoin!(); });
    const rejoinedProvider = providers.at(-1)!;
    assert.equal(rejoinHttp, 2); assert.equal(providers.length, providerCount + 1); assert(transitionProvider.destroyed);
    assert.equal(get().doc, transitionDoc); assert.deepEqual(Y.encodeStateAsUpdate(transitionDoc), transitionBytes);
    assert.equal(transitionDoc.isDestroyed, false); assert.equal(get().clientState.unsyncedChanges, transitionPending);
    assert.equal(get().clientState.admissionBusy, false); assert.equal(get().clientState.remoteSynced, false);
    assert.equal(get().clientState.persistedStateProof, null); assert.equal(get().clientState.checkpointStateProof, null);
    await act(async () => {
      transitionProvider.options.onStatus({ status: 'connected' }); transitionProvider.options.onSynced();
      transitionProvider.options.onUnsyncedChanges({ number: 0 }); transitionProvider.authDenied('synthetic-late-revoke');
      await rejoinedProvider.sendToken();
    });
    assert.equal(get().clientState.connection, 'reconnecting'); assert.equal(get().clientState.unsyncedChanges, transitionPending);
    assert.deepEqual(rejoinedProvider.tokens, ['synthetic-rejoin-fresh']); assert.equal(rejoinHttp, 2);
    await assert.rejects(pausedView.requestAdmissionRejoin!(), /location changed/u);

    const downgradeProvider = await open('rejoin-downgrade');
    await act(async () => downgradeProvider.options.onClose({ event: { code: 1013, reason: 'Collaboration document transition' } }));
    globalThis.fetch = async () => Response.json({ ...session, permission: 'read', token: 'synthetic-read-ticket' });
    await act(async () => { await get().requestAdmissionRejoin!(); });
    assert.equal(get().session?.permission, 'read'); assert.equal(get().connection, 'read_only'); assert.equal(get().clientState.admissionBusy, false);

    for (const invalid of [
      { documentId: 'synthetic-replacement', documentName: 'synthetic-replacement' },
      { lifecycleGeneration: 2 }, { representation: 'tiptap_xml', richTextSchemaVersion: 3 },
      { user: { id: 'synthetic-other', name: 'Other', color: '#123456', colorLight: '#abcdef' } },
      { expiresAt: new Date(0).toISOString() },
    ]) {
      const retainedProvider = await open('rejoin-invalid'); await busyFrame(retainedProvider);
      const retainedDoc = get().doc, bytes = Y.encodeStateAsUpdate(retainedDoc), count = providers.length;
      globalThis.fetch = async () => Response.json({ ...session, ...invalid });
      await act(async () => { await assert.rejects(get().requestAdmissionRejoin!()); });
      assert.equal(get().clientState.admissionBusy, true); assert.equal(providers.length, count);
      assert.equal(get().doc, retainedDoc); assert.deepEqual(Y.encodeStateAsUpdate(retainedDoc), bytes);
      assert.equal(retainedProvider.destroyed, false);
    }
    for (const status of [401, 403]) {
      const deniedProvider = await open(`rejoin-denied-${status}`); await busyFrame(deniedProvider);
      globalThis.fetch = async () => Response.json({ success: false, error: 'Synthetic access revoked' }, { status });
      await act(async () => { await assert.rejects(get().requestAdmissionRejoin!()); });
      assert.equal(get().connection, 'denied'); assert.equal(get().session?.permission, 'read');
      assert.equal(get().clientState.admissionBusy, true); assert.equal(deniedProvider.destroyed, false);
    }
    const epochProvider = await open('rejoin-auth-epoch'); await busyFrame(epochProvider);
    resolveRejoin = undefined as unknown as (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(resolve => { resolveRejoin = resolve; });
    const epochView = get(), epochSession = session;
    const epochRejoin = assert.rejects(epochView.requestAdmissionRejoin!());
    await until(() => Boolean(resolveRejoin));
    await act(async () => {
      observeOpenedDocumentAuth({ data: { user: { id: 'synthetic-owner' }, session: { id: 'synthetic-new-login' } } });
      resolveRejoin(Response.json(epochSession)); await epochRejoin;
    });
    assert.equal(get().connection, 'denied'); assert.equal(get().clientState.admissionBusy, true); assert.equal(epochProvider.destroyed, false);
    observeOpenedDocumentAuth({ data: { user: { id: 'synthetic-owner' }, session: { id: 'synthetic-login' } } });

    const invalidatedProvider = await open('rejoin-same-session-epoch'); await busyFrame(invalidatedProvider);
    resolveRejoin = undefined as unknown as (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(resolve => { resolveRejoin = resolve; });
    const invalidatedSession = session, invalidatedCount = providers.length;
    const invalidatedRejoin = assert.rejects(get().requestAdmissionRejoin!());
    await until(() => Boolean(resolveRejoin));
    await act(async () => { invalidateOpenedDocumentAuth(); resolveRejoin(Response.json(invalidatedSession)); await invalidatedRejoin; });
    assert.equal(get().clientState.admissionBusy, true); assert.equal(providers.length, invalidatedCount);
    assert.equal(invalidatedProvider.destroyed, false, 'unchanged user/session IDs cannot bypass an invalidated authorization epoch');

    const staleProvider = await open('rejoin-retired'); await busyFrame(staleProvider);
    resolveRejoin = undefined as unknown as (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(resolve => { resolveRejoin = resolve; });
    const staleSession = session, staleView = get(), countBeforeRetire = providers.length;
    const staleRejoin = assert.rejects(staleView.requestAdmissionRejoin!());
    await until(() => Boolean(resolveRejoin));
    await act(async () => root.render(null));
    await act(async () => { resolveRejoin(Response.json(staleSession)); await staleRejoin; });
    assert.equal(providers.length, countBeforeRetire); assert.equal(staleView.clientState.admissionBusy, true);

    // An aborted fetch is not assumed to settle. The attempt's own deadline
    // must release its Promise as well, without destroying the open document.
    const timeoutProvider = await open('rejoin-post-timeout'); await busyFrame(timeoutProvider);
    const timeoutDoc = get().doc, timeoutBytes = Y.encodeStateAsUpdate(timeoutDoc), timeoutCount = providers.length;
    const timeoutSignals: AbortSignal[] = [];
    let timeoutHttp = 0;
    globalThis.fetch = async (_input, init) => {
      timeoutHttp++; assert(init?.signal); timeoutSignals.push(init.signal);
      return new Promise<Response>(() => {});
    };
    captureRejoinDeadline = true;
    const timedRejoin = assert.rejects(get().requestAdmissionRejoin!(), /rejoin timed out/u);
    captureRejoinDeadline = false;
    await until(() => timeoutHttp === 1);
    assert.equal(rejoinDeadlines.size, 1);
    const deadline = [...rejoinDeadlines.values()][0];
    await act(async () => { deadline.run(); await timedRejoin; });
    assert.equal(timeoutSignals[0].aborted, true); assert.equal(deadline.cancelled, true);
    assert.equal(timeoutHttp, 1); assert.equal(providers.length, timeoutCount);
    assert.equal(get().clientState.admissionBusy, true); assert.equal(get().doc, timeoutDoc);
    assert.deepEqual(Y.encodeStateAsUpdate(timeoutDoc), timeoutBytes); assert.equal(timeoutProvider.destroyed, false);
    globalThis.fetch = async () => { timeoutHttp++; return Response.json({ ...session, token: 'synthetic-after-timeout' }); };
    await act(async () => { await get().requestAdmissionRejoin!(); });
    assert.equal(timeoutHttp, 2); assert.equal(providers.length, timeoutCount + 1);
    assert.equal(get().doc, timeoutDoc); assert.equal(get().clientState.admissionBusy, false);

    // A genuine location change retires the old path attempt. A late old reply
    // and its finally must neither adopt that path nor clear the new attempt.
    const pathProvider = await open('rejoin-path-superseded'); await busyFrame(pathProvider);
    const pathDoc = get().doc, pathBytes = Y.encodeStateAsUpdate(pathDoc), pathCount = providers.length;
    const pathRequests: Array<{ path: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
    globalThis.fetch = (_input, init) => new Promise<Response>(resolve => {
      assert(init?.signal);
      pathRequests.push({ path: JSON.parse(String(init.body)).path as string, signal: init.signal, resolve });
    });
    const oldPathSession = session;
    const oldPathAttempt = assert.rejects(get().requestAdmissionRejoin!(), /superseded/u);
    await until(() => pathRequests.length === 1);
    openedPath = 'synthetic-current-path.txt'; session = { ...session, token: 'synthetic-location-metadata' };
    assert(validateOpenedLiveDocumentSession('synthetic-workspace', openedPath, session));
    await act(async () => root.render(<Probe />));
    const currentPathAttempt = get().requestAdmissionRejoin!();
    await until(() => pathRequests.length === 2);
    await act(async () => { await oldPathAttempt; });
    assert.equal(pathRequests[0].signal.aborted, true); assert.equal(pathRequests[1].signal.aborted, false);
    assert.deepEqual(pathRequests.map(request => request.path), ['synthetic.txt', openedPath]);
    assert.equal(get().requestAdmissionRejoin!(), currentPathAttempt, 'old finally cannot clear the current attempt');
    await act(async () => { pathRequests[0].resolve(Response.json({ ...oldPathSession, token: 'synthetic-old-path-late' })); });
    assert.equal(providers.length, pathCount); assert.equal(get().clientState.admissionBusy, true);
    assert.equal(get().requestAdmissionRejoin!(), currentPathAttempt); assert.equal(pathRequests.length, 2);
    await act(async () => {
      pathRequests[1].resolve(Response.json({ ...session, token: 'synthetic-current-path-fresh' }));
      await currentPathAttempt;
    });
    assert.equal(providers.length, pathCount + 1); assert.equal(get().session?.token, 'synthetic-current-path-fresh');
    assert.equal(get().doc, pathDoc); assert.deepEqual(Y.encodeStateAsUpdate(pathDoc), pathBytes);
    assert.equal(get().clientState.admissionBusy, false); assert.equal(pathProvider.destroyed, true);
    console.log(JSON.stringify({ scope: 'source-only', busyAuthDeniedCases: busyCases, unknownAuthDeniedCases: unknownDenied,
      draftPreserved: true, authScopePreserved: true, retryTimerCancelled: true, queuedRetryStopped: true,
      queuedSocketReconnects: 0, lateTokenStopped: true, lateNetworkRetryStopped: true,
      lateCheckpointStopped: true, locationProviderRestarts: 0, revokeStillDenied: true,
      nonBusySocketConnects: 1, retiredSocketReconnects: 0, closedSocketReconnects: 0,
      actualDocumentCloseCode: 1000, admissionRejoinRequests: 2, sameDocRetained: true,
      busyRejoinNoRetry: true, freshPermissionDowngrade: true, staleEpochAndViewRejected: true,
      rejoinPostDeadline: true, supersededPathAttemptRetired: true }));
  } finally {
    captureRetry = false; captureRejoinDeadline = false; await act(async () => root.unmount());
    await new Promise(resolve => originalTimeout(resolve, 1100));
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClearTimeout;
    observeOpenedDocumentAuth(null); seed.destroy(); dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
