import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { getDocumentTransitionGuard, registerDocumentTransitionGuard } from '../app/lib/files/document-transition';

type ProviderOptions = {
  onStatus: (value: { status: string }) => void;
  onSynced: () => void;
  onStateless: (value: { payload: string }) => void;
  onAuthenticationFailed: (value: { reason: string }) => void;
};
type Transaction = { snapshot: Uint8Array; commit: () => void; fail: () => void };

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const seed = new Y.Doc(); seed.getText('content').insert(0, 'ABC');
  const session: CollaborationSessionResponse = {
    success: true, documentId: 'lifecycle-doc', documentName: 'lifecycle-doc', provider: 'yjs', representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write', documentSequence: 1, checkpointSequence: 0,
    stateVector: Buffer.from(Y.encodeStateVector(seed)).toString('base64'), stateProof: collaborationStateProof(seed, Y),
    token: 'write-token', expiresAt: new Date(Date.now() + 600_000).toISOString(), websocketUrl: '/ws/collaboration',
    user: { id: 'user', name: 'User', color: '#112233', colorLight: '#ddeeff' },
  };
  const providers: FakeProvider[] = [];
  class FakeProvider {
    destroyed = false;
    constructor(readonly options: ProviderOptions) { providers.push(this); }
    setAwarenessField() {}
    sendStateless() {}
    disconnect() {}
    destroy() { this.destroyed = true; }
  }
  const stored = new Map<string, Uint8Array>();
  const transactions: Transaction[] = [];
  const persistences: FakePersistence[] = [];
  let autoCommit = false;
  class FakePersistence {
    synced = true;
    whenSynced = Promise.resolve();
    destroyed = false;
    db: IDBDatabase;
    constructor(readonly name: string, readonly doc: Y.Doc) {
      persistences.push(this);
      Y.applyUpdate(doc, stored.get(name) ?? Y.encodeStateAsUpdate(seed));
      this.db = { transaction: (store: string, mode: string) => {
        assert.equal(store, 'updates'); assert.equal(mode, 'readwrite');
        const transaction = {
          error: new Error('Quota exceeded'),
          oncomplete: null as (() => void) | null,
          onabort: null as (() => void) | null,
          onerror: null as (() => void) | null,
          abort: () => transaction.onabort?.(),
          objectStore: () => ({ add: (snapshot: Uint8Array) => {
            const queued = { snapshot: snapshot.slice(),
              commit: () => { stored.set(name, snapshot.slice()); transaction.oncomplete?.(); },
              fail: () => transaction.onabort?.() };
            transactions.push(queued);
            if (autoCommit) queueMicrotask(queued.commit);
          } }),
        };
        return transaction;
      } } as unknown as IDBDatabase;
    }
    destroy() { this.destroyed = true; }
  }
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  let afterBackup: (() => void) | null = null;
  const recovery = load('./local-recovery') as typeof import('../app/lib/collaboration/local-recovery');
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const client = {} as typeof Client;
  new Function('require', 'module', 'exports', compiled.outputText)(
    (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
      : name === 'y-indexeddb' ? { IndexeddbPersistence: FakePersistence }
        : name === './local-recovery' ? { ...recovery, preserveLocalCollaborationRecovery: async (...args: Parameters<typeof recovery.preserveLocalCollaborationRecovery>) => {
          const snapshot = await recovery.preserveLocalCollaborationRecovery(...args);
          const callback = afterBackup; afterBackup = null;
          if (callback) queueMicrotask(callback);
          return snapshot;
        } } : load(name), { exports: client }, client,
  );
  // Execute FileEditor's actual guard effects with the real registry document.
  // Unrelated editor rendering is omitted, rather than reimplementing its guard.
  const editorFilename = path.resolve('app/components/editor/FileEditor.tsx');
  const editorSource = ts.createSourceFile(editorFilename, await fs.readFile(editorFilename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect'
      && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) {
      const text = node.arguments[0].getText(editorSource);
      if (text.includes('return registerDocumentTransitionGuard(') || text.includes("addEventListener('beforeunload'")) effects.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(editorSource); assert.equal(effects.length, 2);
  let currentPath = 'before.txt';
  const effectFactories = effects.map((effect) => {
    const expression = ts.transpileModule(`const effect = (${effect.getText(editorSource)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    return (document: Client.CollaborationDocument | null) => {
      const bindings = {
        currentFilePath: currentPath, getExtension: () => 'txt', isSceneCollaboration: false,
        registerDocumentTransitionGuard, getDocumentTransitionGuard, currentFileWorkspaceId: 'workspace',
        useEditorStore: { getState: () => ({ isDirty: false }) }, officeEditorRef: { current: null },
        isCrdtCollaboration: true, activeCollaborationDocument: document, activeExternalTextChangePath: null,
        t: (key: string) => key, isOffice: false, saveTrackedFile: () => { throw new Error('Unexpected file write'); },
        hasCurrentPersistedCollaborationDocument: client.hasCurrentPersistedCollaborationDocument,
        prepareCollaborationDocumentTransition: client.prepareCollaborationDocumentTransition,
        useFileStore: { getState: () => ({ currentFile: { path: currentPath }, currentFileWorkspaceId: 'workspace' }) },
      };
      return new Function(...Object.keys(bindings), `${expression}; return effect;`)(...Object.values(bindings)) as () => (() => void) | undefined;
    };
  });
  let current: Client.CollaborationDocument | null = null;
  let openIdentity = 'request-1';
  function Probe({ filePath, supplied = session, owner = openIdentity, workspace = 'workspace' }: {
    filePath: string; supplied?: CollaborationSessionResponse; owner?: string; workspace?: string;
  }) {
    const handle = client.useCollaborationDocument({ enabled: true, workspaceId: workspace, path: filePath,
      documentKey: owner, representation: 'plain_text', session: supplied });
    current = handle;
    useEffect(() => effectFactories[0](handle)(), [handle, filePath]);
    useEffect(() => effectFactories[1](null)(), []);
    return <output>{current?.durability}</output>;
  }
  const root = createRoot(document.getElementById('root')!);
  const get = () => { assert(current); return current as Client.CollaborationDocument; };
  const render = (filePath = 'before.txt', supplied = session, workspace = 'workspace') => {
    currentPath = filePath;
    return act(async () => root.render(<Probe filePath={filePath} supplied={supplied} owner={openIdentity} workspace={workspace} />));
  };
  const promptsBeforeUnload = () => {
    const event = new dom.window.Event('beforeunload', { cancelable: true });
    dom.window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; !predicate() && i < 30; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert(predicate());
  };
  const closeGrace = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 1050)));
  const oldFetch = globalThis.fetch;
  const oldWarn = console.warn;
  const diagnostics: unknown[][] = [];
  console.warn = (...args) => { diagnostics.push(args); };
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('Markdown projection is unavailable'); };
  try {
    await render(); await until(() => providers.length === 1);
    await act(async () => providers[0].options.onSynced());
    const first = get(); const originalDoc = first.doc;
    assert.equal(first.durability, 'persisted_yjs');
    assert.equal(promptsBeforeUnload(), false, 'actual FileEditor beforeunload does not prompt for confirmed Yjs without Markdown');
    await client.prepareCollaborationDocumentTransition(first);
    assert.equal(requests, 0, 'an exact binary proof allows closing without a Markdown checkpoint');
    assert.equal(transactions.length, 0, 'confirmed server persistence needs no additional local snapshot');

    const vector = Y.encodeStateVector(originalDoc);
    let lateFastTransition!: Promise<unknown>;
    await act(async () => {
      lateFastTransition = client.prepareCollaborationDocumentTransition(first).then(() => null, (error) => error);
      originalDoc.getText('content').delete(0, 1);
    });
    const lateFastFailure = await lateFastTransition;
    assert(lateFastFailure instanceof Error && /changed/u.test(lateFastFailure.message), 'a new delete during the fast proof transition is not falsely confirmed');
    assert.deepEqual(Y.encodeStateVector(originalDoc), vector);
    assert.equal(promptsBeforeUnload(), true, 'actual beforeunload still protects an unconfirmed deletion');
    assert.equal(client.hasCurrentPersistedCollaborationDocument(first), false, 'a stale rendered saved snapshot is not a binary confirmation');
    let done = false;
    const deletionTransition = client.prepareCollaborationDocumentTransition(first).then(() => { done = true; });
    await until(() => transactions.length === 1);
    assert.equal(done, false, 'a stale view snapshot cannot bypass a newer deletion or the IndexedDB commit');
    assert.equal(requests, 0, 'unconfirmed edits use local binary persistence directly');
    transactions[0].commit(); await deletionTransition;
    assert.equal(promptsBeforeUnload(), true, 'a local backup does not claim server persistence');
    const reload = new Y.Doc(); Y.applyUpdate(reload, transactions[0].snapshot);
    assert.equal(reload.getText('content').toString(), 'BC');
    assert.equal(collaborationStateProof(reload, Y), collaborationStateProof(originalDoc, Y)); reload.destroy();

    await act(async () => originalDoc.getText('content').insert(2, ' local'));
    let staleTransitionError: unknown;
    const staleTransition = client.prepareCollaborationDocumentTransition(get()).catch((error) => { staleTransitionError = error; });
    await until(() => transactions.length === 2);
    const renamed = { ...session, token: 'renamed-token' };
    await render('after.txt', renamed); await until(() => providers.length === 2);
    transactions[1].commit(); await staleTransition;
    assert(staleTransitionError instanceof Error && /location changed/u.test(staleTransitionError.message));
    assert.equal(get().doc, originalDoc, 'rename retains the live document');
    await act(async () => providers[0].options.onSynced());
    assert.equal(get().ready, false, 'a closed provider cannot validate the new location');
    await act(async () => providers[1].options.onSynced());

    const oldWritableView = get();
    const readSession = { ...renamed, token: 'read-token', permission: 'read' as const };
    await render('after.txt', readSession); await until(() => providers.length === 3);
    assert.equal(get().session?.permission, 'read', 'same-path session refresh applies permission loss');
    assert.equal(get().ready, false);
    assert.equal(providers[1].destroyed, true);
    await assert.rejects(client.prepareCollaborationDocumentTransition(oldWritableView), /changed/u);
    await act(async () => providers[1].options.onSynced());
    assert.equal(get().ready, false);
    await act(async () => providers[2].options.onSynced());
    await render('after.txt', renamed);
    assert.equal(get().session?.permission, 'read', 'an old write view cannot undo a same-path permission downgrade');

    await act(async () => providers[2].options.onStatus({ status: 'disconnected' }));
    await act(async () => root.render(null)); await closeGrace();
    assert.equal(transactions.length, 3);
    assert.equal(originalDoc.isDestroyed, false, 'view unmount waits for the full binary commit');
    assert.equal(providers[2].destroyed, false);
    transactions[2].fail(); await act(async () => {});
    assert.equal(originalDoc.isDestroyed, false, 'a failed local commit retains the last live document');
    openIdentity = 'request-2';
    await render('after.txt', readSession);
    assert.equal(get().doc, originalDoc, 'a real new open-request identity recovers the retained in-memory document');
    await assert.rejects(client.prepareCollaborationDocumentTransition(first), /connecting/u);
    assert.equal(providers.length, 3);

    await act(async () => root.render(null)); await closeGrace();
    assert.equal(transactions.length, 4);
    await render('after.txt', readSession);
    transactions[3].commit(); await act(async () => {});
    assert.equal(get().doc, originalDoc);
    assert.equal(originalDoc.isDestroyed, false, 'a successful late cleanup cannot destroy a reacquired document');

    await act(async () => root.render(null)); await closeGrace();
    afterBackup = () => originalDoc.getText('content').insert(originalDoc.getText('content').length, ' late');
    transactions[4].commit(); await act(async () => {});
    assert.equal(originalDoc.isDestroyed, false, 'an update after backup resolution but before disposal must retain the document');
    assert.equal(originalDoc.getText('content').toString(), 'BC local late');
    const retained = diagnostics.filter(([tag]) => tag === '[collaboration-client]');
    assert.equal(retained.length, 2, 'failed and superseded local snapshots emit private diagnostics');
    assert.deepEqual(retained[1][1], { event: 'document_retained', documentId: 'lifecycle-doc', generation: 1, code: 'LOCAL_SNAPSHOT_UNCONFIRMED' });
    assert.equal(JSON.stringify(retained).includes('BC local'), false);
    assert.equal(JSON.stringify(retained).includes('read-token'), false);
    openIdentity = 'request-3';
    await render('after.txt', readSession);
    assert.equal(get().doc, originalDoc);
    await act(async () => root.render(null)); await closeGrace();
    transactions[5].commit(); await until(() => originalDoc.isDestroyed);
    assert.equal(providers[2].destroyed, true);
    assert.equal(persistences[0].destroyed, true);
    await render('after.txt', readSession); await until(() => providers.length === 4);
    assert.notEqual(get().doc, originalDoc);
    assert.equal(get().doc.getText('content').toString(), 'BC local late', 'a completed local close reloads the exact offline edit');
    assert.equal(requests, 0);

    const generationOne = get().doc;
    const generationTwo = { ...readSession, lifecycleGeneration: 2 };
    await render('after.txt', generationTwo); await until(() => providers.length === 5);
    assert.notEqual(get().doc, generationOne);
    assert.equal(get().doc.getText('content').toString(), 'ABC', 'generation two never adopts an earlier generation backup');
    await assert.rejects(client.prepareCollaborationDocumentTransition(oldWritableView), /connecting/u);
    autoCommit = true;
    const currentGeneration = get().doc;
    const currentOwner = openIdentity;
    for (const [partition, supplied, workspace] of [
      ['workspace', generationTwo, 'other-workspace'],
      ['user', { ...generationTwo, user: { ...generationTwo.user, id: 'other-user' } }, 'workspace'],
      ['guest', { ...generationTwo, guestAccess: { invitationId: 'guest-a', workspaceId: 'workspace' } }, 'workspace'],
    ] as const) {
      await act(async () => root.render(null));
      openIdentity = `partition-${partition}`;
      await render('after.txt', supplied, workspace); await until(() => Boolean(get().provider));
      assert.notEqual(get().doc, currentGeneration, `${partition} cannot take another access partition's retained document`);
      await act(async () => root.render(null));
      openIdentity = currentOwner;
      await render('after.txt', generationTwo);
      assert.equal(get().doc, currentGeneration);
    }
    const parallelRoot = createRoot(document.createElement('div'));
    try {
      await act(async () => parallelRoot.render(<Probe filePath="after.txt" supplied={generationTwo} owner="parallel-view" />));
      await until(() => Boolean(get().provider));
      assert.notEqual(get().doc, currentGeneration, 'an actively owned view is never taken by a parallel view');
    } finally { await act(async () => parallelRoot.unmount()); }
    console.log('Lifecycle: exact binary transitions, delete-safe IndexedDB commit, rename and permission fencing, failed-close retention, reacquisition, reload and generation isolation passed.');
  } finally {
    autoCommit = true;
    for (const transaction of transactions) transaction.commit();
    await act(async () => root.unmount()); await closeGrace();
    globalThis.fetch = oldFetch; console.warn = oldWarn;
    assert(providers.every((provider) => provider.destroyed), 'all test providers are released');
    assert(persistences.every((persistence) => persistence.destroyed), 'all test persistence adapters are closed');
    seed.destroy(); dom.window.close();
    for (const [key, value] of globals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
