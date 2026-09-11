import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Server from '../server/collaboration-server';
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';

async function main() {
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Already persisted agent edit');
  const state: PersistedCollaborationState = {
    documentId: 'doc', workspaceId: 'workspace', organizationId: 'organization', path: 'document.md',
    lifecycleGeneration: 4, representation: 'plain_text', documentSequence: 5, checkpointSequence: 2,
    stateVector: Y.encodeStateVector(doc), yjsState: Y.encodeStateAsUpdate(doc), status: 'active', schemaVersion: 1,
    persistedAt: 1, checkpointedAt: 0, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false,
  };
  const claims: CollaborationTicketClaims = {
    schemaVersion: 1, issuedAt: 0, expiresAt: Date.now() + 60_000, userId: 'user', sessionId: 'session',
    documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
    path: state.path, provider: 'yjs', representation: state.representation, permission: 'write',
    lifecycleGeneration: state.lifecycleGeneration,
  };
  const newContext = () => ({ claims: { ...claims }, actorType: 'user', observedDocumentSequence: null as number | null });
  let context = newContext();
  const connection = { context, readOnly: false };
  let loaded: PersistedCollaborationState | null = state;
  let reads = 0;
  let accessChecks = 0;
  let accessDenied = false;
  let writes = 0;
  let authCalls = 0;
  let delayedReads: Array<(value: PersistedCollaborationState | null) => void> | null = null;
  const conflictInputs: Array<{ observedDocumentSequence: number | null; doc: Y.Doc }> = [];
  let hooks!: Record<string, (input: Record<string, unknown>) => Promise<void>>;
  class FakeHocuspocus {
    documents = new Map([['doc', doc]]);
    constructor(options: typeof hooks) { hooks = options; }
  }
  const filename = path.resolve('server/collaboration-server.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const server = {} as typeof Server;
  // Capture production Hocuspocus callbacks without binding a port. Every storage
  // write and authorization entry point is counted, independently of ack handling.
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@hocuspocus/server') return { Hocuspocus: FakeHocuspocus };
    if (name === 'ws') return { WebSocketServer: class extends EventEmitter {} };
    if (name.endsWith('/persistence')) return {
      loadCollaborationState: async (documentId: string) => {
        assert.equal(documentId, 'doc'); reads++;
        return delayedReads ? new Promise<PersistedCollaborationState | null>((resolve) => delayedReads!.push(resolve)) : loaded;
      },
      persistCollaborationYDoc: async () => { writes++; throw new Error('Unexpected persistence from acknowledgement'); },
      markCollaborationDegraded: async () => { writes++; },
    };
    if (name.endsWith('/projection-runtime')) return { createCollaborationProjectionRuntime: () => ({
      enqueue: () => { writes++; }, dispose() {},
    }) };
    if (name.endsWith('/access-monitor')) return { createCollaborationAccessMonitor: () => ({
      add: () => () => {}, dispose() {}, check: async () => {
        accessChecks++;
        if (accessDenied) throw new Error('Revoked access');
      },
    }) };
    if (name.endsWith('/auth')) return { auth: { api: { getSession: async () => { authCalls++; return null; } } } };
    if (name.endsWith('/runtime-state')) return { installCollaborationRoomInspector() {} };
    if (name.endsWith('/document-access')) return { installCollaborationDocumentReader() {} };
    if (name.endsWith('/direct-connection')) return { installCollaborationDirectConnection() {} };
    if (name.endsWith('/agent-operations')) return {
      recoverCollaborationAgentOperations: async () => {},
      detectLateAgentSemanticConflicts: async (input: typeof conflictInputs[number]) => { conflictInputs.push(input); },
    };
    if (name.endsWith('/health')) return { setCollaborationRuntimeHealth() {} };
    if (name.endsWith('/server-runtime')) return { Y };
    if (name.endsWith('/failure') || name.endsWith('/state-proof')) return load(name);
    if (name.startsWith('@/')) return {};
    return load(name);
  }, { exports: server }, server);
  const httpServer = new EventEmitter();
  const wss = server.createCollaborationServer(httpServer as unknown as http.Server);
  await hooks.onLoadDocument({ documentName: 'doc', document: doc });
  const ack = (sequence = 5, type = 'durability_ack') => ({
    type, documentId: claims.documentId, lifecycleGeneration: claims.lifecycleGeneration, sequence,
  });
  const send = (payload: unknown, documentName = 'doc') => hooks.onStateless({
    connection, documentName, payload: JSON.stringify(payload),
  });
  let checks = 0;
  const check = (label: string, assertion: () => void) => { assertion(); checks++; console.log(`PASS ${label}`); };
  const reset = () => { context = newContext(); connection.context = context; loaded = state; };
  try {
    await send(ack(5, 'checkpoint_ack'));
    check('legacy checkpoint ack remains bounded by the projected file sequence', () => assert.equal(context.observedDocumentSequence, null));
    await send(ack(2, 'checkpoint_ack'));
    check('older clients can still acknowledge completed Markdown projections', () => assert.equal(context.observedDocumentSequence, 2));
    await send(ack());
    check('binary ack advances observation while Markdown remains behind', () => assert.equal(context.observedDocumentSequence, 5));
    const priorReads = reads;
    await send(ack(4)); await send(ack(5)); await send(ack(1, 'checkpoint_ack'));
    check('duplicate and stale acknowledgements neither regress observation nor reread storage', () => {
      assert.equal(context.observedDocumentSequence, 5); assert.equal(reads, priorReads);
    });
    await send(ack(6));
    check('a claimed future sequence cannot advance beyond actual Yjs persistence', () => assert.equal(context.observedDocumentSequence, 5));
    await hooks.onChange({ documentName: 'doc', document: doc, context });
    check('subsequent user changes reach semantic-conflict detection with the binary observation', () => {
      assert.equal(conflictInputs.at(-1)?.observedDocumentSequence, 5);
      assert.equal(conflictInputs.at(-1)?.doc, doc);
    });
    reset();
    await hooks.onChange({ documentName: 'doc', document: doc, context });
    check('a reconnect starts without inheriting another connection acknowledgement', () => assert.equal(conflictInputs.at(-1)?.observedDocumentSequence, null));

    const readsBeforeMalformed = reads;
    for (const invalid of [null, [], true, 5, 'text', {},
      { ...ack(), type: 'save' }, { ...ack(), documentId: 'other' }, { ...ack(), lifecycleGeneration: 3 },
      ...[-1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 1].map((sequence) => ({ ...ack(), sequence }))]) {
      await send(invalid);
    }
    await hooks.onStateless({ connection, documentName: 'doc', payload: '{' });
    await send(ack(), 'different-room');
    connection.context.claims.documentId = 'foreign-claim';
    await send(ack());
    check('malformed, foreign and stale-generation payloads are ignored before storage access', () => {
      assert.equal(context.observedDocumentSequence, null); assert.equal(reads, readsBeforeMalformed);
    });

    for (const invalid of [null, { ...state, documentId: 'other' }, { ...state, workspaceId: 'other' },
      { ...state, organizationId: null }, { ...state, organizationId: 'other' }, { ...state, path: 'renamed.md' },
      { ...state, representation: 'tiptap_blocks' as const }, { ...state, lifecycleGeneration: 5 },
      { ...state, status: 'archived' as const }]) {
      reset(); loaded = invalid;
      await send(ack());
      assert.equal(context.observedDocumentSequence, null);
    }
    reset(); connection.context.claims.provider = 'excalidraw'; await send(ack());
    check('persisted identity, lifecycle, workspace and organization must match the authenticated document', () => assert.equal(context.observedDocumentSequence, null));

    reset();
    connection.context.claims.permission = 'read'; connection.readOnly = true;
    await send(ack());
    check('read-only peers can report observation without obtaining write permission', () => {
      assert.equal(context.observedDocumentSequence, 5);
      assert.equal(connection.readOnly, true); assert.equal(connection.context.claims.permission, 'read');
    });
    accessDenied = true;
    await assert.rejects(hooks.beforeHandleMessage({ update: new Uint8Array(), connection }), /Revoked access/);
    check('binary acknowledgement cannot bypass per-message authorization', () => {
      assert.equal(accessChecks, 1); assert.equal(connection.readOnly, true);
    });

    reset(); delayedReads = [];
    const earlier = send(ack(3)); const later = send(ack(5));
    assert.equal(delayedReads.length, 2);
    delayedReads[1](state); await later;
    delayedReads[0](state); await earlier;
    check('reordered storage reads preserve the highest confirmed observation', () => assert.equal(context.observedDocumentSequence, 5));
    reset(); delayedReads = [];
    const replacedContext = send(ack());
    connection.context = newContext();
    delayedReads[0](state); await replacedContext;
    check('an acknowledgement cannot escape its original connection context', () => {
      assert.equal(context.observedDocumentSequence, null); assert.equal(connection.context.observedDocumentSequence, null);
    });
    reset(); delayedReads = [];
    const changedGeneration = send(ack());
    context.claims.lifecycleGeneration++;
    delayedReads[0](state); await changedGeneration;
    check('generation is rechecked after asynchronous persistence lookup', () => assert.equal(context.observedDocumentSequence, null));
    check('acknowledgements never persist, enqueue projection, or authenticate a mutation', () => {
      assert.equal(writes, 0); assert.equal(authCalls, 0);
      assert.equal(state.documentSequence, 5); assert.equal(state.checkpointSequence, 2);
      assert.deepEqual(Y.encodeStateAsUpdate(doc), state.yjsState);
    });
    console.log(`Durability acknowledgement server: ${checks} checks passed.`);
  } finally {
    httpServer.emit('close'); wss.emit('close'); doc.destroy();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
