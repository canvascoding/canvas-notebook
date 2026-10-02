import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { MarkdownSaveState } from '../../app/components/editor/MarkdownDocumentModes';
import { useCollaborationDocument } from '../../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../../app/lib/collaboration/types';
import { prepareRecoverableCollaborationTransition, preserveLocalCollaborationRecovery } from '../../app/lib/collaboration/local-recovery';
import { getDocumentTransitionGuard, registerDocumentTransitionGuard } from '../../app/lib/files/document-transition';
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
const session: CollaborationSessionResponse = {
  success: true, documentId: 'recovery-browser', documentName: 'recovery-browser', provider: 'yjs',
  representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write',
  documentSequence: 5, checkpointSequence: 4, stateVector: '', stateProof: null,
  token: 'recovery-fixture', expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
  user: { id: 'fixture', name: 'Fixture', color: '#123456', colorLight: '#abcdef' },
};

async function main() {
  await persistence.whenSynced;
  useWorkspaceStore.setState({ activeWorkspaceId: workspaceId });
  useFileStore.getState().resetWorkspaceView(workspaceId);
  useFileStore.setState({ currentFileWorkspaceId: workspaceId, currentFile: {
    path, content: doc.getText('content').toString(), collaboration: { crdtCapable: true },
  } as ReturnType<typeof useFileStore.getState>['currentFile'] });
  useEditorStore.getState().setActiveFile(path, doc.getText('content').toString());
  function App() {
    const [error, setError] = useState('');
    const currentFile = useFileStore((state) => state.currentFile);
    const currentPath = currentFile?.path;
    const draft = useEditorStore((state) => state.draft);
    const revealStatus = useFileStore((state) => state.browserReveal?.status);
    const handle = useCollaborationDocument({ enabled: currentPath === path, workspaceId, path,
      documentKey: 'recovery-fixture', representation: 'plain_text', session });
    const activeDoc = handle?.clientState.indexedDbHydrated ? handle.doc : null;
    const collaboration = activeDoc && handle ? { ...handle, durability: 'degraded' as const, status: 'degraded' as const,
      error: 'Rich collaboration checkpoint validation failed (stable_id_duplicate).' } : null;
    useEffect(() => {
      if (!activeDoc) return;
      return registerDocumentTransitionGuard(workspaceId, path, {
        hasPendingChanges: () => true,
        prepare: () => prepareRecoverableCollaborationTransition({
          doc: activeDoc, isPersistedCurrent: () => false,
          preserveLocalSnapshot: async () => {
            if (failStorage) throw new Error('Local storage unavailable. Download recovery state before closing.');
            await preserveLocalCollaborationRecovery(persistence, activeDoc);
          },
        }),
      });
    }, [activeDoc]);
    const action = async (kind: 'close' | 'switch' | 'delete') => {
      const restoredOutput = document.getElementById('restored')!;
      restoredOutput.textContent = '';
      setError('');
      try {
        if (kind === 'close') {
          if (useFileStore.getState().currentFile?.unavailable) {
            // FileEditor requires an explicit discard for an unavailable file.
            // First commit this fixture's recovery snapshot before releasing that view.
            const guard = getDocumentTransitionGuard(workspaceId, path);
            if (!guard) throw new Error('Recovery guard is not ready.');
            await guard.prepare();
            useFileStore.getState().clearCurrentFile();
            useEditorStore.getState().clear();
          } else await useFileStore.getState().closeFile(path);
        }
        if (kind === 'switch') {
          const result = await useFileStore.getState().revealAndLoadFile('other.md', { revealInTree: false });
          if (result.status === 'failed') throw new Error(result.error);
        }
        if (kind === 'delete') await useFileStore.getState().deletePath(path);
        const restored = new Y.Doc();
        let reader: IndexeddbPersistence | undefined;
        let restoredContent: string;
        try {
          reader = new IndexeddbPersistence(databaseName, restored);
          await reader.whenSynced;
          restoredContent = restored.getText('content').toString();
        } finally {
          try { await reader?.destroy(); }
          finally { restored.destroy(); }
        }
        restoredOutput.textContent = restoredContent;
      } catch (failure) { setError(String(failure)); }
    };
    return <NextIntlClientProvider locale="en" messages={messages}>
      <h1>Document recovery test</h1>
      <output data-testid="current-path">{currentPath ?? 'closed'}</output>
      <output data-testid="current-unavailable">{currentFile?.unavailable ?? 'none'}</output>
      <output data-testid="current-content">{currentFile?.content ?? ''}</output>
      <output data-testid="editor-draft">{draft}</output>
      <output data-testid="collaboration-view">{handle ? 'retained' : 'detached'}</output>
      <output data-testid="browser-reveal">{revealStatus ?? 'none'}</output>
      {currentPath === path && <MarkdownSaveState collaboration={collaboration} content={doc.getText('content').toString()} available={!currentFile?.unavailable} filePath={path} />}
      <button disabled={!activeDoc} onClick={() => void action('close')}>Close document</button>
      <button disabled={!activeDoc} onClick={() => void action('switch')}>Open other document</button>
      <button disabled={!activeDoc} onClick={() => void action('delete')}>Delete document</button>
      <p role="alert" data-testid="fixture-error">{error}</p>
    </NextIntlClientProvider>;
  }
  createRoot(document.getElementById('root')!).render(<App />);
  window.addEventListener('pagehide', () => { void persistence.destroy(); doc.destroy(); });
}
void main();
