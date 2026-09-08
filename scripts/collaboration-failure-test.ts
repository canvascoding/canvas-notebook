import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type http from 'node:http';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import * as Y from 'yjs';
import { collaborationFailure, COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { CollaborationCheckpointValidationError } from '../app/lib/collaboration/checkpoint-errors';
import type * as Server from '../server/collaboration-server';
import type * as CheckpointRoute from '../app/api/files/collaboration/checkpoint/route';

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
  const state = { documentId: 'doc', workspaceId: 'workspace', organizationId: 'organization', path: 'document.md',
    lifecycleGeneration: 1, representation: 'plain_text', documentSequence: 2, checkpointSequence: 1,
    stateVector: Y.encodeStateVector(doc), yjsState: original, status: 'active' };
  let loadedState = state;
  let persistenceFailure: Error | null = null;
  let checkpointFailure: Error | null = null;
  let degradedCount = 0;
  let closed = 0;
  class StaleError extends Error {}
  class InactiveError extends Error {}
  class SupersededError extends Error { sequence = 3; }
  let hooks!: Record<string, (input: Record<string, unknown>) => Promise<void>>;
  class FakeHocuspocus {
    documents = new Map();
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
    if (name === 'ws') return { WebSocketServer: class {} };
    if (name.endsWith('/persistence')) return persistence;
    if (name.endsWith('/checkpoint')) return { CollaborationCheckpointSupersededError: SupersededError,
      materializeCollaborationCheckpoint: async () => { if (checkpointFailure) throw checkpointFailure; return { state, revisionId: 'revision' }; } };
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
  server.createCollaborationServer({ on() {} } as unknown as http.Server);
  const emitted: { type: string; code?: string }[] = [];
  const lastContext = { claims: { ...state, sessionId: 'session' }, workspace: {}, user: { id: 'user' }, actorType: 'user' };
  const storeInput = { documentName: 'doc', lastContext,
    document: { broadcastStateless: (payload: string) => emitted.push(JSON.parse(payload)) } };
  const lastFailure = () => collaborationFailure(emitted.at(-1)?.code);
  const store = async () => { emitted.length = 0; await hooks.onStoreDocument(storeInput); };
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
      checkpointFailure = validationError;
      await store();
      assert.equal(emitted[0].type, 'durability_snapshot', 'the binary acknowledgement precedes a failed Markdown checkpoint');
      assert.equal(lastFailure().kind, 'validation'); assert.equal(lastFailure().code, validationError.code);
    }
    checkpointFailure = new Error('File write failed');
    await store(); assert.equal(lastFailure().kind, 'storage');
    checkpointFailure = null;
    await store(); assert.equal(emitted.at(-1)?.type, 'checkpointed');
    assert.equal(emitted.at(-1)?.code, undefined, 'a successful snapshot does not carry a prior failure');

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
    console.log('Server callbacks and checkpoint route distinguish validation, storage, inactive documents and generation failures without changing document data.');
  } finally { doc.destroy(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
