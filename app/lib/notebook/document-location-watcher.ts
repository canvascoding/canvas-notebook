import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { isSameOrDescendantPath } from '@/app/lib/files/path-utils';
import { requestCollaborationDocumentLocation } from '@/app/lib/collaboration/document-location-request';
import type { CollaborationDocumentLocation } from '@/app/lib/collaboration/document-location';
import type { NotebookDocumentTabsState } from './document-tabs';

type LocationWatcher = Pick<ReturnType<typeof getFileWatcherClient>, 'acquire' | 'releaseConnection' | 'addEventListener' | 'removeEventListener'>;
type Entry = { path: string; documentId: string; revision: number; pending: boolean; lastStarted: number;
  controller: AbortController | null; timeout: ReturnType<typeof setTimeout> | null };

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
    entry.pending = false;
    entry.lastStarted = Date.now();
    const revision = entry.revision;
    const controller = new AbortController();
    entry.controller = controller;
    running++;
    entry.timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const location = await requestCollaborationDocumentLocation(options.workspaceId, entry.documentId, controller.signal);
      if (!current() || entries.get(entry.path) !== entry || entry.revision !== revision
        || options.isActive(entry.path, entry.documentId)) return;
      const tabs = options.getTabs();
      if (tabs.openPaths.includes(entry.path) && tabs.documentIds?.[entry.path] === entry.documentId && location) {
        options.onLocation(entry.path, entry.documentId, location);
      }
    } catch {
      // A failed lookup never closes a tab or adopts a reused filename. A later
      // reconnect, visibility/focus signal or relevant file event retries it.
    } finally {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.timeout = null;
      entry.controller = null;
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
      const wait = entry.lastStarted + 1000 - Date.now();
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
      entries.set(path, { path, documentId, revision: 0, pending: true, lastStarted: 0, controller: null, timeout: null });
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
      entry.revision++; entry.pending = true;
    }
    schedule();
  };
  const refresh = () => invalidate();
  const onFile = (event: Event) => {
    const detail = (event as CustomEvent<FileEvent>).detail;
    if (!detail || (detail.workspaceId && detail.workspaceId !== options.workspaceId)) return;
    if (detail.type === 'unlink' || detail.type === 'unlinkDir') invalidate(detail.relativePath);
  };
  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  watcher.addEventListener('connected', refresh);
  watcher.addEventListener('filechange', onFile);
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
      watcher.removeEventListener('connected', refresh);
      watcher.removeEventListener('filechange', onFile);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      watcher.releaseConnection();
    },
  };
}
