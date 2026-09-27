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
import type {
  CollaborationRoomReleaseReceipt,
  CollaborationRoomReleaseSnapshot,
} from '../app/lib/collaboration/room-owner-release';
import {
  admissionDrainTicketForTarget,
  type CollaborationAdmissionDrainTicket,
} from '../app/lib/collaboration/room-admission-drain';
import { createCollaborationRoomAdmissionWorker } from '../app/lib/collaboration/room-admission-worker';
import * as RoomMutation from '../app/lib/collaboration/room-mutation-lock';
import * as RoomStartup from '../app/lib/collaboration/room-startup-activity';
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
  release(fence: CollaborationRoomOwnerFence, snapshot?: CollaborationRoomReleaseSnapshot): Promise<void>;
  assertActive(fence: CollaborationRoomOwnerFence): void;
  probe(): Promise<void>;
  close(): Promise<void>;
};

type OwnerRuntime = ReturnType<
  typeof import('../app/lib/collaboration/room-owner-runtime').createCollaborationRoomOwnerRuntime
>;

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

async function main(mode: 'direct-store-failure' | 'queued-peer-loss'
  | 'terminal-success' | 'terminal-store-failure' | 'terminal-lost-ack'
  | 'admission-terminal' | 'admission-unproven-release') {
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
  const releaseSnapshots: Array<CollaborationRoomReleaseSnapshot | undefined> = [];
  const recoveredReleases: Array<{
    fence: CollaborationRoomOwnerFence;
    snapshot: CollaborationRoomReleaseSnapshot;
  }> = [];
  let sessionActive = true;
  let sessionClosed = false;
  let releaseFailure: Error | null = null;
  let releaseFailureMarksAdmissionReleased = false;
  let epoch = 0;
  let instance!: Hocuspocus<TestContext>;
  let ownerRuntime!: OwnerRuntime;
  let activityAdmissionObserver: ((documentId: string) => void) | null = null;
  let direct!: Parameters<typeof Direct.installCollaborationDirectConnection>[0];
  let documentReader!: Reader;
  let localRoomDrainer: ((scope: CollaborationRoomOwnerScope) => Promise<void>) | undefined;
  let localTicketDrainer: ((ticket: CollaborationAdmissionDrainTicket) => Promise<void>) | undefined;
  let localRoomDrainerUninstalls = 0;
  const drainStatuses = new Map<string, 'draining' | 'released'>();
  let readDrainFailure: Error | null = null;
  let unloadFailureDocumentId: string | null = null;
  let unloadBarrier: { documentId: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let accessBarrier: { check: number; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let accessChecks = 0;
  let markDegradedCalls = 0;
  let semanticConflictDetections = 0;
  const persistCalls: Array<{ documentId: string; fence: CollaborationRoomOwnerFence | undefined }> = [];
  let controlledPersist: PersistedCollaborationState | null = null;
  let persistFailure: Error | null = null;
  let persistBarrier: {
    documentId: string;
    entered: ReturnType<typeof gate>;
    release: ReturnType<typeof gate>;
  } | null = null;
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
    async release(fence, snapshot) {
      events.push(`release:${fence.scope.documentId}`);
      if (!sessionActive || fences.get(fence.scope.documentId) !== fence) {
        throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
      }
      assert.equal(fences.get(fence.scope.documentId), fence);
      releaseSnapshots.push(snapshot);
      if (releaseFailure) {
        const error = releaseFailure;
        releaseFailure = null;
        if (releaseFailureMarksAdmissionReleased && snapshot?.admission) {
          drainStatuses.set(snapshot.admission.releaseId, 'released');
        }
        throw error;
      }
      if (snapshot?.admission) drainStatuses.set(snapshot.admission.releaseId, 'released');
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
          if (unloadFailureDocumentId === payload.documentName) {
            unloadFailureDocumentId = null;
            throw new Error('injected local unload failure');
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
  const runtimeForServer = {
    ...roomOwnerRuntime,
    createCollaborationRoomOwnerRuntime: (
      options: Parameters<typeof roomOwnerRuntime.createCollaborationRoomOwnerRuntime>[0],
    ) => {
      const runtime = roomOwnerRuntime.createCollaborationRoomOwnerRuntime(options);
      const admitActivity = runtime.admitActivity.bind(runtime);
      runtime.admitActivity = (documentId: string) => {
        const activity = admitActivity(documentId);
        activityAdmissionObserver?.(documentId);
        return activity;
      };
      ownerRuntime = runtime;
      return runtime;
    },
  };
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const server = {} as typeof Server;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@hocuspocus/server') return { Hocuspocus: ObservedHocuspocus };
    if (name === 'ws') return { WebSocketServer: class extends EventEmitter {} };
    if (name.endsWith('/room-owner-runtime')) return runtimeForServer;
    if (name.endsWith('/room-owner')) return { CollaborationRoomOwnerError };
    if (name.endsWith('/room-admission-drain')) return {
      admissionDrainTicketForTarget,
      matchesCollaborationAdmissionDrainFence: load(name).matchesCollaborationAdmissionDrainFence,
      sameCollaborationAdmissionDrainTicket: load(name).sameCollaborationAdmissionDrainTicket,
    };
    if (name.endsWith('/room-admission-worker')) return { createCollaborationRoomAdmissionWorker };
    if (name.endsWith('/room-startup-activity')) return RoomStartup;
    if (name.endsWith('/local-room-drain')) return {
      installLocalCollaborationRoomDrainer: (
        drainer: {
          drain: (ticket: CollaborationAdmissionDrainTicket) => Promise<void>;
          drainLegacy?: (scope: CollaborationRoomOwnerScope) => Promise<void>;
        },
      ) => {
        localTicketDrainer = drainer.drain;
        localRoomDrainer = drainer.drainLegacy;
        return () => {
          if (localTicketDrainer === drainer.drain) localTicketDrainer = undefined;
          if (localRoomDrainer === drainer.drainLegacy) localRoomDrainer = undefined;
          localRoomDrainerUninstalls += 1;
        };
      },
    };
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
        const barrier = persistBarrier;
        if (barrier?.documentId === documentId) {
          persistBarrier = null;
          barrier.entered.resolve();
          await barrier.release.promise;
        }
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
      ...(mode === 'terminal-lost-ack' ? {
        recoverRelease: async (input: {
          fence: CollaborationRoomOwnerFence;
          snapshot: CollaborationRoomReleaseSnapshot;
        }) => {
          assert.equal(sessionClosed, true,
            'terminal receipt recovery begins only after the old owner session closes');
          recoveredReleases.push(input);
          return { release_id: input.snapshot.releaseId } as CollaborationRoomReleaseReceipt;
        },
      } : {}),
      heartbeatMs: 60_000,
      ...(mode === 'admission-terminal' || mode === 'admission-unproven-release' ? {
        admission: {
          pendingDrains: async () => [],
          readDrain: async (ticket: CollaborationAdmissionDrainTicket) => {
            if (readDrainFailure) {
              const error = readDrainFailure;
              readDrainFailure = null;
              throw error;
            }
            return { ticket, status: drainStatuses.get(ticket.releaseId) ?? 'draining' };
          },
          pollMs: 60_000,
        },
      } : {}),
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
    await turn();
    assert.equal(localRoomDrainer, undefined, 'server close uninstalls its exact local room drainer');
    assert.equal(localTicketDrainer, undefined, 'server close uninstalls its ticket-bound room drainer');
    assert.equal(localRoomDrainerUninstalls, 1);
    for (const document of instance.documents.values()) document.destroy();
    instance.documents.clear();
    await turn();
  };

  if (mode === 'admission-terminal') {
    const documentId = 'admission-terminal';
    states.set(documentId, makeState(documentId, 'durable-admission'));
    const document = await instance.createDocument(documentId, request, 'admission-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(documentId));
    const fence = fences.get(documentId)!;
    const ticket = admissionDrainTicketForTarget('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c'.repeat(64), {
      document: { ...fence.scope, status: 'active' }, ownerEpoch: fence.epoch, ownerToken: fence.token,
      ownerBackendPid: fence.backendPid, ownerBackendStart: fence.backendStart, documentSequence: 1,
    });
    drainStatuses.set(ticket.releaseId, 'draining');
    if (!localTicketDrainer) throw new Error('Ticket-bound room drainer was not installed.');
    readDrainFailure = new Error('known pre-release admission read failure');
    await assert.rejects(localTicketDrainer(ticket), /known pre-release/u);
    assert.equal(ownerRuntime.isDraining(documentId), false,
      'a failed durable preflight is retryable without entering local quiescence');
    assert.equal(ownerRuntime.fence(document), fence);
    unloadFailureDocumentId = documentId;
    await assert.rejects(localTicketDrainer(ticket),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY',
      'a known local unload failure leaves the positive release resumable');
    assert.equal(drainStatuses.get(ticket.releaseId), 'released');
    assert.equal(document.isDestroyed, false);
    assert.equal(instance.documents.get(documentId), document);
    assert.equal(releaseSnapshots.filter((snapshot) => snapshot?.admission?.releaseId === ticket.releaseId).length, 1);
    assert.deepEqual(ownerRuntime.listOwnedFences(), [fence],
      'released proof remains visible until the exact old object finishes unloading');

    await bounded(localTicketDrainer(ticket), 'released ticket unload retry');
    assert.equal(document.isDestroyed, true);
    assert.equal(instance.documents.has(documentId), false);
    assert.equal(releaseSnapshots.filter((snapshot) => snapshot?.admission?.releaseId === ticket.releaseId).length, 1,
      'released retry does not repeat store or owner release');

    const replacement = await instance.createDocument(documentId, request, 'replacement-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(documentId));
    const replacementFence = fences.get(documentId)!;
    await localTicketDrainer(ticket);
    assert.equal(instance.documents.get(documentId), replacement,
      'a repeated completed ticket is a no-op and never unloads the replacement object');
    assert.equal(ownerRuntime.fence(replacement), replacementFence);

    const staleFence = Object.freeze({ ...fence, epoch: fence.epoch + 100, token: 'stale-owner-token' });
    const staleTicket = admissionDrainTicketForTarget('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'd'.repeat(64), {
      document: { ...staleFence.scope, status: 'active' }, ownerEpoch: staleFence.epoch,
      ownerToken: staleFence.token, ownerBackendPid: staleFence.backendPid,
      ownerBackendStart: staleFence.backendStart, documentSequence: 1,
    });
    drainStatuses.set(staleTicket.releaseId, 'draining');
    await assert.rejects(localTicketDrainer(staleTicket),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
    assert.equal(instance.documents.get(documentId), replacement,
      'a late ticket for another epoch cannot enter quiescence on the new object');
    assert.equal(ownerRuntime.fence(replacement), replacementFence);
    console.log('PASS ticket drain retries positive unload, deduplicates release, and ignores completed/late epochs');
    return;
  }

  if (mode === 'admission-unproven-release') {
    const documentId = 'admission-unproven-release';
    states.set(documentId, makeState(documentId, 'unproven-release'));
    const document = await instance.createDocument(documentId, request, 'unproven-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(documentId));
    const fence = fences.get(documentId)!;
    const ticket = admissionDrainTicketForTarget('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'e'.repeat(64), {
      document: { ...fence.scope, status: 'active' }, ownerEpoch: fence.epoch, ownerToken: fence.token,
      ownerBackendPid: fence.backendPid, ownerBackendStart: fence.backendStart, documentSequence: 1,
    });
    drainStatuses.set(ticket.releaseId, 'draining');
    releaseFailureMarksAdmissionReleased = true;
    releaseFailure = new Error('lost release acknowledgement without local receipt recovery');
    if (!localTicketDrainer) throw new Error('Ticket-bound room drainer was not installed.');
    await assert.rejects(localTicketDrainer(ticket), /lost release acknowledgement/u);
    assert.equal(drainStatuses.get(ticket.releaseId), 'released',
      'fixture models a committed target transition observed only by later polling');
    assert.equal(ownerRuntime.resumeTerminalDrain(ticket)?.released, false);
    assert.deepEqual(ownerRuntime.listOwnedFences(), [],
      'an invalidated runtime never advertises an unproven local terminal release');
    await assert.rejects(localTicketDrainer(ticket),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST',
      'durable target status alone cannot upgrade an unproven retained terminal handle');
    assert.equal(document.isDestroyed, false);
    assert.equal(instance.documents.get(documentId), document,
      'the exact old object remains quarantined for full receipt recovery');
    console.log('PASS released target cannot falsely finish a retained terminal handle without local receipt proof');
    return;
  }

  if (mode === 'terminal-success') {
    const unloadingId = 'terminal-unload-race';
    states.set(unloadingId, makeState(unloadingId, 'approved-unload'));
    const unloadingDocument = await instance.createDocument(unloadingId, request, 'unload-race-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(unloadingId));
    const unloadingFence = fences.get(unloadingId)!;
    const approvedUnloadBarrier = { documentId: unloadingId, entered: gate(), release: gate() };
    unloadBarrier = approvedUnloadBarrier;
    const approvedUnload = instance.unloadDocument(unloadingDocument);
    await bounded(approvedUnloadBarrier.entered.promise, 'approved normal unload preflight race');
    if (!localRoomDrainer) throw new Error('Local room drainer was not installed.');
    await assert.rejects(localRoomDrainer(unloadingFence.scope),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(ownerRuntime.isDraining(unloadingId), false,
      'an already-approved normal unload is rejected before opening terminal activity drain');
    assert.equal(ownerRuntime.fence(unloadingDocument), unloadingFence,
      'rejected terminal preflight leaves the old owner proof active until normal unload completes');
    assert.equal(unloadingDocument.isDestroyed, false);
    approvedUnloadBarrier.release.resolve();
    await bounded(approvedUnload, 'approved normal unload completion');
    assert.equal(unloadingDocument.isDestroyed, true);
    assert.equal(instance.documents.has(unloadingId), false);
    assert.equal(released.filter((proof) => proof === unloadingFence).length, 1,
      'the approved normal unload releases the old proof exactly once');
    const freshAfterUnload = await instance.createDocument(unloadingId, request, 'unload-race-fresh-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(unloadingId));
    assert.notEqual(fences.get(unloadingId), unloadingFence);
    assert.equal(ownerRuntime.fence(freshAfterUnload), fences.get(unloadingId),
      'a safe retry requires and accepts a fresh Y.Doc after normal unload');
    console.log('PASS terminal preflight rejects an already-approved normal unload and accepts only a fresh Y.Doc');

    const documentId = 'terminal-success';
    states.set(documentId, makeState(documentId, 'old-content'));
    const document = await instance.createDocument(documentId, request, 'terminal-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(documentId));
    const fence = fences.get(documentId)!;
    const releaseExternalMutation = await RoomMutation.acquireCollaborationRoomMutationLock(document);
    pendingGateReleases.push(releaseExternalMutation);
    const directActivityAdmitted = gate();
    activityAdmissionObserver = (admittedId) => {
      if (admittedId === documentId) directActivityAdmitted.resolve();
    };
    let directApplied = false;
    const pendingDirect = direct({
      documentId, documentPath: `${documentId}.txt`, documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'terminal-pending-direct',
    }, (liveDocument) => {
      directApplied = true;
      liveDocument.getText('content').insert(liveDocument.getText('content').length, '+direct');
    });
    await bounded(directActivityAdmitted.promise, 'terminal pending direct activity');
    if (!localRoomDrainer) throw new Error('Local room drainer was not installed.');
    const terminalDrain = localRoomDrainer(fence.scope);
    let terminalSettled = false;
    void terminalDrain.then(() => { terminalSettled = true; });
    await turn();
    assert.equal(ownerRuntime.isDraining(documentId), true);
    assert.equal(directApplied, false, 'direct work is still queued behind the real room mutex');
    assert.equal(terminalSettled, false, 'terminal drain waits for the already-admitted direct operation');
    await instance.unloadDocument(document);
    assert.equal(instance.documents.get(documentId), document,
      'ordinary Hocuspocus unload remains blocked while terminal drain is active');

    releaseExternalMutation();
    await bounded(pendingDirect, 'terminal pending direct completion');
    await bounded(terminalDrain, 'terminal local room drain');
    assert.equal(directApplied, true);
    assert.equal(document.isDestroyed, true);
    assert.equal(instance.documents.has(documentId), false);
    assert.equal(released.includes(fence), true);
    const durableReleaseSnapshots = releaseSnapshots.filter(
      (snapshot): snapshot is CollaborationRoomReleaseSnapshot => snapshot !== undefined,
    );
    assert.equal(durableReleaseSnapshots.length, 1);
    const persisted = states.get(documentId)!;
    const releaseSnapshot = durableReleaseSnapshots[0];
    assert.deepEqual(Buffer.from(releaseSnapshot.yjsState), Buffer.from(persisted.yjsState),
      'terminal receipt covers the exact final persisted Yjs update');
    assert.deepEqual(Buffer.from(releaseSnapshot.stateVector), Buffer.from(persisted.stateVector),
      'terminal receipt covers the exact final persisted vector');
    const persistedDocument = new Y.Doc();
    try {
      Y.applyUpdate(persistedDocument, persisted.yjsState);
      assert.equal(persistedDocument.getText('content').toString(), 'old-content+direct',
        'terminal final store preserves old content plus the pending direct mutation');
    } finally {
      persistedDocument.destroy();
    }
    activityAdmissionObserver = null;
    console.log('PASS terminal driver drains pending direct work, stores exact bytes, proves release, and unloads');
    return;
  }

  if (mode === 'terminal-store-failure') {
    const mismatchId = 'terminal-scope-mismatch';
    states.set(mismatchId, makeState(mismatchId, 'scope'));
    const mismatchDocument = await instance.createDocument(mismatchId, request, 'scope-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(mismatchId));
    const mismatchFence = fences.get(mismatchId)!;
    if (!localRoomDrainer) throw new Error('Local room drainer was not installed.');
    await assert.rejects(localRoomDrainer({ ...mismatchFence.scope, path: 'replacement-scope.txt' }),
      (error) => error instanceof AgentDirectConnectionAuthorizationError);
    assert.equal(sessionClosed, false, 'replacement scope rejection does not close the owner session');
    assert.equal(ownerRuntime.fence(mismatchDocument), mismatchFence);

    const documentId = 'terminal-store-failure';
    states.set(documentId, makeState(documentId, 'durable-before-failure'));
    const document = await instance.createDocument(documentId, request, 'failure-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(documentId));
    document.getText('content').insert(document.getText('content').length, '+unpersisted');
    const persistedBefore = states.get(documentId)!;
    const markBefore = markDegradedCalls;
    const broadcasts: string[] = [];
    const originalBroadcast = document.broadcastStateless;
    document.broadcastStateless = (payload, filter) => {
      broadcasts.push(payload);
      originalBroadcast.call(document, payload, filter);
    };
    persistFailure = new Error('terminal final store failed');
    await assert.rejects(localRoomDrainer(fences.get(documentId)!.scope),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
    assert.equal(instance.documents.get(documentId), document);
    assert.equal(document.isDestroyed, false);
    assert.equal(document.getText('content').toString(), 'durable-before-failure+unpersisted');
    assert.equal(states.get(documentId), persistedBefore);
    assert.equal(ownerRuntime.canUnload(document), false);
    assert.equal(markDegradedCalls, markBefore);
    assert.equal(broadcasts.some((payload) => {
      try { return JSON.parse(payload).type === 'durability_snapshot'; } catch { return false; }
    }), false);
    assert.equal(releaseSnapshots.some((snapshot) => snapshot !== undefined
      && snapshot.releaseId.length > 0), false,
    'a swallowed final-store failure cannot create a durable release receipt');
    document.broadcastStateless = originalBroadcast;
    console.log('PASS terminal driver rejects replacement scope and quarantines a swallowed final-store failure');
    return;
  }

  if (mode === 'terminal-lost-ack') {
    const documentId = 'terminal-lost-ack';
    const siblingId = 'terminal-lost-sibling';
    states.set(documentId, makeState(documentId, 'release-target'));
    states.set(siblingId, makeState(siblingId, 'release-sibling'));
    const document = await instance.createDocument(documentId, request, 'lost-ack-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(documentId));
    const sibling = await instance.createDocument(siblingId, request, 'lost-sibling-loader', {
      isAuthenticated: true,
      readOnly: false,
    }, contextFor(siblingId));
    const fence = fences.get(documentId)!;
    releaseFailure = new Error('lost durable release acknowledgement');
    if (!localRoomDrainer) throw new Error('Local room drainer was not installed.');
    await bounded(localRoomDrainer(fence.scope), 'terminal lost-ack recovery');
    assert.equal(sessionClosed, true);
    assert.equal(recoveredReleases.length, 1);
    assert.equal(recoveredReleases[0].fence, fence);
    assert.equal(document.isDestroyed, true);
    assert.equal(instance.documents.has(documentId), false,
      'positive receipt recovery unloads the exact old document');
    assert.equal(instance.documents.get(siblingId), sibling);
    assert.equal(sibling.isDestroyed, false);
    assert.equal(ownerRuntime.canUnload(sibling), false,
      'a sibling on the lost owner session remains quarantined');
    const persisted = states.get(documentId)!;
    assert.deepEqual(Buffer.from(recoveredReleases[0].snapshot.yjsState), Buffer.from(persisted.yjsState));
    assert.deepEqual(Buffer.from(recoveredReleases[0].snapshot.stateVector), Buffer.from(persisted.stateVector));
    console.log('PASS lost release acknowledgement recovers one receipt while sibling remains quarantined');
    return;
  }

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

  if (mode === 'direct-store-failure') {
    const externalDirectMutationRelease = await RoomMutation.acquireCollaborationRoomMutationLock(doc);
    const directActivityAdmitted = gate();
    activityAdmissionObserver = (documentId) => {
      if (documentId === 'doc') directActivityAdmitted.resolve();
    };
    let roomLockedDirectApplied = false;
    const roomLockedDirect = direct({
      documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'direct-room-lock-activity-order',
    }, (document) => {
      roomLockedDirectApplied = true;
      document.getText('content').insert(document.getText('content').length, 'L');
    });
    await bounded(directActivityAdmitted.promise, 'room-locked direct activity admission');
    const roomLockedDirectDrain = ownerRuntime.beginActivityDrain('doc');
    let roomLockedDirectIdle = false;
    void roomLockedDirectDrain.idle.then(() => { roomLockedDirectIdle = true; });
    await turn();
    assert.equal(roomLockedDirectApplied, false,
      'direct callback remains queued behind the externally held room mutex');
    assert.equal(roomLockedDirectIdle, false,
      'drain counts a direct call admitted before it waits for the room mutex');
    externalDirectMutationRelease();
    await bounded(roomLockedDirect, 'room-locked direct completion');
    await bounded(roomLockedDirectDrain.idle, 'room-locked direct activity drain');
    assert.equal(roomLockedDirectApplied, true);
    assert.equal(ownerRuntime.fence(doc), docFence,
      'draining a room-mutex waiter does not replace its owner proof');
    roomLockedDirectDrain.finish();
    activityAdmissionObserver = null;
    console.log('PASS direct activity is admitted before the room mutex and drain waits for disconnect');

    const onAppliedBarrier = { entered: gate(), release: gate() };
    const directPersistBarrier = { documentId: 'doc', entered: gate(), release: gate() };
    persistBarrier = directPersistBarrier;
    let drainedDirectApplied = false;
    const drainedDirect = direct({
      documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'direct-activity-drain',
    }, (document) => {
      drainedDirectApplied = true;
      document.getText('content').insert(document.getText('content').length, 'A');
    }, async () => {
      onAppliedBarrier.entered.resolve();
      await onAppliedBarrier.release.promise;
    });
    await bounded(onAppliedBarrier.entered.promise, 'direct activity before drain');
    const directDrain = ownerRuntime.beginActivityDrain('doc');
    let directIdle = false;
    void directDrain.idle.then(() => { directIdle = true; });
    await turn();
    assert.equal(directIdle, false, 'drain cannot report idle while direct onApplied is in flight');
    let secondDirectApplied = false;
    await assert.rejects(direct({
      documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'direct-rejected-during-drain',
    }, () => { secondDirectApplied = true; }),
    (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(secondDirectApplied, false, 'drain rejects a second direct call before transact');
    assert.equal(ownerRuntime.canUnload(doc), false);
    await assert.rejects(instance.hooks('beforeUnloadDocument', {
      instance, documentName: 'doc', document: doc,
    }));
    await instance.unloadDocument(doc);
    assert.equal(instance.documents.get('doc'), doc, 'ordinary unload is cancelled while activity drain is active');
    onAppliedBarrier.release.resolve();
    await bounded(directPersistBarrier.entered.promise, 'direct store during activity drain');
    assert.equal(directIdle, false, 'drain stays non-idle through the direct final store');
    directPersistBarrier.release.resolve();
    await bounded(drainedDirect, 'drained direct disconnect');
    await bounded(directDrain.idle, 'direct activity drain idle');
    assert.equal(drainedDirectApplied, true);
    assert.equal(ownerRuntime.fence(doc), docFence,
      'activity quiescence alone does not release or replace the old owner fence');
    assert.equal(released.includes(docFence), false,
      'activity drain is not a false durable room-release proof');
    directDrain.finish();
    assert.equal(ownerRuntime.canUnload(doc), true);
    console.log('PASS direct drain waits through onApplied, store, and disconnect without releasing ownership');

    const externalMutationRelease = await RoomMutation.acquireCollaborationRoomMutationLock(doc);
    const peerActivityAdmitted = gate();
    activityAdmissionObserver = (documentId) => {
      if (documentId === 'doc') peerActivityAdmitted.resolve();
    };
    const queuedPeer = socket(doc, 'activity-drain-peer');
    queuedPeer.connection.handleMessage(updateFrame('doc', appendUpdate(doc, 'Q')));
    await bounded(peerActivityAdmitted.promise, 'queued peer activity admission');
    const peerDrain = ownerRuntime.beginActivityDrain('doc');
    let peerIdle = false;
    void peerDrain.idle.then(() => { peerIdle = true; });
    await turn();
    assert.equal(peerIdle, false, 'queued peer activity remains counted while waiting for the room mutex');
    externalMutationRelease();
    await bounded(peerDrain.idle, 'queued peer frame cleanup');
    await bounded(queuedPeer.connection.waitForPendingMessages(), 'queued peer drain rejection');
    assert.equal(doc.getText('content').toString().includes('Q'), false,
      'peer admitted before drain is rejected after waiting for the room mutex');
    const mutationProbeRelease = await bounded(
      RoomMutation.acquireCollaborationRoomMutationLock(doc),
      'room mutex after drained peer rejection',
    );
    mutationProbeRelease();
    assert.equal(ownerRuntime.fence(doc), docFence,
      'peer cleanup does not change the active owner proof');
    peerDrain.finish();
    activityAdmissionObserver = null;
    queuedPeer.connection.close();
    console.log('PASS peer queued before drain rejects after mutex wait and releases activity plus room mutex');
  }

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
  const modes = [
    'admission-terminal',
    'admission-unproven-release',
    'terminal-success',
    'terminal-store-failure',
    'terminal-lost-ack',
    'direct-store-failure',
    'queued-peer-loss',
  ] as const;
  for (const mode of modes) {
    await main(mode);
    await emergencyCleanup();
    pendingGateReleases.length = 0;
    emergencyCleanup = async () => {};
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => emergencyCleanup().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}));
