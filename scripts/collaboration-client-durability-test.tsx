import { committedCollaborationTestDatabase } from './collaboration-client-test-storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';

import type { CollaborationDocument, useCollaborationDocument } from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';

type ProviderOptions = {
  document: Y.Doc;
  onStatus: (value: { status: string }) => void;
  onSynced: () => void;
  onUnsyncedChanges: (value: { number: number }) => void;
  onStateless: (value: { payload: string }) => void;
};

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const server = new Y.Doc(); server.getText('content').insert(0, 'ABC');
  const recovery = new Y.Doc(); Y.applyUpdate(recovery, Y.encodeStateAsUpdate(server));
  recovery.getText('content').delete(0, 1);
  const session: CollaborationSessionResponse = {
    success: true, documentId: 'proof-doc', documentName: 'proof-doc', provider: 'yjs', representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write',
    documentSequence: 1, checkpointSequence: 1, stateVector: Buffer.from(Y.encodeStateVector(server)).toString('base64'),
    stateProof: collaborationStateProof(server, Y), token: 'test-token', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    websocketUrl: '/ws/collaboration', user: { id: 'user', name: 'User', color: '#112233', colorLight: '#ddeeff' },
  };
  const payload = (doc: Y.Doc, sequence: number) => ({ type: 'durability_snapshot', success: true,
    documentId: session.documentId, lifecycleGeneration: session.lifecycleGeneration,
    documentSequence: sequence, checkpointSequence: sequence,
    stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof: collaborationStateProof(doc, Y) });
  const providers: FakeProvider[] = [];
  class FakeProvider {
    destroyed = false;
    constructor(readonly options: ProviderOptions) { providers.push(this); }
    setAwarenessField() {}
    sendStateless() {}
    destroy() { this.destroyed = true; }
  }
  const persistences: FakePersistence[] = [];
  let nextHydration: Promise<void> | undefined;
  class FakePersistence {
    synced = true;
    db = committedCollaborationTestDatabase();
    destroyed = false;
    whenSynced: Promise<void>;
    constructor(_name: string, doc: Y.Doc) {
      this.whenSynced = nextHydration ?? Promise.resolve(); nextHydration = undefined;
      persistences.push(this);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(recovery));
    }
    destroy() { this.destroyed = true; }
  }
  // Run the production hook and callbacks. Only the transport and IndexedDB
  // adapters are substituted; Yjs, React and the state reducer remain real.
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const runtimeRequire = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exported = {} as { useCollaborationDocument: typeof useCollaborationDocument };
  const requireMock = (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
    : name === 'y-indexeddb' ? { IndexeddbPersistence: FakePersistence }
      : name === '@/app/lib/files/client' ? { workspaceHeaders: (workspaceId?: string) => ({ 'x-test-workspace': workspaceId ?? 'other-active-workspace' }) } : runtimeRequire(name);
  new Function('require', 'module', 'exports', compiled.outputText)(requireMock, { exports: exported }, exported);
  const useDocument = exported.useCollaborationDocument;
  let current: CollaborationDocument | null = null;
  function Probe({ provided = true }: { provided?: boolean }) {
    current = useDocument({ enabled: true, workspaceId: 'workspace', path: 'document.txt', representation: 'plain_text', session: provided ? session : null });
    return <output>{current?.durability}</output>;
  }
  const get = () => { assert.ok(current); return current as CollaborationDocument; };
  const root = createRoot(document.getElementById('root')!);
  const previousFetch = globalThis.fetch;
  try {
    await act(async () => root.render(<Probe />));
    for (let i = 0; providers.length === 0 && i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(providers.length, 1);
    const provider = providers[0];
    assert.equal(get().ready, false);
    assert.notEqual(get().durability, 'checkpointed_file');
    await act(async () => { provider.options.onStatus({ status: 'connected' }); provider.options.onSynced(); });
    assert.equal(get().ready, true);
    assert.equal(get().doc.getText('content').toString(), 'BC');
    assert.notEqual(get().durability, 'checkpointed_file', 'hydrated offline deletion is not covered by the old session');
    const old = payload(server, 1);
    const message = async (value: unknown) => act(async () => provider.options.onStateless({ payload: JSON.stringify(value) }));
    await message(old);
    assert.notEqual(get().durability, 'checkpointed_file');
    await act(async () => { get().doc.getText('content').delete(0, 1); provider.options.onUnsyncedChanges({ number: 0 }); });
    assert.equal(get().doc.getText('content').toString(), 'C');
    let sentProof: unknown;
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('x-test-workspace'), 'workspace');
      sentProof = JSON.parse(String(init?.body)).stateProof;
      return Response.json(old);
    };
    await act(async () => get().requestCheckpoint());
    assert.equal(sentProof, collaborationStateProof(get().doc, Y));
    assert.notEqual(get().durability, 'checkpointed_file', 'a delayed HTTP success cannot confirm a different delete set');
    Y.applyUpdate(server, Y.encodeStateAsUpdate(get().doc));
    await message(payload(server, 2));
    assert.equal(get().durability, 'checkpointed_file');
    await act(async () => { get().doc.getText('content').delete(0, 1); });
    assert.notEqual(get().durability, 'checkpointed_file', 'local update invalidates saved status before provider callbacks');
    await message(old);
    assert.equal(get().clientState.documentSequence, 2);
    const legacy = { ...payload(get().doc, 3), stateProof: undefined };
    await message(legacy);
    assert.notEqual(get().durability, 'checkpointed_file');
    await message({ ...payload(get().doc, 3), documentId: 'other-document' });
    assert.notEqual(get().durability, 'checkpointed_file');
    await message({ ...payload(get().doc, 3), lifecycleGeneration: 2 });
    assert.notEqual(get().durability, 'checkpointed_file');
    Y.applyUpdate(server, Y.encodeStateAsUpdate(get().doc));
    await message(payload(server, 3));
    assert.equal(get().durability, 'checkpointed_file');
    // A proof arriving before its Yjs update remains pending until that update.
    server.getText('content').insert(0, 'remote');
    await message(payload(server, 4));
    assert.notEqual(get().durability, 'checkpointed_file');
    await act(async () => Y.applyUpdate(get().doc, Y.encodeStateAsUpdate(server), provider));
    assert.equal(get().durability, 'checkpointed_file');
    assert.equal(get().doc.getText('content').toString(), 'remote');
    const currentDoc = get().doc;
    const retainedCheckpoint = get().requestCheckpoint;
    await act(async () => root.render(null));
    await act(async () => root.render(<Probe />));
    assert.equal(get().doc, currentDoc, 'a quick view replacement reuses the same document lifetime');
    assert.equal(providers.length, 1);
    let stoppedWait: unknown;
    await act(async () => {
      provider.options.onUnsyncedChanges({ number: 1 });
      void retainedCheckpoint().catch((error) => { stoppedWait = error; });
    });
    await act(async () => root.render(null));
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert(stoppedWait instanceof Error && /document was closed/u.test(stoppedWait.message), 'cleanup rejects a sync waiter without its ten-second timeout');
    await assert.rejects(retainedCheckpoint, /document was closed/u);
    assert.equal(providers[0].destroyed, true);
    assert.equal(persistences[0].destroyed, true);

    // Ignore AbortSignal deliberately: a late transport result must still be
    // fenced out, including after a replacement entry reuses the exact key.
    const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(input, '/api/files/collaboration/session');
      assert.equal(new Headers(init?.headers).get('x-test-workspace'), 'workspace');
      return new Promise<Response>((resolve) => pending.push({ resolve, signal: init?.signal as AbortSignal }));
    };
    const flushUntil = async (predicate: () => boolean) => {
      for (let i = 0; !predicate() && i < 30; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert(predicate());
    };
    await act(async () => root.render(<Probe provided={false} />));
    await flushUntil(() => pending.length === 1);
    await act(async () => root.render(null));
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(pending[0].signal.aborted, true);
    await act(async () => root.render(<Probe provided={false} />));
    await flushUntil(() => pending.length === 2);
    await act(async () => pending[1].resolve(Response.json(session)));
    await flushUntil(() => providers.length === 2);
    const replacement = get().doc;
    await act(async () => pending[0].resolve(Response.json(session)));
    assert.equal(providers.length, 2, 'an obsolete session response must not create a third provider');
    assert.equal(persistences.length, 2, 'an obsolete session response must not open an orphan database');
    assert.equal(get().doc, replacement);
    let respondCheckpoint: ((response: Response) => void) | undefined;
    let checkpointSignal: AbortSignal | undefined;
    let stoppedResponse: unknown;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, '/api/files/collaboration/checkpoint');
      checkpointSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { respondCheckpoint = resolve; });
    };
    await act(async () => {
      providers[1].options.onSynced();
      void get().requestCheckpoint().catch((error) => { stoppedResponse = error; });
    });
    await flushUntil(() => Boolean(respondCheckpoint));
    await act(async () => root.render(null));
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(checkpointSignal?.aborted, true);
    await act(async () => respondCheckpoint!(Response.json(payload(replacement, 1))));
    assert(stoppedResponse instanceof Error && /document was closed/u.test(stoppedResponse.message), 'a late checkpoint response cannot settle a closed entry');

    let hydrated!: () => void;
    nextHydration = new Promise<void>((resolve) => { hydrated = resolve; });
    await act(async () => root.render(<Probe />));
    await flushUntil(() => persistences.length === 3);
    await act(async () => root.render(null));
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(persistences[2].destroyed, true);
    await act(async () => hydrated());
    assert.equal(providers.length, 2, 'a late IndexedDB hydration cannot start a closed provider');
    console.log('Registry lifecycle: grace-period reuse, workspace-bound requests, closed callbacks, late session replacement and hydration cleanup passed.');
    console.log('Client durability: offline deletion, delayed HTTP/WebSocket responses, scope gates, immediate invalidation and reordered updates passed.');
  } finally {
    globalThis.fetch = previousFetch;
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 1050));
    for (const provider of providers) assert.equal(provider.destroyed, true);
    server.destroy(); recovery.destroy(); dom.window.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
