import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type http from 'node:http';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import * as Y from 'yjs';
import { collaborationFailure, COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import type * as Server from '../server/collaboration-server';
import type * as CheckpointRoute from '../app/api/files/collaboration/checkpoint/route';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { createCollaborationProjectionRuntime } from '../app/lib/collaboration/projection-runtime';

async function compile<T>(file: string, substitute: (name: string, load: NodeRequire) => unknown): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exports = {};
  new Function('require', 'module', 'exports', compiled.outputText)(
    (name: string) => substitute(name, load), { exports }, exports,
  );
  return exports as T;
}

async function main() {
  // Error messages and unknown payloads are deliberately not treated as permission to repair.
  for (const code of [null, undefined, 'roundtrip_unstable', 'private document text', {}, ['COLLABORATION_SCHEMA_INVALID']]) {
    assert.deepEqual(collaborationFailure(code), { kind: 'unknown', code: null });
  }
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Untouched original');
  const original = Y.encodeStateAsUpdate(doc);
  const state: PersistedCollaborationState = { documentId: 'doc', workspaceId: 'workspace', organizationId: 'organization', path: 'document.md',
    lifecycleGeneration: 1, representation: 'plain_text', documentSequence: 2, checkpointSequence: 1,
    stateVector: Y.encodeStateVector(doc), yjsState: original, status: 'active', schemaVersion: 1,
    persistedAt: 1, checkpointedAt: 0, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false };
  let loadedState = state;
  let persistenceFailure: Error | null = null;
  let degradedCount = 0;
  let closed = 0;
  let projectionDisposed = 0;
  let accessMonitorDisposed = 0;
  let projectionCallbacks!: Parameters<typeof createCollaborationProjectionRuntime>[0];
  const queuedProjections: PersistedCollaborationState[] = [];
  const documents = new Map();
  class StaleError extends Error {}
  class InactiveError extends Error {}
  class SupersededError extends Error { sequence = 3; }
  let hooks!: Record<string, (input: Record<string, unknown>) => Promise<void>>;
  class FakeHocuspocus {
    documents = documents;
    constructor(options: typeof hooks) { hooks = options; }
    closeConnections(documentId: string) { assert.equal(documentId, 'doc'); closed++; }
  }
  const persistence = {
    CollaborationStateInactiveError: InactiveError, CollaborationStateStaleError: StaleError,
    loadCollaborationState: async () => loadedState,
    persistCollaborationYDoc: async () => { if (persistenceFailure) throw persistenceFailure; return state; },
    markCollaborationDegraded: async () => { degradedCount++; },
  };
  const server = await compile<typeof Server>('server/collaboration-server.ts', (name, load) => {
    if (name === '@hocuspocus/server') return { Hocuspocus: FakeHocuspocus };
    if (name === 'ws') return { WebSocketServer: class extends EventEmitter {} };
    if (name.endsWith('/persistence')) return persistence;
    if (name.endsWith('/projection-runtime')) return {
      createCollaborationProjectionRuntime: (callbacks: typeof projectionCallbacks) => {
        projectionCallbacks = callbacks;
        return {
          enqueue: (snapshot: PersistedCollaborationState) => {
            queuedProjections.push(snapshot);
            // If the server starts awaiting background work again, store() must
            // fail before this intentionally unresolved export can complete.
            return new Promise<void>(() => {});
          },
          dispose: () => { projectionDisposed++; },
        };
      },
    };
    if (name.endsWith('/access-monitor')) return { createCollaborationAccessMonitor: () => ({
      add: () => () => {}, check: async () => {}, dispose: () => { accessMonitorDisposed++; },
    }) };
    if (name.endsWith('/diagnostics')) return { logCollaborationDiagnostic() {} };
    if (name.endsWith('/runtime-state')) return { installCollaborationRoomInspector() {} };
    if (name.endsWith('/document-access')) return { installCollaborationDocumentReader() {} };
    if (name.endsWith('/direct-connection')) return { installCollaborationDirectConnection() {} };
    if (name.endsWith('/agent-operations')) return { recoverCollaborationAgentOperations: async () => {} };
    if (name.endsWith('/health')) return { setCollaborationRuntimeHealth() {} };
    if (name.endsWith('/server-runtime')) return { Y };
    if (name.endsWith('/failure') || name.endsWith('/checkpoint-errors') || name.endsWith('/state-proof')) return load(name);
    if (name.startsWith('@/')) return {};
    return load(name);
  });
  const httpServer = new EventEmitter();
  const wss = server.createCollaborationServer(httpServer as unknown as http.Server);
  const emitted: Array<{ type: string; code?: string; documentId?: string; lifecycleGeneration?: number;
    documentSequence?: number; checkpointSequence?: number; stateVector?: string; stateProof?: string;
    sequence?: number; revisionId?: string; message?: string }> = [];
  const lastContext = { claims: { ...state, sessionId: 'session' }, workspace: {}, user: { id: 'user' }, actorType: 'user' };
  const storeInput = { documentName: 'doc', lastContext,
    document: { broadcastStateless: (payload: string) => emitted.push(JSON.parse(payload)) } };
  await hooks.onLoadDocument({ documentName: 'doc', document: storeInput.document });
  documents.set('doc', storeInput.document);
  const lastFailure = () => collaborationFailure(emitted.at(-1)?.code);
  const store = async () => {
    emitted.length = 0;
    queuedProjections.length = 0;
    await Promise.race([
      hooks.onStoreDocument(storeInput),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('onStoreDocument waited for background projection')))),
    ]);
  };
  const assertSnapshot = (snapshot: PersistedCollaborationState, message = emitted.at(-1)) => {
    assert.equal(message?.documentId, snapshot.documentId);
    assert.equal(message?.lifecycleGeneration, snapshot.lifecycleGeneration);
    assert.equal(message?.documentSequence, snapshot.documentSequence);
    assert.equal(message?.checkpointSequence, snapshot.checkpointSequence);
    assert.equal(message?.stateVector, Buffer.from(snapshot.stateVector).toString('base64'));
    assert.equal(message?.stateProof, collaborationStateProof(doc, Y));
  };
  try {
    loadedState = { ...state, lifecycleGeneration: 2 };
    await hooks.connected({ context: { claims: state }, connection: {
      sendStateless: (payload: string) => emitted.push(JSON.parse(payload)), close() { closed++; },
    } });
    assert.equal(lastFailure().kind, 'lifecycle'); assert.equal(closed, 1);
    loadedState = state;
    persistenceFailure = new StaleError('Generation changed');
    await store(); assert.equal(lastFailure().kind, 'lifecycle'); assert.equal(closed, 2); assert.equal(degradedCount, 0);
    persistenceFailure = new InactiveError('Deleted document');
    await store(); assert.equal(emitted.length, 0, 'a deleted document must not be resurrected or reported as a durability failure');
    persistenceFailure = new Error('Storage unavailable');
    await assert.rejects(store, /Storage unavailable/);
    assert.equal(lastFailure().kind, 'storage'); assert.equal(lastFailure().code, COLLABORATION_FAILURE_CODES.persistenceFailed);
    persistenceFailure = null;
    for (const code of ['schema_invalid', 'stable_id_missing', 'stable_id_duplicate', 'roundtrip_unstable'] as const) {
      const validationError = new CollaborationCheckpointValidationError(code);
      await store();
      assert.deepEqual(queuedProjections, [state]);
      assert.equal(emitted.length, 1, 'store completes before any projection result is available');
      assert.equal(emitted[0].type, 'durability_snapshot', 'binary persistence has its own acknowledgement');
      assertSnapshot(state);
      const blocksEditing = code !== 'roundtrip_unstable';
      projectionCallbacks.onFailure({ state, code: validationError.code, blocksEditing });
      assert.equal(emitted.at(-1)?.type, blocksEditing ? 'degraded' : 'projection_failed');
      assertSnapshot(state);
      assert.equal(lastFailure().kind, 'validation'); assert.equal(lastFailure().code, validationError.code);
      if (!blocksEditing) assert.equal(emitted.at(-1)?.message, undefined, 'projection failures do not present a blocking editor message');
    }
    await store();
    projectionCallbacks.onFailure({ state, code: COLLABORATION_CHECKPOINT_ERROR_CODES.failed, blocksEditing: false });
    assert.equal(lastFailure().kind, 'storage');
    assert.equal(emitted.at(-1)?.type, 'projection_failed');
    assertSnapshot(state);
    await store();
    const projected = { ...state, checkpointSequence: state.documentSequence };
    projectionCallbacks.onProjected({ state: projected, content: 'Untouched original', revisionId: 'revision' });
    assert.equal(emitted.at(-1)?.type, 'checkpointed');
    assert.equal(emitted.at(-1)?.sequence, 2);
    assert.equal(emitted.at(-1)?.revisionId, 'revision');
    assertSnapshot(projected);
    assert.equal(emitted.at(-1)?.code, undefined, 'a successful snapshot does not carry a prior failure');
    const ahead = { ...projected, documentSequence: 3 };
    projectionCallbacks.onProjected({ state: ahead, content: 'Untouched original', revisionId: 'revision' });
    assert.equal(emitted.at(-1)?.type, 'durability_snapshot', 'an older client must not infer that a newer binary sequence was exported');
    assertSnapshot(ahead);
    documents.delete('doc');
    const beforeClosedRoom = emitted.length;
    projectionCallbacks.onProjected({ state: projected, content: 'Untouched original', revisionId: 'revision' });
    projectionCallbacks.onFailure({ state, code: COLLABORATION_CHECKPOINT_ERROR_CODES.failed, blocksEditing: false });
    assert.equal(emitted.length, beforeClosedRoom, 'background results do not recreate closed rooms');

    const route = await compile<typeof CheckpointRoute>('app/api/files/collaboration/checkpoint/route.ts', (name, load) => {
      if (name.endsWith('/request')) return { requireRequestWorkspace: async () => ({
        workspace: { workspaceId: 'workspace', organizationId: 'organization' }, session: { user: { id: 'user' }, session: { id: 'session' } },
      }) };
      if (name.endsWith('/route-helpers')) return { applyRateLimit: () => null, readJsonBody: (request: Request) => request.json() };
      if (name.endsWith('/ticket')) return { verifyCollaborationTicket: () => ({ ...state, provider: 'yjs', permission: 'write', userId: 'user', sessionId: 'session' }) };
      if (name.endsWith('/persistence')) return persistence;
      if (name.endsWith('/server-runtime')) return { Y };
      if (name.endsWith('/audit-service')) return { recordAuditEvent() {} };
      if (name.endsWith('/checkpoint')) return { CollaborationCheckpointSupersededError: SupersededError };
      return load(name);
    });
    const request = (proof = collaborationStateProof(doc, Y)) => new NextRequest('https://canvas.test/api/files/collaboration/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test', stateVector: Buffer.from(state.stateVector).toString('base64'), stateProof: proof }),
    });
    loadedState = { ...state, lifecycleGeneration: 2 };
    const stale = await route.POST(request());
    assert.equal(stale.status, 409); assert.equal((await stale.json()).code, COLLABORATION_FAILURE_CODES.generationChanged);
    loadedState = state;
    const behind = await route.POST(request('yjs-snapshot-sha256-v1:' + 'a'.repeat(64)));
    assert.equal(behind.status, 409); assert.equal((await behind.json()).code, undefined,
      'a persistence delay remains retryable and is distinct from an obsolete generation');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), original);
    assert.equal(projectionDisposed, 0);
    httpServer.emit('close');
    assert.equal(projectionDisposed, 1, 'server shutdown disposes the background runtime');
    assert.equal(accessMonitorDisposed, 1, 'server shutdown disposes access monitoring');
    wss.emit('close');
    assert.equal(accessMonitorDisposed, 2, 'standalone websocket shutdown also disposes access monitoring');
    console.log('Server acknowledges durable Yjs without awaiting projection; separate projection results retain identity/proof and lifecycle protection.');
  } finally { httpServer.emit('close'); doc.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
