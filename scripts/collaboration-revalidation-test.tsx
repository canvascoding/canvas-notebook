import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';
import type * as Client from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import type { CurrentFile } from '../app/lib/files/types';
import messages from '../messages/en.json';

type ProviderOptions = {
  onStatus: (value: { status: string }) => void;
  onSynced: () => void;
  onStateless: (value: { payload: string }) => void;
  onAuthenticationFailed: (value: { reason: string }) => void;
};

async function main() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://canvas.test' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { MarkdownSaveState } = await import('../app/components/editor/MarkdownDocumentModes');
  const seed = new Y.Doc(); seed.getText('content').insert(0, 'ABC');
  const providers: FakeProvider[] = [];
  class FakeProvider {
    constructor(readonly options: ProviderOptions) { providers.push(this); }
    setAwarenessField() {}
    sendStateless() {}
    destroy() {}
  }
  class FakePersistence {
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
  const requireMock = (name: string) => name === '@hocuspocus/provider' ? { HocuspocusProvider: FakeProvider }
    : name === 'y-indexeddb' ? { IndexeddbPersistence: FakePersistence } : load(name);
  new Function('require', 'module', 'exports', compiled.outputText)(requireMock, { exports: client }, client);
  const originalFetch = globalThis.fetch;
  const requests: { resolve: (response: Response) => void; proof: string }[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/files/collaboration/checkpoint');
    return new Promise<Response>((resolve) => requests.push({ resolve, proof: JSON.parse(String(init?.body)).stateProof }));
  };
  let current: Client.CollaborationDocument | null = null;
  let owner = 0;
  let session!: CollaborationSessionResponse;
  let file!: CurrentFile;
  const root = createRoot(document.getElementById('root')!);
  function Probe() {
    current = client.useCollaborationDocument({ enabled: true, workspaceId: 'workspace', path: file.path,
      documentKey: String(owner), representation: 'plain_text', session });
    return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <MarkdownSaveState collaboration={current} filePath={file.path} available content="ABC" />
    </NextIntlClientProvider>;
  }
  const get = () => { assert(current?.provider); return current; };
  const provider = () => providers.at(-1)!;
  const until = async (predicate: () => boolean) => {
    for (let i = 0; !predicate() && i < 50; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    assert(predicate());
  };
  const send = (message: unknown) => act(async () => provider().options.onStateless({ payload: JSON.stringify(message) }));
  const fixture = async () => {
    owner++;
    session = { success: true, documentId: `doc-${owner}`, documentName: `doc-${owner}`, provider: 'yjs', representation: 'plain_text',
      lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write',
      documentSequence: 1, checkpointSequence: 0, stateVector: Buffer.from(Y.encodeStateVector(seed)).toString('base64'),
      stateProof: collaborationStateProof(seed, Y), token: 'test-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
      user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' } };
    file = { path: 'document.md', content: 'ABC', editorIdentity: String(owner), collaboration: {
      path: 'document.md', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
      requiresRevisionCheck: false, latestRevision: null, activeLock: null,
      document: { id: session.documentId, provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
    } };
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
      useFileStore.setState({ currentFile: file, currentFileWorkspaceId: 'workspace', treeGeneration: owner });
      root.render(<StrictMode><Probe /></StrictMode>);
    });
    await until(() => current?.session?.documentId === session.documentId && !!current.provider);
    await act(async () => { provider().options.onStatus({ status: 'connected' }); provider().options.onSynced(); });
    await send({ type: 'degraded', code: COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable, message: `Validation paused ${owner}` });
  };
  const button = () => [...document.querySelectorAll('button')].find((element) => element.textContent === messages.notebook.editorModes.retry);
  const click = () => act(async () => { assert(button()); button()!.click(); });
  const respond = (body: unknown, status = 200) => act(async () => requests.at(-1)!.resolve(Response.json(body, { status })));
  const checkpoint = (doc: Y.Doc, sequence: number) => ({ success: true, documentId: session.documentId,
    lifecycleGeneration: session.lifecycleGeneration, documentSequence: sequence, checkpointSequence: sequence,
    stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof: collaborationStateProof(doc, Y) });
  try {
    await fixture();
    assert.equal(get().clientState.failure?.kind, 'validation');
    assert(document.body.textContent!.includes(messages.notebook.editorModes.failure.validation));
    assert.equal(get().durability, 'degraded'); assert(button(), 'paused saving offers explicit revalidation');
    await click(); await click();
    assert.equal(requests.length, 1); assert(button()!.disabled);
    await respond({ error: 'Still invalid', code: COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable }, 422);
    assert.equal(get().durability, 'degraded'); assert.equal(button()!.disabled, false);
    await click(); await respond({ error: 'Storage temporarily unavailable' }, 503);
    assert.equal(get().durability, 'degraded', 'a transient retry failure must not release the edit/save gate');
    assert.equal(get().clientState.failure?.kind, 'validation', 'a failed retry retains the reason structural editing is blocked');
    assert.match(document.body.textContent!, /Storage temporarily unavailable/u);
    await act(async () => { provider().options.onStatus({ status: 'connecting' }); provider().options.onStatus({ status: 'connected' }); });
    assert.equal(get().durability, 'degraded');

    await click();
    const old = checkpoint(get().doc, 2);
    const vector = Y.encodeStateVector(get().doc);
    await act(async () => get().doc.getText('content').delete(0, 1));
    assert.deepEqual(Y.encodeStateVector(get().doc), vector);
    await respond(old);
    assert.equal(get().durability, 'degraded', 'a successful old checkpoint cannot validate a newer delete set');
    await send({ type: 'durability_snapshot', ...checkpoint(get().doc, 3), checkpointSequence: 2 });
    assert.equal(get().durability, 'degraded', 'binary persistence alone cannot clear the paused Markdown checkpoint');
    const before = Y.encodeStateAsUpdate(get().doc);
    await click();
    assert.equal(requests.at(-1)!.proof, collaborationStateProof(get().doc, Y));
    await respond(checkpoint(get().doc, 3));
    assert.equal(get().durability, 'checkpointed_file'); assert.equal(get().error, null);
    assert.equal(get().clientState.failure, null);
    assert.equal(button(), undefined); assert(!document.body.textContent!.includes('Storage temporarily unavailable'));
    assert.deepEqual(Y.encodeStateAsUpdate(get().doc), before, 'revalidation never rewrites the document');

    for (const failureStatus of [422, 503]) {
      await send({ type: 'degraded', message: 'Awaiting a repaired checkpoint' }); await click();
      await send({ type: 'durability_snapshot', ...checkpoint(get().doc, failureStatus) });
      assert.equal(get().durability, 'checkpointed_file');
      await respond({ error: 'Obsolete HTTP failure', code: failureStatus === 422
        ? COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable : COLLABORATION_CHECKPOINT_ERROR_CODES.failed }, failureStatus);
      assert.equal(get().durability, 'checkpointed_file', 'a delayed HTTP failure cannot revoke a newer exact checkpoint');
      assert(!document.body.textContent!.includes('Obsolete HTTP failure'));
    }

    await send({ type: 'degraded', message: 'Paused before peer repair' }); await click();
    await respond({ error: 'Failure before peer repair' }, 503);
    assert(document.body.textContent!.includes('Failure before peer repair'));
    await send({ type: 'durability_snapshot', ...checkpoint(get().doc, 504) });
    assert(!document.body.textContent!.includes('Failure before peer repair'), 'a peer checkpoint also clears the obsolete retry alert');
    await act(async () => get().doc.getText('content').insert(0, 'new '));
    assert(!document.body.textContent!.includes('Failure before peer repair'), 'new editing must not resurrect a repaired error');

    await send({ type: 'degraded', message: 'Paused again' }); await click();
    const oldRequest = requests.at(-1)!;
    await fixture();
    await act(async () => oldRequest.resolve(Response.json({ error: 'Obsolete retry failure' }, { status: 503 })));
    assert.equal(get().error, 'Validation paused 2');
    assert(!document.body.textContent!.includes('Obsolete retry failure'), 'an old retry cannot populate the new document status');
    assert.equal(button()!.disabled, false);
    await send({ type: 'degraded', message: 'Legacy message without a code' });
    assert.equal(get().clientState.failure?.kind, 'unknown');
    await send({ type: 'degraded', code: { kind: 'validation' }, message: 'Malformed code' });
    assert.equal(get().clientState.failure?.kind, 'unknown');
    await send({ type: 'degraded', code: COLLABORATION_FAILURE_CODES.persistenceFailed, message: 'Storage failed' });
    assert.equal(get().clientState.failure?.kind, 'storage');
    await click();
    const staleGenerationRequestCount = requests.length;
    await send({ type: 'durability_snapshot', ...checkpoint(get().doc, 10) });
    await respond({ code: COLLABORATION_FAILURE_CODES.generationChanged, error: 'Session generation changed' }, 409);
    assert.equal(requests.length, staleGenerationRequestCount, 'an obsolete generation is not retried as a transient persistence delay');
    assert.equal(get().clientState.failure?.kind, 'lifecycle');
    assert(document.body.textContent!.includes(messages.notebook.editorModes.failure.lifecycle));
    assert.equal(button(), undefined, 'an obsolete session cannot use the retry action');
    await send({ type: 'durability_snapshot', ...checkpoint(get().doc, 10) });
    await act(async () => { provider().options.onStatus({ status: 'connected' }); provider().options.onSynced(); });
    assert.equal(get().durability, 'degraded'); assert.equal(get().clientState.failure?.kind, 'lifecycle',
      'old-generation acknowledgements and reconnects cannot repair a lifecycle failure');
    const beforeRename = get().doc;
    file = { ...file, path: 'renamed.md', collaboration: { ...file.collaboration!, path: 'renamed.md' } };
    await act(async () => {
      useFileStore.setState({ currentFile: file }); root.render(<StrictMode><Probe /></StrictMode>);
    });
    await until(() => current?.doc === beforeRename && !!current.provider);
    await act(async () => { provider().options.onStatus({ status: 'connected' }); provider().options.onSynced(); });
    assert.equal(get().doc, beforeRename); assert.equal(get().clientState.failure, null,
      'a validated same-document rename adopts its new session and removes the old location failure');
    await send({ type: 'degraded', code: COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable, message: 'Validation paused again' });
    await click();
    await send({ type: 'durability_snapshot', ...checkpoint(get().doc, 11) });
    await respond({ error: 'Write access was revoked' }, 403);
    assert.equal(get().connection, 'denied', 'HTTP permission denial revokes the client before a WebSocket denial arrives');
    assert.equal(get().clientState.failure?.kind, 'authentication');
    await send({ type: 'durability_snapshot', ...checkpoint(get().doc, 11) });
    assert.equal(get().clientState.failure?.kind, 'authentication', 'a file checkpoint does not grant access');
    await act(async () => {
      provider().options.onStatus({ status: 'connecting' }); provider().options.onStatus({ status: 'connected' });
    });
    assert.equal(get().connection, 'denied', 'a reconnected socket does not grant access before authenticated sync');
    await act(async () => {
      get().doc.getText('content').insert(0, 'received while denied ');
      provider().options.onSynced();
    });
    assert.equal(get().connection, 'live'); assert.equal(get().durability, 'degraded');
    assert.equal(get().clientState.failure?.kind, 'unknown');
    assert(button(), 'successful reauthentication allows validating the current state again');
    await act(async () => provider().options.onAuthenticationFailed({ reason: 'Write permission revoked' }));
    assert.equal(get().clientState.failure?.kind, 'authentication');
    assert.equal(button(), undefined, 'a denied connection cannot retry a checkpoint');
    console.log('Paused checkpoints support scoped retries; failures, reconnects, old proofs and binary-only acknowledgements never grant a false release.');
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    await new Promise((done) => setTimeout(done, 1_100));
    seed.destroy(); dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
