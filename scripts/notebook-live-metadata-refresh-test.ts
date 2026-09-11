import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import type { CurrentFile, FileCollaborationState, FileRevisionRecord } from '../app/lib/files/types';
import { useEditorStore } from '../app/store/editor-store';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const workspaceId = 'live-metadata';
const revision: FileRevisionRecord = {
  id: 'revision-1', contentHash: 'checkpoint-1', baseRevisionId: null, createdAt: 1,
  createdByActorType: 'user', createdByUserId: 'owner',
};
const collaboration: FileCollaborationState = {
  path: 'live.md', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false,
  lockRequired: false, requiresRevisionCheck: false, latestRevision: revision, activeLock: null,
  document: { id: 'live-document', provider: 'yjs', stateVersion: 1, snapshotRevisionId: revision.id, status: 'active' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(t: TestContext, scene = false) {
  const originalFetch = globalThis.fetch;
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  useFileStore.getState().resetWorkspaceView(workspaceId);
  const file: CurrentFile = {
    path: scene ? 'live.excalidraw' : 'live.md', editorIdentity: 'open-1', viewId: 'view-1', content: 'live editor content',
    stats: { size: 20, modified: 1, permissions: '100644', sha256: 'checkpoint-1' }, revision,
    collaboration: scene ? { ...collaboration, path: 'live.excalidraw', strategy: 'excalidraw_scene',
      crdtCapable: false, sceneCapable: true, document: { ...collaboration.document!, provider: 'excalidraw' } } : collaboration,
  };
  useFileStore.setState({ currentFile: file, currentFileWorkspaceId: workspaceId,
    fileRevisions: { [file.path]: 'checkpoint-1' } });
  useEditorStore.getState().setActiveFile(file.path, file.content);
  t.after(() => {
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
    useFileStore.getState().resetWorkspaceView(null);
  });
  const response = (changes: Partial<CurrentFile> = {}) => Response.json({ success: true,
    data: { ...file, content: 'stale Markdown checkpoint must not enter editor', ...changes } });
  const changes: ReturnType<typeof useFileStore.getState>[] = [];
  const unsubscribe = useFileStore.subscribe((state) => { changes.push(state); });
  t.after(unsubscribe);
  return { file, response, changes,
    refresh: (options?: { allowDirty: boolean }) => useFileStore.getState().refreshCurrentFileContent(file.path, options) };
}

test('unchanged live metadata emits no store update while pending or completed', async (t) => {
  const h = setup(t);
  const pending = deferred<Response>();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    assert.equal(url.searchParams.get('meta'), '1');
    return pending.promise;
  };
  const refresh = h.refresh();
  assert.equal(useFileStore.getState().documentSyncStatus, 'idle');
  assert.equal(h.changes.length, 0);
  // Equivalent API JSON may arrive in a different property order.
  pending.resolve(h.response({ collaboration: Object.fromEntries(Object.entries(collaboration).reverse()) as unknown as FileCollaborationState }));
  assert.equal(await refresh, h.file);
  assert.equal(useFileStore.getState().currentFile, h.file);
  assert.equal(h.changes.length, 0, 'unchanged metadata must not wake the mounted view');
});

test('a checkpoint advances metadata once without changing content, draft, editor identity or sync status', async (t) => {
  const h = setup(t);
  globalThis.fetch = async () => h.response({ stats: { ...h.file.stats!, sha256: 'checkpoint-2', modified: 2 } });
  useEditorStore.getState().updateDraft('user typing in live document');
  await h.refresh();
  const current = useFileStore.getState().currentFile!;
  assert.equal(h.changes.length, 1);
  assert.equal(current.stats?.sha256, 'checkpoint-2');
  assert.equal(current.content, h.file.content);
  assert.equal(current.editorIdentity, h.file.editorIdentity);
  assert.equal(current.viewId, h.file.viewId);
  assert.equal(current.collaboration, h.file.collaboration, 'unchanged nested metadata retains its reference');
  assert.equal(current.revision, h.file.revision);
  assert.equal(useEditorStore.getState().draft, 'user typing in live document');
  assert.equal(useFileStore.getState().pendingExternalFile, null);
  assert(h.changes.every((state) => state.documentSyncStatus === 'idle'));
});

test('scene collaboration metadata is also silent and preserves the scene content', async (t) => {
  const h = setup(t, true);
  globalThis.fetch = async () => h.response({ stats: { ...h.file.stats!, sha256: 'scene-checkpoint' } });
  await h.refresh();
  assert.equal(useFileStore.getState().currentFile?.content, h.file.content);
  assert(h.changes.every((state) => state.documentSyncStatus === 'idle'));
});

test('revision and document-state updates are retained even when file stats are identical', async (t) => {
  const h = setup(t);
  const nextRevision = { ...revision, id: 'revision-2', baseRevisionId: revision.id, createdAt: 2 };
  const nextCollaboration = { ...collaboration, latestRevision: nextRevision,
    document: { ...collaboration.document!, stateVersion: 2, snapshotRevisionId: nextRevision.id } };
  globalThis.fetch = async () => h.response({ revision: nextRevision, collaboration: nextCollaboration });
  await h.refresh();
  const current = useFileStore.getState().currentFile!;
  assert.deepEqual(current.revision, nextRevision);
  assert.deepEqual(current.collaboration, nextCollaboration);
  assert.equal(current.stats, h.file.stats);
  assert.equal(current.editorIdentity, h.file.editorIdentity);
  assert.equal(current.content, h.file.content);
  assert(h.changes.every((state) => state.documentSyncStatus === 'idle'));
});

test('lock and capability changes are not discarded as an unchanged checkpoint', async (t) => {
  const h = setup(t);
  const restricted: FileCollaborationState = { ...collaboration, crdtCapable: false,
    strategy: 'exclusive_lock', lockRequired: true, requiresRevisionCheck: true,
    activeLock: { id: 'lock', lockedByUserId: 'other', lockedBySessionId: null,
      lockType: 'edit', status: 'active', expiresAt: 1000 } };
  globalThis.fetch = async () => h.response({ collaboration: restricted });
  await h.refresh();
  assert.deepEqual(useFileStore.getState().currentFile?.collaboration, restricted);
  assert.equal(useFileStore.getState().currentFile?.content, h.file.content);
  assert(h.changes.every((state) => state.documentSyncStatus === 'idle'));
});

test('live edits made during an explicit metadata refresh cannot create an external-file conflict', async (t) => {
  const h = setup(t);
  let localVersion = 1;
  const unregister = registerDocumentTransitionGuard(workspaceId, h.file.path,
    { hasPendingChanges: () => true, localChangeVersion: () => localVersion, prepare: async () => {} });
  t.after(unregister);
  const pending = deferred<Response>();
  globalThis.fetch = async () => pending.promise;
  const refresh = h.refresh({ allowDirty: true });
  useEditorStore.getState().updateDraft('new local Yjs edit');
  localVersion++;
  pending.resolve(h.response({ stats: { ...h.file.stats!, sha256: 'projected' } }));
  assert(await refresh);
  assert.equal(useEditorStore.getState().draft, 'new local Yjs edit');
  assert.equal(useFileStore.getState().pendingExternalFile, null);
  assert(h.changes.every((state) => state.documentSyncStatus === 'idle'));
});

test('metadata does not clear a pre-existing sync state or pending external file', async (t) => {
  const h = setup(t);
  const pending = { ...h.file, content: 'separate pending external revision' };
  useFileStore.setState({ pendingExternalFile: pending, documentSyncStatus: 'conflict' });
  h.changes.length = 0;
  globalThis.fetch = async () => h.response();
  await h.refresh();
  assert.equal(useFileStore.getState().pendingExternalFile, pending);
  assert.equal(useFileStore.getState().documentSyncStatus, 'conflict');
  assert.equal(h.changes.length, 0);
});

test('a new document id at the same path preserves the old editor and marks it replaced', async (t) => {
  const h = setup(t);
  useEditorStore.getState().updateDraft('local original document changes');
  globalThis.fetch = async () => h.response({ collaboration: {
    ...collaboration, document: { ...collaboration.document!, id: 'replacement-document' },
  } });
  assert.equal(await h.refresh(), null);
  const current = useFileStore.getState().currentFile!;
  assert.equal(current.unavailable, 'replaced');
  assert.equal(current.collaboration, h.file.collaboration);
  assert.equal(current.stats, h.file.stats);
  assert.equal(current.content, h.file.content);
  assert.equal(current.editorIdentity, h.file.editorIdentity);
  assert.equal(current.viewId, h.file.viewId);
  assert.equal(useEditorStore.getState().draft, 'local original document changes');
  assert.equal(useFileStore.getState().documentSyncStatus, 'idle');
});

test('a late replacement response cannot mark a freshly opened instance replaced', async (t) => {
  const h = setup(t);
  const pending = deferred<Response>();
  globalThis.fetch = async () => pending.promise;
  const refresh = h.refresh();
  const reopened = { ...h.file, editorIdentity: 'open-2', viewId: 'view-2', collaboration: {
    ...collaboration, document: { ...collaboration.document!, id: 'newly-opened-document' },
  } };
  useFileStore.setState({ currentFile: reopened, documentSyncStatus: 'updating' });
  pending.resolve(h.response({ collaboration: { ...collaboration,
    document: { ...collaboration.document!, id: 'old-replacement-response' } } }));
  assert.equal(await refresh, null);
  assert.equal(useFileStore.getState().currentFile, reopened);
  assert.equal(useFileStore.getState().documentSyncStatus, 'updating', 'stale finally cannot alter the new view status');
});

test('a late metadata response cannot undo a managed rename', async (t) => {
  const h = setup(t);
  const pending = deferred<Response>();
  globalThis.fetch = async () => pending.promise;
  const refresh = h.refresh();
  assert(useFileStore.getState().applyPathRename({ type: 'rename', workspaceId,
    oldPath: h.file.path, newPath: 'renamed.md', operationId: 'metadata-rename' }));
  const renamed = useFileStore.getState().currentFile;
  pending.resolve(h.response({ stats: { ...h.file.stats!, sha256: 'old-path-checkpoint' } }));
  assert.equal(await refresh, null);
  assert.equal(useFileStore.getState().currentFile, renamed);
  assert.equal(renamed?.path, 'renamed.md');
  assert.equal(renamed?.collaboration?.path, 'renamed.md');
});

test('a late 404 from another workspace cannot detach the current document', async (t) => {
  const h = setup(t);
  const pending = deferred<Response>();
  globalThis.fetch = async () => pending.promise;
  const refresh = h.refresh();
  useWorkspaceStore.setState({ activeWorkspaceId: 'other-workspace' });
  useFileStore.getState().resetWorkspaceView('other-workspace');
  const current = { ...h.file, editorIdentity: 'other-open' };
  useFileStore.setState({ currentFile: current, currentFileWorkspaceId: 'other-workspace' });
  pending.resolve(new Response('', { status: 404 }));
  assert.equal(await refresh, null);
  assert.equal(useFileStore.getState().currentFile, current);
});

test('metadata failures do not publish a document-save error; confirmed deletion still preserves recovery', async (t) => {
  const h = setup(t);
  t.mock.method(console, 'warn', () => {});
  globalThis.fetch = async () => new Response('', { status: 403 });
  assert.equal(await h.refresh(), null);
  assert.equal(h.changes.length, 0);
  assert.equal(useFileStore.getState().currentFile, h.file);
  useEditorStore.getState().updateDraft('recover these local edits');
  globalThis.fetch = async () => new Response('', { status: 404 });
  assert.equal(await h.refresh(), null);
  assert.equal(useFileStore.getState().currentFile?.unavailable, 'deleted');
  assert.equal(useFileStore.getState().currentFile?.content, h.file.content);
  assert.equal(useEditorStore.getState().draft, 'recover these local edits');
  assert.equal(useFileStore.getState().documentSyncStatus, 'idle');
});
