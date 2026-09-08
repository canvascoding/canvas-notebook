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
  class FakePersistence {
    whenSynced = Promise.resolve();
    constructor(_name: string, doc: Y.Doc) { Y.applyUpdate(doc, Y.encodeStateAsUpdate(recovery)); }
    destroy() {}
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
      : name === '@/app/lib/files/client' ? { workspaceHeaders: () => ({}) } : runtimeRequire(name);
  new Function('require', 'module', 'exports', compiled.outputText)(requireMock, { exports: exported }, exported);
  const useDocument = exported.useCollaborationDocument;
  let current: CollaborationDocument | null = null;
  function Probe() {
    current = useDocument({ enabled: true, workspaceId: 'workspace', path: 'document.txt', representation: 'plain_text', session });
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
