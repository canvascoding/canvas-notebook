import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import * as Direct from '../app/lib/collaboration/direct-connection';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type * as Server from '../server/collaboration-server';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-room-generation-'));
  const originalData = process.env.DATA; const originalRoot = process.env.CANVAS_DATA_ROOT;
  process.env.DATA = data; process.env.CANVAS_DATA_ROOT = data;
  const initial = new Y.Doc(); initial.getText('content').insert(0, 'Durable content');
  const workspace = { workspaceId: 'room-generation-test', organizationId: null, workspaceType: 'personal' } as WorkspaceContext;
  let state: PersistedCollaborationState = { documentId: 'doc', workspaceId: workspace.workspaceId, organizationId: null,
    path: 'doc.txt', lifecycleGeneration: 1, representation: 'plain_text', documentSequence: 1, checkpointSequence: 1,
    stateVector: Y.encodeStateVector(initial), yjsState: Y.encodeStateAsUpdate(initial), status: 'active', schemaVersion: 1,
    persistedAt: 1, checkpointedAt: 1, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false };
  const claims: CollaborationTicketClaims = { ...state, schemaVersion: 1, issuedAt: 0, expiresAt: Date.now() + 60_000,
    userId: 'user', sessionId: 'stored-session', permission: 'write', provider: 'yjs' };
  const context = { claims, workspace, user: { id: 'agent', name: 'Agent', email: null }, actorType: 'agent',
    initiatedByUserId: 'user', operationId: 'op', observedDocumentSequence: null, releaseRoomAdmission: null };
  let instance!: Hocuspocus;
  const captureInstance = (value: Hocuspocus) => { instance = value; };
  let direct!: Parameters<typeof Direct.installCollaborationDirectConnection>[0];
  let readDocument!: (documentId: string, workspaceId: string, read: (document: Y.Doc) => unknown) => Promise<unknown>;
  let stored = 0;
  let loadCount = 0;
  let loadBarrier: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
  let projections!: Parameters<typeof import('../app/lib/collaboration/projection-runtime').createCollaborationProjectionRuntime>[0];
  class StaleError extends Error {}
  class InactiveError extends Error {}
  class ObservedHocuspocus extends Hocuspocus {
    constructor(options: ConstructorParameters<typeof Hocuspocus>[0]) {
      super({ ...options, onLoadDocument: async (payload) => {
        const result = await options?.onLoadDocument?.(payload);
        loadCount++;
        const barrier = loadBarrier;
        if (barrier) { barrier.entered.resolve(); await barrier.release.promise; }
        return result;
      } });
      captureInstance(this);
    }
  }
  const filename = path.resolve('server/collaboration-server.ts'); const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const server = {} as typeof Server;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@hocuspocus/server') return { Hocuspocus: ObservedHocuspocus };
    if (name === 'ws') return { WebSocketServer: class extends EventEmitter {} };
    if (name.endsWith('/persistence')) return {
      CollaborationStateStaleError: StaleError, CollaborationStateInactiveError: InactiveError,
      loadCollaborationState: async () => state,
      persistCollaborationYDoc: async (_id: string, generation: number, document: Y.Doc) => {
        if (generation !== state.lifecycleGeneration) throw new StaleError();
        stored++; state = { ...state, yjsState: Y.encodeStateAsUpdate(document), stateVector: Y.encodeStateVector(document),
          documentSequence: state.documentSequence + 1 }; return state;
      },
      markCollaborationDegraded() { throw new Error('Unexpected durability incident'); },
    };
    if (name.endsWith('/direct-connection')) return { ...Direct, installCollaborationDirectConnection: (handler: typeof direct) => { direct = handler; } };
    if (name.endsWith('/document-access')) return { installCollaborationDocumentReader: (handler: typeof readDocument) => { readDocument = handler; } };
    if (name.endsWith('/runtime-state')) return {
      installCollaborationRoomInspector() {}, reserveCollaborationRoomAdmission: () => () => {},
      withCollaborationRoomLifecycleLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
    };
    if (name.endsWith('/workspace-mutation-lock')) return { withWorkspaceMutationLock };
    if (name.endsWith('/session-workspace-context')) return { resolveAgentExecutionContextForStoredSession: async () => workspace,
      workspaceFromAgentExecutionContext: (value: WorkspaceContext) => value };
    if (name.endsWith('/collaboration-policy')) return { readFileCollaborationState: async () => ({ document: { id: 'doc', status: 'active', provider: 'yjs' } }) };
    if (name.endsWith('/projection-runtime')) return { createCollaborationProjectionRuntime: (callbacks: typeof projections) => {
      projections = callbacks; return { enqueue() {}, dispose() {} };
    } };
    if (name.endsWith('/access-monitor')) return { createCollaborationAccessMonitor: () => ({ dispose() {} }) };
    if (name.endsWith('/agent-operations')) return { recoverCollaborationAgentOperations: async () => {} };
    if (name.endsWith('/health')) return { setCollaborationRuntimeHealth() {} };
    if (name.endsWith('/presence')) return { replaceDocumentPresence() {} };
    if (name.endsWith('/diagnostics')) return { logCollaborationDiagnostic() {} };
    if (name.endsWith('/server-runtime')) return { Y };
    if (name.endsWith('/state-proof') || name.endsWith('/failure')) return load(name);
    if (name.startsWith('@/')) return {};
    return load(name);
  }, { exports: server }, server);
  const httpServer = new EventEmitter(); server.createCollaborationServer(httpServer as unknown as http.Server);
  const input: Direct.AgentDirectConnectionInput = { documentId: 'doc', documentPath: 'doc.txt', documentRepresentation: 'plain_text',
    documentLifecycleGeneration: 1, documentSchemaVersion: 1, requiresFileCheckpointIdentity: true, workspace,
    actorId: 'agent', actorDisplayName: 'Agent', initiatedByUserId: 'user', operationId: 'op', actorSessionId: 'stored-session' };
  try {
    // Real Hocuspocus caches this active direct connection by document ID.
    const oldConnection = await instance.openDirectConnection('doc', context);
    const oldRoom = oldConnection.document!;
    await oldConnection.transact((document) => document.getText('content').insert(0, 'Late old room: '));
    const restoredBytes = Uint8Array.from(state.yjsState);
    state = { ...state, lifecycleGeneration: 3 };
    let edits = 0;
    await assert.rejects(direct({ ...input, documentLifecycleGeneration: 3 }, (document) => {
      edits++; document.getText('content').insert(0, 'must not apply');
    }), Direct.AgentDirectConnectionAuthorizationError);
    assert.equal(edits, 0);
    assert.equal(instance.documents.get('doc'), oldRoom, 'the old connection remains cached during this race');
    assert.deepEqual(state.yjsState, restoredBytes, 'a new context cannot persist the old room under the restored generation');
    assert.equal(stored, 0);
    await assert.rejects(readDocument('doc', workspace.workspaceId, (document) => document.getText('content').toString()),
      Direct.AgentDirectConnectionAuthorizationError);

    // The old room also rejects a new-generation websocket sync before Yjs handles it.
    await assert.rejects(instance.hooks('beforeSync', { context: { ...context, claims: { ...claims, lifecycleGeneration: 3 } },
      document: oldRoom, connection: {} as never, type: 2, payload: new Uint8Array(),
      documentName: 'doc', clientsCount: oldRoom.getConnectionsCount() }), Direct.AgentDirectConnectionAuthorizationError);
    await oldConnection.disconnect({ unloadImmediately: true });
    assert.equal(stored, 0); assert.equal(instance.documents.has('doc'), false);

    // A fresh room loads the restored bytes and accepts edits for exactly that generation.
    await direct({ ...input, documentLifecycleGeneration: 3 }, (document) => {
      assert.equal(document.getText('content').toString(), 'Durable content');
      document.getText('content').insert(0, 'New generation: ');
    });
    assert.equal(stored, 1);
    const reopened = await instance.openDirectConnection('doc', { ...context, claims: { ...claims, lifecycleGeneration: 3 } });
    const room = reopened.document!;
    assert.equal(room.getText('content').toString(), 'New generation: Durable content');
    await instance.unloadDocument(oldRoom);
    assert.equal(instance.documents.get('doc'), room, 'a late unload for the old room must not delete the new room map entry');
    assert.equal(room.isDestroyed, false);
    const emitted: unknown[] = [];
    room.broadcastStateless = (payload: string) => { emitted.push(JSON.parse(payload)); };
    projections.onFailure({ state: { ...state, lifecycleGeneration: 1 }, code: 'OLD_FAILURE', blocksEditing: true });
    projections.onProjected({ state: { ...state, lifecycleGeneration: 1 }, content: 'old', revisionId: 'old' });
    assert.deepEqual(emitted, [], 'late projection callbacks cannot affect the replacement room');

    // Rename preserves document identity and does not discard the current live room.
    state = { ...state, path: 'renamed.txt' };
    await direct({ ...input, documentPath: 'renamed.txt', documentLifecycleGeneration: 3 }, (document) => {
      assert.equal(document, room); document.getText('content').insert(0, 'After rename: ');
    });
    assert.equal(room.getText('content').toString(), 'After rename: New generation: Durable content');
    await reopened.disconnect({ unloadImmediately: true });

    const renamedInput = { ...input, documentPath: 'renamed.txt', documentLifecycleGeneration: 3 };
    loadBarrier = { entered: gate(), release: gate() };
    const previousLoads = loadCount;
    const firstOpening = direct(renamedInput, (document) => document.getText('content').toString());
    await loadBarrier.entered.promise;
    assert.equal(instance.documents.has('doc'), false, 'a loading room is not exposed before onLoadDocument completes');
    const secondOpening = direct(renamedInput, (document) => document.getText('content').toString());
    await new Promise<void>((resolve) => setImmediate(resolve));
    loadBarrier.release.resolve(); loadBarrier = null;
    assert.deepEqual(await Promise.all([firstOpening, secondOpening]),
      ['After rename: New generation: Durable content', 'After rename: New generation: Durable content']);
    assert.equal(loadCount, previousLoads + 1, 'legitimate parallel first openings share one correctly pinned room');

    loadBarrier = { entered: gate(), release: gate() };
    const oldOpening = direct(renamedInput, () => { throw new Error('Old generation must not apply'); });
    await loadBarrier.entered.promise;
    const savedBeforeRestore = Uint8Array.from(state.yjsState); const writesBeforeRestore = stored;
    state = { ...state, lifecycleGeneration: 5 };
    const newOpening = direct({ ...renamedInput, documentLifecycleGeneration: 5 }, () => { throw new Error('New generation must not borrow a loading old room'); });
    // Attach rejection handlers before releasing the deliberately delayed loader.
    const openings = Promise.allSettled([oldOpening, newOpening]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    loadBarrier.release.resolve(); loadBarrier = null;
    for (const result of await openings) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert(result.reason instanceof Direct.AgentDirectConnectionAuthorizationError);
    }
    assert.equal(stored, writesBeforeRestore); assert.deepEqual(state.yjsState, savedBeforeRestore);
    assert.equal(instance.documents.has('doc'), false);
    console.log('Real Hocuspocus rooms: stale generations rejected before apply/sync/read/store; late unload/projection callbacks cannot affect a replacement; rename, parallel initial opens and restore during delayed loading passed.');
  } finally {
    httpServer.emit('close');
    loadBarrier?.release.resolve();
    for (const room of instance.documents.values()) {
      await instance.debouncer.executeNow(`onStoreDocument-${room.name}`);
      room.destroy();
    }
    instance.documents.clear(); initial.destroy();
    if (originalData === undefined) delete process.env.DATA; else process.env.DATA = originalData;
    if (originalRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = originalRoot;
    await fs.rm(data, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
