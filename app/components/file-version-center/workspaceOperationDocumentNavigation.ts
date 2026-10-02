'use client';

import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { beginExternalWorkspaceNavigation } from '@/app/lib/workspaces/navigation-sync';
import { notifyWorkspaceFileOpened } from '@/app/lib/files/workspace-file-events';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { useFileStore } from '@/app/store/file-store';
import { closeWorkspaceOperationReview } from '@/app/store/workspace-operation-review-store';

/** Use the same guarded editor opening path as the file browser. */
export async function openWorkspaceOperationSourceDocument(path: string, workspaceId: string): Promise<void> {
  const scope = openedDocumentAuthScope();
  if (!scope) throw new Error('Document session unavailable.');
  const release = beginExternalWorkspaceNavigation();
  try {
    await useWorkspaceStore.getState().hydrateWorkspaces();
    if (openedDocumentAuthScope() !== scope) throw new Error('Document session changed.');
    if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) {
      await useWorkspaceStore.getState().setActiveWorkspace(workspaceId, 'system');
    }
    if (openedDocumentAuthScope() !== scope || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) {
      throw new Error('Document workspace unavailable.');
    }
    const result = await useFileStore.getState().revealAndLoadFile(path, {
      workspaceId, isCurrent: () => openedDocumentAuthScope() === scope && useWorkspaceStore.getState().activeWorkspaceId === workspaceId,
    });
    if (result.status !== 'opened') throw new Error(result.status === 'failed' ? result.error : 'Document could not be opened.');
    if (openedDocumentAuthScope() !== scope || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
    notifyWorkspaceFileOpened(path, 'file-browser', workspaceId);
    closeWorkspaceOperationReview();
  } finally { release(); }
}
