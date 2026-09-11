import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import type { CurrentFile } from '../app/lib/files/types';
import { captureAgentStateSnapshot } from '../app/lib/collaboration/agent-durability';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { findOpenedLiveDocument, invalidateOpenedLiveDocument, observeOpenedDocumentAuth, openedDocumentAuthScope, rememberOpenedLiveDocument, validateOpenedLiveDocumentSession } from '../app/lib/collaboration/opened-document-registry';
import { committedCollaborationTestDatabase } from './collaboration-client-test-storage';

type Options = { token: () => Promise<string>; document: Y.Doc; name: string;
  onAuthenticationFailed: (value: { reason: string }) => void; onSynced: () => void;
  onStatus: (value: { status: string }) => void };

async function main() {
  const dom = new JSDOM('<main id="root"></main>', { url: 'https://canvas.test' });
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const originalFetch = globalThis.fetch;
  const seed = new Y.Doc(); seed.getText('content').insert(0, 'Saved native text');
  let stored: Uint8Array | null = Y.encodeStateAsUpdate(seed);
  const ticket: CollaborationSessionResponse = { success: true, documentId: 'offline-client', documentName: 'offline-client',
    provider: 'yjs', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3,
    permission: 'write', token: 'old-ticket', expiresAt: new Date(Date.now() + 600_000).toISOString(), websocketUrl: '/ws/collaboration',
    user: { id: 'owner', name: 'Owner', color: '#123456', colorLight: '#abcdef' } };
  const providers: FakeProvider[] = [];
  class FakeProvider {
    tokens: string[] = [];
    destroyed = false;
    disconnected = 0;
    effectiveName: string;
    constructor(readonly options: Options) { this.effectiveName = options.name; providers.push(this); }
    getToken() { return this.options.token(); }
    permissionDeniedHandler(reason: string) { this.options.onAuthenticationFailed({ reason }); }
    send(_message: unknown, value: { token: string }) { this.tokens.push(value.token); }
    // Exercise the installed Hocuspocus catch path instead of imitating its error semantics.
    connect() { return HocuspocusProvider.prototype.sendToken.call(this as unknown as HocuspocusProvider); }
    disconnect() { this.disconnected++; }
    setAwarenessField() {}
    sendStateless() {}
    destroy() { this.destroyed = true; }
  }
  class Persistence {
    synced = true;
    whenSynced = Promise.resolve();
    db = committedCollaborationTestDatabase();
    constructor(_name: string, doc: Y.Doc) { if (stored) Y.applyUpdate(doc, stored); }
    destroy() {}
  }
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  const exported = {} as typeof Client;
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(
    (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
      : name === 'y-indexeddb' ? { IndexeddbPersistence: Persistence } : load(name), { exports: exported }, exported,
  );
  let current: Client.CollaborationDocument | null = null;
  let resolution: Client.TextCollaborationSessionResolution | null = null;
  let view = 0;
  function Probe({ owner }: { owner: string }) {
    const session = exported.useTextCollaborationSession({ enabled: true, workspaceId: 'workspace', path: 'offline.txt', expectedDocumentId: ticket.documentId });
    resolution = session;
    current = exported.useCollaborationDocument({ enabled: true, workspaceId: 'workspace', path: 'offline.txt',
      representation: 'plain_text', waitForSession: true, session: session.session, documentKey: owner });
    return <output>{current?.connection}</output>;
  }
  const root = createRoot(document.getElementById('root')!);
  const get = (): Client.CollaborationDocument => { assert(current); return current; };
  const until = async (condition: () => boolean) => {
    for (let i = 0; !condition() && i < 80; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert(condition());
  };
  const authorize = () => observeOpenedDocumentAuth({ data: { user: { id: 'owner' }, session: { id: 'login' } } });
  const file: CurrentFile = { path: 'offline.txt', content: 'serialized contents must not be used', collaboration: {
      path: 'offline.txt', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
      requiresRevisionCheck: false, latestRevision: null, activeLock: null,
      document: { id: ticket.documentId, provider: 'yjs', status: 'active', stateVersion: 1, snapshotRevisionId: null },
  } };
  const remember = (doc = seed) => {
    assert.equal(validateOpenedLiveDocumentSession('workspace', 'offline.txt', ticket), true);
    rememberOpenedLiveDocument({ scope: openedDocumentAuthScope(), workspaceId: 'workspace', path: file.path,
      file, session: ticket, stateProof: collaborationStateProof(doc, Y)!, snapshot: captureAgentStateSnapshot(doc, Y)! });
  };
  const unmount = async () => {
    await act(async () => root.render(null)); current = null; resolution = null;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  };
  const render = () => act(async () => root.render(<Probe key={++view} owner={`view-${view}`} />));
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  try {
    authorize(); remember(); globalThis.fetch = offline;
    await render(); await until(() => Boolean(current?.ready));
    assert.equal(get().doc.getText('content').toString(), 'Saved native text');
    assert.equal(get().clientState.remoteSynced, false); assert.equal(get().clientState.persistedStateProof, null);
    const localProvider = providers.at(-1)!;
    await act(async () => { await localProvider.connect(); });
    assert.equal(localProvider.tokens.length, 0, 'even an unexpired cached token cannot bypass fresh HTTP authorization');
    assert.equal(get().connection, 'offline'); assert.equal(get().session?.permission, 'write');
    globalThis.fetch = async () => Response.json({ ...ticket, token: 'fresh-ticket' });
    await until(() => localProvider.tokens.length === 1);
    assert.deepEqual(localProvider.tokens, ['fresh-ticket'], 'network token failure retries through the real sendToken catch path');
    await act(async () => observeOpenedDocumentAuth({ data: { user: { id: 'other' }, session: { id: 'other-login' } } }));
    assert.equal(get().connection, 'denied'); assert.equal(get().session?.permission, 'read');
    assert.equal(get().doc.getText('content').toString(), 'Saved native text', 'revocation retains the local recovery content');
    await unmount();

    authorize(); globalThis.fetch = async () => Response.json(ticket);
    await render(); await until(() => Boolean(current?.ready));
    assert.equal(get().clientState.remoteSynced, false, 'a fresh HTTP-authorized profile can read its local document before WebSocket sync');
    assert.equal(findOpenedLiveDocument('workspace', file.path, ticket.documentId), null);
    exported.rememberOpenedCollaborationDocument(get(), file, 'workspace');
    assert.equal(findOpenedLiveDocument('workspace', file.path, ticket.documentId)?.file.content, '',
      'the actual live registry accepts the mounted host receipt, retaining metadata only');
    await unmount();

    stored = null; globalThis.fetch = async () => Response.json(ticket);
    await render(); await until(() => providers.length >= 3);
    assert.equal(get().ready, false, 'whenSynced on a new empty IndexedDB is not local document readiness');
    await act(async () => { Y.applyUpdate(get().doc, Y.encodeStateAsUpdate(seed)); providers.at(-1)!.options.onSynced(); });
    assert.equal(get().ready, true);
    await unmount();

    remember(); globalThis.fetch = offline;
    const beforeMissing = providers.length;
    await render(); await until(() => Boolean(current?.error));
    assert.equal(get().ready, false); assert.equal(providers.length, beforeMissing, 'a missing cached binary never opens an empty replacement editor');
    await unmount();

    stored = Y.encodeStateAsUpdate(seed); remember(); globalThis.fetch = offline;
    await render(); await until(() => Boolean(current?.ready));
    const rejectedProvider = providers.at(-1)!;
    globalThis.fetch = async () => Response.json({ error: 'Access revoked' }, { status: 403 });
    await act(async () => { await rejectedProvider.connect(); });
    assert.equal(get().connection, 'denied'); assert.equal(rejectedProvider.tokens.length, 0);
    await unmount();

    const withDeletion = new Y.Doc(); Y.applyUpdate(withDeletion, Y.encodeStateAsUpdate(seed));
    withDeletion.getText('content').delete(0, 6); remember(withDeletion);
    globalThis.fetch = offline; const beforeStale = providers.length;
    await render(); await until(() => Boolean(current?.error));
    assert.equal(get().ready, false); assert.equal(providers.length, beforeStale, 'a stale binary missing a known deletion cannot be opened as the current document');
    await unmount();
    globalThis.fetch = async () => Response.json({ ...ticket, token: 'fresh-http-ticket' });
    await render(); await until(() => providers.length > beforeStale);
    assert.equal(get().ready, false, 'fresh HTTP authorization cannot skip the known deletion witness');
    assert.equal(get().clientState.remoteSynced, false);
    await act(async () => { Y.applyUpdate(get().doc, Y.encodeStateAsUpdate(withDeletion)); providers.at(-1)!.options.onSynced(); });
    assert.equal(get().ready, true); assert.equal(get().doc.getText('content').toString(), 'native text');
    withDeletion.destroy();
    await unmount();
    for (const result of ['allowed', 'denied', 'changed-again'] as const) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        if (requests === 1 || result === 'changed-again') {
          invalidateOpenedLiveDocument('workspace', { path: file.path, documentId: ticket.documentId });
        }
        return requests === 2 && result === 'denied' ? Response.json({ error: 'Access revoked' }, { status: 403 }) : Response.json(ticket);
      };
      const before = providers.length;
      await render();
      if (result === 'allowed') await until(() => Boolean(current?.ready));
      else {
        await until(() => Boolean(resolution?.error));
        assert.equal(providers.length, before, 'the replacement request must still enforce denial and another invalidation');
      }
      assert.equal(requests, 2, 'a concurrent location change gets exactly one fresh authorization attempt');
      await unmount();
    }
    console.log('Actual client hooks: offline native restore, fresh token requirement/retry, auth denial, empty/stale IndexedDB rejection and HTTP-online profile restore passed.');
  } finally {
    await act(async () => root.unmount());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    globalThis.fetch = originalFetch; observeOpenedDocumentAuth(null); seed.destroy(); dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
