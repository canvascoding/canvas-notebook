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
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { findOpenedLiveDocument, observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';

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
  observeOpenedDocumentAuth({ data: { user: { id: 'user' }, session: { id: 'session' } } });
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
    disconnected = false;
    constructor(readonly options: ProviderOptions) { providers.push(this); }
    setAwarenessField() {}
    sendStateless() {}
    disconnect() { this.disconnected = true; }
    destroy() { this.destroyed = true; }
  }
  const persistences: FakePersistence[] = [];
  let nextHydration: Promise<void> | undefined;
  class FakePersistence {
    synced = true;
    db = committedCollaborationTestDatabase();
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

    const authorizationFailures: unknown[] = [];
    const scenarios: Array<{ name: string; timing: 'before' | 'during'; permission: 'write' | 'read';
      guard?: 'proof' | 'unknown' | 'schema'; retryRace?: 'write' | 'read' | 'unknown' }> = [
      { name: 'before', timing: 'before', permission: 'write' },
      { name: 'during', timing: 'during', permission: 'write' },
      { name: 'read', timing: 'before', permission: 'read' },
      { name: 'delete-set-proof', timing: 'before', permission: 'write', guard: 'proof' },
      { name: 'prior-unknown', timing: 'before', permission: 'write', guard: 'unknown' },
      { name: 'prior-schema', timing: 'before', permission: 'write', guard: 'schema' },
      { name: 'retry-race-write', timing: 'before', permission: 'write', retryRace: 'write' },
      { name: 'retry-race-read', timing: 'before', permission: 'write', retryRace: 'read' },
      { name: 'retry-race-unknown', timing: 'before', permission: 'write', retryRace: 'unknown' },
    ];
    for (const scenario of scenarios) {
      await act(async () => root.render(null));
      const sourcePath = `before-access-${scenario.name}.txt`;
      const targetPath = `after-access-${scenario.name}.txt`;
      const supersedingPath = `superseding-access-${scenario.name}.txt`;
      const owner = `authorization-${scenario.name}`;
      const initial = { ...session, documentId: `access-doc-${scenario.name}`, documentName: `access-doc-${scenario.name}` };
      const requests: string[] = [];
      let destinationGate = deferred<Response>();
      let destinationReleased = false;
      let destinationSession: CollaborationSessionResponse;
      let destinationFailure: Response | null = null;
      globalThis.fetch = async (input, init) => {
        assert.equal(input, '/api/files/collaboration/session', 'automatic location revalidation uses authorization, not a checkpoint retry');
        assert.equal(new Headers(init?.headers).get('x-test-workspace'), 'workspace');
        const body = JSON.parse(String(init?.body)) as { path: string };
        requests.push(body.path);
        if (body.path === sourcePath) return Response.json(initial);
        if (body.path === supersedingPath) return Response.json({ ...destinationSession,
          token: `superseding-ticket-${scenario.name}`, permission: 'write' });
        assert.equal(body.path, targetPath);
        if (destinationFailure) { const response = destinationFailure; destinationFailure = null; return response; }
        // A revoke during the first request invalidates its authorization revision.
        // The real registry must retry that response with a newly captured revision.
        return destinationReleased ? Response.json(destinationSession) : destinationGate.promise;
      };
      const replica = new Y.Doc();
      const withoutDeletion = new Y.Doc();
      const providerStart: number = providers.length;
      const persistenceStart: number = persistences.length;
      try {
        await render(sourcePath, owner); await until(() => providers.length === providerStart + 1);
        const oldProvider: FakeProvider = providers[providerStart];
        await act(async () => oldProvider.options.onSynced());
        const retained = get().doc;
        const retainedPersistence: FakePersistence = persistences[persistenceStart];
        const retainedText = retained.getText('content');
        view = new EditorView({ parent: dom.window.document.body, state: EditorState.create({ doc: retainedText.toString(),
          extensions: [createTextEditorCollaboration(retainedText, null)] }) });
        await act(async () => {
          view!.dispatch({ changes: { from: 3, insert: ' local' } });
          retained.transact(() => retainedText.insert(0, 'Peer '), 'peer');
          Y.applyUpdate(withoutDeletion, Y.encodeStateAsUpdate(retained));
          view!.dispatch({ changes: { from: 5, to: 6 } });
          oldProvider.options.onUnsyncedChanges({ number: 1 });
          Y.applyUpdate(replica, Y.encodeStateAsUpdate(retained));
          oldProvider.options.onUnsyncedChanges({ number: 0 });
        });
        assert.equal(retainedText.toString(), 'Peer AA local');
        assert.deepEqual(Y.encodeStateVector(withoutDeletion), Y.encodeStateVector(replica), 'a deletion does not advance the state vector');
        assert.notEqual(collaborationStateProof(withoutDeletion, Y), collaborationStateProof(replica, Y), 'full proof includes the deleted range');
        const sequence = 6;
        const authoritative = (doc: Y.Doc) => ({ type: 'durability_snapshot', success: true,
          documentId: initial.documentId, lifecycleGeneration: initial.lifecycleGeneration,
          documentSequence: sequence, checkpointSequence: sequence,
          stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof: collaborationStateProof(doc, Y),
          degraded: false, projectionFinalized: true, schemaValidated: true });
        await act(async () => oldProvider.options.onStateless({ payload: JSON.stringify(authoritative(replica)) }));
        assert.equal(get().durability, 'checkpointed_file', 'the original content and deletion are durably acknowledged before the move');
        if (scenario.guard === 'unknown' || scenario.guard === 'schema') {
          await act(async () => oldProvider.options.onStateless({ payload: JSON.stringify({ type: 'degraded',
            documentId: initial.documentId, lifecycleGeneration: initial.lifecycleGeneration, documentSequence: sequence,
            message: 'Existing document quarantine',
            ...(scenario.guard === 'schema' ? { code: COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid } : {}) }) }));
          assert.equal(get().durability, 'degraded');
        }
        destinationSession = { ...initial, permission: scenario.permission, token: `fresh-location-${scenario.name}`,
          documentSequence: sequence, checkpointSequence: sequence,
          stateVector: Buffer.from(Y.encodeStateVector(replica)).toString('base64'),
          // HTTP authorizes this path and identity. The provider must separately
          // receive a complete current snapshot before the blocked UI can resume.
          stateProof: undefined, degraded: false, projectionFinalized: true };
        const revoke = () => oldProvider.options.onStateless({ payload: JSON.stringify({ type: 'access_revoked',
          message: 'The old path ticket is no longer authorized.' }) });
        if (scenario.timing === 'before') {
          await act(async () => revoke());
          assert.equal(get().canRevalidateLocation, false, 'an unmoved access failure has no location-retry capability');
          const beforeUnavailableRetry: number = requests.length;
          await assert.rejects(get().requestLocationRevalidation!(), /cannot be revalidated/u);
          assert.equal(requests.length, beforeUnavailableRetry, 'an ineligible retry never requests a replacement ticket');
        }
        await render(targetPath, owner);
        await until(() => requests.includes(targetPath));
        if (scenario.timing === 'during') await act(async () => revoke());
        assert.equal(oldProvider.disconnected, true, 'the revoked provider cannot continue using old write rights');
        await act(async () => { destinationReleased = true; destinationGate.resolve(Response.json(destinationSession)); });
        await until(() => providers.length === providerStart + 2);
        const provider: FakeProvider = providers[providerStart + 1];
        assert.equal(get().doc, retained);
        assert.equal(persistences.length, persistenceStart + 1, 'location reauthorization retains the existing IndexedDB adapter');
        assert.equal(retainedPersistence.destroyed, false);
        assert.equal(oldProvider.destroyed, true);
        assert.equal(get().ready, false, 'fresh HTTP write authorization alone is insufficient');
        assert.equal(get().durability, 'degraded');
        assert.equal(await provider.options.token(), destinationSession.token, 'the new provider may synchronize existing updates while UI editing remains paused');
        if (scenario.timing === 'during') assert.ok(requests.filter((requested) => requested === targetPath).length >= 2,
          'the stale in-flight HTTP receipt is replaced by a fresh authorization response');
        await act(async () => {
          oldProvider.options.onStateless({ payload: JSON.stringify({ type: 'access_revoked', message: 'Late old revoke' }) });
          oldProvider.options.onSynced();
          oldProvider.options.onStateless({ payload: JSON.stringify({ ...authoritative(replica), documentSequence: 99, checkpointSequence: 99 }) });
        });
        assert.equal(get().ready, false, 'late old provider callbacks cannot release the location pause');
        assert.equal(get().clientState.documentSequence, sequence);
        await act(async () => { provider.options.onStatus({ status: 'connected' }); provider.options.onSynced(); });
        const canEdit = () => get().ready && get().session?.permission === 'write' && get().connection === 'live'
          && get().durability !== 'degraded';
        assert.equal(canEdit(), false, 'authenticated synchronization still requires exact persisted snapshot evidence');
        for (const identity of [{ documentId: 'foreign-document' }, { lifecycleGeneration: 2 }]) {
          await act(async () => provider.options.onStateless({ payload: JSON.stringify({ ...authoritative(replica), ...identity }) }));
          assert.equal(canEdit(), false, 'another document or generation cannot validate this location');
        }
        let racePromise: Promise<void> | undefined;
        let raceSettled = false;
        if (scenario.retryRace) {
          exported.rememberOpenedCollaborationDocument(get(), { path: targetPath, content: retainedText.toString(),
            collaboration: { path: targetPath, strategy: 'crdt_text', crdtCapable: true, sceneCapable: false,
              lockRequired: false, requiresRevisionCheck: false, latestRevision: null, activeLock: null,
              document: { id: initial.documentId, provider: 'yjs', stateVersion: sequence,
                snapshotRevisionId: null, status: 'active' } } }, 'workspace');
          assert.equal(findOpenedLiveDocument('workspace', targetPath, initial.documentId)?.session.permission, 'write',
            'the pending retry race includes an actual remembered current write receipt');
          assert.equal(get().canRevalidateLocation, true);
          destinationSession = { ...destinationSession, permission: scenario.retryRace === 'read' ? 'read' : 'write',
            token: `race-ticket-${scenario.name}` };
          destinationGate = deferred<Response>(); destinationReleased = false;
          const beforeRaceRequest: number = requests.length;
          await act(async () => {
            racePromise = get().requestLocationRevalidation!();
            void racePromise.then(() => { raceSettled = true; }, () => { raceSettled = true; });
          });
          await until(() => requests.length === beforeRaceRequest + 1);
          assert.equal(get().revalidatingLocation, true);
          if (scenario.retryRace === 'unknown') {
            await act(async () => provider.options.onStateless({ payload: JSON.stringify({ type: 'degraded',
              message: 'A different unknown failure appeared while authorization was pending.', documentSequence: sequence }) }));
          }
        }
        await act(async () => {
          provider.options.onUnsyncedChanges({ number: 1 });
          provider.options.onStateless({ payload: JSON.stringify(authoritative(scenario.guard === 'proof' ? withoutDeletion : replica)) });
        });
        assert.equal(canEdit(), false, 'unsynchronized local updates cannot be acknowledged by a location change');
        await act(async () => provider.options.onUnsyncedChanges({ number: 0 }));
        assert.equal(get().doc, retained);
        assert.equal(get().clientState.documentSequence, sequence, 'a pure move must not manufacture a newer content sequence');
        if (scenario.retryRace) {
          assert.equal(raceSettled, false, 'automatic proof completion cannot settle the pending authorization response');
          if (scenario.retryRace === 'unknown') assert.equal(canEdit(), false);
          else assert.equal(canEdit(), true, 'the exact current proof can finish automatic recovery while retry HTTP is pending');
          await act(async () => { destinationReleased = true; destinationGate.resolve(Response.json(destinationSession)); });
          if (scenario.retryRace === 'unknown') {
            await assert.rejects(racePromise!, /could not be revalidated/u);
            assert.equal(providers.length, providerStart + 2, 'an intervening unknown failure is never reclassified by the retry response');
          } else if (scenario.retryRace === 'write') {
            await act(async () => racePromise);
            assert.equal(providers.length, providerStart + 2, 'already recovered write access needs no additional provider replacement');
            assert.equal(get().provider, provider);
          } else {
            await until(() => providers.length === providerStart + 3);
            const readProvider: FakeProvider = providers[providerStart + 2];
            assert.equal(get().session?.permission, 'read', 'the fresh response downgrades the earlier write receipt');
            assert.equal(canEdit(), false);
            await act(async () => { readProvider.options.onStatus({ status: 'connected' }); readProvider.options.onSynced(); });
            assert.equal(raceSettled, false, 'a read downgrade still waits for an exact current snapshot');
            await act(async () => {
              readProvider.options.onStateless({ payload: JSON.stringify(authoritative(replica)) });
              await racePromise;
            });
            assert.equal(get().connection, 'read_only');
            assert.equal(findOpenedLiveDocument('workspace', targetPath, initial.documentId), null,
              'the old cached write receipt was invalidated by the fresh read authorization');
          }
          assert.equal(get().revalidatingLocation, false);
        }
        if (scenario.permission === 'read' || scenario.guard || scenario.retryRace === 'read' || scenario.retryRace === 'unknown') {
          assert.equal(canEdit(), false, `${scenario.name} does not authorize write recovery`);
          if (scenario.permission === 'read') assert.equal(get().connection, 'read_only');
          if (scenario.guard === 'unknown' || scenario.guard === 'schema' || scenario.retryRace === 'unknown') {
            assert.equal(get().canRevalidateLocation, false, 'unrelated quarantines have no authorization-retry capability');
            const beforeBlockedRetry: number = requests.length;
            await assert.rejects(get().requestLocationRevalidation!(), /cannot be revalidated/u);
            assert.equal(requests.length, beforeBlockedRetry);
          }
        } else {
          assert.equal(get().durability, 'checkpointed_file', `same-sequence healthy proof completes the ${scenario.timing} location authorization pause`);
          assert.equal(canEdit(), true, 'fresh authorized synchronization and exact current proof restore editing eligibility');
          assert.equal(get().clientState.failure, null);
          assert.equal(get().error, null);
          await act(async () => oldProvider.options.onStateless({ payload: JSON.stringify({ type: 'access_revoked', message: 'Late old revoke after recovery' }) }));
          assert.equal(canEdit(), true, 'a retired provider cannot deny the newly validated location');
          if (scenario.name === 'before' || scenario.name === 'during') {
            await act(async () => provider.options.onStateless({ payload: JSON.stringify({ type: 'access_revoked',
              message: 'Revalidate the already adopted location.' }) }));
            assert.equal(get().canRevalidateLocation, true, 'a paused adopted location exposes the targeted connection retry');
            const currentSession: CollaborationSessionResponse = { ...destinationSession, permission: 'write' };
            const beforeExplicitProviders: number = providers.length;
            if (scenario.name === 'before') {
              destinationFailure = Response.json({ success: false, error: 'Target authorization denied.' }, { status: 403 });
              await act(async () => { await assert.rejects(get().requestLocationRevalidation!(), /Target authorization denied/u); });
              assert.equal(get().revalidatingLocation, false);
              assert.equal(get().canRevalidateLocation, true, 'a failed authorization request permits another explicit retry');
              assert.equal(canEdit(), false);
              assert.equal(providers.length, beforeExplicitProviders, 'a failed HTTP authorization never replaces the current provider');
              for (const identity of [
                { documentId: 'foreign-document' }, { documentName: 'foreign-room' }, { lifecycleGeneration: 2 },
                { richTextSchemaVersion: 999 }, { guestAccess: { invitationId: 'foreign-guest', workspaceId: 'workspace' } },
              ]) {
                destinationSession = { ...currentSession, ...identity };
                await act(async () => { await assert.rejects(get().requestLocationRevalidation!(), /document changed|identity|generation/u); });
                assert.equal(get().doc, retained, 'a retry must not replay the original changes into another document identity');
                assert.equal(providers.length, beforeExplicitProviders);
                assert.equal(get().revalidatingLocation, false);
                assert.equal(canEdit(), false);
              }
            }
            destinationSession = { ...currentSession, token: `same-path-retry-${scenario.name}` };
            destinationGate = deferred<Response>(); destinationReleased = false;
            const pausedView = get();
            const beforeExplicitRequests: number = requests.length;
            let retryPromise!: Promise<void>;
            let duplicatePromise!: Promise<void>;
            let retrySettled = false;
            await act(async () => {
              retryPromise = pausedView.requestLocationRevalidation!();
              duplicatePromise = pausedView.requestLocationRevalidation!();
              void retryPromise.then(() => { retrySettled = true; }, () => { retrySettled = true; });
            });
            assert.equal(duplicatePromise, retryPromise, 'duplicate clicks share the same in-flight revalidation');
            await until(() => requests.length === beforeExplicitRequests + 1);
            assert.equal(requests.at(-1), targetPath, 'explicit recovery authorizes the current destination without inventing another path');
            assert.equal(get().revalidatingLocation, true);
            assert.equal(retrySettled, false);
            await act(async () => { destinationReleased = true; destinationGate.resolve(Response.json(destinationSession)); });
            await until(() => providers.length === beforeExplicitProviders + 1);
            const retryProvider: FakeProvider = providers[beforeExplicitProviders];
            assert.equal(provider.destroyed, true);
            assert.equal(get().doc, retained);
            assert.equal(persistences.length, persistenceStart + 1);
            assert.equal(retainedPersistence.destroyed, false);
            assert.equal(get().revalidatingLocation, true);
            assert.equal(retrySettled, false, 'successful HTTP alone does not finish the retry');
            const afterExplicitRequests: number = requests.length;
            await assert.rejects(pausedView.requestLocationRevalidation!(), /location changed/u);
            assert.equal(requests.length, afterExplicitRequests, 'a stale view callback cannot authorize the new provider lifetime');
            await act(async () => { retryProvider.options.onStatus({ status: 'connected' }); retryProvider.options.onSynced(); });
            assert.equal(retrySettled, false, 'the retry remains pending until the exact full snapshot is confirmed');
            assert.equal(canEdit(), false);
            await act(async () => {
              retryProvider.options.onUnsyncedChanges({ number: 1 });
              retryProvider.options.onStateless({ payload: JSON.stringify(authoritative(replica)) });
            });
            assert.equal(retrySettled, false);
            await act(async () => { retryProvider.options.onUnsyncedChanges({ number: 0 }); await retryPromise; });
            assert.equal(canEdit(), true);
            assert.equal(get().durability, 'checkpointed_file');
            assert.equal(get().clientState.documentSequence, sequence);
            assert.equal(get().revalidatingLocation, false);
            assert.equal(requests.length, beforeExplicitRequests + 1, 'duplicate calls never issue a second HTTP authorization');

            if (scenario.name === 'before') {
              await act(async () => retryProvider.options.onStateless({ payload: JSON.stringify({ type: 'access_revoked',
                message: 'A delayed same-path retry is about to be superseded by another move.' }) }));
              destinationGate = deferred<Response>(); destinationReleased = false;
              const staleGate = destinationGate;
              const beforeStaleRequest: number = requests.length;
              const beforeSupersedingProviders: number = providers.length;
              let staleRetry!: Promise<void>;
              await act(async () => { staleRetry = get().requestLocationRevalidation!(); void staleRetry.catch(() => undefined); });
              await until(() => requests.length === beforeStaleRequest + 1);
              await render(supersedingPath, owner);
              await until(() => providers.length === beforeSupersedingProviders + 1);
              const supersedingProvider: FakeProvider = providers[beforeSupersedingProviders];
              await act(async () => {
                supersedingProvider.options.onStatus({ status: 'connected' }); supersedingProvider.options.onSynced();
                supersedingProvider.options.onStateless({ payload: JSON.stringify(authoritative(replica)) });
              });
              assert.equal(canEdit(), true);
              assert.equal(get().doc, retained);
              await act(async () => { staleGate.resolve(Response.json(destinationSession));
                await assert.rejects(staleRetry, /location changed|aborted/u); });
              assert.equal(get().provider, supersedingProvider, 'a late retry response cannot replace the newer location provider');
              assert.equal(providers.length, beforeSupersedingProviders + 1, 'the obsolete retry creates no orphan provider');
              assert.equal(canEdit(), true);
              assert.equal(get().clientState.documentSequence, sequence);
              assert.equal(get().revalidatingLocation, false);
            }
          }
          await act(async () => view!.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true,
          })));
          assert.equal(retainedText.toString(), 'Peer AAA local', 'the first Undo restores the local deletion and keeps the local insertion and peer edit');
          await act(async () => view!.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true,
          })));
          assert.equal(retainedText.toString(), 'Peer AAA', 'the second Undo removes the earlier local insertion while preserving the peer edit');
        }
      } catch (error) { authorizationFailures.push(error); }
      finally {
        view?.destroy(); view = undefined;
        replica.destroy(); withoutDeletion.destroy();
      }
    }
    if (authorizationFailures.length) throw new AggregateError(authorizationFailures, 'Collaborative move authorization regression failed.');
    console.log('Collaborative rename: delayed resolver, document/history retention, request cancellation, provider fencing, current-path renewal, generation isolation and hydration passed.');
    console.log('Move authorization: before/during revocation, same-sequence full proof, retained Undo/storage, read-only and quarantine protection passed.');
    console.log('Same-path revalidation: HTTP failure retry, identity/lifetime fences, promise dedupe, exact-proof wait and automatic-recovery write/read/unknown races passed.');
  } finally {
    view?.destroy(); globalThis.fetch = previousFetch;
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert(providers.every((provider) => provider.destroyed));
    assert(persistences.every((persistence) => persistence.destroyed));
    observeOpenedDocumentAuth(null);
    server.destroy(); dom.window.close();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
