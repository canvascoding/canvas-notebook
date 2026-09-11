import assert from 'node:assert/strict';
import { useFileStore, type CurrentCollaborationLocationScope } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { useEditorStore } from '../app/store/editor-store';
import { FileWatcherClient } from '../app/lib/file-watcher/client';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';

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
    if (url.pathname === '/api/files/rename' || url.pathname === '/api/files/watch') return Response.json({ success: true });
    assert.equal(url.pathname, '/api/files/read');
    const path = url.searchParams.get('path');
    return Response.json({ success: true, data: { path, content: 'Original', collaboration: {
      path, strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
      requiresRevisionCheck: false, latestRevision: null, activeLock: null,
      document: { id: 'stable-document', provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
    } } });
  };
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
    useFileStore.getState().resetWorkspaceView('workspace');
    assert.equal((await useFileStore.getState().loadFile('folder/before.txt')).status, 'loaded');
    useEditorStore.getState().setActiveFile('folder/before.txt', 'Original');
    const unregister = registerDocumentTransitionGuard('workspace', 'folder/before.txt', {
      prepare: async () => {}, hasPendingChanges: () => false,
    });
    try { await useFileStore.getState().renamePath('folder', 'renamed', false, false); }
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
    watcher.disconnect();
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
    useFileStore.getState().resetWorkspaceView(null);
    useWorkspaceStore.setState({ activeWorkspaceId: null });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
