import { committedCollaborationTestDatabase } from './collaboration-client-test-storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';

import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState as reduce, textCollaborationLegacyStatus } from '../app/lib/collaboration/client-state';
import { COLLABORATION_CHECKPOINT_ERROR_CODES as CHECKPOINT } from '../app/lib/collaboration/checkpoint-errors';
import { COLLABORATION_FAILURE_CODES as FAILURE } from '../app/lib/collaboration/failure';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';

const proof = 'yjs-snapshot-sha256-v1:' + 'a'.repeat(64);
const acknowledgement = { type: 'authoritative_snapshot' as const, documentSequence: 4, checkpointSequence: 3,
  stateVector: 'vector', stateProof: proof, matchesCurrentDocument: true };

function readyState() {
  let state = createInitialTextCollaborationClientState();
  state = reduce(state, { type: 'indexeddb_hydrated' });
  return reduce(state, { type: 'remote_synced', permission: 'write' });
}

test('derived-file failures and explicit export requests retain exact binary durability', () => {
  let state = reduce(readyState(), acknowledgement);
  assert.equal(state.durability, 'persisted_yjs');
  assert.equal(state.persistedStateProof, proof);
  state = reduce(state, { type: 'projection_failed', sequence: 4, code: CHECKPOINT.roundtripUnstable });
  assert.deepEqual(state.projectionError, { sequence: 4, code: CHECKPOINT.roundtripUnstable });
  assert.equal(state.error, null);
  assert.equal(state.failure, null);
  assert.equal(textCollaborationLegacyStatus(state), 'live');
  state = reduce(state, { type: 'checkpoint_requested' });
  assert.equal(state.durability, 'persisted_yjs');
  state = reduce(state, { type: 'checkpoint_failed', code: CHECKPOINT.failed, message: 'Private export failure details' });
  assert.equal(state.durability, 'persisted_yjs');
  assert.equal(state.error, null);
  assert.deepEqual(state.projectionError, { sequence: 4, code: CHECKPOINT.failed });
  state = reduce(state, { type: 'document_changed' });
  assert.equal(state.persistedStateProof, null);
  assert.equal(state.durability, 'server_received');
  state = reduce(state, { type: 'checkpoint_failed', code: CHECKPOINT.failed, message: 'Still exporting' });
  assert.equal(state.durability, 'server_received', 'export failure cannot certify an unsaved change');
  assert.equal(state.error, null);
});

test('projection diagnostics survive newer binary acknowledgements until their failed sequence is projected', () => {
  let state = reduce(readyState(), acknowledgement);
  state = reduce(state, { type: 'projection_failed', sequence: 4 });
  state = reduce(state, { ...acknowledgement, documentSequence: 5 });
  assert.deepEqual(state.projectionError, { sequence: 4, code: null });
  const beforeStale = state;
  state = reduce(state, { type: 'projection_failed', sequence: 3, code: CHECKPOINT.failed });
  assert.equal(state, beforeStale);
  state = reduce(state, { ...acknowledgement, documentSequence: 5, checkpointSequence: 4 });
  assert.equal(state.projectionError, null);
  state = reduce(state, { type: 'projection_failed', sequence: 4, code: CHECKPOINT.failed });
  assert.equal(state.projectionError, null, 'a failure cannot supersede a completed projection');
  state = reduce(state, { type: 'projection_failed', sequence: 5, code: CHECKPOINT.failed });
  const beforeMalformed = state;
  state = reduce(state, { ...acknowledgement, documentSequence: 5, checkpointSequence: 5, stateProof: 'invalid' });
  assert.equal(state, beforeMalformed, 'malformed acknowledgements cannot erase diagnostics');
});

test('only exact binary recovery heals Yjs persistence failure without a Markdown checkpoint', () => {
  const failed = reduce(reduce(readyState(), acknowledgement), { type: 'degraded', code: FAILURE.persistenceFailed, message: 'Yjs storage failed' });
  const reconnected = reduce(failed, { type: 'provider_status', permission: 'write', status: 'connected' });
  assert.equal(reconnected.durability, 'degraded');
  const mismatched = reduce(reconnected, { ...acknowledgement, documentSequence: 5, matchesCurrentDocument: false });
  assert.equal(mismatched.durability, 'degraded');
  const recovered = reduce(mismatched, { ...acknowledgement, documentSequence: 5 });
  assert.equal(recovered.durability, 'persisted_yjs');
  assert.equal(recovered.error, null);
  assert.equal(recovered.failure, null);
  for (const code of [CHECKPOINT.schemaInvalid, CHECKPOINT.stableIdMissing, CHECKPOINT.stableIdDuplicate, undefined]) {
    const invalid = reduce(reduce(readyState(), acknowledgement), { type: 'degraded', code, message: 'Invalid document' });
    const stillBlocked = reduce(invalid, { ...acknowledgement, documentSequence: 5 });
    assert.equal(stillBlocked.durability, 'degraded', `binary persistence is not structural validation: ${code}`);
    assert.equal(stillBlocked.error, 'Invalid document');
  }
});

test('known legacy roundtrip failures become diagnostics only with an exact binary acknowledgement', () => {
  const event = { type: 'degraded' as const, code: CHECKPOINT.roundtripUnstable, message: 'Old server export failed' };
  const durable = reduce(reduce(readyState(), acknowledgement), event);
  assert.equal(durable.durability, 'persisted_yjs');
  assert.equal(durable.error, null);
  const pending = reduce(readyState(), event);
  assert.equal(pending.durability, 'degraded');
  assert.equal(pending.persistedStateProof, null);
  assert.equal(reduce(pending, acknowledgement).durability, 'persisted_yjs');
  const unknown = reduce(reduce(readyState(), acknowledgement), { type: 'degraded', message: 'roundtrip_unstable' });
  assert.equal(reduce(unknown, acknowledgement).durability, 'degraded', 'free-form text never authorizes recovery');
});

test('binary and file acknowledgements cannot override revoked access or a stale generation', () => {
  for (const event of [{ type: 'authentication_failed' as const, message: 'Access revoked' },
    { type: 'degraded' as const, message: 'Generation changed', code: FAILURE.generationChanged }]) {
    let state = reduce(reduce(readyState(), acknowledgement), event);
    state = reduce(state, { ...acknowledgement, documentSequence: 5, checkpointSequence: 5 });
    assert.equal(state.durability, 'degraded');
    state = reduce(state, { type: 'provider_status', permission: 'write', status: 'connected' });
    state = reduce(state, { type: 'remote_synced', permission: 'write' });
    assert.equal(state.durability, 'degraded');
  }
});

type ProviderOptions = {
  document: Y.Doc;
  onStatus: (value: { status: string }) => void;
  onSynced: () => void;
  onUnsyncedChanges: (value: { number: number }) => void;
  onStateless: (value: { payload: string }) => void;
  onAuthenticationFailed: (value: { reason: string }) => void;
};

test('real client callbacks keep projection errors separate through delete proofs, delayed messages and export requests', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const originalFetch = globalThis.fetch;
  const seed = new Y.Doc();
  seed.getText('content').insert(0, 'ABCD');
  const providers: FakeProvider[] = [];
  class FakeProvider {
    destroyed = false;
    disconnected = false;
    constructor(readonly options: ProviderOptions) { providers.push(this); }
    setAwarenessField() {}
    sendStateless() {}
    disconnect() { this.disconnected = true; }
    destroy() { this.destroyed = true; }
  }
  class FakePersistence {
    synced = true;
    db = committedCollaborationTestDatabase();
    whenSynced = Promise.resolve();
    constructor(_name: string, doc: Y.Doc) { Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed)); }
    destroy() {}
  }
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
    success: true, documentId: 'projection-doc', documentName: 'projection-doc', provider: 'yjs', representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write',
    documentSequence: 1, checkpointSequence: 0, stateVector: Buffer.from(Y.encodeStateVector(seed)).toString('base64'),
    stateProof: collaborationStateProof(seed, Y), token: 'test', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    websocketUrl: '/ws/collaboration', user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' },
  };
  let current: Client.CollaborationDocument | null = null;
  const root = createRoot(document.getElementById('root')!);
  function Probe() {
    current = client.useCollaborationDocument({ enabled: true, workspaceId: 'workspace', path: 'document.txt', representation: 'plain_text', session });
    return <output>{current?.error}</output>;
  }
  const get = () => { assert(current?.provider); return current; };
  const send = (message: unknown) => act(async () => providers[0].options.onStateless({ payload: JSON.stringify(message) }));
  const snapshot = (doc: Y.Doc, sequence: number, checkpointSequence = 0) => ({
    documentId: session.documentId, lifecycleGeneration: session.lifecycleGeneration,
    documentSequence: sequence, checkpointSequence, stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
    stateProof: collaborationStateProof(doc, Y),
  });
  try {
    await act(async () => root.render(<Probe />));
    for (let i = 0; providers.length === 0 && i < 30; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    assert.equal(providers.length, 1);
    await send({ type: 'projection_failed', ...snapshot(seed, 1), code: CHECKPOINT.failed });
    assert.equal(get().ready, false);
    assert.equal(get().durability, 'server_received', 'a diagnostic arriving before authenticated sync is not a durability acknowledgement');
    assert.equal(get().clientState.persistedStateProof, null);
    await act(async () => { providers[0].options.onStatus({ status: 'connected' }); providers[0].options.onSynced(); });
    assert.equal(get().durability, 'persisted_yjs');
    await send({ type: 'projection_failed', ...snapshot(seed, 1), code: CHECKPOINT.failed, message: 'Private filesystem path' });
    assert.equal(get().durability, 'persisted_yjs');
    assert.equal(get().error, null);
    assert.equal(document.body.textContent, '');
    assert.deepEqual(get().clientState.projectionError, { sequence: 1, code: CHECKPOINT.failed });
    for (const invalid of [{ documentId: 'other' }, { lifecycleGeneration: 2 }, { stateProof: 'invalid' },
      { stateProof: 'yjs-snapshot-sha256-v1:' + 'b'.repeat(64) }, { documentSequence: 0 }]) {
      const before = get().clientState;
      await send({ type: 'projection_failed', ...snapshot(seed, 1), ...invalid, code: CHECKPOINT.roundtripUnstable });
      assert.deepEqual(get().clientState, before, 'wrong identity, malformed, conflicting or stale snapshot is ignored');
    }
    const oldSnapshot = snapshot(seed, 1);
    const oldVector = Y.encodeStateVector(get().doc);
    await act(async () => get().doc.getText('content').delete(0, 1));
    assert.deepEqual(Y.encodeStateVector(get().doc), oldVector);
    await send({ type: 'projection_failed', ...oldSnapshot, code: CHECKPOINT.failed });
    assert.equal(get().durability, 'server_received', 'an old delete set cannot certify the local deletion');
    await act(async () => providers[0].options.onUnsyncedChanges({ number: 1 }));
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(get().doc));
    await send({ type: 'projection_failed', ...snapshot(seed, 2), code: CHECKPOINT.roundtripUnstable });
    assert.equal(get().durability, 'local_pending', 'the binary message cannot bypass pending transport changes');
    await act(async () => providers[0].options.onUnsyncedChanges({ number: 0 }));
    assert.equal(get().durability, 'persisted_yjs');
    assert.equal(get().clientState.projectionError?.sequence, 2);
    await send({ type: 'durability_snapshot', ...snapshot(seed, 3, 1) });
    assert.equal(get().clientState.projectionError?.sequence, 2, 'an older projection cannot clear the failed sequence');
    await send({ type: 'durability_snapshot', ...snapshot(seed, 3, 2) });
    assert.equal(get().clientState.projectionError, null);
    await send({ type: 'projection_failed', ...snapshot(seed, 2), code: CHECKPOINT.failed });
    assert.equal(get().clientState.projectionError, null, 'a delayed failure cannot reintroduce an older error');
    for (const invalid of [{ documentId: 'other' }, { lifecycleGeneration: 2 }, { documentSequence: 2 }]) {
      await send({ type: 'degraded', ...snapshot(seed, 3, 2), ...invalid, code: CHECKPOINT.schemaInvalid, message: 'Obsolete schema failure' });
      assert.equal(get().durability, 'persisted_yjs', 'an obsolete schema failure cannot block this document lifetime');
    }
    await send({ type: 'degraded', ...snapshot(seed, 3, 2), code: CHECKPOINT.roundtripUnstable });
    assert.deepEqual(get().clientState.projectionError, { sequence: 3, code: CHECKPOINT.roundtripUnstable });
    assert.equal(get().error, null, 'a scoped legacy projection failure uses the same binary proof path');

    seed.getText('content').insert(0, 'remote ');
    await send({ type: 'projection_failed', ...snapshot(seed, 4, 2), code: CHECKPOINT.failed });
    assert.equal(get().durability, 'server_received', 'a future snapshot waits for its actual Yjs update');
    await act(async () => Y.applyUpdate(get().doc, Y.encodeStateAsUpdate(seed), providers[0]));
    assert.equal(get().durability, 'persisted_yjs');
    assert.equal(get().clientState.projectionError?.sequence, 4);
    for (const code of [CHECKPOINT.roundtripUnstable, CHECKPOINT.failed]) {
      globalThis.fetch = async () => Response.json({ error: 'Private export failure', code }, { status: 422 });
      await act(async () => { await assert.rejects(get().requestCheckpoint(), /Private export failure/); });
      assert.equal(get().durability, 'persisted_yjs');
      assert.equal(get().error, null);
      assert.equal(document.body.textContent, '');
    }
    let release!: (response: Response) => void;
    let pending: Promise<void> | undefined;
    const failedRequestSnapshot = snapshot(seed, 4, 2);
    globalThis.fetch = async () => new Promise<Response>((resolve) => { release = resolve; });
    await act(async () => { pending = assert.rejects(get().requestCheckpoint(), /Delayed export failure/); });
    await act(async () => get().doc.getText('content').delete(0, 1));
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(get().doc));
    await send({ type: 'durability_snapshot', ...snapshot(seed, 5, 4) });
    assert.equal(get().clientState.projectionError, null);
    await act(async () => { release(Response.json({ ...failedRequestSnapshot, error: 'Delayed export failure', code: CHECKPOINT.failed }, { status: 503 })); await pending; });
    assert.equal(get().durability, 'persisted_yjs');
    assert.equal(get().clientState.projectionError, null, 'an old HTTP failure cannot target newer text');

    await send({ type: 'degraded', code: FAILURE.persistenceFailed, message: 'Binary storage failed' });
    assert.equal(get().durability, 'degraded');
    await send({ type: 'durability_snapshot', ...snapshot(seed, 6, 4) });
    assert.equal(get().durability, 'persisted_yjs');
    await send({ type: 'projection_failed', ...snapshot(seed, 6, 4), code: CHECKPOINT.stableIdDuplicate });
    assert.equal(get().durability, 'degraded', 'a mislabeled structure error is still blocking');
    await send({ type: 'durability_snapshot', ...snapshot(seed, 7, 4) });
    assert.equal(get().durability, 'degraded');
    await send({ type: 'durability_snapshot', ...snapshot(seed, 7, 7) });
    assert.equal(get().durability, 'checkpointed_file');
    await act(async () => get().doc.getText('content').insert(0, 'new '));
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(get().doc));
    globalThis.fetch = async () => Response.json({ ...snapshot(seed, 8, 7), error: 'HTTP projection failed', code: CHECKPOINT.failed }, { status: 503 });
    await act(async () => { await assert.rejects(get().requestCheckpoint(), /HTTP projection failed/); });
    assert.equal(get().durability, 'persisted_yjs', 'a projection error response can carry the exact binary acknowledgement');
    assert.equal(get().error, null);
    assert.deepEqual(get().clientState.projectionError, { sequence: 8, code: CHECKPOINT.failed });
    await act(async () => providers[0].options.onAuthenticationFailed({ reason: 'Access revoked' }));
    assert.equal(providers[0].disconnected, true);
    await send({ type: 'projection_failed', ...snapshot(seed, 9, 8), code: CHECKPOINT.failed });
    await send({ type: 'durability_snapshot', ...snapshot(seed, 9, 9) });
    assert.equal(get().connection, 'denied');
    assert.equal(get().durability, 'degraded');
  } finally {
    await act(async () => root.unmount());
    await new Promise((done) => setTimeout(done, 1_050));
    assert(providers.every((provider) => provider.destroyed));
    globalThis.fetch = originalFetch;
    seed.destroy(); dom.window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
