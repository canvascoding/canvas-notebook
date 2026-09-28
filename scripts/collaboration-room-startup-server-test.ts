import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

import { AuthMessageType } from '@hocuspocus/common';
import {
  Hocuspocus,
  MessageType,
  type Document,
} from '@hocuspocus/server';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import ts from 'typescript';
import * as Y from 'yjs';

import { createCollaborationRoomActivityGate } from '../app/lib/collaboration/room-activity-gate';
import { createCollaborationRoomStartupActivity } from '../app/lib/collaboration/room-startup-activity';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';
import type * as CollaborationServer from '../server/collaboration-server';

type Gate = {
  promise: Promise<void>;
  resolve(): void;
};

const pendingGates: Gate[] = [];

function gate(): Gate {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  let resolved = false;
  const value = {
    promise,
    resolve() {
      if (resolved) return;
      resolved = true;
      resolvePromise();
    },
  };
  pendingGates.push(value);
  return value;
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

async function waitFor(predicate: () => boolean, label: string) {
  await bounded((async () => {
    while (!predicate()) await turn();
  })(), label);
}

function stateFor(documentId: string): PersistedCollaborationState {
  const document = new Y.Doc();
  try {
    document.getText('content').insert(0, documentId);
    return {
      documentId,
      workspaceId: 'startup-workspace',
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

function claimsFor(documentId: string): CollaborationTicketClaims {
  return {
    schemaVersion: 1,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    userId: 'startup-user',
    sessionId: 'startup-session',
    workspaceId: 'startup-workspace',
    organizationId: null,
    documentId,
    path: `${documentId}.txt`,
    provider: 'yjs',
    representation: 'plain_text',
    permission: 'write',
    lifecycleGeneration: 1,
  };
}

function authFrame(documentId: string) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentId);
  encoding.writeVarUint(encoder, MessageType.Auth);
  encoding.writeVarUint(encoder, AuthMessageType.Token);
  encoding.writeVarString(encoder, documentId);
  return encoding.toUint8Array(encoder);
}

function authSubtype(bytes: Uint8Array): number | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    decoding.readVarString(decoder);
    if (decoding.readVarUint(decoder) !== MessageType.Auth) return null;
    return decoding.readVarUint(decoder);
  } catch {
    return null;
  }
}

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Uint8Array[] = [];
  throwAuthenticated = false;
  closeCalls = 0;

  send(data: ArrayBuffer | ArrayBufferView) {
    const bytes = data instanceof Uint8Array
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    if (this.throwAuthenticated && authSubtype(bytes) === AuthMessageType.Authenticated) {
      throw new Error('simulated authenticated send failure');
    }
    this.sent.push(bytes);
  }

  close(code = 1000, reason = 'closed') {
    if (this.readyState >= 2) return;
    this.closeCalls += 1;
    this.readyState = 2;
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', code, Buffer.from(reason));
    });
  }

  peerClose(code = 1000, reason = 'peer closed') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  receive(bytes: Uint8Array) {
    this.emit('message', Buffer.from(bytes));
  }
}

class FakeWebSocketServer extends EventEmitter {
  handleUpgrade(
    _request: http.IncomingMessage,
    socket: FakeWebSocket,
    _head: Buffer,
    callback: (websocket: FakeWebSocket) => void,
  ) {
    callback(socket);
  }
}

class CollaborationRoomOwnerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CollaborationRoomOwnerError';
  }
}

class AgentDirectConnectionAuthorizationError extends Error {}

async function main() {
  const filename = path.resolve('server/collaboration-server.ts');
  const load = createRequire(filename);
  const realHocuspocus = load('@hocuspocus/server') as typeof import('@hocuspocus/server');
  const states = new Map<string, PersistedCollaborationState>();
  const loadCounts = new Map<string, number>();
  const loadGates = new Map<string, Gate>();
  const authGates = new Map<string, Gate>();
  const authEntered = new Map<string, Gate>();
  const authFailures = new Set<string>();
  const loadFailures = new Set<string>();
  const connectedFailures = new Set<string>();
  const postLoadGates = new Map<string, { entered: Gate; release: Gate }>();
  const claimed = new WeakSet<Y.Doc>();
  const activityGate = createCollaborationRoomActivityGate();
  const clientConnections = new Set<ReturnType<Hocuspocus['handleConnection']>>();
  const createdDocuments = new Set<Document>();
  let ownerRuntime!: {
    admitActivity: ReturnType<typeof createCollaborationRoomActivityGate>['admit'];
    beginActivityDrain: ReturnType<typeof createCollaborationRoomActivityGate>['beginDrain'];
    tryBeginIdleTerminalDrain(document: Y.Doc): {
      idle: Promise<void>;
      releaseDurably(snapshot: unknown): Promise<void>;
      finish(): void;
    } | undefined;
    isDraining(documentId: string): boolean;
    claim(document: Y.Doc): Promise<object>;
    release(document: Y.Doc): Promise<void>;
    fence(document: Y.Doc): object;
    canUnload(document: Y.Doc): boolean;
    waitForRelease(documentId: string): Promise<void>;
    assertAvailable(): void;
    dispose(): Promise<void>;
  };
  let hocuspocus!: Hocuspocus;
  const captureHocuspocus = (instance: Hocuspocus) => { hocuspocus = instance; };

  class ObservedHocuspocus extends Hocuspocus {
    constructor(options: ConstructorParameters<typeof Hocuspocus>[0]) {
      super({
        ...options,
        async onLoadDocument(payload) {
          createdDocuments.add(payload.document);
          return options?.onLoadDocument?.(payload);
        },
      });
      captureHocuspocus(this);
    }

    override handleConnection(...args: Parameters<Hocuspocus['handleConnection']>) {
      const connection = super.handleConnection(...args);
      clientConnections.add(connection);
      return connection;
    }

  }

  const runtimeModule = {
    createCollaborationRoomOwnerRuntime(options: { onActivityIdle?: (documentId: string) => void }) {
      const terminalDrains = new WeakMap<Y.Doc, {
        released: boolean;
        drain: ReturnType<typeof activityGate.beginDrain>;
      }>();
      const drainingIds = new Set<string>();
      ownerRuntime = {
        admitActivity(documentId: string) {
          const lease = activityGate.admit(documentId);
          let released = false;
          return {
            assertOpen: lease.assertOpen,
            release() {
              if (released) return;
              released = true;
              lease.release();
              if (activityGate.isIdle(documentId)) options.onActivityIdle?.(documentId);
            },
          };
        },
        beginActivityDrain(documentId: string) {
          const drain = activityGate.beginDrain(documentId);
          return {
            idle: drain.idle,
            finish() {
              drain.finish();
              // Test probes use a real drain to observe startup activity. Once
              // the probe reopens admission, replay the server's deferred-idle
              // signal so the probe itself does not suppress orphan cleanup.
              options.onActivityIdle?.(documentId);
            },
          };
        },
        tryBeginIdleTerminalDrain(document: Y.Doc) {
          const documentId = (document as Document).name;
          if (terminalDrains.has(document) || !activityGate.isIdle(documentId)) return undefined;
          const drain = activityGate.beginDrain(documentId);
          drainingIds.add(documentId);
          const terminal = {
            released: false,
            drain,
          };
          const handle = {
            idle: drain.idle,
            async releaseDurably(_snapshot: unknown) {
              claimed.delete(document);
              terminal.released = true;
            },
            finish() {
              assert.equal(terminal.released, true);
              assert.equal(document.isDestroyed, true);
              drain.finish();
              drainingIds.delete(documentId);
              terminalDrains.delete(document);
            },
          };
          terminalDrains.set(document, terminal);
          return handle;
        },
        isDraining: (documentId: string) => drainingIds.has(documentId),
        async claim(document: Y.Doc) {
          claimed.add(document);
          return {};
        },
        async release(document: Y.Doc) {
          claimed.delete(document);
        },
        fence(document: Y.Doc) {
          if (!claimed.has(document)) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
          return {};
        },
        canUnload(document: Y.Doc) {
          const terminal = terminalDrains.get(document);
          return !terminal || terminal.released;
        },
        waitForRelease: async () => {},
        assertAvailable() {},
        async dispose() { activityGate.dispose(); },
      };
      return ownerRuntime;
    },
  };

  const workspace = {
    workspaceId: 'startup-workspace',
    organizationId: null,
    workspaceType: 'personal',
  };
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  const unloadCoordinatorFilename = path.resolve('app/lib/collaboration/owned-room-unload.ts');
  const compiledUnloadCoordinator = ts.transpileModule(await fs.readFile(unloadCoordinatorFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const unloadCoordinator = {} as typeof import('../app/lib/collaboration/owned-room-unload');
  new Function('require', 'module', 'exports', compiledUnloadCoordinator.outputText)((name: string) => {
    if (name === 'server-only') return {};
    return createRequire(unloadCoordinatorFilename)(name);
  }, { exports: unloadCoordinator }, unloadCoordinator);
  const exported = {} as typeof CollaborationServer;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@hocuspocus/server') return { ...realHocuspocus, Hocuspocus: ObservedHocuspocus };
    if (name === 'ws') return { WebSocketServer: FakeWebSocketServer };
    if (name.endsWith('/room-owner-runtime')) return runtimeModule;
    if (name.endsWith('/owned-room-unload')) return unloadCoordinator;
    if (name.endsWith('/room-startup-activity')) return { createCollaborationRoomStartupActivity };
    if (name.endsWith('/local-room-drain')) return {
      installLocalCollaborationRoomDrainer: () => () => {},
    };
    if (name.endsWith('/room-owner')) return { CollaborationRoomOwnerError };
    if (name.endsWith('/auth')) return {
      auth: {
        api: {
          async getSession(input: { headers: Headers }) {
            const attempt = input.headers.get('x-attempt') ?? '';
            authEntered.get(attempt)?.resolve();
            const blocker = authGates.get(attempt);
            if (blocker) await blocker.promise;
            if (authFailures.has(attempt)) throw new Error('simulated authentication failure');
            return {
              user: { id: 'startup-user', name: 'Startup User', email: 'startup@example.invalid', role: 'user' },
              session: { id: 'startup-session' },
            };
          },
        },
      },
    };
    if (name.endsWith('/ticket')) return {
      verifyCollaborationTicket: (token: string) => claimsFor(token),
    };
    if (name.endsWith('/connection-access')) return {
      resolveCollaborationSessionAccess: async () => ({
        workspace,
        user: { id: 'startup-user', name: 'Startup User', email: 'startup@example.invalid', role: 'user' },
      }),
      assertCollaborationDocumentAccess: async () => {},
      revalidateCollaborationAccess: async () => ({
        workspace,
        user: { id: 'startup-user', name: 'Startup User', email: 'startup@example.invalid', role: 'user' },
      }),
    };
    if (name.endsWith('/persistence')) return {
      CollaborationStateInactiveError: class extends Error {},
      CollaborationStateStaleError: class extends Error {},
      async loadCollaborationState(documentId: string) {
        loadCounts.set(documentId, (loadCounts.get(documentId) ?? 0) + 1);
        const blocker = loadGates.get(documentId);
        if (blocker) await blocker.promise;
        if (loadFailures.has(documentId)) throw new Error('simulated document load failure');
        return states.get(documentId) ?? null;
      },
      persistCollaborationYDoc: async (documentId: string, _generation: number, document: Y.Doc) => {
        const previous = states.get(documentId);
        if (!previous) throw new Error('missing startup-test collaboration state');
        const next = {
          ...previous,
          yjsState: Y.encodeStateAsUpdate(document),
          stateVector: Y.encodeStateVector(document),
          documentSequence: previous.documentSequence + 1,
          persistenceDisposition: 'advanced' as const,
          incomingNeedsReconcile: false,
        };
        states.set(documentId, next);
        return next;
      },
      markCollaborationDegraded: async () => {},
    };
    if (name.endsWith('/access-monitor')) return {
      createCollaborationAccessMonitor: () => ({
        add: () => () => {},
        async check(connection: { document?: Document }) {
          if (connection.document && connectedFailures.has(connection.document.name)) {
            throw new Error('simulated connected hook failure');
          }
        },
        dispose() {},
      }),
    };
    if (name.endsWith('/runtime-state')) return {
      installCollaborationRoomInspector() {},
      reserveCollaborationRoomAdmission: () => () => {},
      withCollaborationRoomLifecycleLock: async (_documentId: string, operation: () => Promise<unknown>) => operation(),
    };
    if (name.endsWith('/runtime-policy')) return { liveCollaborationRuntimeAvailable: () => true };
    if (name.endsWith('/trusted-origins')) return { isConfiguredTrustedOrigin: () => true };
    if (name.endsWith('/collaboration-ticket')) return {
      consumeMobileCollaborationTicket: () => null,
      hasMobileCollaborationProtocol: () => false,
      MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL: 'canvas-mobile',
    };
    if (name.endsWith('/service') && name.includes('/user-profile/')) return {
      resolveUserProfile: async () => ({
        displayName: 'Startup User', initials: 'SU', color: '#000000', imageUrl: null, revision: 1,
      }),
    };
    if (name.endsWith('/service') && name.includes('/file-guests/')) return {
      fileGuestService: { access: async () => { throw new Error('unexpected guest access'); } },
    };
    if (name.endsWith('/types') && name.includes('/file-guests/')) return {
      fileGuestCookieName: () => 'guest',
    };
    if (name.endsWith('/update-policy')) return { assertFileGuestUpdateAllowed: async () => {} };
    if (name.endsWith('/projection-runtime')) return {
      createCollaborationProjectionRuntime: () => ({ enqueue() {}, dispose() {} }),
    };
    if (name.endsWith('/direct-connection')) return {
      AgentDirectConnectionAuthorizationError,
      installCollaborationDirectConnection() {},
    };
    if (name.endsWith('/document-access')) return { installCollaborationDocumentReader() {} };
    if (name.endsWith('/session-workspace-context')) return {
      resolveAgentExecutionContextForStoredSession: async () => workspace,
      workspaceFromAgentExecutionContext: () => workspace,
    };
    if (name.endsWith('/collaboration-policy')) return { readFileCollaborationState: async () => null };
    if (name.endsWith('/workspace-mutation-lock')) return {
      withWorkspaceMutationLock: async (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
    };
    if (name.endsWith('/room-mutation-lock')) return {
      acquireCollaborationRoomMutationLock: async () => () => {},
      withCollaborationRoomMutationLock: async (_document: Y.Doc, operation: () => Promise<unknown>) => operation(),
    };
    if (name.endsWith('/agent-operations')) return {
      detectLateAgentSemanticConflicts: async () => {},
      recoverCollaborationAgentOperations: async () => {},
      recoverProposalGraphActions: async () => ({ recovered: 0, pending: 0 }),
    };
    if (name.endsWith('/history-service')) return {
      fileVersionHistoryService: { capturePersistedCollaboration: async () => {} },
    };
    if (name.endsWith('/server-runtime')) return { Y };
    if (name.endsWith('/state-proof')) return { collaborationUpdateStateProof: () => 'proof' };
    if (name.endsWith('/failure')) return {
      COLLABORATION_FAILURE_CODES: {
        generationChanged: 'COLLABORATION_GENERATION_CHANGED',
        persistenceFailed: 'COLLABORATION_PERSISTENCE_FAILED',
      },
    };
    if (name.endsWith('/identity')) return { collaborationUserColors: ['#000000'] };
    if (name.endsWith('/health')) return { setCollaborationRuntimeHealth() {} };
    if (name.endsWith('/presence')) return { replaceDocumentPresence() {} };
    if (name.endsWith('/diagnostics')) return { logCollaborationDiagnostic() {} };
    if (name.startsWith('@/')) return {};
    return load(name);
  }, { exports: exported }, exported);

  const httpServer = new EventEmitter();
  const webSocketServer = exported.createCollaborationServer(httpServer as unknown as http.Server, {
    roomOwner: {
      createSession: async () => { throw new Error('fake runtime does not create a database session'); },
      heartbeatMs: 60_000,
    },
  });
  // Install this test seam outside the server's startup.run wrapper. It creates
  // the otherwise tiny gap where load has completed but ClientConnection has
  // not yet created the Connection whose disconnect hook can settle startup.
  const createDocumentAfterStartupRun = hocuspocus.createDocument.bind(hocuspocus);
  hocuspocus.createDocument = async (...args) => {
    const document = await createDocumentAfterStartupRun(...args);
    const blocker = postLoadGates.get(document.name);
    if (blocker) {
      blocker.entered.resolve();
      await blocker.release.promise;
    }
    return document;
  };
  const sockets = new Set<FakeWebSocket>();

  const connect = (documentId: string, attempt: string, options: { throwAuthenticated?: boolean } = {}) => {
    states.set(documentId, stateFor(documentId));
    const websocket = new FakeWebSocket();
    websocket.throwAuthenticated = options.throwAuthenticated ?? false;
    sockets.add(websocket);
    const request = {
      url: '/ws/collaboration',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'x-attempt': attempt,
        'x-document': documentId,
      },
    } as unknown as http.IncomingMessage;
    const networkSocket = Object.assign(new EventEmitter(), {
      write() {},
      destroy() {},
    });
    httpServer.emit('upgrade', request, websocket, Buffer.alloc(0), networkSocket);
    return websocket;
  };

  const hasAuthResponse = (socket: FakeWebSocket, subtype: AuthMessageType) => (
    socket.sent.some((bytes) => authSubtype(bytes) === subtype)
  );
  const assertDrainPending = async (drain: { idle: Promise<void> }, message: string) => {
    let idle = false;
    void drain.idle.then(() => { idle = true; });
    await turn();
    assert.equal(idle, false, message);
  };

  try {
    authFailures.add('auth-failure');
    const authFailure = connect('auth-failure-doc', 'auth-failure');
    authFailure.receive(authFrame('auth-failure-doc'));
    await waitFor(
      () => hasAuthResponse(authFailure, AuthMessageType.PermissionDenied),
      'authentication failure response',
    );
    const authFailureDrain = ownerRuntime.beginActivityDrain('auth-failure-doc');
    await bounded(authFailureDrain.idle, 'authentication failure activity release');
    authFailureDrain.finish();
    assert.equal(hocuspocus.documents.has('auth-failure-doc'), false);
    console.log('PASS authentication failure settles the startup activity');

    const pendingAuthGate = gate();
    const pendingAuthEntered = gate();
    authGates.set('pending-auth-close', pendingAuthGate);
    authEntered.set('pending-auth-close', pendingAuthEntered);
    const pendingAuth = connect('pending-auth-doc', 'pending-auth-close');
    pendingAuth.receive(authFrame('pending-auth-doc'));
    await bounded(pendingAuthEntered.promise, 'pending authentication entry');
    const pendingAuthDrain = ownerRuntime.beginActivityDrain('pending-auth-doc');
    pendingAuth.peerClose();
    await assertDrainPending(
      pendingAuthDrain,
      'socket close must not release an authentication operation that is still running',
    );
    pendingAuthGate.resolve();
    await bounded(pendingAuthDrain.idle, 'closed pending authentication completion');
    pendingAuthDrain.finish();
    console.log('PASS socket close cancels but does not prematurely settle pending authentication');

    const parallelGate = gate();
    const parallelEntered = gate();
    authGates.set('same-doc-pending', parallelGate);
    authEntered.set('same-doc-pending', parallelEntered);
    const parallel = connect('same-doc', 'same-doc-pending');
    parallel.receive(authFrame('same-doc'));
    await bounded(parallelEntered.promise, 'parallel same-document authentication entry');
    const throwing = connect('same-doc', 'same-doc-throw', { throwAuthenticated: true });
    throwing.receive(authFrame('same-doc'));
    await waitFor(
      () => hasAuthResponse(throwing, AuthMessageType.PermissionDenied),
      'authenticated-send failure terminal denial',
    );
    const sameDocumentDrain = ownerRuntime.beginActivityDrain('same-doc');
    await assertDrainPending(
      sameDocumentDrain,
      'terminal fallback for one request must not settle another request for the same document',
    );
    parallel.peerClose();
    parallelGate.resolve();
    await bounded(sameDocumentDrain.idle, 'parallel same-document authentication completion');
    sameDocumentDrain.finish();
    console.log('PASS authenticated send failure settles only its request-correlated startup');

    loadFailures.add('load-failure-doc');
    const loadFailure = connect('load-failure-doc', 'load-failure');
    loadFailure.receive(authFrame('load-failure-doc'));
    await waitFor(
      () => hasAuthResponse(loadFailure, AuthMessageType.PermissionDenied),
      'load failure response',
    );
    const loadFailureDrain = ownerRuntime.beginActivityDrain('load-failure-doc');
    await bounded(loadFailureDrain.idle, 'load failure activity release');
    loadFailureDrain.finish();
    assert.equal(hocuspocus.documents.has('load-failure-doc'), false);
    assert.equal(
      [...createdDocuments].find((document) => document.name === 'load-failure-doc')?.isDestroyed,
      true,
      'a failed pre-claim load destroys the orphan Hocuspocus document',
    );
    console.log('PASS document load failure settles the startup activity');

    const pendingLoadGate = gate();
    loadGates.set('pending-load-doc', pendingLoadGate);
    const pendingLoad = connect('pending-load-doc', 'pending-load-close');
    pendingLoad.receive(authFrame('pending-load-doc'));
    await waitFor(
      () => (loadCounts.get('pending-load-doc') ?? 0) > 0,
      'pending document load entry',
    );
    const pendingLoadDrain = ownerRuntime.beginActivityDrain('pending-load-doc');
    pendingLoad.peerClose();
    await assertDrainPending(
      pendingLoadDrain,
      'socket close must not release a document load that is still running',
    );
    pendingLoadGate.resolve();
    await bounded(pendingLoadDrain.idle, 'closed pending load completion');
    pendingLoadDrain.finish();
    await waitFor(() => !hocuspocus.documents.has('pending-load-doc'), 'orphan pending-load document cleanup');
    console.log('PASS close during load waits for load cleanup before releasing activity');

    const postLoadEntered = gate();
    const postLoadRelease = gate();
    postLoadGates.set('post-load-close-doc', { entered: postLoadEntered, release: postLoadRelease });
    const postLoadClose = connect('post-load-close-doc', 'post-load-close');
    postLoadClose.receive(authFrame('post-load-close-doc'));
    await bounded(postLoadEntered.promise, 'completed load before ClientConnection continuation');
    const postLoadDrain = ownerRuntime.beginActivityDrain('post-load-close-doc');
    postLoadClose.peerClose();
    await assertDrainPending(
      postLoadDrain,
      'close after load completion must not release before createDocument continuation settles',
    );
    postLoadRelease.resolve();
    await bounded(postLoadDrain.idle, 'post-load close continuation completion');
    postLoadDrain.finish();
    await waitFor(
      () => !hocuspocus.documents.has('post-load-close-doc'),
      'post-load close orphan document cleanup',
    );
    console.log('PASS close between load completion and Connection setup retains activity until cleanup');

    connectedFailures.add('connected-failure-doc');
    const connectedFailure = connect('connected-failure-doc', 'connected-failure');
    connectedFailure.receive(authFrame('connected-failure-doc'));
    await waitFor(
      () => hasAuthResponse(connectedFailure, AuthMessageType.PermissionDenied),
      'connected hook failure response',
    );
    const connectedFailureDrain = ownerRuntime.beginActivityDrain('connected-failure-doc');
    await bounded(connectedFailureDrain.idle, 'connected hook failure activity release');
    connectedFailureDrain.finish();
    await waitFor(
      () => (hocuspocus.documents.get('connected-failure-doc')?.getConnectionsCount() ?? 0) === 0,
      'connected hook failure connection cleanup',
    );
    assert.equal(
      hocuspocus.documents.get('connected-failure-doc')?.getConnectionsCount() ?? 0,
      0,
      'connected failure closes the real Hocuspocus document connection',
    );
    console.log('PASS connected hook failure closes the connection and settles activity');

    loadFailures.add('multiplex-failure-doc');
    const multiplex = connect('multiplex-failure-doc', 'multiplex');
    multiplex.receive(authFrame('multiplex-failure-doc'));
    await waitFor(
      () => hasAuthResponse(multiplex, AuthMessageType.PermissionDenied),
      'multiplex first document load failure',
    );
    states.set('multiplex-success-doc', stateFor('multiplex-success-doc'));
    multiplex.receive(authFrame('multiplex-success-doc'));
    await waitFor(
      () => (hocuspocus.documents.get('multiplex-success-doc')?.getConnectionsCount() ?? 0) === 1,
      'multiplex unrelated document connection',
    );
    assert.equal(
      multiplex.sent.filter((bytes) => authSubtype(bytes) === AuthMessageType.Authenticated).length >= 2,
      true,
      'both multiplexed document attempts reached authenticated protocol state',
    );
    const multiplexFailureDrain = ownerRuntime.beginActivityDrain('multiplex-failure-doc');
    await bounded(multiplexFailureDrain.idle, 'multiplex failed-document activity release');
    multiplexFailureDrain.finish();
    const multiplexSuccessDrain = ownerRuntime.beginActivityDrain('multiplex-success-doc');
    await bounded(multiplexSuccessDrain.idle, 'multiplex successful-document startup release');
    multiplexSuccessDrain.finish();
    console.log('PASS one multiplexed document can connect after an unrelated document fails');
  } finally {
    for (const blocker of pendingGates) blocker.resolve();
    for (const socket of sockets) socket.peerClose();
    for (const connection of clientConnections) connection.handleClose();
    await turn();
    for (const document of [...hocuspocus.documents.values()]) {
      await hocuspocus.unloadDocument(document).catch(() => undefined);
    }
    for (const document of createdDocuments) {
      if (!document.isDestroyed) document.destroy();
    }
    httpServer.emit('close');
    webSocketServer.emit('close');
    await turn();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
