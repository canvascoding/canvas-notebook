import assert from 'node:assert/strict';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { useFileEditorCollaborationDocument } from '../app/lib/collaboration/file-editor-document';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import type { CurrentFile } from '../app/lib/files/types';

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  for (const key of ['window', 'document', 'navigator'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const base: CurrentFile = { path: 'same.txt', editorIdentity: 'open-a', content: 'AAA', collaboration: {
    path: 'same.txt', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
    requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: { id: 'doc-a', provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
  } };
  const documents: Y.Doc[] = [];
  const collaboration = (id: string, error: string) => {
    const doc = new Y.Doc(); documents.push(doc);
    // The hook only owns the status/handle association, not transport or checkpoints.
    return { doc, session: { documentId: id, lifecycleGeneration: 1 }, error,
      durability: 'checkpointed_file' } as CollaborationDocument;
  };
  const a = collaboration('doc-a', 'Status A');
  const b = collaboration('doc-b', 'Status B');
  let result: ReturnType<typeof useFileEditorCollaborationDocument> | undefined;
  function Probe() {
    const file = useFileStore((state) => state.currentFile);
    const workspace = useFileStore((state) => state.currentFileWorkspaceId);
    result = useFileEditorCollaborationDocument(file, workspace);
    return <output>{result.document?.error ?? 'connecting'}</output>;
  }
  const root = createRoot(document.getElementById('root')!);
  const get = () => { assert(result); return result; };
  const setFile = async (file: CurrentFile, workspace: string) => act(async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: workspace });
    useFileStore.setState({ currentFile: file, currentFileWorkspaceId: workspace });
  });
  try {
    await setFile(base, 'workspace-a');
    await act(async () => root.render(<StrictMode><Probe /></StrictMode>));
    const callbackA = get().onCollaborationChange;
    await act(async () => callbackA(a));
    assert.equal(get().document, a);
    // Workspace selection itself revokes the old status before the file store catches up.
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-b' }));
    assert.equal(get().document, null);
    await act(async () => callbackA(a));
    assert.equal(get().document, null);
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' }));
    assert.equal(get().document, null, 'returning to A does not resurrect its old status');
    await act(async () => callbackA(a));
    assert.equal(get().document, null, 'returning to A does not reactivate its previous callbacks');
    await act(async () => get().onCollaborationChange(a));
    assert.equal(get().document, a);

    const fileB = { ...base, editorIdentity: 'open-b', collaboration: { ...base.collaboration!,
      document: { ...base.collaboration!.document!, id: 'doc-b' } } };
    await setFile(fileB, 'workspace-b');
    const callbackB = get().onCollaborationChange;
    await act(async () => callbackB(a));
    assert.equal(get().document, null, 'a wrong document ID cannot supply persistence handles');
    await act(async () => callbackB(b));
    assert.equal(get().document, b);
    await act(async () => { callbackA(null); callbackA(a); });
    assert.equal(get().document, b, 'old callbacks cannot clear or overwrite the new status');

    await setFile({ ...fileB, editorIdentity: 'open-b-again' }, 'workspace-b');
    assert.equal(get().document, null, 'same-path reopening starts without old checkpoint confirmation');
    await act(async () => callbackB(b));
    assert.equal(get().document, null);
    const reopenedCallback = get().onCollaborationChange;
    await act(async () => reopenedCallback(b));
    assert.equal(get().document, b);
    await setFile({ ...useFileStore.getState().currentFile!, path: 'renamed.txt' }, 'workspace-b');
    assert.equal(get().document, null);
    const renamedCallback = get().onCollaborationChange;
    await act(async () => renamedCallback(b));
    await act(async () => { reopenedCallback(null); reopenedCallback(a); });
    assert.equal(get().document, b);

    await act(async () => useFileStore.setState((state) => ({ treeGeneration: state.treeGeneration + 1 })));
    assert.equal(get().document, null);
    await act(async () => renamedCallback(b));
    assert.equal(get().document, null);
    await act(async () => get().onCollaborationChange(b));
    assert.equal(get().document, b);
    const beforeDisable = get().onCollaborationChange;
    await setFile({ ...fileB, collaboration: { ...fileB.collaboration, crdtCapable: false } }, 'workspace-b');
    assert.equal(get().document, null);
    await act(async () => beforeDisable(b));
    assert.equal(get().document, null);

    await setFile(fileB, 'workspace-b');
    b.doc.destroy();
    await act(async () => get().onCollaborationChange(b));
    assert.equal(get().document, null, 'destroyed documents cannot become active again');
    console.log('File editor collaboration status is scoped to workspace, open identity, document ID, path and tree lifetime.');
  } finally {
    await act(async () => root.unmount());
    for (const doc of documents) if (!doc.isDestroyed) doc.destroy();
    useFileStore.setState({ currentFile: null, currentFileWorkspaceId: null });
    useWorkspaceStore.setState({ activeWorkspaceId: null });
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
