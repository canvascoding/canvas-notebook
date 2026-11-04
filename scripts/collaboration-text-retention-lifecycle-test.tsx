import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { observeOpenedDocumentAuth, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { committedCollaborationTestDatabase } from './collaboration-client-test-storage';

type Options = {
  onStatus: (event: { status: string }) => void;
  onSynced: () => void;
  onUnsyncedChanges: (event: { number: number }) => void;
};

async function main() {
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  load('../auth-client');
  const dom = new JSDOM('<!doctype html><main id="root"></main>', { url: 'https://canvas.test' });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  const server = new Map<string, Y.Doc>();
  for (const id of ['A', 'B', 'C', 'D']) {
    const doc = new Y.Doc(); const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText(); text.insert(0, `Saved ${id}`); paragraph.insert(0, [text]);
    doc.getXmlFragment('body').insert(0, [paragraph]); server.set(id, doc);
  }
  let userId = 'retention-owner';
  let permission: 'write' | 'read' = 'write';
  let sequence = 1;
  const requests: string[] = [];
  const providers: Provider[] = [];
  const stores: Persistence[] = [];
  class Provider {
    destroyed = false;
    constructor(readonly options: Options) {
      providers.push(this);
      queueMicrotask(() => {
        if (this.destroyed) return;
        options.onStatus({ status: 'connecting' });
        options.onUnsyncedChanges({ number: 1 });
      });
    }
    setAwarenessField() {}
    sendStateless() {}
    disconnect() {}
    destroy() { this.destroyed = true; }
  }
  class Persistence {
    synced = true;
    whenSynced = Promise.resolve();
    db = committedCollaborationTestDatabase();
    destroyed = false;
    constructor(name: string, doc: Y.Doc) {
      const id = name.split(':')[1]; assert(server.has(id));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.get(id)!)); stores.push(this);
    }
    destroy() { this.destroyed = true; }
  }
  const exported = {} as typeof Client;
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(
    (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: Provider }
      : name === 'y-indexeddb' ? { IndexeddbPersistence: Persistence } : load(name), { exports: exported }, exported,
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/files/collaboration/session');
    const id = JSON.parse(String(init?.body)).path.replace('.md', '');
    const doc = server.get(id); assert(doc); requests.push(id);
    const session: CollaborationSessionResponse = {
      success: true, provider: 'yjs', documentId: id, documentName: id, representation: 'tiptap_xml',
      lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission,
      documentSequence: sequence, checkpointSequence: sequence, projectionFinalized: true,
      stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof: collaborationStateProof(doc, Y),
      token: `ticket-${requests.length}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
      user: { id: userId, name: userId, color: '#123456', colorLight: '#abcdef' },
    };
    return Response.json(session);
  };
  let current: Client.CollaborationDocument | null = null;
  let owner = 0;
  function Probe({ id, lifetime }: { id: string; lifetime: number }) {
    const resolution = exported.useTextCollaborationSession({ enabled: true, workspaceId: 'retention-workspace', path: `${id}.md` });
    current = exported.useCollaborationDocument({ enabled: true, workspaceId: 'retention-workspace', path: `${id}.md`,
      representation: 'tiptap_xml', waitForSession: true, session: resolution.session, documentKey: `open-${lifetime}` });
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  const tick = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const until = async (condition: () => boolean) => {
    for (let n = 0; !condition() && n < 100; n++) await tick(10);
    assert(condition());
  };
  const get = () => { assert(current); return current as Client.CollaborationDocument; };
  const open = async (id: string) => {
    const count = requests.length;
    await act(async () => root.render(<Probe key={++owner} id={id} lifetime={owner} />));
    await until(() => requests.length > count && current?.session?.documentId === id && current.clientState.indexedDbHydrated);
    await tick(); return get();
  };
  const close = async () => { await act(async () => root.render(null)); current = null; await tick(); };
  const auth = () => observeOpenedDocumentAuth({ data: { user: { id: userId }, session: { id: `login-${userId}` } } });
  try {
    auth(); const first = await open('A'); const original = first.doc; const storage = stores[0];
    assert.equal(first.clientState.unsyncedChanges, 1);
    await close(); await tick(1100);
    assert.equal(original.isDestroyed, false, 'unchanged text survives the old one-second disposal interval');
    assert.equal(providers[0].destroyed, true, 'parking closes the inactive transport');
    const reopened = await open('A');
    assert.equal(reopened.doc, original); assert.equal(stores.length, 1); assert.equal(storage.destroyed, false);
    assert.equal(requests.length, 2, 'RAM reuse still obtains a fresh HTTP authorization');
    assert.equal(reopened.clientState.remoteSynced, false);
    assert.equal(exported.hasCurrentPersistedCollaborationDocument(reopened), false, 'reuse does not confirm saving');

    await close();
    const peer = server.get('A')!;
    const text = (peer.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const vector = Y.encodeStateVector(peer); text.delete(0, 1); sequence++;
    assert.deepEqual(Y.encodeStateVector(peer), vector);
    const stale = await open('A'); assert.equal(stale.doc, original);
    assert.equal(stale.clientState.locallyUsable, false, 'a peer deletion invalidates the held snapshot before it is exposed');
    await act(async () => {
      Y.applyUpdate(original, Y.encodeStateAsUpdate(peer));
      providers.at(-1)!.options.onSynced(); providers.at(-1)!.options.onUnsyncedChanges({ number: 0 });
    });
    assert.equal(collaborationStateProof(get().doc, Y), collaborationStateProof(peer, Y));
    assert.equal(get().clientState.remoteSynced, true);
    await close(); permission = 'read';
    assert.equal((await open('A')).session?.permission, 'read'); await close();

    invalidateOpenedDocumentAuth(); userId = 'second-owner'; permission = 'write'; auth();
    assert.notEqual((await open('A')).doc, original, 'another authenticated account gets a new RAM lifetime');
    await close();
    const held: Y.Doc[] = [];
    for (const id of ['A', 'B', 'C', 'D']) { held.push((await open(id)).doc); await close(); }
    await until(() => held[0].isDestroyed);
    assert(held.slice(1).every(doc => !doc.isDestroyed), 'only the oldest of four parked documents is evicted');
    await tick(15_100);
    assert(held.every(doc => doc.isDestroyed), 'parked lifetimes expire within the fixed retention interval');
    console.log('Text retention lifecycle: fresh authorization, RAM reuse, peer deletion, read downgrade, account isolation, eviction and expiry passed.');
  } finally {
    await act(async () => root.unmount()); invalidateOpenedDocumentAuth(); globalThis.fetch = previousFetch;
    for (const doc of server.values()) doc.destroy(); dom.window.close();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
