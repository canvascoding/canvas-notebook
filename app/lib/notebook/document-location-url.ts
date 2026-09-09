import { getNotebookNavigationIntent } from '@/app/lib/chat/chat-navigation-intent';
import type { NotebookDocumentTabsState } from './document-tabs';

/** Follow only the confirmed identity already addressed by this deep link. */
export function notebookUrlAfterDocumentMove(
  href: string,
  workspaceId: string,
  before: NotebookDocumentTabsState,
  after: NotebookDocumentTabsState,
): { href: string; previousPath: string; path: string } | null {
  const url = new URL(href);
  const intent = getNotebookNavigationIntent(url.searchParams);
  if (!intent.path || (intent.workspaceId && intent.workspaceId !== workspaceId)
    || !before.openPaths.includes(intent.path)) return null;
  const id = Object.hasOwn(before.documentIds ?? {}, intent.path) ? before.documentIds?.[intent.path] : null;
  if (!id || after.documentIds?.[intent.path] === id) return null;
  const destinations = after.openPaths.filter(path => after.documentIds?.[path] === id);
  if (destinations.length !== 1) return null;
  const path = destinations[0];
  url.searchParams.set('path', path);
  return { href: `${url.pathname}${url.search}${url.hash}`, previousPath: intent.path, path };
}
