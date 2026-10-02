import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { Connection, Hocuspocus, MessageType, type Document } from '@hocuspocus/server';
import * as encoding from 'lib0/encoding';
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';
import * as Direct from '../app/lib/collaboration/direct-connection';
import * as RoomMutation from '../app/lib/collaboration/room-mutation-lock';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type * as Server from '../server/collaboration-server';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function turn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type TestContext = {
  claims: CollaborationTicketClaims;
  workspace: WorkspaceContext;
  user: { id: string; name: string; email: null };
  actorType: 'user';
  observedDocumentSequence: null;
  releaseRoomAdmission: null;
};

type ControlledPersistResult = PersistedCollaborationState & {
  persistenceDisposition: 'unchanged' | 'advanced' | 'merged';
  incomingNeedsReconcile: boolean;
};

function updateFrame(documentName: string, update: Uint8Array, subtype: number = messageYjsUpdate) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, MessageType.Sync);
  encoding.writeVarUint(encoder, subtype);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function statelessFrame(documentName: string) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, MessageType.Stateless);
  encoding.writeVarString(encoder, JSON.stringify({ type: 'harmless_test_message' }));
  return encoding.toUint8Array(encoder);
}

function appendUpdate(document: Y.Doc, text: string) {
  const peer = new Y.Doc();
  try {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
    const before = Y.encodeStateVector(peer);
    peer.getText('content').insert(peer.getText('content').length, text);
    return Y.encodeStateAsUpdate(peer, before);
  } finally {
    peer.destroy();
  }
}

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-room-mutation-server-'));
  const originalData = process.env.DATA;
  const originalRoot = process.env.CANVAS_DATA_ROOT;
  process.env.DATA = data;
  process.env.CANVAS_DATA_ROOT = data;
  const workspace = { workspaceId: 'mutation-workspace', organizationId: null, workspaceType: 'personal' } as WorkspaceContext;
  const seedDocuments = new Map<string, Y.Doc>();
  const states = new Map<string, PersistedCollaborationState>();
  for (const documentId of ['doc', 'other']) {
    const seed = new Y.Doc();
    seed.getText('content').insert(0, `${documentId}:`);
    seedDocuments.set(documentId, seed);
    states.set(documentId, {
      documentId, workspaceId: workspace.workspaceId, organizationId: null, path: `${documentId}.txt`,
      lifecycleGeneration: 1, representation: 'plain_text', documentSequence: 1, checkpointSequence: 1,
      stateVector: Y.encodeStateVector(seed), yjsState: Y.encodeStateAsUpdate(seed), status: 'active', schemaVersion: 1,
      persistedAt: 1, checkpointedAt: 1, canonicalHash: null, serializedHash: null,
      newlineStyle: 'lf', hasBom: false, degraded: false,
    });
  }
  const claimsFor = (documentId: string): CollaborationTicketClaims => {
    const state = states.get(documentId)!;
    return { schemaVersion: state.schemaVersion, issuedAt: 0, expiresAt: Date.now() + 60_000,
      userId: 'user', sessionId: 'session', documentId, workspaceId: workspace.workspaceId,
      organizationId: null, path: state.path, provider: 'yjs', representation: state.representation,
      permission: 'write', lifecycleGeneration: state.lifecycleGeneration };
  };
  const contextFor = (documentId: string): TestContext => ({ claims: claimsFor(documentId), workspace,
    user: { id: 'user', name: 'User', email: null }, actorType: 'user', observedDocumentSequence: null,
    releaseRoomAdmission: null });
  const inputFor = (documentId: string): Direct.AgentDirectConnectionInput => ({
    documentId, documentPath: `${documentId}.txt`, documentRepresentation: 'plain_text',
    documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: true,
    workspace, actorId: 'agent', actorDisplayName: 'Agent', initiatedByUserId: 'user',
    operationId: `operation-${documentId}`, actorSessionId: 'stored-session',
  });
  const mcpAuthority = { scope: {
    userId: 'user', actorId: 'agent', sessionId: 'stored-session', workspaceId: workspace.workspaceId,
    documentId: 'doc', path: 'doc.txt', lifecycleGeneration: 1,
  }, verifyCurrent: async () => workspace, assertUnexpired() {} } as unknown as
    NonNullable<Direct.AgentDirectConnectionInput['mcpAuthority']>;
  let instance!: Hocuspocus;
  const captureInstance = (value: Hocuspocus) => { instance = value; };
  let direct!: Parameters<typeof Direct.installCollaborationDirectConnection>[0];
  let documentReader!: Parameters<typeof installCollaborationDocumentReader>[0];
  let ordinaryStateReads = 0;
  let directAcquireAttempt: ReturnType<typeof gate> | null = null;
  let syncBarrier: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let storeBarrier: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  const cleanupReleases: Array<() => void> = [];
  const pendingOperations: Promise<unknown>[] = [];
  const trackedGate = () => {
    const barrier = gate();
    cleanupReleases.push(barrier.resolve);
    return barrier;
  };
  const trackedRelease = (release: () => void) => {
    cleanupReleases.push(release);
    return release;
  };
  const trackPending = <T>(operation: Promise<T>) => {
    pendingOperations.push(operation);
    void operation.catch(() => undefined);
    return operation;
  };
  let rejectGuestUpdate = false;
  const denied = new Set<Connection>();
  let accessChecks = 0;
  let stores = 0;
  const historyCaptures: Array<{ source: string; actorUserId: string | null; actorType: string }> = [];
  let directHistoryContext: unknown;
  let operationHistoryRow: { status: string; has_state_snapshot: boolean; has_version_snapshot: boolean;
    result_json: string } | undefined;
  const controlledPersistResults: ControlledPersistResult[] = [];
  let reconciliationObservation: { entered: ReturnType<typeof gate>; completed: ReturnType<typeof gate> } | null = null;
  class ObservedHocuspocus extends Hocuspocus {
    constructor(options: ConstructorParameters<typeof Hocuspocus>[0]) {
      super({ ...options, async onChange(payload) {
        if (payload.context?.actorType === 'agent') directHistoryContext = payload.context;
        await options?.onChange?.(payload);
      }, async beforeSync(payload) {
        // The production hook acquires its room lease first. This gate then
        // suspends the receiver just before it applies the Yjs update.
        await options?.beforeSync?.(payload);
        const barrier = syncBarrier;
        if (barrier) {
          syncBarrier = null;
          barrier.entered.resolve();
          await barrier.release.promise;
        }
      } });
      captureInstance(this);
    }
  }
  const filename = path.resolve('server/collaboration-server.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const server = {} as typeof Server;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@/app/lib/db') return { openDb: async () => ({
      run: async (sql: string) => { assert.ok(['BEGIN READ ONLY', 'ROLLBACK'].includes(sql)); },
      get: async (sql: string, params: unknown[]) => {
        assert.match(sql, /requested_mode='direct_apply'/u);
        assert.match(sql, /operation_type='apply'/u);
        assert.match(sql, /agent_run_id IS NULL/u);
        assert.deepEqual(params, [`operation-${params[1]}`, params[1], workspace.workspaceId, 'agent', 'user',
          'stored-session', `${params[1]}.txt`, 'plain_text', 1, 1, null]);
        return operationHistoryRow;
      }, close: async () => {},
    }) };
    if (name === '@hocuspocus/server') return { Hocuspocus: ObservedHocuspocus };
    if (name === 'ws') return { WebSocketServer: class extends EventEmitter {} };
    if (name.endsWith('/persistence')) return {
      CollaborationStateStaleError: class extends Error {}, CollaborationStateInactiveError: class extends Error {},
      loadCollaborationState: async (documentId: string) => { ordinaryStateReads++; return states.get(documentId) ?? null; },
      persistCollaborationYDoc: async (documentId: string, generation: number, document: Y.Doc) => {
        const barrier = storeBarrier;
        if (barrier) {
          storeBarrier = null;
          barrier.entered.resolve();
          await barrier.release.promise;
        }
        const controlled = controlledPersistResults.shift();
        if (controlled) {
          assert.equal(generation, controlled.lifecycleGeneration);
          stores++;
          if (controlled.incomingNeedsReconcile && !reconciliationObservation) {
            reconciliationObservation = { entered: gate(), completed: gate() };
          }
          return controlled;
        }
        const previous = states.get(documentId)!;
        assert.equal(generation, previous.lifecycleGeneration);
        stores++;
        const next = { ...previous, stateVector: Y.encodeStateVector(document), yjsState: Y.encodeStateAsUpdate(document),
          documentSequence: previous.documentSequence + 1 };
        states.set(documentId, next);
        return { ...next, persistenceDisposition: 'advanced', incomingNeedsReconcile: false };
      },
      markCollaborationDegraded() { throw new Error('Unexpected persistence failure'); },
    };
    if (name.endsWith('/direct-connection')) return { ...Direct,
      installCollaborationDirectConnection: (handler: typeof direct) => { direct = handler; } };
    if (name.endsWith('/direct-edit-authority')) return {
      isDirectMcpEditAuthority: (value: unknown) => value === mcpAuthority,
    };
    if (name.endsWith('/document-access')) return {
      installCollaborationDocumentReader: (handler: typeof documentReader) => { documentReader = handler; },
    };
    if (name.endsWith('/runtime-state')) return { installCollaborationRoomInspector() {},
      reserveCollaborationRoomAdmission: () => () => {},
      withCollaborationRoomLifecycleLock: async (_id: string, operation: () => Promise<unknown>) => operation() };
    if (name.endsWith('/workspace-mutation-lock')) return { withWorkspaceMutationLock };
    if (name.endsWith('/room-mutation-lock')) return { ...RoomMutation,
      withCollaborationRoomMutationLock: <T>(document: object, operation: () => Promise<T> | T) => {
        directAcquireAttempt?.resolve();
        directAcquireAttempt = null;
        const observation = reconciliationObservation;
        return RoomMutation.withCollaborationRoomMutationLock(document, async () => {
          observation?.entered.resolve();
          try { return await operation(); }
          finally { observation?.completed.resolve(); }
        });
      },
    };
    if (name.endsWith('/session-workspace-context')) return {
      resolveAgentExecutionContextForStoredSession: async () => workspace,
      workspaceFromAgentExecutionContext: (value: WorkspaceContext) => value,
    };
    if (name.endsWith('/collaboration-policy')) return { readFileCollaborationState: async ({ path: filePath }: { path: string }) => ({
      document: { id: filePath.replace('.txt', ''), status: 'active', provider: 'yjs' },
    }) };
    if (name.endsWith('/projection-runtime')) return { createCollaborationProjectionRuntime: () => ({ enqueue() {}, dispose() {} }) };
    if (name.endsWith('/history-service')) return { fileVersionHistoryService: { capturePersistedCollaboration: async (capture: {
      source: string; actorUserId: string | null; actorType: string;
    }) => { historyCaptures.push(capture); } } };
    if (name.endsWith('/agent-turn-history')) return { agentTurnHistoryService: {
      boundary: async () => false, recoverExpired: async () => undefined,
    } };
    if (name.endsWith('/access-monitor')) return { createCollaborationAccessMonitor: () => ({
      dispose() {}, add: () => () => {}, check: async (connection: Connection) => {
        accessChecks++;
        if (denied.has(connection) || !connection.document.hasConnection(connection)) throw new Error('Collaboration access is closed.');
      },
    }) };
    if (name === '@/app/lib/file-guests/update-policy') return { assertFileGuestUpdateAllowed: () => {
      if (rejectGuestUpdate) throw new Error('Deliberate guest update rejection');
    } };
    if (name.endsWith('/agent-operations')) return { recoverCollaborationAgentOperations: async () => {},
      recoverProposalGraphActions: async () => ({ recovered: 0, pending: 0 }),
      detectLateAgentSemanticConflicts: async () => {} };
    if (name.endsWith('/health')) return { setCollaborationRuntimeHealth() {} };
    if (name.endsWith('/presence')) return { replaceDocumentPresence() {} };
    if (name.endsWith('/diagnostics')) return { logCollaborationDiagnostic() {} };
    if (name.endsWith('/server-runtime')) return { Y };
    if (name.endsWith('/state-proof') || name.endsWith('/failure')) return load(name);
    if (name.startsWith('@/')) return {};
    return load(name);
  }, { exports: server }, server);
  const httpServer = new EventEmitter();
  server.createCollaborationServer(httpServer as unknown as http.Server);
  const sockets: Connection<TestContext>[] = [];
  const request = new Request('http://localhost/ws/collaboration');
  const socket = (document: Document, id: string, readOnly = false) => {
    const websocket = { readyState: 1, send() {}, close() {} } as ConstructorParameters<typeof Connection>[0];
    const connection = new Connection(websocket, request, document, id, contextFor(document.name), readOnly);
    const hookMetadata = { instance, clientsCount: document.getConnectionsCount(), socketId: id,
      requestHeaders: request.headers, requestParameters: new URLSearchParams() };
    connection.beforeHandleMessage((_connection, update) => instance.hooks('beforeHandleMessage', {
      ...hookMetadata, update, connection, document, context: connection.context, documentName: document.name,
    }));
    connection.afterHandleMessage((_connection, update) => instance.hooks('afterHandleMessage', {
      ...hookMetadata, update, connection, document, context: connection.context, documentName: document.name,
    }));
    connection.beforeSync((_connection, payload) => instance.hooks('beforeSync', {
      ...hookMetadata, ...payload, connection, document, context: connection.context, documentName: document.name,
    }));
    sockets.push(connection);
    return connection;
  };
  const send = async (connection: Connection<TestContext>, bytes: Uint8Array) => {
    connection.handleMessage(bytes);
    await bounded(connection.waitForPendingMessages(), `socket ${connection.socketId}`);
  };
  const room = await instance.createDocument('doc', request, 'loader', { isAuthenticated: true, readOnly: false }, contextFor('doc'));
  const otherRoom = await instance.createDocument('other', request, 'other-loader', { isAuthenticated: true, readOnly: false }, contextFor('other'));
  const anchor = socket(room, 'anchor');
  const otherAnchor = socket(otherRoom, 'other-anchor');
  const makeAheadState = (document: Y.Doc, marker: string) => {
    const previous = states.get('doc')!;
    const persisted = new Y.Doc();
    try {
      Y.applyUpdate(persisted, previous.yjsState);
      persisted.getText('content').insert(persisted.getText('content').length, marker);
      Y.applyUpdate(persisted, Y.encodeStateAsUpdate(document));
      return {
        ...previous,
        stateVector: Y.encodeStateVector(persisted),
        yjsState: Y.encodeStateAsUpdate(persisted),
        documentSequence: previous.documentSequence + 1,
        persistedAt: Date.now(),
      };
    } finally {
      persisted.destroy();
    }
  };
  const getReconciliationObservation = () => {
    if (!reconciliationObservation) throw new Error('Expected persisted room reconciliation.');
    return reconciliationObservation;
  };
  try {
    // Direct receipt work holds the lease, even after Yjs has changed.
    const receipt = trackedGate(); const entered = trackedGate();
    const directRun = trackPending(direct(inputFor('doc'), (document) => {
      document.getText('content').insert(document.getText('content').length, 'D');
    }, async () => { entered.resolve(); await receipt.promise; }));
    await bounded(entered.promise, 'direct receipt gate');
    const first = socket(room, 'first'); const second = socket(room, 'second');
    const firstBytes = updateFrame('doc', appendUpdate(room, 'U'));
    const secondBytes = updateFrame('doc', appendUpdate(room, 'S'), messageYjsSyncStep2);
    first.handleMessage(firstBytes); second.handleMessage(secondBytes);
    await turn();
    assert.equal(room.getText('content').toString(), 'doc:D', 'two sockets wait while direct receipt is pending');
    const harmless = socket(room, 'harmless');
    const step1 = encoding.createEncoder();
    encoding.writeVarString(step1, 'doc');
    encoding.writeVarUint(step1, MessageType.Sync);
    encoding.writeVarUint(step1, messageYjsSyncStep1);
    encoding.writeVarUint8Array(step1, Y.encodeStateVector(room));
    await bounded(send(harmless, encoding.toUint8Array(step1)), 'SyncStep1 during direct receipt');
    await bounded(send(harmless, statelessFrame('doc')), 'stateless during direct receipt');
    const readonly = socket(room, 'readonly', true);
    readonly.context.claims.permission = 'read';
    await bounded(send(readonly, updateFrame('doc', appendUpdate(room, 'read-only-update'))), 'read-only Update during direct receipt');
    await bounded(send(readonly, updateFrame('doc', appendUpdate(room, 'read-only-step2'), messageYjsSyncStep2)),
      'read-only SyncStep2 during direct receipt');
    assert.equal(room.getText('content').toString(), 'doc:D', 'harmless frames did not apply queued edits');
    receipt.resolve();
    await bounded(Promise.all([directRun, first.waitForPendingMessages(), second.waitForPendingMessages()]), 'direct and two sockets');
    let expected = room.getText('content').toString();
    assert.equal(expected.startsWith('doc:D'), true);
    assert.equal([...expected.slice(5)].sort().join(''), 'SU');
    console.log('PASS direct receipt blocks writable edits while SyncStep1, stateless and read-only sync progress');

    // A receiver paused inside beforeSync owns the lease before direct revalidation.
    syncBarrier = { entered: trackedGate(), release: trackedGate() };
    const reverseBarrier = syncBarrier;
    const reverse = socket(room, 'reverse');
    reverse.handleMessage(updateFrame('doc', appendUpdate(room, 'R')));
    await bounded(reverseBarrier.entered.promise, 'beforeSync gate');
    let directApplied = false;
    directAcquireAttempt = trackedGate();
    const attempted = directAcquireAttempt;
    const waitingDirect = trackPending(direct(inputFor('doc'), (document) => {
      directApplied = true;
      document.getText('content').insert(document.getText('content').length, 'A');
    }));
    await bounded(attempted.promise, 'direct reached room acquire');
    await turn();
    assert.equal(directApplied, false);
    assert.equal(room.getText('content').toString(), expected);
    reverseBarrier.release.resolve();
    await bounded(Promise.all([reverse.waitForPendingMessages(), waitingDirect]), 'reverse lease');
    expected += 'RA';
    assert.equal(room.getText('content').toString(), expected);
    console.log('PASS inbound beforeSync blocks direct mutation until Yjs applies');

    rejectGuestUpdate = true;
    const rejected = socket(room, 'rejected-sync');
    rejected.context.claims.guestInvitationId = 'test-guest';
    rejected.handleMessage(updateFrame('doc', appendUpdate(room, 'X')));
    await bounded(rejected.waitForPendingMessages(), 'guest rejection releases lease');
    rejectGuestUpdate = false;
    const afterReject = trackPending(direct(inputFor('doc'), (document) => document.getText('content').insert(document.getText('content').length, 'B')));
    await bounded(afterReject, 'direct after rejected Sync');
    expected += 'B';
    assert.equal(room.getText('content').toString(), expected);
    console.log('PASS beforeSync rejection releases the lease');

    const hold = trackedRelease(await RoomMutation.acquireCollaborationRoomMutationLock(room));
    const unauthorized = socket(room, 'unauthorized');
    unauthorized.handleMessage(updateFrame('doc', appendUpdate(room, 'N')));
    const checksBeforeQueued = accessChecks;
    let unauthorizedFinished = false;
    void unauthorized.waitForPendingMessages().then(() => { unauthorizedFinished = true; });
    await turn();
    assert.equal(unauthorizedFinished, false);
    assert.equal(accessChecks, checksBeforeQueued + 1, 'only the initial authorization runs before the room lease');
    denied.add(unauthorized);
    hold();
    await bounded(unauthorized.waitForPendingMessages(), 'queued authorization rejection');
    assert.equal(room.getText('content').toString(), expected);
    await send(anchor, updateFrame('doc', appendUpdate(room, 'C')));
    expected += 'C';
    assert.equal(room.getText('content').toString(), expected);
    console.log('PASS queued authorization rejection cannot edit and releases the lease');

    // MessageReceiver itself rejects malformed Yjs; afterHandleMessage must still run.
    const malformed = socket(room, 'malformed');
    await send(malformed, updateFrame('doc', Uint8Array.of(255, 255)));
    await send(anchor, updateFrame('doc', appendUpdate(room, 'M')));
    expected += 'M';
    assert.equal(room.getText('content').toString(), expected);
    console.log('PASS malformed Sync payload releases the lease');

    const closedHold = trackedRelease(await RoomMutation.acquireCollaborationRoomMutationLock(room));
    const closed = socket(room, 'closed-while-queued');
    closed.handleMessage(updateFrame('doc', appendUpdate(room, 'Z')));
    const checksBeforeClose = accessChecks;
    let closedFinished = false;
    void closed.waitForPendingMessages().then(() => { closedFinished = true; });
    await turn();
    assert.equal(closedFinished, false);
    assert.equal(accessChecks, checksBeforeClose + 1, 'closed socket was queued before second access validation');
    closed.close();
    closedHold();
    await bounded(closed.waitForPendingMessages(), 'closed queued socket');
    assert.equal(room.getText('content').toString(), expected);
    await send(anchor, updateFrame('doc', appendUpdate(room, 'Q')));
    expected += 'Q';
    assert.equal(room.getText('content').toString(), expected);
    console.log('PASS closed queued socket cannot edit');

    // Persist returns a union containing a peer branch that is ahead of the
    // live room. Reconciliation must wait for the room lease and preserve the
    // room's local pending branch without scheduling another store.
    const reconcileHold = trackedRelease(await RoomMutation.acquireCollaborationRoomMutationLock(room));
    const beforeReconcile = room.getText('content').toString();
    const aheadState = makeAheadState(room, 'P');
    states.set('doc', aheadState);
    controlledPersistResults.push({ ...aheadState, persistenceDisposition: 'unchanged', incomingNeedsReconcile: true });
    storeBarrier = { entered: trackedGate(), release: trackedGate() };
    const reconcileStoreBarrier = storeBarrier;

    const broadcastGate = trackedGate();
    const originalBroadcastStateless = room.broadcastStateless;
    room.broadcastStateless = (payload, filter) => {
      let parsed: { type?: string; documentSequence?: number } = {};
      try { parsed = JSON.parse(payload) as typeof parsed; } catch { /* Other stateless payloads are ignored. */ }
      if (parsed.type === 'durability_snapshot' && parsed.documentSequence === aheadState.documentSequence) {
        assert.equal(room.getText('content').toString().includes('P'), true,
          'the durability notification follows the persisted update applied to the room');
        assert.equal(room.getText('content').toString().includes('L'), true,
          'reconciliation preserves the room-local pending edit');
        broadcastGate.resolve();
      }
      originalBroadcastStateless.call(room, payload, filter);
    };
    const storesBeforeReconcile = stores;
    const historyBeforeReconcile = historyCaptures.length;
    const storeResult = trackPending(instance.storeDocumentHooks(room, { document: room, documentName: 'doc',
      lastContext: anchor.context, lastTransactionOrigin: { source: 'connection', connection: anchor },
      clientsCount: room.getConnectionsCount(), instance }, true));
    await bounded(reconcileStoreBarrier.entered.promise, 'controlled persistence before concurrent local edit');
    room.transact(() => room.getText('content').insert(room.getText('content').length, 'L'), {
      source: 'local', skipStoreHooks: true,
    });
    const liveBeforeReconcile = room.getText('content').toString();
    assert.equal(liveBeforeReconcile, `${beforeReconcile}L`);
    reconcileStoreBarrier.release.resolve();
    await bounded(storeResult, 'onStoreDocument queues room reconciliation without awaiting it');
    assert.equal(room.getText('content').toString(), liveBeforeReconcile,
      'the live room stays unchanged by PG reconciliation while its mutation lease is held');
    assert.equal(room.getText('content').toString().includes('P'), false);
    assert.equal(stores, storesBeforeReconcile + 1);
    assert.equal(historyCaptures.length, historyBeforeReconcile,
      'an unchanged persistence reply does not claim authored history for the prior PG commit');
    const manualReconciliation = getReconciliationObservation();

    reconcileHold();
    await bounded(Promise.all([manualReconciliation.entered.promise,
      manualReconciliation.completed.promise, broadcastGate.promise]), 'persisted room reconciliation');
    const afterReconcile = room.getText('content').toString();
    assert.equal(afterReconcile.includes('P'), true);
    assert.equal(afterReconcile.includes('L'), true);
    assert.equal(stores, storesBeforeReconcile + 1, 'reconciliation does not schedule another store');
    assert.equal(states.get('doc')!.documentSequence, aheadState.documentSequence,
      'reconciliation does not mint another persistence sequence');
    expected = afterReconcile;
    room.broadcastStateless = originalBroadcastStateless;
    reconciliationObservation = null;
    console.log('PASS persisted room reconciliation waits for the lease, preserves local edits, and broadcasts after apply');

    const replacedRoomHold = trackedRelease(await RoomMutation.acquireCollaborationRoomMutationLock(room));
    const replacedAheadState = makeAheadState(room, 'STALE');
    states.set('doc', replacedAheadState);
    controlledPersistResults.push({ ...replacedAheadState, persistenceDisposition: 'merged', incomingNeedsReconcile: true });
    const replacementRoom = new Y.Doc();
    const originalDocumentMapValue = instance.documents.get('doc');
    let replacedRoomBroadcast = false;
    const preReplacementBroadcast = room.broadcastStateless;
    room.broadcastStateless = (payload, filter) => {
      let parsed: { type?: string; documentSequence?: number } = {};
      try { parsed = JSON.parse(payload) as typeof parsed; } catch { /* Other stateless payloads are ignored. */ }
      if (parsed.type === 'durability_snapshot' && parsed.documentSequence === replacedAheadState.documentSequence) {
        replacedRoomBroadcast = true;
      }
      preReplacementBroadcast.call(room, payload, filter);
    };
    const replacedStore = trackPending(instance.storeDocumentHooks(room, { document: room, documentName: 'doc',
      lastContext: anchor.context, lastTransactionOrigin: { source: 'connection', connection: anchor },
      clientsCount: room.getConnectionsCount(), instance }, true));
    await bounded(replacedStore, 'replacement guard store hook');
    try {
      instance.documents.set('doc', replacementRoom as Document);
      const replacementObservation = getReconciliationObservation();
      replacedRoomHold();
      await bounded(Promise.all([replacementObservation.entered.promise, replacementObservation.completed.promise]),
        'replaced room reconciliation guard');
      assert.equal(room.getText('content').toString().includes('STALE'), false,
        'reconciliation never applies persisted bytes to the replaced room');
      assert.equal(replacedRoomBroadcast, false, 'a replaced room receives no stale durability broadcast');
    } finally {
      if (originalDocumentMapValue) instance.documents.set('doc', originalDocumentMapValue);
      room.broadcastStateless = preReplacementBroadcast;
      replacementRoom.destroy();
      reconciliationObservation = null;
    }
    console.log('PASS reconciliation skips a room replaced before the queued lease runs');

    const unrelatedHold = trackedRelease(await RoomMutation.acquireCollaborationRoomMutationLock(room));
    try {
      await bounded(send(otherAnchor, updateFrame('other', appendUpdate(otherRoom, 'W'))), 'unrelated room message');
      assert.equal(otherRoom.getText('content').toString(), 'other:W');
    } finally { unrelatedHold(); }
    console.log('PASS unrelated rooms mutate independently');

    // An earlier store owns saveMutex. Direct disconnect must wait for it without
    // onStoreDocument trying to reacquire the room lock held by direct.
    storeBarrier = { entered: trackedGate(), release: trackedGate() };
    const previousStore = storeBarrier;
    const preceding = trackPending(instance.storeDocumentHooks(room, { document: room, documentName: 'doc',
      lastContext: anchor.context, lastTransactionOrigin: { source: 'connection', connection: anchor },
      clientsCount: room.getConnectionsCount(), instance }, true));
    await bounded(previousStore.entered.promise, 'preceding store');
    const finalApplied = trackedGate();
    const finalDirect = trackPending(direct(inputFor('doc'), (document) => {
      document.getText('content').insert(document.getText('content').length, 'F');
      finalApplied.resolve();
    }));
    await bounded(finalApplied.promise, 'direct mutation while store owns saveMutex');
    expected += 'F';
    assert.equal(room.getText('content').toString(), expected);

    // Make the earlier store's returned row a durable union ahead of the live
    // room. onStoreDocument must finish while direct disconnect still owns the
    // room lease, then reconciliation can run after saveMutex and the lease.
    const directAheadState = makeAheadState(room, 'G');
    states.set('doc', directAheadState);
    controlledPersistResults.push(
      { ...directAheadState, persistenceDisposition: 'merged', incomingNeedsReconcile: true },
      { ...directAheadState, persistenceDisposition: 'merged', incomingNeedsReconcile: true },
    );
    const directReconcileBroadcast = trackedGate();
    const directBroadcast = room.broadcastStateless;
    room.broadcastStateless = (payload, filter) => {
      let parsed: { type?: string; documentSequence?: number } = {};
      try { parsed = JSON.parse(payload) as typeof parsed; } catch { /* Other stateless payloads are ignored. */ }
      if (parsed.type === 'durability_snapshot' && parsed.documentSequence === directAheadState.documentSequence) {
        assert.equal(room.getText('content').toString().includes('G'), true,
          'the saveMutex reconciliation applies the PG-ahead branch before acknowledgement');
        directReconcileBroadcast.resolve();
      }
      directBroadcast.call(room, payload, filter);
    };
    previousStore.release.resolve();
    await bounded(Promise.all([preceding, finalDirect]), 'saveMutex and direct disconnect');
    const disconnectReconciliation = getReconciliationObservation();
    await bounded(Promise.all([disconnectReconciliation.entered.promise,
      disconnectReconciliation.completed.promise, directReconcileBroadcast.promise]),
      'direct disconnect reconciliation after saveMutex');
    assert.equal(room.getText('content').toString().includes('G'), true);
    assert.equal(states.get('doc')!.documentSequence, directAheadState.documentSequence,
      'the reconciliation itself does not advance the stored sequence');
    room.broadcastStateless = directBroadcast;
    reconciliationObservation = null;
    assert.equal(states.get('doc')!.documentSequence > 1, true);
    assert.equal(Y.encodeStateAsUpdate(room).length > 0, true);
    assert.equal(stores > 0, true);
    assert.equal(accessChecks > 0, true);
    assert.equal(historyCaptures.some((capture) => capture.source === 'automatic_checkpoint'
      && capture.actorUserId === null && capture.actorType === 'system'), true,
    'merged reconciliation history is attributed to the system');
    assert.equal(historyCaptures.some((capture) => capture.actorType === 'agent'
      && capture.actorUserId === 'user'), true,
    'ordinary direct-agent persistence keeps its existing author attribution');
    console.log('PASS preceding saveMutex store and direct disconnect reconcile without deadlock');

    const capturesBeforeMcp = historyCaptures.length;
    const storesBeforeMcp = stores;
    await bounded(direct({ ...inputFor('doc'), mcpAuthority,
      mcpPolicyFence: async () => undefined }, (document) => {
      document.getText('content').insert(document.getText('content').length, 'MCP');
    }), 'OAuth MCP direct operation');
    assert.equal(stores, storesBeforeMcp + 1, 'the MCP edit persisted through the actual room-store hook');
    assert.equal(historyCaptures.length, capturesBeforeMcp,
      'the actual room-store hook leaves exact MCP operation history to its operation receipt');
    assert.equal(room.getText('content').toString().endsWith('MCP'), true);
    const reconciledState = states.get('doc')!;
    controlledPersistResults.push({ ...reconciledState,
      persistenceDisposition: 'merged', incomingNeedsReconcile: true });
    const capturesBeforeMcpReconcile = historyCaptures.length;
    const mcpContext = { ...contextFor('doc'), actorType: 'agent' as const,
      versionSource: 'agent_apply' as const, versionBaseRevisionId: null,
      versionSourceSessionId: null, agentTurnId: undefined,
      exactOperationHistoryOwned: true, initiatedByUserId: 'user', operationId: 'operation-doc' };
    await bounded(instance.storeDocumentHooks(room, { document: room, documentName: 'doc',
      lastContext: mcpContext, lastTransactionOrigin: { source: 'connection', connection: anchor },
      clientsCount: room.getConnectionsCount(), instance }, true), 'MCP reconciled room store');
    assert.equal(historyCaptures.length, capturesBeforeMcpReconcile + 1);
    assert.equal(historyCaptures.at(-1)?.source, 'automatic_checkpoint',
      'a reconciled union retains its system-owned history despite the MCP exact-operation marker');
    const mcpReconciliation = getReconciliationObservation();
    await bounded(Promise.all([mcpReconciliation.entered.promise, mcpReconciliation.completed.promise]),
      'MCP room reconciliation');
    reconciliationObservation = null;

    // The real Hocuspocus store may own saveMutex while onApplied is still
    // committing the immutable operation bytes. It must await that proof, not
    // claim a second version from the same persisted room update.
    operationHistoryRow = { status: 'applying', has_state_snapshot: false,
      has_version_snapshot: false, result_json: '{}' };
    const callbackEntered = trackedGate();
    const callbackRelease = trackedGate();
    const capturesBeforeStandalone = historyCaptures.length;
    const standalone = trackPending(direct(inputFor('doc'), (document) => {
      document.getText('content').insert(document.getText('content').length, 'PI');
      return { appliedTargetIds: ['standalone-target'] };
    }, async () => {
      callbackEntered.resolve();
      await callbackRelease.promise;
      operationHistoryRow = { status: 'applied_to_ydoc', has_state_snapshot: true,
        has_version_snapshot: true, result_json: JSON.stringify({ appliedTargetIds: ['standalone-target'] }) };
    }));
    await bounded(callbackEntered.promise, 'standalone SQL callback entered');
    const storesBeforeStandalone = stores;
    let standaloneStoreFinished = false;
    const standaloneStore = trackPending(instance.storeDocumentHooks(room, {
      document: room, documentName: 'doc', lastContext: directHistoryContext,
      lastTransactionOrigin: null, clientsCount: room.getConnectionsCount(), instance,
    }, true).then(() => { standaloneStoreFinished = true; }));
    await turn();
    assert.equal(stores, storesBeforeStandalone + 1, 'the scheduled store persists while SQL proof is pending');
    assert.equal(standaloneStoreFinished, false, 'history capture waits for the committed operation proof');
    assert.equal(historyCaptures.length, capturesBeforeStandalone);
    callbackRelease.resolve();
    await bounded(Promise.all([standalone, standaloneStore]), 'standalone proof and saveMutex drain');
    assert.equal(historyCaptures.length, capturesBeforeStandalone,
      'the exact standalone operation owns its version after its snapshot commits');
    assert.equal(room.getText('content').toString().endsWith('PI'), true);
    console.log('PASS standalone operation waits for committed snapshot proof without duplicate history');

    operationHistoryRow = { status: 'applying', has_state_snapshot: false,
      has_version_snapshot: false, result_json: '{}' };
    const failedCallbackEntered = trackedGate();
    const failedCallbackRelease = trackedGate();
    const capturesBeforeFailedCallback = historyCaptures.length;
    const callbackFailure = new Error('Deliberate immutable operation SQL failure');
    const failedStandalone = trackPending(direct(inputFor('doc'), (document) => {
      document.getText('content').insert(document.getText('content').length, 'FALLBACK');
      return { appliedTargetIds: ['failed-target'] };
    }, async () => {
      failedCallbackEntered.resolve();
      await failedCallbackRelease.promise;
      throw callbackFailure;
    }));
    await bounded(failedCallbackEntered.promise, 'failed standalone SQL callback entered');
    let failedStoreFinished = false;
    const failedStore = trackPending(instance.storeDocumentHooks(room, {
      document: room, documentName: 'doc', lastContext: directHistoryContext,
      lastTransactionOrigin: null, clientsCount: room.getConnectionsCount(), instance,
    }, true).then(() => { failedStoreFinished = true; }));
    await turn();
    assert.equal(failedStoreFinished, false);
    failedCallbackRelease.resolve();
    await bounded(Promise.all([assert.rejects(failedStandalone, error => error === callbackFailure), failedStore]),
      'failed callback releases history proof before disconnect waits for saveMutex');
    assert.ok(historyCaptures.length > capturesBeforeFailedCallback,
      'missing committed operation bytes retain the ordinary history fallback');
    assert.equal(historyCaptures.at(-1)?.actorType, 'agent');
    operationHistoryRow = undefined;
    console.log('PASS failed standalone callback retains history and releases saveMutex without deadlock');

    const capturesBeforeNoSnapshot = historyCaptures.length;
    operationHistoryRow = { status: 'applying', has_state_snapshot: false,
      has_version_snapshot: false, result_json: '{}' };
    await bounded(direct(inputFor('doc'), (document) => {
      document.getText('content').insert(document.getText('content').length, 'UNPROVEN');
      return { appliedTargetIds: [] };
    }, async () => {
      operationHistoryRow = { status: 'applied_to_ydoc', has_state_snapshot: true,
        has_version_snapshot: false, result_json: '{}' };
    }), 'zero-effect standalone ownership fallback');
    assert.ok(historyCaptures.length > capturesBeforeNoSnapshot,
      'zero-effect or unavailable immutable bytes never suppress ordinary history');
    operationHistoryRow = undefined;
    console.log('PASS unproven standalone ownership retains ordinary history');

    const readsBeforeScoped = ordinaryStateReads;
    const scopedState = async (documentId: string) => { assert.equal(documentId, 'doc'); return states.get('doc')!; };
    assert.equal(await documentReader('doc', workspace.workspaceId, (doc) => doc.getText('content').toString(), scopedState),
      room.getText('content').toString(), 'scoped server reads retain the live room rather than a persisted substitute');
    for (const invalid of [{ ...states.get('doc')!, documentId: 'other' },
      { ...states.get('doc')!, workspaceId: 'other' }, { ...states.get('doc')!, status: 'archived' as const },
      { ...states.get('doc')!, lifecycleGeneration: 2 }]) {
      await assert.rejects(documentReader('doc', workspace.workspaceId, () => assert.fail('Invalid live scope exposed'),
        async () => invalid));
    }
    const fallbackState = { ...states.get('other')!, documentId: 'reader-only', path: 'reader-only.txt' };
    assert.equal(await documentReader('reader-only', workspace.workspaceId, (doc) => doc.getText('content').toString(),
      async () => fallbackState), 'other:', 'a roomless read uses the supplied persisted snapshot, not another live room');
    assert.equal(ordinaryStateReads, readsBeforeScoped, 'scoped server readers never borrow the default state connection');
    assert.equal(await documentReader('doc', workspace.workspaceId, (doc) => doc.getText('content').toString()),
      room.getText('content').toString());
    assert.equal(ordinaryStateReads, readsBeforeScoped + 1, 'ordinary server reader preserves its default lookup');
    console.log('PASS scoped server reads preserve live/fallback identity checks without another state connection');
  } finally {
    for (const release of cleanupReleases.reverse()) release();
    await bounded(Promise.allSettled([
      ...pendingOperations,
      ...sockets.map((connection) => connection.waitForPendingMessages()),
    ]), 'drain test operations').catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
    for (const connection of sockets) connection.close();
    httpServer.emit('close');
    for (const document of instance.documents.values()) {
      await instance.debouncer.executeNow(`onStoreDocument-${document.name}`);
      document.destroy();
    }
    instance.documents.clear();
    for (const seed of seedDocuments.values()) seed.destroy();
    if (originalData === undefined) delete process.env.DATA; else process.env.DATA = originalData;
    if (originalRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = originalRoot;
    await fs.rm(data, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
