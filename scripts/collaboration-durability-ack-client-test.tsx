import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';

type Acknowledgement = { type: string; documentId: string; lifecycleGeneration: number; sequence: number };
type ProviderOptions = {
  document: Y.Doc;
  onStatus: (value: { status: string }) => void;
  onSynced: () => void;
  onUnsyncedChanges: (value: { number: number }) => void;
  onStateless: (value: { payload: string }) => void;
  onAuthenticationFailed: (value: { reason: string }) => void;
};

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const priorGlobals = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const seed = new Y.Doc(); seed.getText('content').insert(0, 'ABCD');
  const providers: FakeProvider[] = [];
  class FakeProvider {
    sent: Acknowledgement[] = [];
    destroyed = false;
    disconnected = false;
    constructor(readonly options: ProviderOptions) { providers.push(this); }
    setAwarenessField() {}
    sendStateless(payload: string) { this.sent.push(JSON.parse(payload)); }
    disconnect() { this.disconnected = true; }
    destroy() { this.destroyed = true; }
  }
  class FakePersistence {
    whenSynced = Promise.resolve();
    constructor(_name: string, doc: Y.Doc) { Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed)); }
    destroy() {}
  }
  // Execute the real hook, reducer and Yjs proof implementation. Only browser
  // transport/storage adapters are replaced; no browser or server is started.
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const client = {} as typeof Client;
  new Function('require', 'module', 'exports', compiled.outputText)(
    (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
      : name === 'y-indexeddb' ? { IndexeddbPersistence: FakePersistence } : load(name), { exports: client }, client,
  );
  const session: CollaborationSessionResponse = {
    success: true, documentId: 'ack-doc', documentName: 'ack-doc', provider: 'yjs', representation: 'plain_text',
    lifecycleGeneration: 7, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write',
    documentSequence: 1, checkpointSequence: 0, stateVector: Buffer.from(Y.encodeStateVector(seed)).toString('base64'),
    stateProof: collaborationStateProof(seed, Y), token: 'test', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    websocketUrl: '/ws/collaboration', user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' },
  };
  let current: Client.CollaborationDocument | null = null;
  const root = createRoot(document.getElementById('root')!);
  function Probe() {
    current = client.useCollaborationDocument({ enabled: true, workspaceId: 'workspace', path: 'document.txt', representation: 'plain_text', session });
    return <output>{current?.durability}</output>;
  }
  const get = () => { assert(current?.provider); return current; };
  const send = (value: unknown) => act(async () => providers[0].options.onStateless({ payload: JSON.stringify(value) }));
  const snapshot = (doc: Y.Doc, sequence: number, checkpointSequence = 0) => ({
    type: 'durability_snapshot', documentId: session.documentId, lifecycleGeneration: session.lifecycleGeneration,
    documentSequence: sequence, checkpointSequence, stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
    stateProof: collaborationStateProof(doc, Y),
  });
  const expected = (sequence: number, type = 'durability_ack') => ({
    type, documentId: session.documentId, lifecycleGeneration: session.lifecycleGeneration, sequence,
  });
  const priorFetch = globalThis.fetch;
  let checks = 0;
  const check = (label: string, assertion: () => void) => { assertion(); checks++; console.log(`PASS ${label}`); };
  try {
    await act(async () => root.render(<Probe />));
    for (let i = 0; providers.length === 0 && i < 30; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    assert.equal(providers.length, 1);
    const provider = providers[0];
    await send(snapshot(seed, 1));
    check('session and pre-sync snapshot do not acknowledge an unverified local document', () => assert.deepEqual(provider.sent, []));
    await act(async () => { provider.options.onStatus({ status: 'connected' }); provider.options.onSynced(); });
    check('binary durability is acknowledged before any Markdown projection', () => {
      assert.equal(get().durability, 'persisted_yjs');
      assert.deepEqual(provider.sent, [expected(1)]);
    });

    provider.sent.length = 0;
    const beforeDelete = snapshot(seed, 1);
    const beforeVector = Y.encodeStateVector(get().doc);
    await act(async () => get().doc.getText('content').delete(0, 1));
    await send(beforeDelete);
    check('equal state vectors cannot acknowledge a newer delete set', () => {
      assert.deepEqual(Y.encodeStateVector(get().doc), beforeVector);
      assert.notEqual(collaborationStateProof(get().doc, Y), beforeDelete.stateProof);
      assert.deepEqual(provider.sent, []);
    });
    await act(async () => provider.options.onUnsyncedChanges({ number: 1 }));
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(get().doc));
    await send(snapshot(seed, 2));
    check('matching proof does not bypass outstanding transport changes', () => assert.deepEqual(provider.sent, []));
    await act(async () => provider.options.onUnsyncedChanges({ number: 0 }));
    check('the exact persisted deletion is acknowledged when transport settles', () => assert.deepEqual(provider.sent, [expected(2)]));

    provider.sent.length = 0;
    seed.getText('content').insert(0, 'Peer ');
    await send(snapshot(seed, 3));
    check('snapshot arriving ahead of the Yjs update is not acknowledged early', () => assert.deepEqual(provider.sent, []));
    await act(async () => Y.applyUpdate(get().doc, Y.encodeStateAsUpdate(seed)));
    check('applying the matching peer update reconciles and acknowledges the pending snapshot', () => assert.deepEqual(provider.sent, [expected(3)]));

    provider.sent.length = 0;
    for (const invalid of [null, [], 'bad', { documentId: 'foreign' }, { lifecycleGeneration: 8 },
      { documentSequence: 2 }, { documentSequence: -1 }, { documentSequence: 3.5 },
      { stateProof: undefined }, { stateProof: 'bad' },
      { stateProof: `yjs-snapshot-sha256-v1:${'f'.repeat(64)}` }, { checkpointSequence: 4 }]) {
      await send(invalid && !Array.isArray(invalid) && typeof invalid === 'object' ? { ...snapshot(seed, 3), ...invalid } : invalid);
    }
    check('stale, foreign, malformed and conflicting snapshots send no acknowledgements', () => assert.deepEqual(provider.sent, []));
    await send(snapshot(seed, 3, 3));
    check('legacy checkpoint acknowledgement is retained alongside binary acknowledgement', () => {
      assert.deepEqual(provider.sent, [expected(3), expected(3, 'checkpoint_ack')]);
    });

    provider.sent.length = 0;
    await act(async () => provider.options.onStatus({ status: 'disconnected' }));
    await send(snapshot(seed, 4, 3));
    await act(async () => provider.options.onStatus({ status: 'connecting' }));
    await send(snapshot(seed, 4, 3));
    check('offline and reconnecting callbacks do not queue acknowledgements', () => assert.deepEqual(provider.sent, []));
    await act(async () => { provider.options.onStatus({ status: 'connected' }); provider.options.onSynced(); });
    check('authenticated resync acknowledges the current binary sequence again', () => assert.deepEqual(provider.sent, [expected(4), expected(3, 'checkpoint_ack')]));

    provider.sent.length = 0;
    await send({ ...snapshot(seed, 5, 3), type: 'projection_failed', code: COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable });
    check('failed Markdown projection still acknowledges independently confirmed Yjs durability', () => {
      assert.equal(get().durability, 'persisted_yjs');
      assert.deepEqual(provider.sent, [expected(5), expected(3, 'checkpoint_ack')]);
    });
    provider.sent.length = 0;
    globalThis.fetch = async () => Response.json({ ...snapshot(seed, 6, 3), success: true });
    await act(async () => get().requestCheckpoint());
    check('HTTP snapshot uses the same exact proof gate and binary acknowledgement path', () => {
      assert.deepEqual(provider.sent, [expected(6), expected(3, 'checkpoint_ack')]);
    });

    provider.sent.length = 0;
    await send({ type: 'degraded', code: COLLABORATION_FAILURE_CODES.persistenceFailed });
    await send(snapshot(seed, 7, 3));
    check('a storage failure heals only with a matching current binary proof', () => {
      assert.equal(get().durability, 'persisted_yjs');
      assert.deepEqual(provider.sent, [expected(7), expected(3, 'checkpoint_ack')]);
    });
    provider.sent.length = 0;
    await send({ type: 'degraded', code: COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid });
    await send(snapshot(seed, 8, 3));
    check('schema-blocked states do not acknowledge a usable durable editor state', () => {
      assert.equal(get().durability, 'degraded');
      assert.deepEqual(provider.sent, []);
    });
    await act(async () => provider.options.onAuthenticationFailed({ reason: 'Revoked' }));
    await send(snapshot(seed, 9, 9));
    check('revoked sessions cannot send binary or legacy acknowledgements', () => {
      assert.equal(get().clientState.connection, 'denied');
      assert.equal(provider.disconnected, true);
      assert.deepEqual(provider.sent, []);
    });
    console.log(`Durability acknowledgement client: ${checks} checks passed.`);
  } finally {
    globalThis.fetch = priorFetch;
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 1050));
    for (const provider of providers) assert.equal(provider.destroyed, true);
    seed.destroy(); dom.window.close();
    globals.forEach((name, i) => {
      const descriptor = priorGlobals[i];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
