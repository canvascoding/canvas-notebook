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

type ProviderOptions = {
  document: Y.Doc; token: () => Promise<string>;
  onStatus: (value: { status: string }) => void;
  onSynced: () => void;
  onUnsyncedChanges: (value: { number: number }) => void;
  onStateless: (value: { payload: string }) => void;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test', pretendToBeVisual: true });
  for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element',
    'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  const server = new Y.Doc(); server.getText('content').insert(0, 'AAA');
  const session: CollaborationSessionResponse = { success: true, documentId: 'rename-doc', documentName: 'rename-doc',
    provider: 'yjs', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3,
    permission: 'write', documentSequence: 1, checkpointSequence: 1,
    stateVector: Buffer.from(Y.encodeStateVector(server)).toString('base64'), stateProof: collaborationStateProof(server, Y),
    token: 'before-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
    user: { id: 'user', name: 'User', color: '#112233', colorLight: '#ddeeff' } };
  const after = { ...session, token: 'after-token' };
  const fresh = { ...session, token: 'refreshed-after-token' };
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
    destroyed = false;
    whenSynced: Promise<void>;
    constructor(_name: string, readonly doc: Y.Doc) {
      this.whenSynced = nextHydration ?? Promise.resolve(); nextHydration = undefined;
      persistences.push(this); Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    }
    destroy() { this.destroyed = true; }
  }
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exported = {} as typeof Client;
  const requireMock = (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
    : name === 'y-indexeddb' ? { IndexeddbPersistence: FakePersistence }
      : name === '@/app/lib/files/client' ? { workspaceHeaders: (workspaceId: string) => ({ 'x-test-workspace': workspaceId }) } : load(name);
  new Function('require', 'module', 'exports', compiled.outputText)(requireMock, { exports: exported }, exported);
  const { EditorState } = load('@codemirror/state') as typeof import('@codemirror/state');
  const { EditorView } = load('@codemirror/view') as typeof import('@codemirror/view');
  const { createTextEditorCollaboration } = load('./text-editor-history') as typeof import('../app/lib/collaboration/text-editor-history');
  let current: Client.CollaborationDocument | null = null;
  function Probe({ filePath, owner = 'open-document' }: { filePath: string; owner?: string }) {
    const resolution = exported.useTextCollaborationSession({ enabled: true, workspaceId: 'workspace', path: filePath });
    current = exported.useCollaborationDocument({ enabled: true, workspaceId: 'workspace', path: filePath,
      documentKey: owner, waitForSession: true, representation: 'plain_text', session: resolution.session });
    return <output>{current?.durability}</output>;
  }
  const get = () => { assert(current); return current as Client.CollaborationDocument; };
  const root = createRoot(document.getElementById('root')!);
  const render = (filePath: string, owner?: string) => act(async () => root.render(<Probe filePath={filePath} owner={owner} />));
  const until = async (predicate: () => boolean) => {
    for (let i = 0; !predicate() && i < 30; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert(predicate());
  };
  const checkpoint = (doc: Y.Doc, sequence: number) => ({ success: true, documentId: session.documentId,
    lifecycleGeneration: 1, documentSequence: sequence, checkpointSequence: sequence,
    stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof: collaborationStateProof(doc, Y) });
  const sessionRequests: string[] = [];
  const checkpointRequests: { gate: ReturnType<typeof deferred<Response>>; signal: AbortSignal; token: string }[] = [];
  let renameGate: ReturnType<typeof deferred<Response>> | null = deferred<Response>();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('x-test-workspace'), 'workspace');
    const body = JSON.parse(String(init?.body));
    if (input === '/api/files/collaboration/session') {
      sessionRequests.push(body.path);
      if (body.path === 'before.txt') return Response.json(session);
      if (body.path === 'after.txt') return renameGate?.promise ?? Response.json(fresh);
      assert.equal(body.path, 'restored.txt');
      return Response.json({ ...session, lifecycleGeneration: 2 });
    }
    assert.equal(input, '/api/files/collaboration/checkpoint');
    const gate = deferred<Response>();
    checkpointRequests.push({ gate, signal: init?.signal as AbortSignal, token: body.token });
    return gate.promise; // Deliberately ignore cancellation to exercise late replies.
  };
  let view: InstanceType<typeof EditorView> | undefined;
  try {
    await render('before.txt'); await until(() => providers.length === 1);
    await act(async () => providers[0].options.onSynced());
    const document = get().doc;
    const text = document.getText('content');
    const mount = () => new EditorView({ parent: dom.window.document.body, state: EditorState.create({ doc: text.toString(),
      extensions: [createTextEditorCollaboration(text, null)] }) });
    view = mount();
    await act(async () => {
      view!.dispatch({ changes: { from: 3, insert: ' local' } });
      document.transact(() => text.insert(0, 'Peer '), 'peer');
    });
    let oldError: unknown;
    await act(async () => { void get().requestCheckpoint().catch((error) => { oldError = error; }); });
    await until(() => checkpointRequests.length === 1);
    await render('after.txt');
    assert.equal(current, null, 'new views wait for the renamed path session');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(providers[0].destroyed, false, 'session resolution retains the old document beyond the grace period');
    assert.equal(persistences.length, 1);
    await act(async () => { renameGate!.resolve(Response.json(after)); renameGate = null; });
    await until(() => providers.length === 2);
    assert.equal(get().doc, document);
    assert.equal(get().ready, false, 'new location requires a new authenticated synchronization');
    assert.equal(providers[0].destroyed, true);
    assert.equal(persistences.length, 1);
    assert.equal(persistences[0].destroyed, false);
    assert.equal(checkpointRequests[0].signal.aborted, true);
    await assert.rejects(providers[0].options.token(), /location changed/u);
    await act(async () => {
      providers[0].options.onSynced();
      providers[0].options.onUnsyncedChanges({ number: 999 });
      providers[0].options.onStateless({ payload: JSON.stringify({ type: 'durability_snapshot', ...checkpoint(document, 99) }) });
    });
    assert.equal(get().ready, false);
    assert.notEqual(get().clientState.documentSequence, 99);
    assert.equal(get().clientState.unsyncedChanges, 0);
    await act(async () => providers[1].options.onSynced());
    assert.equal(get().ready, true);
    let newCheckpoint!: Promise<void>;
    await act(async () => { newCheckpoint = get().requestCheckpoint(); });
    await until(() => checkpointRequests.length === 2);
    assert.equal(checkpointRequests[1].token, 'after-token');
    await act(async () => checkpointRequests[0].gate.resolve(Response.json(checkpoint(document, 99))));
    assert(oldError instanceof Error && /location changed/u.test(oldError.message));
    assert.equal(get().requestCheckpoint(), newCheckpoint, 'old finally cannot clear the new checkpoint request');
    assert.notEqual(get().clientState.documentSequence, 99);
    await act(async () => { checkpointRequests[1].gate.resolve(Response.json(checkpoint(document, 2))); await newCheckpoint; });
    assert.equal(get().durability, 'checkpointed_file');
    const now = Date.now;
    Date.now = () => now() + 60_000;
    try { assert.equal(await providers[1].options.token(), 'refreshed-after-token'); }
    finally { Date.now = now; }
    assert.equal(sessionRequests.at(-1), 'after.txt', 'token renewal uses the adopted path');
    view.destroy(); view = mount();
    await act(async () => view!.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true,
    })));
    assert.equal(text.toString(), 'Peer AAA', 'the renamed document retains selective source history');
    view.destroy(); view = undefined;
    await render('restored.txt'); await until(() => providers.length === 3);
    assert.notEqual(get().doc, document, 'a generation change creates a separate document despite the same open identity');
    await act(async () => root.render(null));
    await new Promise((resolve) => setTimeout(resolve, 1050));

    const hydration = deferred<void>(); nextHydration = hydration.promise;
    await render('before.txt', 'hydrating-document'); await until(() => persistences.length === 3);
    const hydrating = persistences[2].doc;
    await render('after.txt', 'hydrating-document');
    await act(async () => hydration.resolve()); await until(() => providers.length === 4);
    assert.equal(get().doc, hydrating, 'rename before IndexedDB hydration keeps the same pending document');
    assert.equal(persistences.length, 3);
    assert.equal(await providers[3].options.token(), 'refreshed-after-token');
    console.log('Collaborative rename: delayed resolver, document/history retention, request cancellation, provider fencing, current-path renewal, generation isolation and hydration passed.');
  } finally {
    view?.destroy(); globalThis.fetch = previousFetch;
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert(providers.every((provider) => provider.destroyed));
    assert(persistences.every((persistence) => persistence.destroyed));
    server.destroy(); dom.window.close();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
