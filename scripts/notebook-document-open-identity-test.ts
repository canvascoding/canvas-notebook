import assert from 'node:assert/strict';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { useEditorStore } from '../app/store/editor-store';
import { registerDocumentTransitionGuard } from '../app/lib/files/document-transition';
import type { CurrentFile } from '../app/lib/files/types';

function file(path: string, id: string): CurrentFile {
  return { path, content: `Content of ${id}`, editorIdentity: id, collaboration: {
    path, strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
    requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: { id, provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
  } };
}

async function main() {
  const originalFetch = globalThis.fetch;
  const initial = file('same.md', 'original');
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
  useFileStore.getState().resetWorkspaceView('workspace');
  useFileStore.setState({ currentFile: initial, currentFileWorkspaceId: 'workspace' });
  useEditorStore.getState().setActiveFile(initial.path, initial.content);
  let prepares = 0;
  const release = registerDocumentTransitionGuard('workspace', initial.path, {
    prepare: async () => { prepares++; }, hasPendingChanges: () => false,
  });
  try {
    let readCount = 0;
    globalThis.fetch = async input => {
      if (String(input).startsWith('/api/files/read')) {
        readCount++;
        return Response.json({ success: true, data: file('same.md', 'replacement') });
      }
      return Response.json({ success: true });
    };
    const failed = await useFileStore.getState().loadFile('same.md', true, 'workspace', 'original');
    assert.equal(failed.status, 'failed');
    assert.equal(useFileStore.getState().currentFile, initial, 'a reused path does not replace the current document');
    assert.equal(useEditorStore.getState().draft, initial.content);

    const before = readCount;
    const wrongAlreadyOpen = await useFileStore.getState().revealAndLoadFile('same.md', {
      workspaceId: 'workspace', revealInTree: false, expectedDocumentId: 'another-document',
    });
    assert.equal(wrongAlreadyOpen.status, 'failed');
    assert.equal(readCount, before + 1, 'same path is not an identity match for the already-open fast path');
    assert.equal(prepares, 1, 'replacing a different document at the same path still prepares the old document');
    assert.equal(useFileStore.getState().currentFile, initial);

    let settle!: (response: Response) => void;
    globalThis.fetch = async input => String(input).startsWith('/api/files/read')
      ? new Promise(resolve => { settle = resolve; }) : Response.json({ success: true });
    const pending = useFileStore.getState().revealAndLoadFile('same.md', {
      workspaceId: 'workspace', revealInTree: false, expectedDocumentId: 'replacement',
    });
    await Promise.resolve(); await Promise.resolve();
    assert(settle);
    useEditorStore.getState().updateDraft('New input while the document loads');
    settle(Response.json({ success: true, data: file('same.md', 'replacement') }));
    assert.equal((await pending).status, 'failed');
    assert.equal(useFileStore.getState().currentFile, initial);
    assert.equal(useEditorStore.getState().draft, 'New input while the document loads');
    useEditorStore.getState().setActiveFile(initial.path, initial.content);

    const slow = useFileStore.getState().loadFile('moved.md', true, 'workspace', 'original');
    const complete = settle;
    const selected = await useFileStore.getState().revealAndLoadFile('same.md', {
      revealInTree: false, expectedDocumentId: 'original',
    });
    complete(Response.json({ success: true, data: file('moved.md', 'original') }));
    assert.equal(selected.status, 'opened');
    assert.equal((await slow).status, 'superseded');
    assert.equal(useFileStore.getState().currentFile, initial);

    globalThis.fetch = async input => String(input).startsWith('/api/files/read')
      ? Response.json({ success: true, data: file('moved.md', 'original') }) : Response.json({ success: true });
    assert.equal((await useFileStore.getState().revealAndLoadFile('moved.md', {
      revealInTree: false, expectedDocumentId: 'original',
    })).status, 'opened');
    assert.equal(useFileStore.getState().currentFile?.path, 'moved.md');
    assert.equal(useFileStore.getState().currentFile?.collaboration?.document?.id, 'original');
    console.log('Guarded file opening rejects reused identities, preserves concurrent input, fences older responses and loads the confirmed document.');
  } finally {
    release(); globalThis.fetch = originalFetch;
    useEditorStore.getState().clear(); useFileStore.getState().resetWorkspaceView(null);
    useWorkspaceStore.setState({ activeWorkspaceId: null });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
