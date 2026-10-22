import assert from 'node:assert/strict';
import { useFileStore, type CurrentCollaborationLocationScope, type CurrentCollaborationLocationConfirmation } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { useEditorStore } from '../app/store/editor-store';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import { observeOpenedDocumentAuth, openedDocumentAuthScope } from '../app/lib/collaboration/opened-document-registry';

class FakeEventSource extends EventTarget {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(..._args: unknown[]) { super(); FakeEventSource.instances.push(this); }
  close() {}
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

async function main() {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const watcher = new FileWatcherClient(() => new FakeEventSource());
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'https://canvas.test'); calls.push(url.pathname);
    if (url.pathname === '/api/files/watch') return Response.json({ success: true });
    if (url.pathname === '/api/files/rename') return Response.json({ success: true,
      operation: { batchId: 'fixture-folder-rename-0001', workspaceId: 'workspace', planId: '1'.repeat(64),
        kind: 'rename', selections: [{ sourcePath: 'folder', destinationPath: 'renamed' }],
        status: 'applied', phase: 'complete', completedActions: 1, totalActions: 1, errorCode: null },
      mutation: { type: 'rename', operationId: 'fixture-folder-rename-0001', workspaceId: 'workspace',
        oldPath: 'folder', newPath: 'renamed' } });
    assert.equal(url.pathname, '/api/files/read');
    const path = url.searchParams.get('path');
    return Response.json({ success: true, data: { path, content: 'Original', collaboration: {
      path, strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
      requiresRevisionCheck: false, latestRevision: null, activeLock: null,
      document: { id: 'stable-document', provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
    } } });
  };
  try {
    // Controlled client/store identity only, not a genuine server authorization.
    observeOpenedDocumentAuth({ data: { user: { id: 'user' }, session: { id: 'adoption-test-session' } } });
    const authScope = openedDocumentAuthScope(); assert(authScope);
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
    useFileStore.getState().resetWorkspaceView('workspace');
    assert.equal((await useFileStore.getState().loadFile('folder/before.txt')).status, 'loaded');
    useEditorStore.getState().setActiveFile('folder/before.txt', 'Original');
    const unregister = registerDocumentTransitionGuard('workspace', 'folder/before.txt', {
      prepare: async () => {}, hasPendingChanges: () => false,
    });
    try { await useFileStore.getState().renamePath('folder', 'renamed', false, false, undefined, '1'.repeat(64)); }
    finally { unregister(); }
    assert.equal(useFileStore.getState().currentFile?.collaboration?.path, 'renamed/before.txt');
    useEditorStore.getState().updateDraft('Local and peer edits');
    const state = useFileStore.getState();
    const file = state.currentFile!;
    const scope: CurrentCollaborationLocationScope = { workspaceId: 'workspace', documentId: 'stable-document',
      editorIdentity: file.editorIdentity!, treeGeneration: state.treeGeneration, path: file.path };
    const sessionId = useEditorStore.getState().sessionId;
    const callsBeforeAdoption = calls.length;
    assert.equal(state.adoptCurrentCollaborationLocation(scope, 'elsewhere/after.txt'), true);
    assert.equal(calls.length, callsBeforeAdoption, 'adopting a committed location never writes or reloads the file');
    const adopted = useFileStore.getState().currentFile!;
    assert.equal(adopted.editorIdentity, file.editorIdentity);
    assert.equal(adopted.content, file.content);
    assert.equal(adopted.collaboration?.document, file.collaboration?.document);
    assert.equal(adopted.collaboration?.path, 'elsewhere/after.txt');
    assert.equal(useEditorStore.getState().draft, 'Local and peer edits');
    assert.equal(useEditorStore.getState().isDirty, true);
    assert.equal(useEditorStore.getState().activePath, adopted.path);
    assert.equal(useEditorStore.getState().sessionId, sessionId + 1, 'old save callbacks lose their session');
    assert.equal(state.adoptCurrentCollaborationLocation(scope, 'stale.txt'), false, 'old path responses cannot rewind a rename');
    const currentScope = { ...scope, path: adopted.path };
    for (const stale of [
      { ...currentScope, editorIdentity: 'previous-open' }, { ...currentScope, documentId: 'replacement-document' },
      { ...currentScope, workspaceId: 'other-workspace' }, { ...currentScope, treeGeneration: state.treeGeneration - 1 },
    ]) assert.equal(state.adoptCurrentCollaborationLocation(stale, 'stale.txt'), false);
    assert.equal(state.adoptCurrentCollaborationLocation(currentScope, '../invalid.txt'), false);
    await useFileStore.getState().loadFile(adopted.path);
    assert.equal(state.adoptCurrentCollaborationLocation(currentScope, 'stale.txt'), false, 'reopening the same path revokes pending adoption');

    useEditorStore.getState().clear();
    assert.equal((await useFileStore.getState().loadFile(' literal.md')).status, 'loaded');
    useEditorStore.getState().setActiveFile(' literal.md', 'Original');
    useEditorStore.getState().updateDraft('Exact-path local draft');
    const exactState = useFileStore.getState(), exactFile = exactState.currentFile!;
    const exactScope: CurrentCollaborationLocationScope = { workspaceId: 'workspace', documentId: 'stable-document',
      editorIdentity: exactFile.editorIdentity!, treeGeneration: exactState.treeGeneration, path: exactFile.path };
    const exactCalls = calls.length;
    assert.equal(exactState.adoptCurrentCollaborationLocation(exactScope, ' moved.markdown'), true);
    assert.equal(useFileStore.getState().currentFile?.path, ' moved.markdown');
    assert.equal(useFileStore.getState().currentFile?.editorIdentity, exactFile.editorIdentity);
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document, exactFile.collaboration?.document);
    assert.equal(useEditorStore.getState().draft, 'Exact-path local draft');
    assert.equal(useEditorStore.getState().activePath, ' moved.markdown');
    assert.equal(calls.length, exactCalls, 'literal-path adoption must not reload or write');
    const movedScope = { ...exactScope, path: ' moved.markdown' };
    assert.equal(exactState.adoptCurrentCollaborationLocation({ ...movedScope, documentId: 'replacement' }, ' wrong.md'), false);
    assert.equal(exactState.adoptCurrentCollaborationLocation({ ...movedScope, workspaceId: 'foreign' }, ' wrong.md'), false);
    assert.equal(exactState.adoptCurrentCollaborationLocation(movedScope, '../invalid.md'), false);

    // A committed ID-location adoption may precede the original HTTP/SSE
    // mutation. The latter must stay conservative until a fresh same-ID read.
    useFileStore.getState().applyPathRename({ type: 'rename', workspaceId: 'workspace',
      oldPath: ' literal.md', newPath: ' moved.markdown', operationId: 'late-original-mutation' });
    const replacement = useFileStore.getState().currentFile!;
    assert.equal(replacement.unavailable, 'replaced');
    const confirmation: CurrentCollaborationLocationConfirmation = { file: replacement,
      fileLoadRequestId: useFileStore.getState().fileLoadRequestId, authScope,
      lifecycleGeneration: 1, representation: 'plain_text', location: { workspaceId: 'workspace',
        documentId: 'stable-document', path: replacement.path, lifecycleGeneration: 1, representation: 'plain_text' } };
    const currentSessionId = useEditorStore.getState().sessionId, confirmedDraft = useEditorStore.getState().draft;
    assert.equal(useFileStore.getState().adoptCurrentCollaborationLocation(movedScope, replacement.path), false,
      'A path or healthy-looking current file alone cannot remove replacement recovery.');
    assert.equal(useFileStore.getState().adoptCurrentCollaborationLocation(movedScope, replacement.path, confirmation), true);
    const confirmed = useFileStore.getState().currentFile!;
    assert.equal(confirmed.unavailable, undefined);
    assert.equal(confirmed.editorIdentity, replacement.editorIdentity); assert.equal(confirmed.viewId, replacement.viewId);
    assert.equal(confirmed.collaboration?.document, replacement.collaboration?.document);
    assert.equal(confirmed.content, replacement.content); assert.equal(useEditorStore.getState().draft, confirmedDraft);
    assert.equal(useEditorStore.getState().sessionId, currentSessionId, 'Confirmation never remounts or changes the editor session.');
    const invalidConfirmations: Array<[string, (value: CurrentCollaborationLocationConfirmation) => CurrentCollaborationLocationConfirmation]> = [
      ['earlier read', value => ({ ...value, fileLoadRequestId: value.fileLoadRequestId - 1 })],
      ['different view snapshot', value => ({ ...value, file: { ...value.file } })],
      ['different auth epoch', value => ({ ...value, authScope: { ...value.authScope } })],
      ['unmounted generation', value => ({ ...value, lifecycleGeneration: 0 })],
      ['changed generation', value => ({ ...value, location: { ...value.location, lifecycleGeneration: 2 } })],
      ['uninitialized generation', value => ({ ...value, location: { ...value.location, lifecycleGeneration: null } })],
      ['changed representation', value => ({ ...value, location: { ...value.location, representation: 'tiptap_xml' } })],
      ['different document', value => ({ ...value, location: { ...value.location, documentId: 'D2' } })],
      ['different workspace', value => ({ ...value, location: { ...value.location, workspaceId: 'foreign' } })],
      ['different path', value => ({ ...value, location: { ...value.location, path: 'elsewhere.md' } })],
    ];
    for (const [label, change] of invalidConfirmations) {
      const retained = { ...replacement }; useFileStore.setState({ currentFile: retained });
      const candidate = change({ ...confirmation, file: retained });
      assert.equal(useFileStore.getState().adoptCurrentCollaborationLocation(movedScope, retained.path, candidate), false, label);
      assert.equal(useFileStore.getState().currentFile, retained, label);
      assert.equal(retained.unavailable, 'replaced', label);
    }
    const deleted = { ...replacement, unavailable: 'deleted' as const }; useFileStore.setState({ currentFile: deleted });
    assert.equal(useFileStore.getState().adoptCurrentCollaborationLocation(movedScope, deleted.path,
      { ...confirmation, file: deleted }), false, 'A real deletion retains recovery.');
    const destinationD2 = { ...replacement, collaboration: { ...replacement.collaboration!,
      document: { ...replacement.collaboration!.document!, id: 'D2' } } };
    useFileStore.setState({ currentFile: destinationD2 });
    assert.equal(useFileStore.getState().adoptCurrentCollaborationLocation(movedScope, destinationD2.path,
      { ...confirmation, file: destinationD2 }), false, 'A reused destination never becomes the original D1.');
    useFileStore.setState({ currentFile: confirmed });

    watcher.acquire();
    const oldSource = FakeEventSource.instances.at(-1)!;
    let connections = 0; let changes = 0;
    watcher.addEventListener('connected', () => { connections++; });
    watcher.addEventListener('filechange', () => { changes++; });
    oldSource.emit('connected', { clientId: 'old', workspaceId: 'workspace' });
    assert.equal(connections, 1);
    useWorkspaceStore.setState({ activeWorkspaceId: 'other-workspace' });
    const newSource = FakeEventSource.instances.at(-1)!;
    assert.notEqual(oldSource, newSource);
    // Even an event without workspace metadata must be tied to its transport lifetime.
    oldSource.emit('connected', { clientId: 'late-old' });
    oldSource.emit('filechange', { type: 'change', relativePath: 'elsewhere/after.txt', dir: 'elsewhere' });
    assert.equal(connections, 1);
    assert.equal(changes, 0);
    assert.equal(watcher.isConnected, false);
    newSource.emit('connected', { clientId: 'new', workspaceId: 'other-workspace' });
    newSource.emit('filechange', { type: 'change', relativePath: 'another.txt', dir: '.' });
    assert.equal(connections, 2);
    assert.equal(changes, 1);
    oldSource.onerror?.();
    assert.equal(watcher.isConnected, true);
    console.log('Collaboration location adoption retains open identity/draft, revokes stale scopes, and ignores old watcher transports.');
  } finally {
    observeOpenedDocumentAuth(null);
    watcher.disconnect();
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
    useFileStore.getState().resetWorkspaceView(null);
    useWorkspaceStore.setState({ activeWorkspaceId: null });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
