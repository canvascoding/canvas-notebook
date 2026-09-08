import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { getNotebookNavigationIntent } from '@/app/lib/chat/chat-navigation-intent';
import type { NotebookDocumentTabsState } from './document-tabs';

/** Keep an old file deep link from reopening a tab after a successful cleanup. */
export function notebookLocationAfterClosing(href: string, workspaceId: string, paths: string[]): string {
  const url = new URL(href);
  const intent = getNotebookNavigationIntent(url.searchParams);
  if (intent.path && paths.includes(intent.path) && (!intent.workspaceId || intent.workspaceId === workspaceId)) {
    url.searchParams.delete('path');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function closeAllNotebookDocuments({ workspaceId, getTabs, onClosed }: {
  workspaceId: string;
  getTabs: () => NotebookDocumentTabsState;
  onClosed: (closed: NotebookDocumentTabsState) => void;
}): Promise<boolean> {
  const snapshot = getTabs();
  const path = useFileStore.getState().currentFile?.path ?? snapshot.activePath;
  const isCurrent = () => useWorkspaceStore.getState().activeWorkspaceId === workspaceId && getTabs() === snapshot;
  if (!path || !snapshot.openPaths.includes(path) || !isCurrent()) return false;
  return useFileStore.getState().closeFile(path, {
    canClose: isCurrent,
    onClosed: () => onClosed(snapshot),
  });
}
