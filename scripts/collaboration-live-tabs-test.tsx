/** Mechanical registry/React lifetimes. Transport/storage doubles do not prove browser or server acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import type { CurrentFile } from '../app/lib/files/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { findConnectedOpenedDocument, observeOpenedDocumentAuth, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { committedCollaborationTestDatabase } from './collaboration-client-test-storage';
import { NATIVE_PEER_ADMISSION_BUSY_REASON } from '../app/lib/collaboration/failure';

async function main() {
  const filename = path.resolve('app/lib/collaboration/client.ts'), load = createRequire(filename);
  load('../auth-client');
  const dom = new JSDOM('<!doctype html><main id="root"></main>', { url: 'https://canvas.test', pretendToBeVisual: true });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let clock = 0;
  Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
  const documents = new Map<string, Y.Doc>();
  for (const id of ['A', 'B', 'C', 'D']) { const doc = new Y.Doc(); doc.getText('content').insert(0, `Saved ${id}`); documents.set(id, doc); }
  let user = 'owner', constrained = false, enabled = true, databaseUnavailable = false, quotaExceeded = false;
  let permission: 'read' | 'write' = 'write';
  let delayNextResponse = false, releaseDelayedResponse: (() => void) | undefined;
  const paths = new Map<string, Record<string, string>>(), requests: string[] = [], providers: Provider[] = [];
  const activePaths = new Map<string, string | null>();
  type Options = { document: Y.Doc; token: () => Promise<string>; onStatus: (event: { status: string }) => void; onSynced: (event?: { state: boolean }) => void;
    onUnsyncedChanges: (event: { number: number }) => void; onStateless: (event: { payload: string }) => void;
    onAuthenticationFailed: (event: { reason: string }) => void; onClose: (event: { event: { code: number; reason: string } }) => void };
  class Provider {
    destroyed = false;
    disconnects = 0;
    connects = 0;
    presence: unknown = null;
    awareness = { setLocalState: (value: unknown) => { this.presence = value; } };
    constructor(readonly options: Options) {
      providers.push(this);
      queueMicrotask(() => {
        if (this.destroyed) return;
        void options.token().then(() => {
          if (!this.destroyed) { options.onStatus({ status: 'connected' }); options.onSynced(); options.onUnsyncedChanges({ number: 0 }); }
        }).catch(error => { if (!this.destroyed) options.onAuthenticationFailed({ reason: String(error) }); });
      });
    }
    setAwarenessField(_name: string, value: unknown) { this.presence = value; }
    sendStateless() {}
    disconnect() { this.disconnects++; this.options.onStatus({ status: 'disconnected' }); }
    async connect() {
      this.connects++;
      await this.options.token();
      if (!this.destroyed) { this.options.onStatus({ status: 'connected' }); this.options.onSynced(); }
    }
    destroy() { this.destroyed = true; }
  }
  class Persistence {
    synced = true;
    whenSynced = Promise.resolve();
    private database = committedCollaborationTestDatabase();
    get db() {
      return databaseUnavailable ? null : quotaExceeded ? {
        transaction: () => { throw new DOMException('Local storage quota exceeded.', 'QuotaExceededError'); },
      } as unknown as IDBDatabase : this.database;
    }
    constructor(name: string, doc: Y.Doc) { Y.applyUpdate(doc, Y.encodeStateAsUpdate(documents.get(name.split(':')[1])!)); }
    destroy() {}
  }
  const exported = {} as typeof Client & { flushRetention: () => void };
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', compiled + '\nexports.flushRetention = reconcileDocumentRetention;')(
    (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: Provider }
      : name === 'y-indexeddb' ? { IndexeddbPersistence: Persistence } : load(name), { exports: exported }, exported);
  const originalFetch = globalThis.fetch;
  const originalWallClock = Date.now;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/files/collaboration/session');
    const id = JSON.parse(String(init?.body)).path.replace('.txt', ''), doc = documents.get(id); assert(doc); requests.push(id);
    const session: CollaborationSessionResponse = { success: true, provider: 'yjs', documentId: id, documentName: id,
      representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission,
      documentSequence: 1, checkpointSequence: 1, projectionFinalized: true,
      stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof: collaborationStateProof(doc, Y),
      token: `synthetic-ticket-${requests.length}`, expiresAt: new Date(Date.now() + 90_000).toISOString(), websocketUrl: '/ws/collaboration',
      user: { id: user, name: user, color: '#123456', colorLight: '#abcdef' } };
    if (delayNextResponse) {
      delayNextResponse = false;
      return new Promise<Response>(resolve => { releaseDelayedResponse = () => resolve(Response.json(session)); });
    }
    return Response.json(session);
  };
  let current: Client.CollaborationDocument | null = null, lifetime = 0;
  function Probe({ id, workspace, owner }: { id: string; workspace: string; owner: number }) {
    const resolution = exported.useTextCollaborationSession({ enabled: true, workspaceId: workspace, path: `${id}.txt`, expectedDocumentId: id });
    const live = exported.useCollaborationDocument({ enabled: true, workspaceId: workspace, path: `${id}.txt`,
      representation: 'plain_text', waitForSession: true, session: resolution.session, documentKey: String(owner) });
    current = live;
    useEffect(() => {
      if (!live?.ready) return;
      const file: CurrentFile = { path: `${id}.txt`, content: '', collaboration: { path: `${id}.txt`,
        strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false, requiresRevisionCheck: false,
        latestRevision: null, activeLock: null,
        document: { id, provider: 'yjs', status: 'active', stateVersion: 1, snapshotRevisionId: null } } };
      exported.rememberOpenedCollaborationDocument(live, file, workspace);
    }, [live, id, workspace]);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const until = async (condition: () => boolean) => {
    for (let n = 0; !condition() && n < 100; n++) await tick();
    assert(condition());
  };
  const own = (workspace: string) => {
    const ids = paths.get(workspace) ?? {};
    exported.updateOpenedCollaborationTabs({ workspaceId: workspace, activePath: activePaths.get(workspace) ?? null,
      paths: Object.keys(ids), documentIds: ids, constrained, enabled });
  };
  const open = async (id: string, workspace = 'one') => {
    clock += 100;
    paths.set(workspace, { ...paths.get(workspace), [`${id}.txt`]: id });
    activePaths.set(workspace, `${id}.txt`);
    await act(async () => { own(workspace); root.render(<Probe key={++lifetime} id={id} workspace={workspace} owner={lifetime} />); });
    await until(() => current?.session?.documentId === id && current.ready);
    await tick(); assert(current); return current as Client.CollaborationDocument;
  };
  try {
    observeOpenedDocumentAuth({ data: { user: { id: user }, session: { id: `login-${user}` } } });
    const a = await open('A'), pa = a.provider as unknown as Provider;
    const b = await open('B'), pb = b.provider as unknown as Provider;
    assert.equal(pa.destroyed, false); assert.deepEqual(pa.presence, {}, 'Background heartbeat must not announce an active cursor.');
    const count = requests.length, again = await open('A');
    assert.equal(requests.length, count); assert.equal(again.doc, a.doc); assert.equal(again.provider, a.provider);
    assert(pa.presence); assert.deepEqual(pb.presence, {}, 'Background heartbeat must not announce an active cursor.');

    // Match the real 90-second ticket lifetime, not a synthetic 15-minute one.
    // The inactive document must retain its budget while obtaining fresh HTTP
    // authority; repeated reconciliation must not issue duplicate renewals.
    const beforeTicketRenewal = requests.length;
    const preservedB = Y.encodeStateAsUpdate(b.doc);
    delayNextResponse = true;
    Date.now = () => originalWallClock() + 61_000;
    clock += 61_000;
    await act(async () => exported.flushRetention());
    await until(() => requests.length === beforeTicketRenewal + 1);
    assert.equal(requests.at(-1), 'B');
    const renewedB = providers.filter(provider => provider.options.document === b.doc).at(-1)!;
    assert.notEqual(renewedB, pb);
    assert.equal(renewedB.destroyed, false, 'Pending fresh ticket authority retains the inactive document transport slot.');
    assert.equal(findConnectedOpenedDocument('one', 'B.txt', 'B'), null);
    await act(async () => exported.flushRetention());
    assert.equal(requests.length, beforeTicketRenewal + 1, 'An in-flight renewal is coalesced.');
    await act(async () => { releaseDelayedResponse!(); });
    await until(() => findConnectedOpenedDocument('one', 'B.txt', 'B') !== null);
    assert.equal(renewedB.destroyed, false);
    assert.deepEqual(Y.encodeStateAsUpdate(b.doc), preservedB);
    const beforeDisconnect = requests.length;
    delayNextResponse = true;
    await act(async () => {
      renewedB.options.onClose({ event: { code: 1006, reason: 'owned network interruption' } });
      exported.flushRetention();
    });
    await until(() => requests.length === beforeDisconnect + 1);
    assert.equal(renewedB.destroyed, true, 'The old request scope and provider retire before a fresh reconnect.');
    assert.equal(findConnectedOpenedDocument('one', 'B.txt', 'B'), null,
      'A reconnect cannot expose the previous HTTP authority while renewal is pending.');
    await act(async () => { releaseDelayedResponse!(); });
    await until(() => findConnectedOpenedDocument('one', 'B.txt', 'B') !== null);
    assert.equal(requests.length, beforeDisconnect + 1);
    assert(findConnectedOpenedDocument('one', 'B.txt', 'B'));
    assert.deepEqual(Y.encodeStateAsUpdate(b.doc), preservedB);
    Date.now = originalWallClock;

    constrained = true;
    const c = await open('C', 'two'), pc = c.provider as unknown as Provider;
    assert.equal(pa.destroyed, false); assert.equal(pb.destroyed, true, 'the global mobile budget demotes the older workspace-one document');
    const beforeWarm = requests.length, warm = await open('B');
    assert.equal(requests.length, beforeWarm + 1); assert.equal(warm.doc, b.doc); assert.notEqual(warm.provider, b.provider);
    assert.equal(pa.destroyed, true); assert.equal(pc.destroyed, false);

    await act(async () => {
      const peer = documents.get('C')!; peer.getText('content').insert(0, 'Peer ');
      Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(peer));
      pc.options.onStateless({ payload: JSON.stringify({ type: 'durability_snapshot', documentId: 'C', lifecycleGeneration: 1,
        documentSequence: 2, checkpointSequence: 2, stateVector: Buffer.from(Y.encodeStateVector(peer)).toString('base64'),
        stateProof: collaborationStateProof(peer, Y), projectionFinalized: true, schemaValidated: true }) });
    });
    const beforePeer = requests.length, peer = await open('C', 'two');
    assert.equal(requests.length, beforePeer); assert.equal(peer.doc, c.doc); assert.equal(peer.provider, c.provider);
    assert.equal(peer.doc.getText('content').toString(), 'Peer Saved C');

    await act(async () => (warm.provider as unknown as Provider).options.onAuthenticationFailed({ reason: NATIVE_PEER_ADMISSION_BUSY_REASON }));
    assert.equal((warm.provider as unknown as Provider).destroyed, true);
    const beforeBusy = requests.length, rejoined = await open('B');
    assert.equal(requests.length, beforeBusy + 1); assert.equal(rejoined.doc, b.doc);
    assert.equal(rejoined.clientState.admissionBusy, false);
    const backgroundProvider = rejoined.provider as unknown as Provider;
    await open('C', 'two'); assert.equal(backgroundProvider.destroyed, false);

    const activeProvider = peer.provider as unknown as Provider;
    await act(async () => { clock += 300_000; exported.flushRetention(); });
    assert.equal(backgroundProvider.destroyed, true, 'background networking stops at the inactivity boundary');
    assert.equal(activeProvider.destroyed, false);
    const visibility = async (hidden: boolean) => {
      await act(async () => {
        Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
        document.dispatchEvent(new dom.window.Event('visibilitychange'));
      });
      await tick();
    };
    const beforeHidden = requests.length;
    await visibility(true);
    await act(async () => { clock += 119_999; exported.flushRetention(); });
    assert.equal(activeProvider.disconnects, 0);
    delayNextResponse = true;
    let retiredTokenRejected = false;
    activeProvider.options.onClose({ event: { code: 1006, reason: '' } });
    const retiredToken = activeProvider.options.token().catch(() => { retiredTokenRejected = true; });
    await tick(); assert(releaseDelayedResponse);
    await act(async () => { clock += 1; exported.flushRetention(); });
    assert.equal(activeProvider.destroyed, true, 'the mounted document also retires its transport after two hidden minutes');
    assert.equal(peer.doc.isDestroyed, false);
    assert.equal(activeProvider.presence, null);
    assert.equal(findConnectedOpenedDocument('two', 'C.txt', 'C'), null);
    await act(async () => peer.doc.getText('content').insert(0, 'Local while hidden '));
    const hiddenText = peer.doc.getText('content').toString();
    await act(async () => { clock += 300_000; exported.flushRetention(); });
    assert.equal(requests.length, beforeHidden + 1, 'hidden idle time cannot restart HTTP authorization');
    permission = 'read';
    await visibility(false);
    await until(() => Boolean(findConnectedOpenedDocument('two', 'C.txt', 'C')));
    assert.equal(requests.length, beforeHidden + 2, 'resume obtains fresh HTTP authority');
    const resumedProvider = current!.provider as unknown as Provider;
    assert.notEqual(resumedProvider, activeProvider);
    assert.equal(current!.doc, peer.doc); assert.equal(peer.doc.getText('content').toString(), hiddenText);
    assert.equal(current!.session!.permission, 'read', 'fresh resume observes a write-permission downgrade');
    assert(resumedProvider.presence);
    await act(async () => { releaseDelayedResponse!(); await retiredToken; });
    assert(retiredTokenRejected, 'a token response started before pause must be retired');
    assert.equal(current!.session!.permission, 'read', 'a late pre-pause write response cannot undo the fresh downgrade');
    permission = 'write';
    await visibility(true);
    await act(async () => { clock += 120_000; exported.flushRetention(); });
    const beforeHiddenLogout = requests.length;
    await act(async () => { invalidateOpenedDocumentAuth(); });
    assert.equal(activeProvider.destroyed, true);
    assert.equal(findConnectedOpenedDocument('two', 'C.txt', 'C'), null);
    await visibility(false);
    assert.equal(requests.length, beforeHiddenLogout, 'returning to a signed-out app cannot reauthorize an old document');
    user = 'another-owner';
    await act(async () => observeOpenedDocumentAuth({ data: { user: { id: user }, session: { id: `login-${user}` } } }));
    const other = await open('C', 'two'); assert.notEqual(other.doc, c.doc, 'another login cannot inherit the RAM document lifetime');
    paths.set('two', {});
    activePaths.set('two', null);
    await act(async () => { own('two'); root.render(null); }); current = null;
    await until(() => other.doc.isDestroyed);

    permission = 'read';
    const readonly = await open('D', 'two'), readProvider = readonly.provider as unknown as Provider;
    assert.equal(readonly.connection, 'read_only');
    await act(async () => readProvider.options.onStatus({ status: 'disconnected' }));
    assert.equal(findConnectedOpenedDocument('two', 'D.txt', 'D'), null, 'read_only UI status cannot substitute for a connected lifetime');
    await act(async () => {
      readProvider.options.onClose({ event: { code: 1006, reason: '' } });
      readProvider.options.onStatus({ status: 'connected' }); readProvider.options.onSynced();
    });
    assert.equal(findConnectedOpenedDocument('two', 'D.txt', 'D'), null, 'reconnected transport cannot reuse its old HTTP authority');
    const beforeRenewal = requests.length;
    await act(async () => { await readProvider.options.token(); readProvider.options.onSynced(); });
    await tick();
    assert.equal(requests.length, beforeRenewal + 1); assert(findConnectedOpenedDocument('two', 'D.txt', 'D'));
    await act(async () => readProvider.options.onSynced({ state: false }));
    assert.equal(findConnectedOpenedDocument('two', 'D.txt', 'D'), null, 'a false synced event cannot restore live provenance');
    enabled = false; permission = 'write';
    const rollbackA = await open('A'), rollbackProvider = rollbackA.provider as unknown as Provider;
    await open('B');
    assert.equal(rollbackProvider.destroyed, true, 'the rollback mode stops background providers');
    const beforeRollback = requests.length, rollbackAgain = await open('A');
    assert.equal(requests.length, beforeRollback + 1, 'rollback mode uses the original session bootstrap');
    assert.equal(rollbackAgain.doc, rollbackA.doc);
    enabled = true;
    await act(async () => { own('one'); rollbackAgain.doc.getText('content').insert(0, 'Unsaved local '); });
    const dirtyBytes = Y.encodeStateAsUpdate(rollbackAgain.doc);
    databaseUnavailable = true;
    paths.set('one', {}); activePaths.set('one', null);
    await act(async () => { own('one'); root.render(null); });
    await tick();
    assert.equal((rollbackAgain.provider as unknown as Provider).destroyed, true, 'release immediately stops networking even when backup is unavailable');
    assert.equal(rollbackAgain.doc.isDestroyed, false, 'failed local backup must retain the last dirty RAM copy');
    assert.deepEqual(Y.encodeStateAsUpdate(rollbackAgain.doc), dirtyBytes);
    databaseUnavailable = false;
    quotaExceeded = true;
    await act(async () => exported.flushRetention()); await tick();
    assert.equal(rollbackAgain.doc.isDestroyed, false, 'quota failure also retains the last dirty RAM copy');
    assert.deepEqual(Y.encodeStateAsUpdate(rollbackAgain.doc), dirtyBytes);
    quotaExceeded = false;
    await act(async () => exported.flushRetention());
    await until(() => rollbackAgain.doc.isDestroyed);
    console.log('Live tabs: same provider/Y.Doc without new session, peer updates, global mobile cap, authorized warm/busy reconnect, expiry, hidden-app pause/fresh resume with local edits and current rights, presence, auth isolation, close, read-only connection renewal, rollback and dirty-copy preservation on missing storage/quota failure passed.');
  } finally {
    await act(async () => { root.unmount(); exported.clearOpenedCollaborationTabs(); invalidateOpenedDocumentAuth(); });
    await tick(); globalThis.fetch = originalFetch; Date.now = originalWallClock;
    if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor); else Reflect.deleteProperty(performance, 'now');
    for (const doc of documents.values()) doc.destroy(); dom.window.close();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
