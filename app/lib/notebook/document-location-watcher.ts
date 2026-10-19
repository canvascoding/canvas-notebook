import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { isWorkspaceFileInvalidation } from '@/app/lib/files/file-events';
import { isSameOrDescendantPath } from '@/app/lib/files/path-utils';
import { requestCollaborationDocumentLocation } from '@/app/lib/collaboration/document-location-request';
import { CollaborationDocumentLocationRequestError, createDocumentLocationRetryBudget, nextDocumentLocationRetryDelay,
  type DocumentLocationRetryBudget } from '@/app/lib/collaboration/document-location-retry';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation,
  type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import type { CollaborationDocumentLocation } from '@/app/lib/collaboration/document-location';
import type { NotebookDocumentTabsState } from './document-tabs';

type LocationWatcher = Pick<ReturnType<typeof getFileWatcherClient>, 'acquire' | 'releaseConnection' | 'addEventListener' | 'removeEventListener'>;
type Entry = { path: string; documentId: string; revision: number; pending: boolean; lastStarted: number;
  controller: AbortController | null; timeout: ReturnType<typeof setTimeout> | null;
  retryBudget: DocumentLocationRetryBudget | null; retryAuthScope: OpenedDocumentAuthScope | null };

/** Keep inactive tabs attached to their identity without mounting another editor. */
export function createNotebookDocumentLocationWatcher(options: {
  workspaceId: string;
  getTabs: () => NotebookDocumentTabsState;
  isCurrent: () => boolean;
  isActive: (path: string, documentId: string) => boolean;
  onLocation: (path: string, documentId: string, location: CollaborationDocumentLocation) => void;
  watcher?: LocationWatcher;
}) {
  const watcher = options.watcher ?? getFileWatcherClient();
  const entries = new Map<string, Entry>();
  let disposed = false;
  let running = 0;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const current = () => !disposed && options.isCurrent();
  const retire = (entry: Entry) => {
    entry.pending = false; entry.retryBudget = null;
    entry.controller?.abort();
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = null;
  };

  const schedule = () => {
    if (!current() || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  };
  const start = async (entry: Entry) => {
    if (!entry.retryBudget) {
      entry.retryBudget = createDocumentLocationRetryBudget(); entry.retryAuthScope = openedDocumentAuthScope();
    }
    const budget = entry.retryBudget, authScope = entry.retryAuthScope;
    if (openedDocumentAuthScope() !== authScope || budget.attempts >= 6 || Date.now() >= budget.deadline) {
      entry.pending = false; entry.retryBudget = null; return;
    }
    entry.pending = false;
    budget.attempts++;
    entry.lastStarted = Date.now();
    const revision = entry.revision;
    const controller = new AbortController();
    entry.controller = controller;
    running++;
    entry.timeout = setTimeout(() => controller.abort(new CollaborationDocumentLocationRequestError(
      'Location lookup timed out.', { code: 'LOCATION_TIMEOUT', retryable: true })), Math.min(10_000, budget.deadline - entry.lastStarted));
    try {
      const location = await requestCollaborationDocumentLocation(options.workspaceId, entry.documentId, controller.signal);
      if (!current() || entries.get(entry.path) !== entry || entry.revision !== revision
        || entry.retryBudget !== budget || entry.retryAuthScope !== authScope || openedDocumentAuthScope() !== authScope
        || options.isActive(entry.path, entry.documentId)) return;
      entry.retryBudget = null;
      const tabs = options.getTabs();
      if (tabs.openPaths.includes(entry.path) && tabs.documentIds?.[entry.path] === entry.documentId && location) {
        options.onLocation(entry.path, entry.documentId, location);
      }
    } catch (error) {
      if (current() && entries.get(entry.path) === entry && entry.revision === revision && entry.retryBudget === budget
        && entry.retryAuthScope === authScope && openedDocumentAuthScope() === authScope
        && !options.isActive(entry.path, entry.documentId)) {
        entry.pending = nextDocumentLocationRetryDelay(budget, error) !== null;
        if (!entry.pending) entry.retryBudget = null;
      }
    } finally {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.timeout = null;
      if (entry.controller === controller) entry.controller = null;
      if (entry.retryBudget === budget && openedDocumentAuthScope() !== authScope) { entry.retryBudget = null; entry.pending = false; }
      running--;
      schedule();
    }
  };
  const pump = () => {
    if (!current()) return;
    if (timer) clearTimeout(timer);
    timer = null;
    let earliest = Infinity;
    for (const entry of entries.values()) {
      if (!entry.pending || entry.controller || options.isActive(entry.path, entry.documentId)) continue;
      if (running >= 2) break;
      const wait = Math.max(entry.lastStarted + 1000, entry.retryBudget?.nextAt ?? 0) - Date.now();
      if (wait > 0) { earliest = Math.min(earliest, wait); continue; }
      void start(entry);
    }
    if (Number.isFinite(earliest) && running < 2) timer = setTimeout(() => { timer = null; schedule(); }, earliest);
  };
  const track = () => {
    if (!current()) return;
    const tabs = options.getTabs();
    const remaining = new Set<string>();
    for (const path of tabs.openPaths) {
      const documentId = tabs.documentIds?.[path];
      if (!documentId || !Object.hasOwn(tabs.documentIds ?? {}, path)) continue;
      remaining.add(path);
      const existing = entries.get(path);
      if (existing?.documentId === documentId) continue;
      if (existing) retire(existing);
      entries.set(path, { path, documentId, revision: 0, pending: true, lastStarted: 0, controller: null, timeout: null,
        retryBudget: null, retryAuthScope: openedDocumentAuthScope() });
    }
    for (const [path, entry] of entries) if (!remaining.has(path)) {
      retire(entry); entries.delete(path);
    }
    schedule();
  };
  const invalidate = (path?: string) => {
    track();
    for (const entry of entries.values()) {
      if (path && !isSameOrDescendantPath(entry.path, path)) continue;
      if (entry.retryBudget && Date.now() >= entry.retryBudget.deadline && !entry.controller) entry.retryBudget = null;
      entry.revision++; entry.pending = true;
    }
    schedule();
  };
  const onAuthInvalidated = () => {
    for (const entry of entries.values()) { entry.revision++; retire(entry); }
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const removeAuthListener = subscribeOpenedDocumentAuthInvalidation(onAuthInvalidated);
  const refresh = () => invalidate();
  const onFile = (event: Event) => {
    const detail = (event as CustomEvent<FileEvent>).detail;
    if (!detail || (detail.workspaceId && detail.workspaceId !== options.workspaceId)) return;
    if (detail.type === 'unlink' || detail.type === 'unlinkDir') invalidate(detail.relativePath);
  };
  const onWorkspaceInvalidated = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (current() && isWorkspaceFileInvalidation(detail) && detail.workspaceId === options.workspaceId) refresh();
  };
  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  watcher.addEventListener('connected', refresh);
  watcher.addEventListener('filechange', onFile);
  watcher.addEventListener('workspace-invalidated', onWorkspaceInvalidated);
  window.addEventListener('online', refresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', onVisible);
  watcher.acquire();
  track();
  return {
    // Call synchronously whenever tabs change, including close then reopen of
    // the same identity. Removing an Entry revokes all of its pending results.
    track,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const entry of entries.values()) retire(entry);
      entries.clear();
      removeAuthListener();
      watcher.removeEventListener('connected', refresh);
      watcher.removeEventListener('filechange', onFile);
      watcher.removeEventListener('workspace-invalidated', onWorkspaceInvalidated);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      watcher.releaseConnection();
    },
  };
}
