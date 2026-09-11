import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { recordExportedCollaborationRecovery } from '../app/lib/collaboration/local-recovery';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import type { CurrentFile } from '../app/lib/files/types';
import messages from '../messages/en.json';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test?collaborationDebug=1' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'MutationObserver'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');

  // The registry, recovery transaction, Yjs codec, component and stores are real.
  // Only transport and the IndexedDB transaction boundary are controlled here.
  const backups: { snapshot: Uint8Array; commit: () => void; abort: () => void }[] = [];
  const committed: Uint8Array[] = [];
  let seed = new Y.Doc();
  let beforeDeletion = Y.encodeStateAsUpdate(seed);
  class FakePersistence {
    synced = true;
    whenSynced = Promise.resolve();
    db = { transaction: (store: string, mode: string) => {
      assert.equal(store, 'updates'); assert.equal(mode, 'readwrite');
      const transaction = { error: new Error('Quota exceeded'), oncomplete: () => {}, onerror: () => {}, onabort: () => {},
        abort() { transaction.onabort(); },
        objectStore(name: string) {
          assert.equal(name, 'updates');
          return { add(snapshot: Uint8Array) {
            backups.push({ snapshot: snapshot.slice(),
              commit() { committed.push(snapshot.slice()); transaction.oncomplete(); },
              abort() { transaction.abort(); } });
          } };
        } };
      return transaction;
    } };
    constructor(_name: string, doc: Y.Doc) { Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed)); }
    destroy() {}
  }
  class FakeProvider {
    constructor(_options: unknown) {}
    setAwarenessField() {}
    sendStateless() {}
    destroy() {}
  }
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const client = {} as typeof Client;
  const requireMock = (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
    : name === 'y-indexeddb' ? { IndexeddbPersistence: FakePersistence } : load(name);
  new Function('require', 'module', 'exports', compiled.outputText)(requireMock, { exports: client }, client);
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => request === './client' && parent?.filename.endsWith('markdown-recovery-client.ts')
    ? client : originalLoad(request, parent, isMain);
  const { MarkdownSaveState } = await import('../app/components/editor/MarkdownDocumentModes');
  const originalFetch = globalThis.fetch;
  const writes: { path: string; content: string; gate: ReturnType<typeof deferred<Response>> }[] = [];
  const opens: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/files/write');
    assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), 'workspace');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.expectedSha256, null); assert.equal(body.baseRevisionId, null);
    const write = { ...body, gate: deferred<Response>() };
    writes.push(write);
    return write.gate.promise;
  };
  useFileStore.setState({ revealAndLoadFile: async (filePath) => {
    opens.push(filePath); return { status: 'opened', path: filePath };
  } });
  let current: Client.CollaborationDocument | null = null;
  let owner = 0;
  let file!: CurrentFile;
  let session!: CollaborationSessionResponse & { representation: 'plain_text' | 'tiptap_blocks' };
  let show = true;
  let denied = false;
  const root = createRoot(document.getElementById('root')!);
  function Probe() {
    current = client.useCollaborationDocument({ enabled: true, workspaceId: 'workspace', path: file.path,
      documentKey: String(owner), representation: session.representation, session });
    const degraded = current ? { ...current, durability: 'degraded' as const, status: 'degraded' as const,
      connection: denied ? 'denied' as const : current.connection,
      session: current.session ? { ...current.session, permission: session.permission } : null,
      error: 'Rich collaboration checkpoint validation failed (roundtrip_unstable).' } : null;
    return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      {show && <MarkdownSaveState collaboration={degraded} content="STALE RENDER PROP" available filePath={file.path} />}
    </NextIntlClientProvider>;
  }
  const render = () => act(async () => root.render(<StrictMode><Probe /></StrictMode>));
  const get = () => { assert(current?.provider); return current; };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; !predicate() && i < 50; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    assert(predicate(), 'expected asynchronous state did not arrive');
  };
  const fixture = async (representation: 'plain_text' | 'tiptap_blocks' = 'plain_text') => {
    owner++; show = true; denied = false; seed.destroy(); seed = new Y.Doc();
    if (representation === 'plain_text') {
      const text = seed.getText('content'); text.insert(0, 'First\nMiddle\nLast');
      beforeDeletion = Y.encodeStateAsUpdate(seed); text.delete(6, 7);
    } else {
      const extensions = richMarkdownCodecExtensions();
      CollaborationBlockTree.create(seed, getSchema(extensions).nodeFromJSON(generateUniqueIds(
        createRichMarkdownManager().parse('AAA\n\nBBB\n\nCCC'), extensions,
      )));
      seed.getText('frontmatter').insert(0, '---\ntitle: Backup\n---\n');
      seed.getText('bodyFinalLineEnding').insert(0, '\n');
    }
    seed.getMap('unrenderedRecoveryData').set('stable-id', 'opaque metadata');
    session = { success: true, documentId: `doc-${owner}`, documentName: `doc-${owner}`, provider: 'yjs', representation,
      lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, blockTreeFormatVersion: 1,
      permission: 'write', documentSequence: 5, checkpointSequence: 4, stateVector: '', stateProof: null,
      token: 'test-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
      user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' } };
    file = { path: 'broken.md', editorIdentity: String(owner), content: 'STALE FILE', collaboration: {
      path: 'broken.md', crdtCapable: true, sceneCapable: false, lockRequired: false, requiresRevisionCheck: false,
      strategy: 'crdt_text', activeLock: null, latestRevision: null,
      document: { id: session.documentId, provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
    } };
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
      useFileStore.setState({ currentFile: file, currentFileWorkspaceId: 'workspace', treeGeneration: owner });
    });
    await render(); await until(() => current?.session?.documentId === session.documentId && !!current.provider);
  };
  const button = () => [...document.querySelectorAll('button')].find((element) =>
    element.textContent === messages.notebook.editorModes.recoverCopy || element.textContent === messages.notebook.editorModes.recoveringCopy)!;
  const click = () => act(async () => { assert(button()); button().click(); });
  const commit = () => act(async () => backups.at(-1)!.commit());
  const writeReply = () => act(async () => {
    const write = writes.at(-1)!; write.gate.resolve(Response.json({ success: true, data: { path: write.path } }));
  });
  try {
    await fixture();
    const live = get().doc;
    const before = Y.encodeStateAsUpdate(live);
    await click(); await click();
    assert.equal(backups.length, 1, 'double activation shares one recovery operation');
    assert.equal(writes.length, 0, 'adding the IndexedDB record does not yet permit a Markdown write');
    assert(button().disabled);
    await commit();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].content, 'First\nLast', 'copy uses the committed state, not a stale Markdown prop');
    assert.match(writes[0].path, /^broken\.recovered-[\da-f-]+\.md$/u);
    const restored = new Y.Doc(); Y.applyUpdate(restored, committed[0]);
    assert.equal(restored.getText('content').toString(), 'First\nLast');
    assert.equal(restored.getMap('unrenderedRecoveryData').get('stable-id'), 'opaque metadata');
    Y.applyUpdate(restored, beforeDeletion);
    assert.equal(restored.getText('content').toString(), 'First\nLast', 'saved delete set prevents resurrection');
    restored.destroy();
    assert.deepEqual(Y.encodeStateAsUpdate(live), before, 'recovery projection does not mutate the original');
    await writeReply(); assert.equal(opens.length, 1);

    await fixture();
    recordExportedCollaborationRecovery(get().doc, Y.encodeStateAsUpdate(get().doc));
    await click();
    await act(async () => backups.at(-1)!.abort());
    assert.match(document.body.textContent!, /Quota exceeded/u);
    assert.equal(writes.length, 1, 'an initiated download cannot bypass a failed local backup');
    assert.equal(opens.length, 1);

    await fixture(); await click();
    const vector = Y.encodeStateVector(get().doc);
    await act(async () => get().doc.getText('content').delete(0, 6));
    assert.deepEqual(Y.encodeStateVector(get().doc), vector);
    const oldBackupCount = backups.length;
    await commit();
    assert.equal(backups.length, oldBackupCount + 1, 'a deletion during commit requires another full snapshot');
    assert.equal(writes.length, 1);
    await commit(); assert.equal(writes.at(-1)!.content, 'Last'); await writeReply();

    await fixture(); await click(); await commit();
    const openCount = opens.length;
    const currentVector = Y.encodeStateVector(get().doc);
    await act(async () => get().doc.getText('content').delete(0, 6));
    assert.deepEqual(Y.encodeStateVector(get().doc), currentVector);
    await writeReply();
    assert.equal(opens.length, openCount, 'a copy response cannot hide newer edits in the original');
    assert.match(document.body.textContent!, /newer changes and remains open/u);
    assert(document.body.textContent!.includes(writes.at(-1)!.path));

    for (const change of ['workspace', 'workspace-return', 'other-file', 'file-return', 'reopen', 'rename', 'tree', 'navigation', 'unmount', 'generation', 'permission', 'denied'] as const) {
      await fixture(); await click(); const count: number = writes.length;
      await act(async () => {
        if (change === 'workspace' || change === 'workspace-return') useWorkspaceStore.setState({ activeWorkspaceId: 'other' });
        if (change === 'other-file' || change === 'file-return') useFileStore.setState({ currentFile: { ...file, path: 'other.md' } });
        if (change === 'reopen') useFileStore.setState({ currentFile: { ...file, editorIdentity: 'reopened' } });
        if (change === 'tree') useFileStore.setState({ treeGeneration: owner + 1 });
        if (change === 'navigation') useFileStore.setState((state) => ({ openFileRequestId: state.openFileRequestId + 1 }));
      });
      if (change === 'workspace-return') await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' }));
      if (change === 'file-return') await act(async () => useFileStore.setState({ currentFile: file }));
      if (change === 'rename') {
        file = { ...file, path: 'renamed.md' };
        await act(async () => useFileStore.setState({ currentFile: file })); await render();
      }
      if (change === 'unmount') { show = false; await render(); }
      if (change === 'generation') { session = { ...session, lifecycleGeneration: 2 }; await render(); }
      if (change === 'permission') { session = { ...session, permission: 'read' }; await render(); }
      if (change === 'denied') { denied = true; await render(); }
      await commit(); assert.equal(writes.length, count, `${change} revokes a backup's permission to create a copy`);
    }

    await fixture(); await click(); await commit();
    const openedBeforeSwitch = opens.length;
    await act(async () => useFileStore.setState({ currentFile: { ...file, path: 'other.md' } }));
    await writeReply(); assert.equal(opens.length, openedBeforeSwitch, 'a pending write cannot navigate away from another document');

    await fixture(); await click(); await commit();
    const beforeWriteFailure = opens.length;
    await act(async () => writes.at(-1)!.gate.resolve(Response.json({ error: 'File storage unavailable' }, { status: 503 })));
    assert.equal(opens.length, beforeWriteFailure);
    assert.match(document.body.textContent!, /File storage unavailable/u);

    await fixture('tiptap_blocks');
    const richBefore = readRichDocumentJson(get().doc);
    await click(); await commit();
    assert.equal(writes.at(-1)!.content, '---\ntitle: Backup\n---\nAAA\n\nBBB\n\nCCC\n');
    const full = new Y.Doc(); Y.applyUpdate(full, committed.at(-1)!);
    assert.deepEqual(readRichDocumentJson(full), richBefore, 'full block structure and IDs survive the binary backup');
    assert.equal(full.getMap('unrenderedRecoveryData').get('stable-id'), 'opaque metadata');
    full.destroy(); await writeReply();

    const handle = get();
    await assert.rejects(client.preserveCollaborationDocumentRecovery({ ...handle, registryKey: 'missing' }), /connecting/u);
    await assert.rejects(client.preserveCollaborationDocumentRecovery({ ...handle, session: { ...handle.session!, lifecycleGeneration: 999 } }), /changed/u);
    await assert.rejects(client.preserveCollaborationDocumentRecovery({ ...handle, session: { ...handle.session!, documentId: 'wrong' } }), /changed/u);
    console.log('Recovery copies require committed full snapshots, preserve deletion sets and block IDs, and fence stale UI/navigation/registry lifetimes.');
  } finally {
    await act(async () => root.unmount());
    internals._load = originalLoad; globalThis.fetch = originalFetch;
    // Allow the real registry's final reference cleanup to release Yjs awareness timers.
    await new Promise((done) => setTimeout(done, 1_100));
    seed.destroy(); dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
