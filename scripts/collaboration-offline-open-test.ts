import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import type { CurrentFile } from '../app/lib/files/types';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from '../app/lib/collaboration/agent-durability';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { hasStoredLocalDocument } from '../app/lib/collaboration/local-document';
import { requestCollaborationDocumentLocation } from '../app/lib/collaboration/document-location-request';
import { fetchLiveDocument, findOpenedLiveDocument, invalidateOpenedDocumentAuth, LiveDocumentNetworkError,
  observeOpenedDocumentAuth, openedDocumentAuthScope, openedDocumentRequestRevision, rememberOpenedLiveDocument,
  validateOpenedLiveDocumentSession } from '../app/lib/collaboration/opened-document-registry';
import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState } from '../app/lib/collaboration/client-state';

async function main() {
  const previousFetch = globalThis.fetch;
  const seed = new Y.Doc(); seed.getText('content').insert(0, 'Native contents');
  const session: CollaborationSessionResponse = {
    success: true, documentId: 'offline-doc', documentName: 'offline-doc', provider: 'yjs', representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write',
    token: 'synthetic-unit-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
    user: { id: 'owner', name: 'Owner', color: '#123456', colorLight: '#abcdef' },
  };
  const file: CurrentFile = { path: 'offline.txt', content: 'Old Markdown must never become native state', collaboration: {
    path: 'offline.txt', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
    requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: { id: session.documentId, provider: 'yjs', status: 'active', stateVersion: 1, snapshotRevisionId: null },
  } };
  const auth = (userId = 'owner', sessionId = 'browser-session') => observeOpenedDocumentAuth({
    data: { user: { id: userId }, session: { id: sessionId } }, error: null,
  });
  const observeExistingEditor = () => rememberOpenedLiveDocument({ scope: openedDocumentAuthScope(), workspaceId: 'workspace', path: file.path,
    file, session, stateProof: collaborationStateProof(seed, Y)!, snapshot: captureAgentStateSnapshot(seed, Y)! });
  const remember = () => {
    assert.equal(validateOpenedLiveDocumentSession('workspace', file.path, session), true);
    observeExistingEditor();
  };
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  const load = (workspace = 'workspace', id: string | undefined = session.documentId) =>
    useFileStore.getState().loadFile(file.path, true, workspace, id);
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
  useFileStore.getState().resetWorkspaceView('workspace'); useEditorStore.getState().clear();
  try {
    auth(); remember(); globalThis.fetch = offline;
    assert.equal((await load()).status, 'loaded');
    assert.equal(useFileStore.getState().currentFile?.content, '', 'only metadata, never stale serialized contents');
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, session.documentId);
    assert.equal((await useFileStore.getState().loadFile(file.path, true, 'workspace')).status, 'failed', 'expected identity is required');
    assert.equal((await load('workspace', 'different-document')).status, 'failed');
    assert.equal(findOpenedLiveDocument('different-workspace', file.path, session.documentId), null);

    for (const status of [401, 403, 404, 409, 410]) {
      remember(); globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status });
      const oldRevision = openedDocumentRequestRevision();
      assert.notEqual((await load()).status, 'loaded');
      assert.equal(findOpenedLiveDocument('workspace', file.path, session.documentId), null);
      observeExistingEditor();
      assert.equal(findOpenedLiveDocument('workspace', file.path, session.documentId), null, 'an old mounted editor cannot undo denial');
      assert.equal(validateOpenedLiveDocumentSession('workspace', file.path, { ...session }, openedDocumentAuthScope(), oldRevision),
        false, 'a delayed HTTP response cannot undo a newer denial');
      globalThis.fetch = offline; assert.equal((await load()).status, 'failed');
    }
    remember(); globalThis.fetch = async () => Response.json({ error: 'Failed' }, { status: 500 });
    assert.equal((await load()).status, 'failed', 'an HTTP failure never substitutes cached metadata');
    globalThis.fetch = async () => {
      const response = Response.json({ success: true });
      response.json = async () => { throw new TypeError('Invalid JSON response'); };
      return response;
    };
    assert.equal((await load()).status, 'failed', 'a parsing TypeError is not a network failure');

    globalThis.fetch = async () => Response.json({ success: true, data: { ...file, content: 'Fresh server contents' } });
    assert.equal((await load()).status, 'loaded');
    assert.equal(useFileStore.getState().currentFile?.content, 'Fresh server contents', 'online remains server-first');

    remember(); let reject!: (error: Error) => void;
    globalThis.fetch = () => new Promise<Response>((_resolve, fail) => { reject = fail; });
    const obsolete = load();
    auth('another-user', 'another-session'); reject(new TypeError('Failed to fetch'));
    assert.equal((await obsolete).status, 'superseded');
    assert.equal(findOpenedLiveDocument('workspace', file.path, session.documentId), null);
    auth(); remember(); let resolve!: (response: Response) => void;
    globalThis.fetch = () => new Promise<Response>(done => { resolve = done; });
    const obsoleteSuccess = load();
    const beforeSwitch = useFileStore.getState().currentFile;
    auth('another-user', 'another-session');
    resolve(Response.json({ success: true, data: { ...file, content: 'Private contents from the previous account' } }));
    assert.equal((await obsoleteSuccess).status, 'superseded');
    assert.equal(useFileStore.getState().currentFile, beforeSwitch);
    assert.equal(useFileStore.getState().isLoadingFile, false);
    auth(); remember(); invalidateOpenedDocumentAuth();
    assert.equal(findOpenedLiveDocument('workspace', file.path, session.documentId), null, 'session mutation revokes old handles synchronously');
    remember(); auth('owner', 'new-session');
    assert.equal(findOpenedLiveDocument('workspace', file.path, session.documentId), null, 'same user in a different login is isolated');

    remember(); globalThis.fetch = async () => Response.json({ success: true, workspaceId: 'workspace',
      documentId: session.documentId, path: file.path, lifecycleGeneration: 2, representation: 'plain_text' });
    await requestCollaborationDocumentLocation('workspace', session.documentId, new AbortController().signal);
    assert.equal(findOpenedLiveDocument('workspace', file.path, session.documentId), null, 'a confirmed restore invalidates before the next load');

    globalThis.fetch = offline;
    await assert.rejects(fetchLiveDocument('/synthetic', {}), LiveDocumentNetworkError);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(fetchLiveDocument('/synthetic', { signal: aborted.signal }), error => error instanceof TypeError);
    const empty = new Y.Doc();
    assert.equal(hasStoredLocalDocument(empty, session), false); empty.destroy();
    assert.equal(hasStoredLocalDocument(seed, session), true);
    const receipt = captureAgentStateSnapshot(seed, Y)!;
    seed.getText('content').delete(0, 6);
    assert.equal(persistedUpdateIncludesAgentSnapshot(Y.encodeStateAsUpdate(seed), receipt, Y), true);
    const unrelated = new Y.Doc(); unrelated.getText('content').insert(0, 'Other');
    assert.equal(persistedUpdateIncludesAgentSnapshot(Y.encodeStateAsUpdate(unrelated), receipt, Y), false); unrelated.destroy();

    let state = createInitialTextCollaborationClientState();
    state = reduceTextCollaborationClientState(state, { type: 'indexeddb_hydrated' });
    assert.equal(state.ready, false);
    state = reduceTextCollaborationClientState(state, { type: 'local_document_restored' });
    assert.equal(state.ready, true); assert.equal(state.remoteSynced, false);
    assert.equal(state.persistedStateProof, null); assert.equal(state.durability, 'local_pending');
    state = reduceTextCollaborationClientState(state, { type: 'authentication_failed', message: 'Denied' });
    assert.equal(reduceTextCollaborationClientState(state, { type: 'local_document_restored' }).connection, 'denied');
    console.log('Offline opening: native receipts, metadata-only fallback, online precedence, HTTP/parser/abort boundaries, auth partitions, restore invalidation and local readiness passed.');
  } finally {
    globalThis.fetch = previousFetch; seed.destroy(); observeOpenedDocumentAuth(null);
    useEditorStore.getState().clear(); useFileStore.getState().resetWorkspaceView(null);
    useWorkspaceStore.setState({ activeWorkspaceId: null });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
