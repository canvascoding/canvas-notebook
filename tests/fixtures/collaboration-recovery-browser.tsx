import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { MarkdownSaveState } from '../../app/components/editor/MarkdownDocumentModes';
import type { CollaborationDocument } from '../../app/lib/collaboration/client';
import { prepareRecoverableCollaborationTransition, preserveLocalCollaborationRecovery } from '../../app/lib/collaboration/local-recovery';
import { registerDocumentTransitionGuard } from '../../app/lib/files/document-transition';
import { useFileStore } from '../../app/store/file-store';
import { useEditorStore } from '../../app/store/editor-store';
import { useWorkspaceStore } from '../../app/store/workspace-store';
import messages from '../../messages/en.json';

const doc = new Y.Doc();
doc.getText('content').insert(0, 'First item\nMiddle item\nLast item');
doc.getText('content').delete('First item\n'.length, 'Middle item\n'.length);
const databaseName = 'canvas:recovery-browser:1:plain_text';
const persistence = new IndexeddbPersistence(databaseName, doc);
const workspaceId = 'recovery-workspace';
const path = 'broken.md';
const failStorage = location.search.includes('fail-storage');

async function main() {
  await persistence.whenSynced;
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  useFileStore.getState().resetWorkspaceView(workspaceId);
  useFileStore.setState({ currentFileWorkspaceId: workspaceId, currentFile: {
    path, content: doc.getText('content').toString(), collaboration: { crdtCapable: true },
  } as ReturnType<typeof useFileStore.getState>['currentFile'] });
  useEditorStore.getState().setActiveFile(path, doc.getText('content').toString());
  const unregister = registerDocumentTransitionGuard(workspaceId, path, {
    hasPendingChanges: () => true,
    prepare: () => prepareRecoverableCollaborationTransition({
      doc, connection: 'live', durability: 'degraded',
      requestCheckpoint: async () => { throw new Error('stable_id_duplicate'); },
      preserveLocalSnapshot: async () => {
        if (failStorage) throw new Error('Local storage unavailable. Download recovery state before closing.');
        await preserveLocalCollaborationRecovery(persistence, doc);
      },
    }),
  });
  const collaboration = {
    registryKey: `${workspaceId}\0${path}`, doc, connection: 'live', durability: 'degraded',
    session: { documentId: 'recovery-browser', lifecycleGeneration: 1, permission: 'write' },
    clientState: { documentSequence: 5, checkpointSequence: 4, unsyncedChanges: 0 },
    error: 'Rich collaboration checkpoint validation failed (stable_id_duplicate).',
  } as unknown as CollaborationDocument;
  function App() {
    const [error, setError] = useState('');
    const currentPath = useFileStore((state) => state.currentFile?.path);
    const action = async (kind: 'close' | 'switch' | 'delete') => {
      try {
        if (kind === 'close') await useFileStore.getState().closeFile(path);
        if (kind === 'switch') {
          const result = await useFileStore.getState().revealAndLoadFile('other.md', { revealInTree: false });
          if (result.status === 'failed') throw new Error(result.error);
        }
        if (kind === 'delete') await useFileStore.getState().deletePath(path);
        const restored = new Y.Doc();
        const reader = new IndexeddbPersistence(databaseName, restored);
        await reader.whenSynced;
        document.getElementById('restored')!.textContent = restored.getText('content').toString();
        await reader.destroy(); restored.destroy(); setError('');
      } catch (failure) { setError(String(failure)); }
    };
    return <NextIntlClientProvider locale="en" messages={messages}>
      <h1>Document recovery test</h1>
      <output data-testid="current-path">{currentPath ?? 'closed'}</output>
      {currentPath === path && <MarkdownSaveState collaboration={collaboration} content={doc.getText('content').toString()} available filePath={path} />}
      <button onClick={() => void action('close')}>Close document</button>
      <button onClick={() => void action('switch')}>Open other document</button>
      <button onClick={() => void action('delete')}>Delete document</button>
      <p role="alert">{error}</p>
    </NextIntlClientProvider>;
  }
  createRoot(document.getElementById('root')!).render(<App />);
  window.addEventListener('pagehide', () => { unregister(); void persistence.destroy(); doc.destroy(); });
}
void main();
