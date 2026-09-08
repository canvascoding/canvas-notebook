'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { CurrentFile } from '@/app/lib/files/types';
import type { CollaborationDocument } from './client';

function fileDocumentScope(file: CurrentFile | null, workspaceId: string | null, treeGeneration: number): string | null {
  return file?.collaboration?.crdtCapable ? JSON.stringify([workspaceId, treeGeneration, file.editorIdentity ?? file.path, file.path,
    file.collaboration?.document?.id ?? null]) : null;
}

/** Scope child editor status and persistence handles to the actual open document. */
export function useFileEditorCollaborationDocument(file: CurrentFile | null, workspaceId: string | null) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const treeGeneration = useFileStore((state) => state.treeGeneration);
  const scope = activeWorkspaceId === workspaceId ? fileDocumentScope(file, workspaceId, treeGeneration) : null;
  const expectedDocumentId = file?.collaboration?.document?.id;
  // A → B → A must not reactivate callbacks retained from the first A view.
  const lifetime = useMemo(() => ({ scope }), [scope]);
  const activeLifetime = useRef<typeof lifetime | null>(null);
  const [state, setState] = useState<{ lifetime: typeof lifetime; document: CollaborationDocument } | null>(null);
  if (state && state.lifetime !== lifetime) setState(null);
  useLayoutEffect(() => {
    activeLifetime.current = lifetime;
    return () => { if (activeLifetime.current === lifetime) activeLifetime.current = null; };
  }, [lifetime]);
  const onCollaborationChange = useCallback((document: CollaborationDocument | null) => {
    const current = useFileStore.getState();
    if (activeLifetime.current !== lifetime || !scope || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
      || fileDocumentScope(current.currentFile, current.currentFileWorkspaceId, current.treeGeneration) !== scope
      || (document?.session && expectedDocumentId && document.session.documentId !== expectedDocumentId)
      || document?.doc.isDestroyed) return;
    setState((previous) => document ? { lifetime, document } : previous?.lifetime === lifetime ? null : previous);
  }, [lifetime, scope, workspaceId, expectedDocumentId]);
  return { document: state?.lifetime === lifetime && !state.document.doc.isDestroyed ? state.document : null, onCollaborationChange };
}
