import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import ts from 'typescript';
import { Connection, Hocuspocus, MessageType, type Document } from '@hocuspocus/server';
import * as encoding from 'lib0/encoding';
import { messageYjsUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';

import type * as Direct from '../app/lib/collaboration/direct-connection';
import type * as Notebook from '../app/lib/mobile/notebook';
import type * as NotebookOperations from '../app/lib/mobile/notebook-operations';
import { MOBILE_NOTEBOOK_OPERATION_STATEMENTS } from '../app/lib/db/mobile-notebook-operation-migration';
import * as DirectActivity from '../app/lib/collaboration/direct-activity-session';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { withWorkspaceFileLifecycleLeases, type WorkspaceFileLifecycleLease } from '../app/lib/collaboration/file-lifecycle-admission-context';
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
import { COLLABORATION_SCHEMA_VERSION, type CollaborationTicketClaims } from '../app/lib/collaboration/types';
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

type Reader = <T>(documentId: string, workspaceId: string, read: (document: Y.Doc) => T,
  loadState?: typeof import('../app/lib/collaboration/persistence').loadCollaborationState) => Promise<T>;

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
  | 'admission-terminal' | 'admission-unproven-release' | 'normal-unload' | 'admission-writer-gate' | 'batch-idle-release'
  | 'reader-normal-unload' | 'direct-activity-session' | 'direct-activity-session-close'
  | 'direct-activity-session-unavailable' | 'native-read-busy-postgres') {
  const workspace = {
    workspaceId: mode === 'native-read-busy-postgres' ? `native-busy-${randomUUID()}` : 'owner-workspace',
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
  const durablyReleased = new Set<CollaborationRoomOwnerFence>();
  const releaseSnapshots: Array<CollaborationRoomReleaseSnapshot | undefined> = [];
  const recoveredReleases: Array<{
    fence: CollaborationRoomOwnerFence;
    snapshot: CollaborationRoomReleaseSnapshot;
  }> = [];
  let sessionActive = true;
  let sessionClosed = false;
  let releaseFailure: Error | null = null;
  let releaseFailureMarksAdmissionReleased = false;
  let recoverReleaseFailure: Error | null = null;
  let epoch = 0;
  let instance!: Hocuspocus<TestContext>;
  let ownerRuntime!: OwnerRuntime;
  let activityAdmissionObserver: ((documentId: string) => void) | null = null;
  let direct!: Parameters<typeof Direct.installCollaborationDirectConnection>[0];
  let activitySession!: DirectActivity.CollaborationDirectActivitySessionHandler;
  let userAccessAllowed = true;
  let userAccessChecks = 0;
  let userAccessBarrier: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let documentReader!: Reader;
  let localRoomDrainer: ((scope: CollaborationRoomOwnerScope) => Promise<void>) | undefined;
  let localTicketDrainer: ((ticket: CollaborationAdmissionDrainTicket) => Promise<void>) | undefined;
  let localIdleRelease: ((input: { scope: CollaborationRoomOwnerScope; operationId: string }) => Promise<void>) | undefined;
  let localRoomDrainerUninstalls = 0;
  const drainStatuses = new Map<string, 'draining' | 'released'>();
  let readDrainFailure: Error | null = null;
  let unloadFailureDocumentId: string | null = null;
  let afterStoreFailureDocumentId: string | null = null;
  let afterUnloadFailureDocumentId: string | null = null;
  let unloadBarrier: { documentId: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let loadBarrier: { documentId: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let accessBarrier: { check: number; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let accessChecks = 0;
  let markDegradedCalls = 0;
  let semanticConflictDetections = 0;
  const persistCalls: Array<{ documentId: string; fence: CollaborationRoomOwnerFence | undefined }> = [];
  let controlledPersist: PersistedCollaborationState | null = null;
  let persistObserver: ((state: PersistedCollaborationState) => Promise<void>) | null = null;
  let admissionBlocked = false;
  let admissionChecks = 0;
  const admissionLockQueries: string[] = [];
  let blockOnAdmissionCheck = 0;
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
      if (snapshot) durablyReleased.add(fence);
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
        async onLoadDocument(payload) {
          const barrier = loadBarrier;
          if (barrier?.documentId === payload.documentName) {
            loadBarrier = null;
            barrier.entered.resolve();
            await barrier.release.promise;
          }
          return options?.onLoadDocument?.(payload);
        },
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
        async afterStoreDocument(payload) {
          await options?.afterStoreDocument?.(payload);
          if (afterStoreFailureDocumentId === payload.documentName) {
            afterStoreFailureDocumentId = null;
            throw new Error('injected local after-store failure');
          }
        },
        async afterUnloadDocument(payload) {
          await options?.afterUnloadDocument?.(payload);
          if (afterUnloadFailureDocumentId === payload.documentName) {
            afterUnloadFailureDocumentId = null;
            throw new Error('injected local after-unload failure');
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
  const unloadCoordinatorFilename = path.resolve('app/lib/collaboration/owned-room-unload.ts');
  const compiledUnloadCoordinator = ts.transpileModule(await fs.readFile(unloadCoordinatorFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const unloadCoordinator = {} as typeof import('../app/lib/collaboration/owned-room-unload');
  new Function('require', 'module', 'exports', compiledUnloadCoordinator.outputText)((name: string) => {
    if (name === 'server-only') return {};
    return createRequire(unloadCoordinatorFilename)(name);
  }, { exports: unloadCoordinator }, unloadCoordinator);
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
    if (name.endsWith('/owned-room-unload')) return unloadCoordinator;
    if (name.endsWith('/document-idle-release')) return {
      assertCollaborationDocumentIdleReleaseProof: async (_database: unknown, scope: CollaborationRoomOwnerScope,
        fence?: CollaborationRoomOwnerFence) => {
        const proof = fence ?? released.findLast(candidate => candidate.scope.documentId === scope.documentId);
        assert(proof && durablyReleased.has(proof), 'a direct disconnect or owner absence alone is not a release proof');
        assert.equal(fences.has(scope.documentId), false);
        assert.equal(instance.documents.has(scope.documentId), false);
        assert.equal(proof.scope.path, scope.path);
        events.push(`idle-proof:${scope.documentId}`);
      },
    };
    if (name.endsWith('/room-owner')) return { CollaborationRoomOwnerError };
    if (name.endsWith('/room-admission-drain')) return {
      admissionDrainTicketForTarget,
      matchesCollaborationAdmissionDrainFence: load(name).matchesCollaborationAdmissionDrainFence,
      sameCollaborationAdmissionDrainTicket: load(name).sameCollaborationAdmissionDrainTicket,
    };
    if (name.endsWith('/room-admission-worker')) return { createCollaborationRoomAdmissionWorker };
    if (name.endsWith('/room-startup-activity')) return RoomStartup;
    if (name.endsWith('/file-lifecycle-admission-context')) return load(name);
    if (name.endsWith('/local-room-drain')) return {
      installLocalCollaborationRoomDrainer: (
        drainer: {
          drain: (ticket: CollaborationAdmissionDrainTicket) => Promise<void>;
          drainLegacy?: (scope: CollaborationRoomOwnerScope) => Promise<void>;
          releaseIdle?: typeof localIdleRelease;
        },
      ) => {
        localTicketDrainer = drainer.drain;
        localRoomDrainer = drainer.drainLegacy;
        localIdleRelease = drainer.releaseIdle;
        return () => {
          if (localTicketDrainer === drainer.drain) localTicketDrainer = undefined;
          if (localRoomDrainer === drainer.drainLegacy) localRoomDrainer = undefined;
          if (localIdleRelease === drainer.releaseIdle) localIdleRelease = undefined;
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
        events.push(`persist:${documentId}`);
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
        if (persistObserver) await persistObserver(next);
        return { ...next, persistenceDisposition: 'advanced', incomingNeedsReconcile: false };
      },
      markCollaborationDegraded: async () => { markDegradedCalls++; },
    };
    if (name.endsWith('/direct-connection')) return {
      AgentDirectConnectionAuthorizationError,
      installCollaborationDirectConnection: (handler: typeof direct) => { direct = handler; },
    };
    if (name.endsWith('/direct-activity-session')) return {
      ...DirectActivity,
      installCollaborationDirectActivitySession: (handler: typeof activitySession) => {
        activitySession = handler;
        return DirectActivity.installCollaborationDirectActivitySession(handler);
      },
    };
    if (name.endsWith('/connection-access')) return {
      resolveCollaborationSessionAccess: async () => {
        userAccessChecks++;
        const barrier = userAccessBarrier;
        if (barrier) {
          userAccessBarrier = null;
          barrier.entered.resolve();
          await barrier.release.promise;
        }
        if (!userAccessAllowed) throw new AgentDirectConnectionAuthorizationError('User session revoked.');
        return { workspace };
      },
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
    if (name.endsWith('/projection-repository')) return {
      loadCollaborationProjectionStatus: async () => ({ degraded: false, projectionFinalized: false }),
    };
    if (name.endsWith('/agent-turn-history')) return {
      agentTurnHistoryService: { boundary: async () => {}, recoverExpired: async () => {} },
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
    if (name.endsWith('/representation-migration-runtime')) return load(name);
    if (name.endsWith('/representation-drain-refusal')) return { readRepresentationDrainRequest: async () => null };
    if (name.endsWith('/room-admission')) return load(name);
    if (name.endsWith('/file-lifecycle-writer-admission')) return {
      tryLockFileLifecycleCollaborationRoomAdmission: load('@/app/lib/collaboration/file-lifecycle-writer-admission').tryLockFileLifecycleCollaborationRoomAdmission,
      tryLockFileLifecycleCollaborationWriterAdmission: async (query: Parameters<typeof import('../app/lib/collaboration/room-admission').tryLockCollaborationAdmissionWorkspace>[0], scope: CollaborationRoomOwnerScope) =>
        load('@/app/lib/collaboration/room-admission').tryLockCollaborationAdmissionWorkspace(query, scope.workspaceId),
    };
    if (name === '@/app/lib/db') return { openDb: async () => ({ run: async () => {},
      all: async (sql: string) => {
        if (sql.includes('pg_try_advisory_xact_lock')) { admissionLockQueries.push(sql); return [{ locked: true }]; }
        if (sql.includes('FROM collaboration_admission_scopes')) {
          admissionChecks++;
          return admissionBlocked || admissionChecks === blockOnAdmissionCheck ? [{ request_id: 'pending-representation' }] : [];
        }
        return [];
      }, close: async () => {} }) };
    if (name.startsWith('@/')) return {};
    return load(name);
  }, { exports: server }, server);

  const httpServer = new EventEmitter();
  server.createCollaborationServer(httpServer as unknown as http.Server, mode === 'direct-activity-session-unavailable' ? {} : {
    roomOwner: {
      createSession: async (onInvalidated) => {
        void onInvalidated;
        return ownerSession as never;
      },
      ...(mode === 'terminal-lost-ack' || mode === 'normal-unload' ? {
        recoverRelease: async (input: {
          fence: CollaborationRoomOwnerFence;
          snapshot: CollaborationRoomReleaseSnapshot;
        }) => {
          assert.equal(sessionClosed, true,
            'terminal receipt recovery begins only after the old owner session closes');
          recoveredReleases.push(input);
          if (recoverReleaseFailure) {
            const error = recoverReleaseFailure;
            recoverReleaseFailure = null;
            throw error;
          }
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
    assert.equal(localRoomDrainerUninstalls, mode === 'direct-activity-session-unavailable' ? 0
      : mode === 'direct-activity-session-close' ? 2 : 1);
    for (const document of instance.documents.values()) document.destroy();
    instance.documents.clear();
    await turn();
  };

  if (mode === 'native-read-busy-postgres') {
    const { testNativeBusyReadPostgres } = await import('./helpers/file-read-busy-postgres-fixture');
    await testNativeBusyReadPostgres({
      workspaceId: workspace.workspaceId, reader: documentReader,
      room: async id => {
        states.set(id, { ...makeState(id, 'original+latest'), workspaceId: workspace.workspaceId });
        const document = await instance.createDocument(id, request, 'reader-loader',
          { isAuthenticated: true, readOnly: false }, contextFor(id));
        const state = { ...makeState(id, 'original'), workspaceId: workspace.workspaceId }; states.set(id, state);
        return { document, state };
      },
      onPersist: callback => { persistObserver = callback; },
      unload: async document => {
        const barrier = { documentId: document.name, entered: gate(), release: gate() };
        persistBarrier = barrier;
        const complete = instance.unloadDocument(document);
        return { entered: barrier.entered.promise, release: barrier.release.resolve, complete };
      },
    });
    return;
  }

  if (mode === 'direct-activity-session-unavailable') {
    await assert.rejects(activitySession({
      documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User',
      initiatedByUserId: 'user', actorSessionId: 'mobile-session', operationId: 'unavailable',
    }, async () => assert.fail('a no-runtime activity pin must never succeed')),
    (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_UNAVAILABLE');
    console.log('PASS no RoomOwner runtime cannot report a successful ineffective activity pin');
    return;
  }

  if (mode === 'direct-activity-session' || mode === 'direct-activity-session-close') {
    const inputFor = (id: string): DirectActivity.CollaborationDirectActivitySessionInput => ({
      documentId: id, documentPath: `${id}.txt`, documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace: { ...workspace }, actorType: 'user', actorId: 'user', actorDisplayName: 'User',
      initiatedByUserId: 'user', actorSessionId: 'mobile-session', operationId: `mobile-${id}`,
    });
    const busy = (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY';
    const source = (id: string, content = 'original') => { states.set(id, makeState(id, content)); return inputFor(id); };

    if (mode === 'direct-activity-session-close') {
      const input = source('session-close');
      const originalHandler = activitySession;
      const originalInstance = instance;
      const replacementHttp = new EventEmitter();
      await assert.rejects(activitySession(input, async session => {
        await direct(input, () => undefined);
        server.createCollaborationServer(replacementHttp as unknown as http.Server, {
          roomOwner: { createSession: async () => ownerSession as never, heartbeatMs: 60_000 },
        });
        const replacementHandler = activitySession;
        const replacementInstance = instance;
        instance = originalInstance;
        await assert.rejects(direct(input, () => assert.fail('new server must reject an old ALS continuation')));
        assert.equal(replacementInstance.documents.size, 0, 'replaced continuation must not open a new native room');
        httpServer.emit('close');
        assert.equal(DirectActivity.isCollaborationDirectActivitySessionInstalled(replacementHandler), true,
          'old server uninstaller must retain the replacement bridge');
        await assert.rejects(session.assertOpen());
        await assert.rejects(direct(input, () => assert.fail('closed session must not apply')));
        replacementHttp.emit('close');
      }));
      await assert.rejects(originalHandler(input, async () => assert.fail('old handler must not start after close')));
      console.log('PASS replacement server rejects old ALS; close revokes captured handlers and preserves newer bridge');
      return;
    }

    // The original two independent Direct calls deterministically reproduce V6:
    // the first idle callback starts final persistence while prepare yields.
    const unpinned = source('session-old-race');
    await direct(unpinned, doc => assert.equal(doc.getText('content').toString(), 'original'));
    const oldStore = { documentId: unpinned.documentId, entered: gate(), release: gate() };
    persistBarrier = oldStore;
    await bounded(oldStore.entered.promise, 'unscoped first Direct idle final store');
    await assert.rejects(direct(unpinned, () => assert.fail('draining second Direct must not apply')), busy);
    const oldDocument = instance.documents.get(unpinned.documentId)!;
    const oldDestroyed = gate();
    oldDocument.on('destroy', oldDestroyed.resolve);
    oldStore.release.resolve();
    await bounded(oldDestroyed.promise, 'unscoped old room durable release');
    console.log('PASS reproduced original two-Direct idle-drain ROOM_OWNER_BUSY with no peer');

    const pinned = source('session-mobile');
    let pinnedDoc!: Y.Doc;
    let retainedSession!: DirectActivity.CollaborationDirectActivitySession;
    const applied = await DirectActivity.withCollaborationDirectActivitySession(pinned, async session => {
      retainedSession = session;
      const prepared = await direct(pinned, doc => {
        pinnedDoc = doc;
        return appendUpdate(doc, '+applied');
      });
      const owner = fences.get(pinned.documentId)!;
      assert.equal(pinnedDoc.isDestroyed, false);
      const stores = persistCalls.length;
      await turn(); // asynchronous durable preparation, outside the concrete room mutex
      assert.equal(persistCalls.length, stores, 'group pin prevents deferred final store between phases');
      assert.equal(fences.get(pinned.documentId), owner);
      assert.equal(released.includes(owner), false);
      await session.assertOpen();
      await direct(pinned, doc => {
        assert.equal(doc, pinnedDoc);
        Y.applyUpdate(doc, prepared);
      });
      await turn(); // durable acknowledgement / private compaction can yield too
      await session.assertOpen();
      assert.equal(fences.get(pinned.documentId), owner);
      assert.equal(released.includes(owner), false);
      return documentReader(pinned.documentId, workspace.workspaceId, doc => doc.getText('content').toString());
    });
    assert.equal(applied, 'original+applied');
    const groupDestroyed = gate();
    pinnedDoc.on('destroy', groupDestroyed.resolve);
    await bounded(groupDestroyed.promise, 'normal unload after complete Mobile activity session');
    await assert.rejects(retainedSession.assertOpen(), busy);
    assert.equal(userAccessChecks >= 6, true, 'session and both Direct phases revalidate real user-session access');
    console.log('PASS pinned two-Direct prepare/apply/durability/readback preserves owner until complete');

    // Exercise the actual Mobile service and its real private operation SQL,
    // while the same real Hocuspocus runtime owns disconnect and idle unload.
    for (const rich of [false, true]) {
      const initialContent = rich ? '' : 'original';
      const savedContent = rich ? '# Mobile title\n\nSaved paragraph' : 'original+mobile';
      const mobileInput = source(rich ? 'session-mobile-rich-empty' : 'session-mobile-service', initialContent);
      if (rich) {
        const initial = createRichMarkdownYDoc('', 'tiptap_blocks');
        try {
          mobileInput.documentPath = `${mobileInput.documentId}.md`;
          mobileInput.documentRepresentation = 'tiptap_blocks';
          mobileInput.documentSchemaVersion = COLLABORATION_SCHEMA_VERSION;
          states.set(mobileInput.documentId, { ...states.get(mobileInput.documentId)!, path: mobileInput.documentPath,
            representation: 'tiptap_blocks', schemaVersion: COLLABORATION_SCHEMA_VERSION, documentSequence: 0, checkpointSequence: 0,
            persistedAt: 0, checkpointedAt: 0, yjsState: Y.encodeStateAsUpdate(initial), stateVector: Y.encodeStateVector(initial) });
        } finally { initial.destroy(); }
      }
      assert.equal(authoritativeNativeCollaborationSnapshot(states.get(mobileInput.documentId)!).schemaVersion,
        COLLABORATION_SCHEMA_VERSION, 'the actual native snapshot validator must accept the persisted fixture');
      const nativeContent = (doc: Y.Doc) => rich ? richMarkdownFromYDoc(doc) : doc.getText('content').toString();
      const database = new DatabaseSync(':memory:');
      try {
        database.exec('PRAGMA foreign_keys=ON; CREATE TABLE collaboration_yjs_states(document_id text PRIMARY KEY)');
        database.prepare('INSERT INTO collaboration_yjs_states VALUES (?)').run(mobileInput.documentId);
        for (const statement of MOBILE_NOTEBOOK_OPERATION_STATEMENTS) database.exec(statement);
        const bindings = (values: unknown[] = []) => Object.fromEntries(values.map((value, index) =>
          [`$${index + 1}`, value as SQLInputValue]));
        const compile = async <T,>(relative: string, dependencies: Record<string, unknown>): Promise<T> => {
          const absolute = path.resolve(relative);
          const compiled = ts.transpileModule(await fs.readFile(absolute, 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
          });
          const exports = {};
          new Function('require', 'module', 'exports', compiled.outputText)((name: string) =>
            name === 'server-only' ? {} : name in dependencies ? dependencies[name] : createRequire(absolute)(name),
          { exports }, exports);
          return exports as T;
        };
        const operations = await compile<typeof NotebookOperations>('app/lib/mobile/notebook-operations.ts', {
          '@/app/lib/db': { openDb: async () => ({
            get: async (sql: string, values?: unknown[]) => database.prepare(sql).get(bindings(values)),
            run: async (sql: string, values?: unknown[]) => {
              const result = database.prepare(sql).run(bindings(values));
              if (sql.startsWith('INSERT INTO mobile_notebook_operations')) {
                assert.equal(nativeContent(instance.documents.get(mobileInput.documentId)!), initialContent);
                await turn(); // persisted prepared row yields before live apply
                assert.equal(instance.documents.has(mobileInput.documentId), true);
                assert.equal(fences.has(mobileInput.documentId), true);
              }
              return result;
            },
            close: async () => {},
          }) },
        });
        const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
        let mobileDirectCalls = 0;
        const notebook = await compile<typeof Notebook>('app/lib/mobile/notebook.ts', {
          './notebook-operations': operations,
          '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: async (_id: string, operation: () => Promise<unknown>) => operation() },
          '@/app/lib/filesystem/workspace-files': {
            getFileStats: async () => ({ size: Buffer.byteLength(initialContent), modified: Date.now() / 1_000 }),
            readFile: async () => Buffer.from(initialContent),
          },
          '@/app/lib/files/collaboration-policy': {
            getFileCollaborationState: async () => ({ document: { id: mobileInput.documentId },
              latestRevision: { id: 'revision' }, strategy: 'crdt_text', requiresRevisionCheck: true }),
            ensureFileRevisionForCurrentContent: async () => ({ id: 'revision' }),
          },
          '@/app/lib/files/revision-guard': { sha256Buffer: hash },
          '@/app/lib/files/write-service': { writeWorkspaceFileContent: () => assert.fail('native service must not fall back to a physical writer') },
          '@/app/lib/collaboration/document-state-service': {
            selectInitialTextCollaborationRepresentation: () => mobileInput.documentRepresentation,
            resolveTextCollaborationState: async () => ({ state: states.get(mobileInput.documentId)! }),
          },
          '@/app/lib/collaboration/persistence': { sha256Text: hash, loadCollaborationState: async (id: string) => states.get(id) },
          '@/app/lib/collaboration/agent-file-edits': {
            readCurrentCollaborationTextSnapshot: async () => documentReader(mobileInput.documentId, workspace.workspaceId,
              doc => { const content = nativeContent(doc); return { content, sha256: hash(content) }; }),
          },
          '@/app/lib/collaboration/direct-activity-session': DirectActivity,
          '@/app/lib/collaboration/direct-connection': {
            runCollaborationDirectConnection: async (input: Direct.AgentDirectConnectionInput, apply: (doc: Y.Doc) => unknown) => {
              if (++mobileDirectCalls === 2) assert.ok(database.prepare('SELECT yjs_update FROM mobile_notebook_operations').get()?.yjs_update);
              return direct(input, apply);
            },
          },
        });
        const result = await notebook.saveMobileNotebookDocument({
          workspace: { ...workspace, permissions: { canRead: true, canWrite: true } } as WorkspaceContext,
          fileOptions: {}, actorUserId: 'user', actorSessionId: 'mobile-session', path: mobileInput.documentPath,
          content: savedContent, expectedSha256: hash(initialContent), baseRevisionId: 'revision',
          idempotencyKey: 'session-real-mobile',
        });
        assert.equal(mobileDirectCalls, 2);
        assert.equal(result.content, savedContent);
        assert.equal(result.saveReceipt?.durable, true);
        assert.equal(result.saveReceipt?.documentSequence, states.get(mobileInput.documentId)!.documentSequence);
        assert.equal(database.prepare('SELECT yjs_update FROM mobile_notebook_operations').get()?.yjs_update, null,
          'only the durable prepared update is compacted after real server persistence');
        console.log(`PASS actual Mobile ${rich ? 'sequence-zero empty Rich' : 'Plain'} service persists SQL before real Direct apply and durable readback`);
      } finally { database.close(); }
    }

    const binding = source('session-binding');
    await assert.rejects(activitySession({ ...binding, actorId: 'forged-display-actor' },
      async () => assert.fail('user session must be bound to its own authenticated actor')), AgentDirectConnectionAuthorizationError);
    await activitySession(binding, async () => {
      const changes: Array<Partial<DirectActivity.CollaborationDirectActivitySessionInput>> = [
        { documentId: 'foreign' }, { documentPath: 'other.txt' }, { documentRepresentation: 'tiptap_blocks' },
        { documentLifecycleGeneration: 2 }, { documentSchemaVersion: 2 }, { actorId: 'other' },
        { actorSessionId: 'other' }, { initiatedByUserId: 'other' }, { operationId: 'other' },
        { workspace: { ...workspace, workspaceId: 'foreign' } },
        { workspace: { ...workspace, organizationId: 'foreign' } },
      ];
      for (const change of changes) {
        const acquisitions = events.filter(event => event.startsWith('acquire:')).length;
        await assert.rejects(direct({ ...binding, ...change }, () => assert.fail('changed session input must not apply')),
          AgentDirectConnectionAuthorizationError);
        assert.equal(events.filter(event => event.startsWith('acquire:')).length, acquisitions);
      }
      await assert.rejects(documentReader('foreign', workspace.workspaceId, () => assert.fail('foreign reader visitor must not run')),
        AgentDirectConnectionAuthorizationError);
      await assert.rejects(documentReader(binding.documentId, 'foreign', () => assert.fail('foreign workspace visitor must not run')),
        AgentDirectConnectionAuthorizationError);
      const originalState = states.get(binding.documentId)!;
      for (const change of [{ path: 'foreign.txt' }, { organizationId: 'foreign' },
        { representation: 'tiptap_blocks' as const }, { lifecycleGeneration: 2 }, { schemaVersion: 2 }]) {
        states.set(binding.documentId, { ...originalState, ...change });
        await assert.rejects(documentReader(binding.documentId, workspace.workspaceId,
          () => assert.fail('changed native read identity visitor must not run')), AgentDirectConnectionAuthorizationError);
        states.set(binding.documentId, originalState);
      }
      const input = { ...binding };
      const auth = { entered: gate(), release: gate() };
      userAccessBarrier = auth;
      const pending = direct(input, () => assert.fail('input changed during auth await must not apply'));
      await bounded(auth.entered.promise, 'Direct actor validation paused');
      input.operationId = 'changed-after-entry';
      auth.release.resolve();
      await assert.rejects(pending, AgentDirectConnectionAuthorizationError);
      assert.equal(await documentReader(binding.documentId, workspace.workspaceId, doc => doc.getText('content').toString()), 'original');
    });
    console.log('PASS actor/operation/read/native identity changes, including during async admission, cannot reuse a session');

    const saturated = source('session-capacity');
    const activities = Array.from({ length: 128 }, () => ownerRuntime.admitActivity(saturated.documentId));
    try {
      await assert.rejects(activitySession(saturated, async () => assert.fail('capacity must not bypass gate')), busy);
    } finally { for (const activity of activities) activity.release(); }
    console.log('PASS logical session retains normal activity capacity rejection');

    const detached = source('session-detached');
    const continuation = gate();
    let late!: Promise<void>;
    await activitySession(detached, async () => {
      late = continuation.promise.then(async () => {
        await assert.rejects(direct(detached, () => assert.fail('detached Direct must not apply')), busy);
        await assert.rejects(documentReader(detached.documentId, workspace.workspaceId, () => undefined), busy);
      });
    });
    continuation.resolve();
    await bounded(late, 'revoked detached continuation');
    console.log('PASS detached ALS continuations retain revoked session rather than re-admit');

    const thrown = source('session-sync-throw');
    await assert.rejects(activitySession(thrown, () => { throw new Error('deliberate synchronous callback failure'); }),
      /deliberate synchronous callback failure/u);
    const thrownDrain = ownerRuntime.beginActivityDrain(thrown.documentId);
    await bounded(thrownDrain.idle, 'synchronously failed callback releases activity exactly once');
    thrownDrain.finish();
    console.log('PASS synchronous callback failure releases its logical activity without a retained slot');

    const drained = source('session-drain');
    let drain!: ReturnType<OwnerRuntime['beginActivityDrain']>;
    await assert.rejects(activitySession(drained, async session => {
      await direct(drained, () => undefined);
      drain = ownerRuntime.beginActivityDrain(drained.documentId);
      let idle = false;
      void drain.idle.then(() => { idle = true; });
      await turn();
      assert.equal(idle, false, 'explicit drain waits for complete logical session');
      await assert.rejects(direct(drained, () => assert.fail('explicit drain must not apply')), busy);
      await session.assertOpen();
    }), busy);
    await bounded(drain.idle, 'failed session finally releases explicit drain');
    drain.finish();
    await instance.unloadDocument(instance.documents.get(drained.documentId)!);
    console.log('PASS explicit drain revokes session, blocks new apply and quiesces after finally');

    const reserved = source('session-reservation');
    await assert.rejects(activitySession(reserved, async session => {
      await direct(reserved, () => undefined);
      admissionBlocked = true;
      await assert.rejects(direct(reserved, () => assert.fail('foreign reservation must not apply')));
      await session.assertOpen();
    }));
    admissionBlocked = false;
    const revoked = source('session-access-revoked');
    await assert.rejects(activitySession(revoked, async session => {
      await direct(revoked, () => undefined);
      userAccessAllowed = false;
      await assert.rejects(direct(revoked, () => assert.fail('revoked actor must not apply')), AgentDirectConnectionAuthorizationError);
      await assert.rejects(documentReader(revoked.documentId, workspace.workspaceId,
        () => assert.fail('revoked readback visitor must not run')), AgentDirectConnectionAuthorizationError);
      await session.assertOpen();
    }), AgentDirectConnectionAuthorizationError);
    userAccessAllowed = true;
    const changed = source('session-generation');
    await assert.rejects(activitySession(changed, async session => {
      await direct(changed, () => undefined);
      states.set(changed.documentId, { ...states.get(changed.documentId)!, lifecycleGeneration: 2 });
      await session.assertOpen();
    }), AgentDirectConnectionAuthorizationError);
    console.log('PASS reservation, fresh session revocation and changed lifecycle deny post-prepare continuation');

    const replaced = source('session-replaced');
    const oldHandler = activitySession;
    const replacement: DirectActivity.CollaborationDirectActivitySessionHandler = async () => 'replacement' as never;
    let uninstallReplacement!: () => void;
    await assert.rejects(oldHandler(replaced, async session => {
      uninstallReplacement = DirectActivity.installCollaborationDirectActivitySession(replacement);
      await session.assertOpen();
    }));
    assert.equal(DirectActivity.isCollaborationDirectActivitySessionInstalled(replacement), true);
    uninstallReplacement();
    DirectActivity.installCollaborationDirectActivitySession(oldHandler);
    console.log('PASS handler replacement revokes old sessions without granting a new native authority');

    const lost = source('session-owner-lost');
    await assert.rejects(activitySession(lost, async session => {
      await direct(lost, () => undefined);
      sessionActive = false;
      await assert.rejects(direct(lost, () => assert.fail('lost owner must not apply')));
      await session.assertOpen();
    }), (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
    console.log('PASS owner loss rejects complete session before another apply or success');
    return;
  }

  if (mode === 'reader-normal-unload') {
    const leaseFor = (): WorkspaceFileLifecycleLease => ({ active: true, verify: async () => true });
    const withinLease = <T>(lease: WorkspaceFileLifecycleLease, action: () => Promise<T>) =>
      withWorkspaceFileLifecycleLeases(new Map([[workspace.workspaceId, lease]]), action);
    const room = async (id: string) => {
      states.set(id, makeState(id, 'original+latest'));
      const document = await instance.createDocument(id, request, 'reader-loader',
        { isAuthenticated: true, readOnly: false }, contextFor(id));
      // Model a live room newer than its persisted snapshot without spawning
      // a separate unscoped debounce store in the Hocuspocus fixture.
      states.set(id, makeState(id, 'original'));
      return document;
    };
    const busy = (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY';
    const own = leaseFor();
    const id = 'reader-own-normal';
    const document = await room(id);
    const storing = { documentId: id, entered: gate(), release: gate() };
    persistBarrier = storing;
    const unloading = withinLease(own, () => instance.unloadDocument(document));
    await bounded(storing.entered.promise, 'reader-owned final store');
    let customLoaded = false;
    await bounded(withinLease(own, () => assert.rejects(documentReader(id, workspace.workspaceId, () => undefined,
      async key => { customLoaded = true; return states.get(key) ?? null; }), busy)), 'custom transaction loader refuses without waiting');
    assert.equal(customLoaded, false);
    await bounded(withinLease(leaseFor(), () => assert.rejects(documentReader(id, workspace.workspaceId, () => undefined), busy)),
      'foreign lifecycle lease refuses without waiting');
    await bounded(assert.rejects(documentReader(id, workspace.workspaceId, () => undefined), busy),
      'unleased reader refuses without waiting');
    const readsBefore = events.filter(event => event === `load:${id}`).length;
    let readCompleted = false;
    const reading = withinLease(own, () => documentReader(id, workspace.workspaceId,
      current => current.getText('content').toString())).then(value => { readCompleted = true; return value; });
    await turn();
    assert.equal(readCompleted, false, 'the matching reader waits instead of becoming a new activity in the drain');
    assert.equal(events.filter(event => event === `load:${id}`).length, readsBefore, 'state is loaded only after the final store');
    storing.release.resolve();
    await bounded(unloading, 'reader-owned unload completion');
    assert.equal(await bounded(reading, 'reader after proven normal unload'), 'original+latest');
    assert.equal(document.isDestroyed, true);
    let admittedSynchronously = false;
    activityAdmissionObserver = current => { if (current === id) admittedSynchronously = true; };
    const ordinaryRead = documentReader(id, workspace.workspaceId, current => current.getText('content').toString());
    assert.equal(admittedSynchronously, true, 'no-pending read admission does not yield');
    activityAdmissionObserver = null;
    assert.equal(await ordinaryRead, 'original+latest');

    for (const invalidation of ['inactive', 'verification', 'verification-after-wait'] as const) {
      const invalid = leaseFor();
      let verified = true;
      invalid.verify = async () => verified;
      const staleId = `reader-${invalidation}`;
      const stale = await room(staleId);
      const blocked = { documentId: staleId, entered: gate(), release: gate() };
      persistBarrier = blocked;
      const pending = withinLease(invalid, () => instance.unloadDocument(stale));
      await bounded(blocked.entered.promise, 'stale lease final store');
      if (invalidation === 'inactive') invalid.active = false;
      if (invalidation === 'verification') verified = false;
      const refused = withinLease(invalid, () => assert.rejects(documentReader(staleId, workspace.workspaceId, () => undefined), busy));
      if (invalidation === 'verification-after-wait') { await turn(); verified = false; blocked.release.resolve(); }
      await bounded(refused, `refuse ${invalidation} lease`);
      blocked.release.resolve();
      await bounded(pending, 'stale originating unload completion');
    }

    const terminalLease = leaseFor();
    const terminalId = 'reader-terminal-raw';
    const terminal = await room(terminalId);
    const terminalFence = ownerRuntime.fence(terminal);
    const raw = { documentId: terminalId, entered: gate(), release: gate() };
    unloadBarrier = raw;
    const terminalDrain = withinLease(terminalLease, () => localRoomDrainer!(terminalFence.scope));
    await bounded(raw.entered.promise, 'terminal raw unload');
    assert.equal(instance.unloadingDocuments.has(terminalId), true);
    await bounded(withinLease(terminalLease, () => assert.rejects(documentReader(terminalId, workspace.workspaceId, () => undefined), busy)),
      'terminal raw unload is not a normal reader handoff');
    raw.release.resolve();
    await bounded(terminalDrain, 'terminal drain completion');

    const failedLease = leaseFor();
    const failedId = 'reader-local-store-failure';
    const failed = await room(failedId);
    const failedStore = { documentId: failedId, entered: gate(), release: gate() };
    persistBarrier = failedStore;
    afterStoreFailureDocumentId = failedId;
    const failedUnload = withinLease(failedLease, () => instance.unloadDocument(failed));
    await bounded(failedStore.entered.promise, 'retained gated final store');
    const failedRead = withinLease(failedLease, () => assert.rejects(documentReader(failedId, workspace.workspaceId, () => undefined), busy));
    failedStore.release.resolve();
    await bounded(failedUnload, 'known failed normal unload');
    await bounded(failedRead, 'failed gate is never accepted as a snapshot');
    assert.equal(failed.isDestroyed, false);
    assert.equal(failed.getText('content').toString(), 'original+latest');

    const lostLease = leaseFor();
    const lostId = 'reader-lost-store';
    const lost = await room(lostId);
    const lostStore = { documentId: lostId, entered: gate(), release: gate() };
    persistBarrier = lostStore;
    persistFailure = new Error('injected reader final store owner loss');
    const lostUnload = withinLease(lostLease, () => instance.unloadDocument(lost));
    await bounded(lostStore.entered.promise, 'owner-loss final store');
    const lostRead = withinLease(lostLease, () => assert.rejects(documentReader(lostId, workspace.workspaceId, () => undefined),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST'));
    lostStore.release.resolve();
    await bounded(lostUnload, 'owner-loss unload settles');
    await bounded(lostRead, 'owner loss never falls back to persisted state');
    assert.equal(lost.isDestroyed, false);
    assert.equal(lost.getText('content').toString(), 'original+latest');
    console.log('PASS reader waits only for its exact verified normal lifecycle unload; custom/foreign/expired/terminal/failure paths remain strict');
    return;
  }
  if (mode === 'batch-idle-release') {
    const inputFor = (documentId: string) => ({
      documentId, documentPath: `${documentId}.txt`, documentRepresentation: 'plain_text' as const,
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'owned-batch-undo', actorType: 'user' as const,
    });
    const scopeFor = (documentId: string): CollaborationRoomOwnerScope => ({
      documentId, workspaceId: workspace.workspaceId, organizationId: null, path: `${documentId}.txt`,
      representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    });
    const id = 'batch-owned-idle';
    states.set(id, makeState(id, 'original'));
    await direct(inputFor(id), document => { document.getText('content').insert(0, 'inverse '); });
    const document = instance.documents.get(id)!;
    assert(document && !document.isDestroyed, 'Direct return precedes the deferred idle unload');
    const fence = ownerRuntime.fence(document);
    assert.equal(durablyReleased.has(fence), false);
    const activity = ownerRuntime.admitActivity(id);
    await assert.rejects(localIdleRelease!({ scope: scopeFor(id), operationId: 'other-operation' }),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    await assert.rejects(localIdleRelease!({ scope: scopeFor(id), operationId: 'owned-batch-undo' }),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(document.isDestroyed, false, 'even an owned peerless room must wait for its active operation');
    assert.equal(durablyReleased.has(fence), false);
    activity.release();
    unloadBarrier = { documentId: id, entered: gate(), release: gate() };
    const barrier = unloadBarrier;
    let finished = false;
    const releasing = localIdleRelease!({ scope: scopeFor(id), operationId: 'owned-batch-undo' }).then(() => { finished = true; });
    await bounded(barrier.entered.promise, 'owned idle unload boundary');
    assert.equal(finished, false, 'inverse path work must wait for durable release');
    assert.equal(document.isDestroyed, false);
    barrier.release.resolve();
    await bounded(releasing, 'owned idle release proof');
    assert.equal(document.isDestroyed, true);
    assert(durablyReleased.has(fence));
    assert(events.includes(`idle-proof:${id}`));
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, states.get(id)!.yjsState);
    assert.equal(persisted.getText('content').toString(), 'inverse original'); persisted.destroy();

    const peerId = 'batch-owned-peer';
    states.set(peerId, makeState(peerId, 'peer bytes'));
    await direct(inputFor(peerId), () => {});
    const peerDocument = instance.documents.get(peerId)!;
    const peer = socket(peerDocument, 'still-active-peer');
    await assert.rejects(localIdleRelease!({ scope: scopeFor(peerId), operationId: 'owned-batch-undo' }),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(peerDocument.getConnectionsCount(), 1, 'the barrier never force-closes a peer');
    assert.equal(peerDocument.isDestroyed, false); peer.connection.close();

    const foreignId = 'batch-foreign-idle';
    states.set(foreignId, makeState(foreignId, 'foreign bytes'));
    const foreign = await instance.createDocument(foreignId, request, 'foreign-loader',
      { isAuthenticated: true, readOnly: false }, contextFor(foreignId));
    await assert.rejects(localIdleRelease!({ scope: scopeFor(foreignId), operationId: 'owned-batch-undo' }),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(foreign.isDestroyed, false, 'a pre-existing room is never treated as Direct-created ownership');

    const loadingId = 'batch-foreign-loading';
    states.set(loadingId, makeState(loadingId, 'loading foreign bytes'));
    const loading = { documentId: loadingId, entered: gate(), release: gate() };
    loadBarrier = loading;
    pendingGateReleases.push(loading.release.resolve);
    const loadingRoom = instance.createDocument(loadingId, request, 'foreign-loader',
      { isAuthenticated: true, readOnly: false }, contextFor(loadingId));
    await bounded(loading.entered.promise, 'foreign room loading');
    const joinedLoading = gate();
    const originalGet = instance.loadingDocuments.get.bind(instance.loadingDocuments);
    instance.loadingDocuments.get = key => {
      if (key === loadingId) joinedLoading.resolve();
      return originalGet(key);
    };
    const joinedDirect = direct(inputFor(loadingId), () => {});
    await bounded(joinedLoading.promise, 'Direct joins foreign loading room');
    loading.release.resolve();
    const foreignLoading = await loadingRoom;
    await joinedDirect;
    instance.loadingDocuments.get = originalGet;
    await assert.rejects(localIdleRelease!({ scope: scopeFor(loadingId), operationId: 'owned-batch-undo' }),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(foreignLoading.isDestroyed, false, 'joining a foreign startup never upgrades its ownership');

    const failedId = 'batch-owned-store-failure';
    states.set(failedId, makeState(failedId, 'preserved bytes'));
    await direct(inputFor(failedId), document => { document.getText('content').insert(0, 'inverse '); });
    const failedDocument = instance.documents.get(failedId)!;
    const failedFence = ownerRuntime.fence(failedDocument);
    persistFailure = new Error('injected batch idle final-store failure');
    await assert.rejects(localIdleRelease!({ scope: scopeFor(failedId), operationId: 'owned-batch-undo' }),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(failedDocument.isDestroyed, false, 'failed durable store retains the exact live document');
    assert.equal(failedDocument.getText('content').toString(), 'inverse preserved bytes');
    assert.equal(durablyReleased.has(failedFence), false);
    assert.equal(events.includes(`idle-proof:${failedId}`), false, 'failed store never reaches successful vacancy proof');
    await assert.rejects(localIdleRelease!({ scope: scopeFor(failedId), operationId: 'owned-batch-undo' }),
      (error: unknown) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST');
    console.log('PASS batch idle barrier waits for durable exact-owner release and preserves active activity/peer/foreign rooms and failed-store bytes');
    return;
  }
  if (mode === 'admission-writer-gate') {
    const document = await instance.createDocument('doc', request, 'existing-owner', {
      isAuthenticated: true, readOnly: false,
    }, contextFor('doc'));
    socket(document, 'retained-peer');
    const before = document.getText('content').toString();
    const fence = ownerRuntime.fence(document);
    const input = { documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text' as const,
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user' as const, actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'pending-direct' };
    let mutations = 0;
    const apply = () => { mutations++; };
    admissionBlocked = true;
    await assert.rejects(direct(input, apply), { code: 'ADMISSION_CONFLICT' });
    assert.equal(mutations, 0, 'A retained owned room cannot bypass reservation admission.');
    admissionBlocked = false;
    admissionChecks = 0;
    blockOnAdmissionCheck = 2;
    await assert.rejects(direct(input, apply), { code: 'ADMISSION_CONFLICT' });
    assert.equal(admissionChecks, 2, 'Admission is rechecked after opening the direct connection.');
    assert.equal(mutations, 0, 'A reservation accepted between open and transact cannot receive a new writer.');
    assert.equal(document.getText('content').toString(), before);
    assert.equal(ownerRuntime.fence(document), fence);
    assert.equal(sessionActive, true, 'Admission busy does not quarantine unrelated owner authority.');
    assert.ok(admissionLockQueries.length > 0, 'Direct open and post-open revalidation reach admission.');
    assert.ok(admissionLockQueries.every(sql => sql === 'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked'),
      'Every Direct open and post-open revalidation retains strict exclusive writer admission.');
    console.log('PASS pending admission fences retained Direct open and final transact without changing bytes or owner');
    return;
  }

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

    afterUnloadFailureDocumentId = documentId;
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

    const throwingId = 'admission-destroy-listener';
    states.set(throwingId, makeState(throwingId, 'destroy-listener'));
    const throwingDocument = await instance.createDocument(throwingId, request, 'throwing-loader', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(throwingId));
    const throwingFence = fences.get(throwingId)!;
    const throwingTicket = admissionDrainTicketForTarget(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'f'.repeat(64),
      {
        document: { ...throwingFence.scope, status: 'active' }, ownerEpoch: throwingFence.epoch,
        ownerToken: throwingFence.token, ownerBackendPid: throwingFence.backendPid,
        ownerBackendStart: throwingFence.backendStart, documentSequence: 1,
      },
    );
    drainStatuses.set(throwingTicket.releaseId, 'draining');
    throwingDocument.on('destroy', () => { throw new Error('injected destroy listener failure'); });
    await bounded(localTicketDrainer(throwingTicket), 'ticket destroy-listener cleanup');
    assert.equal(throwingDocument.isDestroyed, true);
    assert.equal(instance.documents.has(throwingId), false);
    assert.equal(instance.unloadingDocuments.has(throwingId), false);
    assert.equal(ownerRuntime.isDraining(throwingId), false);
    assert.equal(releaseSnapshots.filter(
      (snapshot) => snapshot?.admission?.releaseId === throwingTicket.releaseId,
    ).length, 1);
    const throwingReplacement = await instance.createDocument(throwingId, request, 'throwing-replacement', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(throwingId));
    assert.notEqual(ownerRuntime.fence(throwingReplacement), throwingFence,
      'a fresh exact object can claim only after the destroyed terminal handle finished');
    const throwingPersistCount = persistCalls.filter((call) => call.documentId === throwingId).length;
    await localTicketDrainer(throwingTicket);
    assert.equal(instance.documents.get(throwingId), throwingReplacement);
    assert.equal(persistCalls.filter((call) => call.documentId === throwingId).length, throwingPersistCount,
      'a repeated completed destroy-listener ticket never stores the replacement');
    assert.equal(releaseSnapshots.filter(
      (snapshot) => snapshot?.admission?.releaseId === throwingTicket.releaseId,
    ).length, 1, 'destroy-listener cleanup never repeats durable release');

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

  if (mode === 'normal-unload') {
    const directId = 'normal-direct-unload';
    states.set(directId, makeState(directId, 'normal'));
    const directDestroyed = gate();
    let directDocument: Y.Doc | undefined;
    await bounded(direct({
      documentId: directId, documentPath: `${directId}.txt`, documentRepresentation: 'plain_text',
      documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: false,
      workspace, actorType: 'user', actorId: 'user', actorDisplayName: 'User', initiatedByUserId: 'user',
      operationId: 'normal-direct-unload',
    }, (document) => {
      directDocument = document;
      document.on('destroy', directDestroyed.resolve);
      document.getText('content').insert(document.getText('content').length, '+direct');
    }), 'Direct disconnect before deferred normal unload');
    assert.ok(directDocument);
    await bounded(directDestroyed.promise, 'deferred normal unload after Direct activity idle');
    assert.equal(instance.documents.has(directId), false);
    const directPersisted = new Y.Doc();
    try {
      Y.applyUpdate(directPersisted, states.get(directId)!.yjsState);
      assert.equal(directPersisted.getText('content').toString(), 'normal+direct');
    } finally {
      directPersisted.destroy();
    }
    console.log('PASS Direct disconnect defers normal terminal drain until its own activity is idle');

    const gatedId = 'normal-gated-unload';
    states.set(gatedId, makeState(gatedId, 'gated'));
    const gatedDocument = await instance.createDocument(gatedId, request, 'gated-loader', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(gatedId));
    const gatedFence = fences.get(gatedId)!;
    const gatedPersist = { documentId: gatedId, entered: gate(), release: gate() };
    persistBarrier = gatedPersist;
    gatedDocument.on('destroy', () => { events.push(`destroy:${gatedId}`); });
    const gatedUnload = instance.unloadDocument(gatedDocument);
    await bounded(gatedPersist.entered.promise, 'normal final store under terminal gate');
    assert.equal(released.includes(gatedFence), false,
      'durable release cannot precede the final store');
    await assert.rejects(instance.createDocument(gatedId, request, 'late-raw-loader', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(gatedId)),
    (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    gatedPersist.release.resolve();
    await bounded(gatedUnload, 'normal exact-object unload');
    const persistEvent = events.lastIndexOf(`persist:${gatedId}`);
    const releaseEvent = events.lastIndexOf(`release:${gatedId}`);
    const destroyEvent = events.lastIndexOf(`destroy:${gatedId}`);
    assert.equal(persistEvent >= 0 && persistEvent < releaseEvent && releaseEvent < destroyEvent, true,
      'final store precedes receipt-backed release, which precedes exact-object destroy');
    assert.equal(gatedDocument.isDestroyed, true);
    const gatedSnapshot = releaseSnapshots.at(-1)!;
    assert.deepEqual(Buffer.from(gatedSnapshot.yjsState), Buffer.from(states.get(gatedId)!.yjsState));
    console.log('PASS normal unload stores exact bytes, gates late opens, proves release, then destroys');

    const retryId = 'normal-store-hook-retry';
    states.set(retryId, makeState(retryId, 'retry'));
    const retryDocument = await instance.createDocument(retryId, request, 'retry-loader', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(retryId));
    const retryFence = fences.get(retryId)!;
    const retryDestroyed = gate();
    retryDocument.on('destroy', retryDestroyed.resolve);
    afterStoreFailureDocumentId = retryId;
    const retryPersistBefore = persistCalls.filter((call) => call.documentId === retryId).length;
    await bounded(instance.unloadDocument(retryDocument), 'first local hook failure');
    assert.equal(instance.documents.get(retryId), retryDocument);
    assert.equal(retryDocument.isDestroyed, false);
    assert.equal(ownerRuntime.fence(retryDocument), retryFence,
      'a local hook failure retains the exact active fence for retry');
    assert.equal(released.includes(retryFence), false);
    await bounded(retryDestroyed.promise, 'automatic local store-hook retry');
    assert.equal(persistCalls.filter((call) => call.documentId === retryId).length, retryPersistBefore + 2);
    assert.equal(released.filter((fence) => fence === retryFence).length, 1);
    console.log('PASS local final-store hook failure retains the room and later retry releases once');

    const cleanupId = 'normal-destroy-cleanup';
    states.set(cleanupId, makeState(cleanupId, 'cleanup'));
    const cleanupDocument = await instance.createDocument(cleanupId, request, 'cleanup-loader', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(cleanupId));
    const cleanupFence = fences.get(cleanupId)!;
    const cleanupStoresBefore = persistCalls.filter((call) => call.documentId === cleanupId).length;
    cleanupDocument.on('destroy', () => { throw new Error('injected normal destroy listener failure'); });
    afterUnloadFailureDocumentId = cleanupId;
    await bounded(instance.unloadDocument(cleanupDocument), 'normal destroy-listener cleanup');
    assert.equal(cleanupDocument.isDestroyed, true);
    assert.equal(instance.documents.has(cleanupId), false);
    assert.equal(instance.unloadingDocuments.has(cleanupId), false);
    assert.equal(ownerRuntime.isDraining(cleanupId), false);
    assert.equal(persistCalls.filter((call) => call.documentId === cleanupId).length, cleanupStoresBefore + 1);
    assert.equal(released.filter((fence) => fence === cleanupFence).length, 1);
    const cleanupReplacement = await instance.createDocument(cleanupId, request, 'cleanup-replacement', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(cleanupId));
    const cleanupReplacementFence = fences.get(cleanupId)!;
    assert.notEqual(cleanupReplacementFence, cleanupFence);
    await bounded(instance.unloadDocument(cleanupDocument), 'stale normal unload retry');
    assert.equal(instance.documents.get(cleanupId), cleanupReplacement);
    assert.equal(ownerRuntime.fence(cleanupReplacement), cleanupReplacementFence);
    assert.equal(persistCalls.filter((call) => call.documentId === cleanupId).length, cleanupStoresBefore + 1,
      'a stale old-object unload never stores the replacement');
    assert.equal(released.filter((fence) => fence === cleanupFence).length, 1,
      'a stale old-object unload never repeats durable release');
    await bounded(instance.unloadDocument(cleanupReplacement), 'fresh cleanup replacement unload');
    console.log('PASS normal destroy/after-unload failures finish once and cannot affect a fresh replacement');

    const recoveryId = 'normal-release-recovery';
    states.set(recoveryId, makeState(recoveryId, 'recovery'));
    const recoveryDocument = await instance.createDocument(recoveryId, request, 'recovery-loader', {
      isAuthenticated: true, readOnly: false,
    }, contextFor(recoveryId));
    const recoveryDestroyed = gate();
    recoveryDocument.on('destroy', recoveryDestroyed.resolve);
    const recoveryStoresBefore = persistCalls.filter((call) => call.documentId === recoveryId).length;
    const recoveryReleasesBefore = releaseSnapshots.length;
    const recoveryReadsBefore = recoveredReleases.length;
    releaseFailure = new Error('lost normal release acknowledgement');
    recoverReleaseFailure = new Error('transient normal receipt read failure');
    await bounded(instance.unloadDocument(recoveryDocument), 'first normal release recovery read');
    assert.equal(instance.documents.get(recoveryId), recoveryDocument);
    assert.equal(recoveryDocument.isDestroyed, false);
    await bounded(recoveryDestroyed.promise, 'normal release receipt retry');
    assert.equal(persistCalls.filter((call) => call.documentId === recoveryId).length, recoveryStoresBefore + 1,
      'receipt retry never repeats the final store');
    assert.equal(releaseSnapshots.length, recoveryReleasesBefore + 1,
      'receipt retry never repeats the owner-session release command');
    assert.equal(recoveredReleases.length, recoveryReadsBefore + 2,
      'one failed receipt read is retried read-only before local destroy');
    assert.equal(recoveredReleases.at(-1)?.snapshot.releaseId,
      recoveredReleases.at(-2)?.snapshot.releaseId);
    console.log('PASS lost normal release acknowledgement retries receipt proof without double store or release');
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
    const persisted = states.get(documentId)!;
    const releaseSnapshot = durableReleaseSnapshots.at(-1)!;
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
  if (process.argv[2] === '--native-read-busy-postgres') {
    await main('native-read-busy-postgres');
    return;
  }
  const modes = [
    'direct-activity-session',
    'direct-activity-session-close',
    'direct-activity-session-unavailable',
    'admission-writer-gate',
    'batch-idle-release',
    'reader-normal-unload',
    'normal-unload',
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
