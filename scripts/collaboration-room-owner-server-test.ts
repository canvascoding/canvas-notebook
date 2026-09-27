import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { Connection, Hocuspocus, MessageType, type Document } from '@hocuspocus/server';
import * as encoding from 'lib0/encoding';
import { messageYjsUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';

import type * as Direct from '../app/lib/collaboration/direct-connection';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type {
  CollaborationRoomOwnerFence,
  CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';
import * as RoomMutation from '../app/lib/collaboration/room-mutation-lock';
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type * as Server from '../server/collaboration-server';

const pendingGateReleases: Array<() => void> = [];
let emergencyCleanup = async () => {};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  let settled = false;
  const resolve = () => {
    if (settled) return;
    settled = true;
    release();
  };
  pendingGateReleases.push(resolve);
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
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
  versionSource: 'automatic_checkpoint';
  versionBaseRevisionId: null;
  versionSourceSessionId: null;
  initiatedByUserId: null;
  operationId: null;
  observedDocumentSequence: null;
  releaseRoomAdmission: null;
};

type OwnerSession = {
  acquire(scope: CollaborationRoomOwnerScope): Promise<CollaborationRoomOwnerFence>;
  release(fence: CollaborationRoomOwnerFence): Promise<void>;
  assertActive(fence: CollaborationRoomOwnerFence): void;
  probe(): Promise<void>;
  close(): Promise<void>;
};

type Reader = <T>(documentId: string, workspaceId: string, read: (document: Y.Doc) => T) => Promise<T>;

class CollaborationRoomOwnerError extends Error {
  constructor(readonly code: 'ROOM_OWNER_BUSY' | 'ROOM_OWNER_LOST' | 'ROOM_OWNER_SCOPE_CHANGED' | 'ROOM_OWNER_UNAVAILABLE') {
    super(code);
    this.name = 'CollaborationRoomOwnerError';
  }
}

class AgentDirectConnectionAuthorizationError extends Error {}

function updateFrame(documentName: string, update: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, MessageType.Sync);
  encoding.writeVarUint(encoder, messageYjsUpdate);
  encoding.writeVarUint8Array(encoder, update);
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

function makeState(documentId: string, text: string): PersistedCollaborationState {
  const document = new Y.Doc();
  try {
    document.getText('content').insert(0, text);
    return {
      documentId,
      workspaceId: 'owner-workspace',
      organizationId: null,
      path: `${documentId}.txt`,
      lifecycleGeneration: 1,
      representation: 'plain_text',
      documentSequence: 1,
      checkpointSequence: 1,
      stateVector: Y.encodeStateVector(document),
      yjsState: Y.encodeStateAsUpdate(document),
      status: 'active',
      schemaVersion: 1,
      persistedAt: 1,
      checkpointedAt: 1,
      canonicalHash: null,
      serializedHash: null,
      newlineStyle: 'lf',
      hasBom: false,
      degraded: false,
    };
  } finally {
    document.destroy();
  }
}

async function main(mode: 'direct-store-failure' | 'queued-peer-loss') {
  const workspace = {
    workspaceId: 'owner-workspace',
    organizationId: null,
    workspaceType: 'personal',
  } as WorkspaceContext;
  const states = new Map<string, PersistedCollaborationState>([
    ['doc', makeState('doc', 'stale')],
    ['cancel', makeState('cancel', 'cancel')],
    ['load-failure', makeState('load-failure', 'failure')],
  ]);
  const freshDocState = makeState('doc', 'fresh');
  const events: string[] = [];
  const fences = new Map<string, CollaborationRoomOwnerFence>();
  const released: CollaborationRoomOwnerFence[] = [];
  let sessionActive = true;
  let sessionClosed = false;
  let epoch = 0;
  let instance!: Hocuspocus<TestContext>;
  let direct!: Parameters<typeof Direct.installCollaborationDirectConnection>[0];
  let documentReader!: Reader;
  let unloadBarrier: { documentId: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let accessBarrier: { check: number; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let accessChecks = 0;
  let markDegradedCalls = 0;
  let semanticConflictDetections = 0;
  const persistCalls: Array<{ documentId: string; fence: CollaborationRoomOwnerFence | undefined }> = [];
  let controlledPersist: PersistedCollaborationState | null = null;
  let persistFailure: Error | null = null;
  const captureInstance = (value: Hocuspocus<TestContext>) => { instance = value; };

  const ownerSession: OwnerSession = {
    async acquire(scope) {
      assert.equal(sessionActive, true);
      events.push(`acquire:${scope.documentId}`);
      const fence = Object.freeze({
        scope: Object.freeze({ ...scope }),
        epoch: ++epoch,
        token: `token-${scope.documentId}-${epoch}`,
        backendPid: 9000 + epoch,
        backendStart: `start-${epoch}`,
      });
      fences.set(scope.documentId, fence);
      if (scope.documentId === 'doc') states.set('doc', freshDocState);
      if (scope.documentId === 'load-failure') states.delete('load-failure');
      return fence;
    },
    async release(fence) {
      events.push(`release:${fence.scope.documentId}`);
      assert.equal(fences.get(fence.scope.documentId), fence);
      fences.delete(fence.scope.documentId);
      released.push(fence);
    },
    assertActive(fence) {
      events.push(`active:${fence.scope.documentId}`);
      if (!sessionActive || fences.get(fence.scope.documentId) !== fence) {
        throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
      }
    },
    async probe() {
      if (!sessionActive) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
    },
    async close() {
      if (sessionClosed) return;
      sessionClosed = true;
      sessionActive = false;
      fences.clear();
    },
  };

  class ObservedHocuspocus extends Hocuspocus<TestContext> {
    constructor(options: ConstructorParameters<typeof Hocuspocus<TestContext>>[0]) {
      super({
        ...options,
        async beforeUnloadDocument(payload) {
          await options?.beforeUnloadDocument?.(payload);
          const barrier = unloadBarrier;
          if (barrier?.documentId === payload.documentName) {
            unloadBarrier = null;
            barrier.entered.resolve();
            await barrier.release.promise;
          }
        },
      });
      captureInstance(this);
    }
  }

  const filename = path.resolve('server/collaboration-server.ts');
  const load = createRequire(filename);
  const runtimeFilename = path.resolve('app/lib/collaboration/room-owner-runtime.ts');
  const compiledRuntime = ts.transpileModule(await fs.readFile(runtimeFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const roomOwnerRuntime = {} as typeof import('../app/lib/collaboration/room-owner-runtime');
  new Function('require', 'module', 'exports', compiledRuntime.outputText)((name: string) => {
    if (name === 'server-only') return {};
    if (name === './room-owner') return { CollaborationRoomOwnerError };
    return createRequire(runtimeFilename)(name);
  }, { exports: roomOwnerRuntime }, roomOwnerRuntime);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const server = {} as typeof Server;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@hocuspocus/server') return { Hocuspocus: ObservedHocuspocus };
    if (name === 'ws') return { WebSocketServer: class extends EventEmitter {} };
    if (name.endsWith('/room-owner-runtime')) return roomOwnerRuntime;
    if (name.endsWith('/room-owner')) return { CollaborationRoomOwnerError };
    if (name.endsWith('/persistence')) return {
      CollaborationStateStaleError: class extends Error {},
      CollaborationStateInactiveError: class extends Error {},
      loadCollaborationState: async (documentId: string) => {
        events.push(`load:${documentId}`);
        return states.get(documentId) ?? null;
      },
      persistCollaborationYDoc: async (
        documentId: string,
        _generation: number,
        document: Y.Doc,
        _identity: unknown,
        fence?: CollaborationRoomOwnerFence,
      ) => {
        persistCalls.push({ documentId, fence });
        if (persistFailure) {
          const error = persistFailure;
          persistFailure = null;
          throw error;
        }
        const controlled = controlledPersist;
        controlledPersist = null;
        if (controlled) {
          states.set(documentId, controlled);
          return { ...controlled, persistenceDisposition: 'merged', incomingNeedsReconcile: true };
        }
        const previous = states.get(documentId)!;
        const next = {
          ...previous,
          stateVector: Y.encodeStateVector(document),
          yjsState: Y.encodeStateAsUpdate(document),
          documentSequence: previous.documentSequence + 1,
          persistedAt: Date.now(),
        };
        states.set(documentId, next);
        return { ...next, persistenceDisposition: 'advanced', incomingNeedsReconcile: false };
      },
      markCollaborationDegraded: async () => { markDegradedCalls++; },
    };
    if (name.endsWith('/direct-connection')) return {
      AgentDirectConnectionAuthorizationError,
      installCollaborationDirectConnection: (handler: typeof direct) => { direct = handler; },
    };
    if (name.endsWith('/document-access')) return {
      installCollaborationDocumentReader: (reader: Reader) => { documentReader = reader; },
    };
    if (name.endsWith('/runtime-state')) return {
      installCollaborationRoomInspector() {},
      reserveCollaborationRoomAdmission: () => () => {},
      withCollaborationRoomLifecycleLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    };
    if (name.endsWith('/room-mutation-lock')) return RoomMutation;
    if (name.endsWith('/workspace-mutation-lock')) return {
      withWorkspaceMutationLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    };
    if (name.endsWith('/session-workspace-context')) return {
      resolveAgentExecutionContextForStoredSession: async () => workspace,
      workspaceFromAgentExecutionContext: (value: WorkspaceContext) => value,
    };
    if (name.endsWith('/collaboration-policy')) return { readFileCollaborationState: async () => null };
    if (name.endsWith('/projection-runtime')) return {
      createCollaborationProjectionRuntime: () => ({ enqueue() {}, dispose() {} }),
    };
    if (name.endsWith('/history-service')) return {
      fileVersionHistoryService: { capturePersistedCollaboration: async () => {} },
    };
    if (name.endsWith('/access-monitor')) return {
      createCollaborationAccessMonitor: () => ({
        dispose() {}, add: () => () => {},
        async check() {
          const current = ++accessChecks;
          events.push(`access-start:${current}`);
          const barrier = accessBarrier;
          if (barrier?.check === current) {
            barrier.entered.resolve();
            await barrier.release.promise;
          }
          events.push(`access-end:${current}`);
        },
      }),
    };
    if (name.endsWith('/agent-operations')) return {
      recoverCollaborationAgentOperations: async () => {},
      recoverProposalGraphActions: async () => ({ recovered: 0, pending: 0 }),
      detectLateAgentSemanticConflicts: async (input: { assertRoomActive?: () => void }) => {
        input.assertRoomActive?.();
        semanticConflictDetections++;
      },
    };
    if (name.endsWith('/health')) return { setCollaborationRuntimeHealth() {} };
    if (name.endsWith('/presence')) return { replaceDocumentPresence() {} };
    if (name.endsWith('/diagnostics')) return { logCollaborationDiagnostic() {} };
    if (name.endsWith('/server-runtime')) return { Y };
    if (name.endsWith('/state-proof') || name.endsWith('/failure')) return load(name);
    if (name.startsWith('@/')) return {};
    return load(name);
  }, { exports: server }, server);

  const httpServer = new EventEmitter();
  server.createCollaborationServer(httpServer as unknown as http.Server, {
    roomOwner: {
      createSession: async (onInvalidated) => {
        void onInvalidated;
        return ownerSession as never;
      },
      heartbeatMs: 60_000,
    },
  });
  const request = new Request('http://localhost/ws/collaboration');
  const claimsFor = (documentId: string): CollaborationTicketClaims => {
    const state = states.get(documentId) ?? makeState(documentId, 'missing');
    return {
      schemaVersion: state.schemaVersion,
      issuedAt: 0,
      expiresAt: Date.now() + 60_000,
      userId: 'user',
      sessionId: `session-${documentId}`,
      documentId,
      workspaceId: workspace.workspaceId,
      organizationId: null,
      path: `${documentId}.txt`,
      provider: 'yjs',
      representation: 'plain_text',
      permission: 'write',
      lifecycleGeneration: 1,
    };
  };
  const contextFor = (documentId: string): TestContext => ({
    claims: claimsFor(documentId),
    workspace,
    user: { id: 'user', name: 'User', email: null },
    actorType: 'user',
    versionSource: 'automatic_checkpoint',
    versionBaseRevisionId: null,
    versionSourceSessionId: null,
    initiatedByUserId: null,
    operationId: null,
    observedDocumentSequence: null,
    releaseRoomAdmission: null,
  });
  const sockets: Connection<TestContext>[] = [];
  const socket = (document: Document, id: string, context = contextFor(document.name)) => {
    const sent: Uint8Array[] = [];
    const websocket = { readyState: 1, send: (bytes: Uint8Array) => sent.push(bytes), close() {} };
    const connection = new Connection(websocket, request, document, id, context, false);
    const hookMetadata = {
      instance,
      clientsCount: document.getConnectionsCount(),
      socketId: id,
      requestHeaders: request.headers,
      requestParameters: new URLSearchParams(),
    };
    connection.beforeHandleMessage((_connection, update) => instance.hooks('beforeHandleMessage', {
      ...hookMetadata, update, connection, document, context, documentName: document.name,
    }));
    connection.afterHandleMessage((_connection, update) => instance.hooks('afterHandleMessage', {
      ...hookMetadata, update, connection, document, context, documentName: document.name,
    }));
    connection.beforeSync((_connection, payload) => instance.hooks('beforeSync', {
      ...hookMetadata, ...payload, connection, document, context, documentName: document.name,
    }));
    sockets.push(connection);
    return { connection, sent };
  };
  const storePayload = (document: Document, context: TestContext) => ({
    instance,
    clientsCount: document.getConnectionsCount(),
    document,
    documentName: document.name,
    lastContext: context,
    lastTransactionOrigin: { source: 'local' as const, context },
  });
  let cleaned = false;
  emergencyCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const release of pendingGateReleases) release();
    for (const connection of sockets) connection.close();
    await turn();
    for (const document of [...instance.documents.values()]) {
      await instance.unloadDocument(document).catch(() => undefined);
    }
    httpServer.emit('close');
    for (const document of instance.documents.values()) document.destroy();
    instance.documents.clear();
    await turn();
  };

  const doc = await instance.createDocument('doc', request, 'loader', {
    isAuthenticated: true,
    readOnly: false,
  }, contextFor('doc'));
  assert.equal(doc.getText('content').toString(), 'fresh');
  const acquireIndex = events.indexOf('acquire:doc');
  const freshLoadIndex = events.indexOf('load:doc', acquireIndex + 1);
  assert.equal(acquireIndex > events.indexOf('load:doc'), true);
  assert.equal(freshLoadIndex > acquireIndex, true);
  const docFence = fences.get('doc')!;
  assert.equal(Object.isFrozen(docFence.scope), true);
  console.log('PASS owner claim precedes a fresh persisted-state reread');

  const peer = socket(doc, 'peer');
  const accessGate = { check: accessChecks + 2, entered: gate(), release: gate() };
  accessBarrier = accessGate;
  const beforeSyncEvents = events.length;
  peer.connection.handleMessage(updateFrame('doc', appendUpdate(doc, '!')));
  await bounded(accessGate.entered.promise, 'beforeSync access gate');
  try {
    assert.equal(doc.getText('content').toString(), 'fresh');
  } finally {
    accessGate.release.resolve();
  }
  await bounded(peer.connection.waitForPendingMessages(), 'owner-fenced receiver');
  assert.equal(doc.getText('content').toString(), 'fresh!');
  const gatedEvents = events.slice(beforeSyncEvents);
  const accessEnd = gatedEvents.indexOf(`access-end:${accessGate.check}`);
  assert.equal(accessEnd >= 0, true);
  assert.equal(gatedEvents.slice(accessEnd + 1).includes('active:doc'), true,
    'owner activity is checked again after awaited access validation');
  console.log('PASS actual message receiver rechecks ownership after awaited access validation');

  const readerEvents = events.length;
  assert.equal(await documentReader('doc', workspace.workspaceId, (document) => document.getText('content').toString()), 'fresh!');
  assert.equal(events.slice(readerEvents).includes('active:doc'), true);
  let directApplied = false;
  const directEvents = events.length;
  await direct({
    documentId: 'doc',
    documentPath: 'doc.txt',
    documentRepresentation: 'plain_text',
    documentLifecycleGeneration: 1,
    documentSchemaVersion: 1,
    requiresFileCheckpointIdentity: false,
    workspace,
    actorType: 'user',
    actorId: 'user',
    actorDisplayName: 'User',
    initiatedByUserId: 'user',
    operationId: 'direct-owner-test',
  }, (document) => {
    assert.equal(events.slice(directEvents).includes('active:doc'), true,
      'direct mutation checks the owner before apply');
    directApplied = true;
    document.getText('content').insert(document.getText('content').length, 'D');
  });
  assert.equal(directApplied, true);
  assert.equal(persistCalls.at(-1)?.fence, docFence);
  console.log('PASS document reader, direct apply, and persistence use the exact active fence');

  await assert.rejects(
    instance.createDocument('load-failure', request, 'failed-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor('load-failure')),
    (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED',
  );
  assert.equal(released.some((fence) => fence.scope.documentId === 'load-failure'), true);
  assert.equal(instance.documents.has('load-failure'), false);
  console.log('PASS load failure after claim releases the exact owner proof');

  const cancelRoom = await instance.createDocument('cancel', request, 'cancel-loader', {
    isAuthenticated: true,
    readOnly: false,
  }, contextFor('cancel'));
  const cancelFence = fences.get('cancel')!;
  const cancelUnloadBarrier = { documentId: 'cancel', entered: gate(), release: gate() };
  unloadBarrier = cancelUnloadBarrier;
  const cancelledUnload = instance.unloadDocument(cancelRoom);
  await bounded(cancelUnloadBarrier.entered.promise, 'beforeUnload cancellation gate');
  let cancellationPeer!: ReturnType<typeof socket>;
  try {
    cancellationPeer = socket(cancelRoom, 'cancel-peer');
  } finally {
    cancelUnloadBarrier.release.resolve();
  }
  await bounded(cancelledUnload, 'cancelled unload');
  assert.equal(instance.documents.get('cancel'), cancelRoom);
  assert.equal(released.includes(cancelFence), false);
  await bounded(instance.storeDocumentHooks(cancelRoom, storePayload(cancelRoom, cancellationPeer.connection.context), true),
    'final owned store');
  assert.equal(persistCalls.at(-1)?.fence, cancelFence);
  cancellationPeer.connection.close();
  await bounded(instance.unloadDocument(cancelRoom), 'final owned unload');
  assert.equal(instance.documents.has('cancel'), false);
  assert.equal(cancelRoom.isDestroyed, true);
  assert.equal(released.includes(cancelFence), true);
  console.log('PASS a new connection cancels real unload; final store and destroy release the exact proof');

  if (mode === 'direct-store-failure') {
    const storedBeforeFailure = states.get('doc')!;
    const storedDocument = new Y.Doc();
    try {
      Y.applyUpdate(storedDocument, storedBeforeFailure.yjsState);
      assert.equal(storedDocument.getText('content').toString().includes('F'), false);
    } finally {
      storedDocument.destroy();
    }
    const broadcasts: string[] = [];
    const originalBroadcast = doc.broadcastStateless;
    doc.broadcastStateless = (payload, filter) => {
      broadcasts.push(payload);
      originalBroadcast.call(doc, payload, filter);
    };
    const markBeforeFailure = markDegradedCalls;
    const persistBeforeFailure = persistCalls.length;
    persistFailure = new Error('deliberate direct final-store failure');
    let callbackApplied = false;
    await assert.rejects(direct({
      documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'direct-final-store-failure',
    }, (document) => {
      callbackApplied = true;
      document.getText('content').insert(document.getText('content').length, 'F');
    }), (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
    assert.equal(callbackApplied, true, 'the direct callback mutates before its final store fails');
    assert.equal(doc.getText('content').toString().includes('F'), true,
      'unpersisted direct bytes remain in the quarantined warm document');
    assert.equal(instance.documents.get('doc'), doc);
    assert.equal(persistCalls.length, persistBeforeFailure + 1);
    assert.equal(persistCalls.at(-1)?.fence, docFence);
    assert.equal(states.get('doc'), storedBeforeFailure, 'the failed store does not publish direct bytes');
    assert.equal(markDegradedCalls, markBeforeFailure, 'owned failure does not mark shared state degraded');
    assert.equal(broadcasts.some((payload) => {
      try { return JSON.parse(payload).type === 'durability_snapshot'; } catch { return false; }
    }), false, 'failed direct store sends no durability acknowledgement');
    await turn();
    const detectionsAfterLoss = semanticConflictDetections;
    await instance.hooks('onChange', {
      instance, clientsCount: doc.getConnectionsCount(), context: peer.connection.context,
      document: doc, documentName: 'doc', requestHeaders: request.headers,
      requestParameters: new URLSearchParams(), socketId: 'post-loss-change',
      update: Uint8Array.of(1), transactionOrigin: { source: 'local', context: peer.connection.context },
    });
    assert.equal(semanticConflictDetections, detectionsAfterLoss,
      'terminal owner guard resolves before semantic conflict detection');
    doc.broadcastStateless = originalBroadcast;
    console.log('PASS direct callback mutates, failed final store is swallowed, and post-disconnect owner assertion rejects');
    return;
  }

  const reconciled = new Y.Doc();
  try {
    Y.applyUpdate(reconciled, Y.encodeStateAsUpdate(doc));
    reconciled.getText('content').insert(reconciled.getText('content').length, 'R');
    controlledPersist = {
      ...states.get('doc')!,
      yjsState: Y.encodeStateAsUpdate(reconciled),
      stateVector: Y.encodeStateVector(reconciled),
      documentSequence: states.get('doc')!.documentSequence + 1,
    };
  } finally {
    reconciled.destroy();
  }
  await instance.hooks('onStoreDocument', storePayload(doc, peer.connection.context));
  const lossAccessGate = { check: accessChecks + 2, entered: gate(), release: gate() };
  accessBarrier = lossAccessGate;
  peer.connection.handleMessage(updateFrame('doc', appendUpdate(doc, 'X')));
  await bounded(lossAccessGate.entered.promise, 'owner loss during access validation');
  const markBeforeGenericFailure = markDegradedCalls;
  persistFailure = new Error('deliberate generic persistence failure');
  try {
    await bounded(instance.storeDocumentHooks(doc, storePayload(doc, peer.connection.context), true),
      'generic persistence failure swallowed by Hocuspocus');
  } finally {
    lossAccessGate.release.resolve();
  }
  const persistCountBeforeLossRetry = persistCalls.length;
  assert.equal(markDegradedCalls, markBeforeGenericFailure,
    'owned generic store failure does not mutate shared degraded state');
  await bounded(peer.connection.waitForPendingMessages(), 'lost-owner receiver rejection');
  assert.equal(peer.connection.readOnly, true);
  assert.equal(doc.hasConnection(peer.connection), false);
  await turn();
  await turn();
  assert.equal(doc.getText('content').toString().includes('R'), false,
    'queued reconciliation cannot apply after owner invalidation');
  assert.equal(doc.getText('content').toString().includes('X'), false,
    'an update waiting on access validation cannot apply after owner invalidation');
  await assert.rejects(instance.hooks('beforeUnloadDocument', {
    instance, documentName: 'doc', document: doc,
  }));
  await instance.unloadDocument(doc);
  assert.equal(instance.documents.get('doc'), doc, 'lost-owner room remains quarantined');
  await assert.rejects(documentReader('doc', workspace.workspaceId, () => undefined),
    (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
  let staleDirectApplied = false;
  await assert.rejects(direct({
    documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text',
    documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
    workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
    operationId: 'stale-direct-owner-test',
  }, () => { staleDirectApplied = true; }),
  (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
  assert.equal(staleDirectApplied, false);
  const markBeforeStaleStore = markDegradedCalls;
  const messages: string[] = [];
  const originalBroadcast = doc.broadcastStateless;
  doc.broadcastStateless = (payload, filter) => {
    messages.push(payload);
    originalBroadcast.call(doc, payload, filter);
  };
  await assert.rejects(instance.hooks('onStoreDocument', storePayload(doc, peer.connection.context)),
    (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
  assert.equal(persistCalls.length, persistCountBeforeLossRetry);
  assert.equal(markDegradedCalls, markBeforeStaleStore);
  assert.equal(messages.some((payload) => {
    try { return JSON.parse(payload).type === 'durability_snapshot'; } catch { return false; }
  }), false);
  console.log('PASS owner loss closes peers and quarantines reader, reconciliation, direct, unload, and stale store paths');

  doc.broadcastStateless = originalBroadcast;
}

async function run() {
  await main('direct-store-failure');
  await emergencyCleanup();
  pendingGateReleases.length = 0;
  emergencyCleanup = async () => {};
  await main('queued-peer-loss');
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => emergencyCleanup().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}));
