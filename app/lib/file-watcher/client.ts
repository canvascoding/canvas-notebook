/**
 * FileWatcher SSE Client - Singleton with acquire/release pattern
 *
 * - Single SSE connection per browser tab
 * - Ref-counting: connection stays alive while any consumer holds a reference
 * - Auto-reconnect with exponential backoff
 * - Graceful disconnect after DISCONNECT_GRACE_MS when refCount reaches 0
 * - Debounced directory sync with server
 */

import { useFileStore } from '@/app/store/file-store';
import { runDirectoryTasksByDepth } from '@/app/lib/files/tree-refresh';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { WorkspaceFileEvent } from '@/app/lib/files/file-events';
import { getParentDirectory, isSameOrDescendantPath } from '@/app/lib/files/path-utils';
import { readWorkspaceFile } from '@/app/lib/files/client';

type FileEvent = WorkspaceFileEvent;

const WATCHER_REFRESH_CONCURRENCY = 4;

function watcherUrl(workspaceId: string | null): string {
  return workspaceId ? `/api/files/watch?workspaceId=${encodeURIComponent(workspaceId)}` : '/api/files/watch';
}

function getWatchedDirs(): string[] {
  const { browserMode, currentDirectory, currentFile, expandedDirs } = useFileStore.getState();
  const dirs = new Set<string>();

  if (currentDirectory && currentDirectory !== '.') {
    dirs.add(currentDirectory);
  }

  if (currentFile?.path) {
    const parts = currentFile.path.split('/').filter(Boolean);
    if (parts.length > 1) {
      dirs.add(parts.slice(0, -1).join('/'));
    }
  }

  if (browserMode === 'tree') {
    for (const dir of expandedDirs) {
      if (dir !== '.') dirs.add(dir);
    }
  }

  return Array.from(dirs);
}

export class FileWatcherClient extends EventTarget {
  private eventSource: EventSource | null = null;
  private clientId: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isManualDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refCount = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRefreshDirs = new Set<string>();
  private lastReloadTime = 0;
  private debounceMs = 1000;
  private maxDebounceMs = 5000;
  private _isConnected = false;
  private storeUnsubscribe: (() => void) | null = null;
  private workspaceUnsubscribe: (() => void) | null = null;
  private connectionWorkspaceId: string | null = null;
  private pendingDeletions = new Map<string, object>();

  static readonly DISCONNECT_GRACE_MS = 3000;
  static readonly SYNC_DEBOUNCE_MS = 200;

  constructor() {
    super();
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  acquire(): void {
    const wasZero = this.refCount === 0;
    this.refCount++;
    this.cancelDisconnectTimer();

    if (wasZero && !this.storeUnsubscribe) {
      this.storeUnsubscribe = useFileStore.subscribe((state, prevState) => {
        const watchedDirsChanged =
          state.expandedDirs !== prevState.expandedDirs ||
          state.currentDirectory !== prevState.currentDirectory ||
          state.currentFile?.path !== prevState.currentFile?.path ||
          state.browserMode !== prevState.browserMode;

        if (watchedDirsChanged && this._isConnected && this.clientId) {
          this.scheduleDirSync(getWatchedDirs());
        }
      });

      this.workspaceUnsubscribe = useWorkspaceStore.subscribe((state, prevState) => {
        if (state.activeWorkspaceId !== prevState.activeWorkspaceId && this.refCount > 0) {
          this.reconnectForWorkspace();
        }
      });
    }

    if (this._isConnected && this.clientId) {
      this.scheduleDirSync(getWatchedDirs());
    }

    if (this._isConnected || this.eventSource) {
      return;
    }

    this.connect();
  }

  releaseConnection(): void {
    if (this.refCount > 0) {
      this.refCount--;
    }

    if (this.refCount === 0 && !this.disconnectTimer) {
      if (this.storeUnsubscribe) {
        this.storeUnsubscribe();
        this.storeUnsubscribe = null;
      }
      if (this.workspaceUnsubscribe) {
        this.workspaceUnsubscribe();
        this.workspaceUnsubscribe = null;
      }
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (this.refCount === 0) {
          this.disconnect();
        }
      }, FileWatcherClient.DISCONNECT_GRACE_MS);
    }
  }

  syncDirs(dirs: string[]): void {
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!this.clientId || (activeWorkspaceId && this.connectionWorkspaceId !== activeWorkspaceId)) return;

    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      if (!this.clientId) return;
      fetch(watcherUrl(this.connectionWorkspaceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ clientId: this.clientId, dirs }),
      }).catch(() => {});
    }, FileWatcherClient.SYNC_DEBOUNCE_MS);
  }

  private connect(): void {
    if (this.eventSource) return;
    this.isManualDisconnect = false;
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    this.connectionWorkspaceId = workspaceId;

    const eventSource = new EventSource(watcherUrl(workspaceId), {
      withCredentials: true,
    });

    this.eventSource = eventSource;

    eventSource.onopen = () => {
      this.reconnectAttempts = 0;
    };

    eventSource.addEventListener('connected', (message: MessageEvent) => {
      try {
        const data = JSON.parse(message.data);
        if (data.clientId && (!this.connectionWorkspaceId || !data.workspaceId || data.workspaceId === this.connectionWorkspaceId)) {
          this.clientId = data.clientId;
          this.connectionWorkspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : this.connectionWorkspaceId;
          this._isConnected = true;
          this.dispatchEvent(new CustomEvent('connected'));

          this.scheduleDirSync(getWatchedDirs());
        }
      } catch {}
    });

    eventSource.addEventListener('filechange', (message: MessageEvent) => {
      try {
        const event: FileEvent = JSON.parse(message.data);
        this.handleFileChange(event);
      } catch (error) {
        console.warn('[FileWatcherClient] Failed to parse event:', error);
      }
    });

    eventSource.addEventListener('heartbeat', () => {});

    eventSource.onerror = () => {
      if (this.eventSource !== eventSource) return;
      this._isConnected = false;
      this.clientId = null;

      eventSource.close();
      if (this.eventSource === eventSource) {
        this.eventSource = null;
      }

      this.dispatchEvent(new CustomEvent('disconnected'));

      if (!this.isManualDisconnect) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.isManualDisconnect = true;
    this.refCount = 0;
    this._isConnected = false;
    this.clientId = null;
    this.connectionWorkspaceId = null;
    this.cancelDisconnectTimer();
    this.cancelSyncTimer();

    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }
    if (this.workspaceUnsubscribe) {
      this.workspaceUnsubscribe();
      this.workspaceUnsubscribe = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingRefreshDirs.clear();

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.dispatchEvent(new CustomEvent('disconnected'));
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[FileWatcherClient] Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      this.dispatchEvent(new CustomEvent('error', { detail: { error: 'Max reconnect attempts reached' } }));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isManualDisconnect && !this.eventSource) {
        this.connect();
      }
    }, delay);
  }

  private handleFileChange(event: FileEvent): void {
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (activeWorkspaceId && event.workspaceId && event.workspaceId !== activeWorkspaceId) return;

    const affectedPaths = event.mutation
      ? [event.mutation.oldPath, event.mutation.newPath]
      : [event.relativePath];
    for (const pendingPath of this.pendingDeletions.keys()) {
      if (affectedPaths.some((path) => isSameOrDescendantPath(path, pendingPath) || isSameOrDescendantPath(pendingPath, path))) {
        this.pendingDeletions.delete(pendingPath);
      }
    }
    if (event.type === 'rename' && event.mutation) {
      useFileStore.getState().applyPathRename(event.mutation);
      this.scheduleDirectoryRefresh(getParentDirectory(event.mutation.oldPath));
      this.scheduleDirectoryRefresh(getParentDirectory(event.mutation.newPath));
      this.dispatchEvent(new CustomEvent<FileEvent>('filechange', { detail: event }));
      return;
    }
    if (event.type === 'unlink' || event.type === 'unlinkDir') {
      // Atomic replacement and delayed native events can report an unlink for
      // a path that already exists again. Confirm absence before detaching it.
      const workspaceId = activeWorkspaceId;
      const generation = useFileStore.getState().treeGeneration;
      const fileLoadRequestId = useFileStore.getState().fileLoadRequestId;
      const source = this.eventSource;
      const confirmation = {};
      this.pendingDeletions.set(event.relativePath, confirmation);
      void readWorkspaceFile(event.relativePath, { metaOnly: true, noCache: true, workspaceId })
        .catch((error) => {
          if (error instanceof Response && error.status === 404
            && this.pendingDeletions.get(event.relativePath) === confirmation
            && this.eventSource === source
            && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
            && useFileStore.getState().treeGeneration === generation
            && useFileStore.getState().fileLoadRequestId === fileLoadRequestId) {
            useFileStore.getState().applyPathsDeleted([event.relativePath], workspaceId);
          }
        }).finally(() => {
          if (this.pendingDeletions.get(event.relativePath) === confirmation) this.pendingDeletions.delete(event.relativePath);
        });
    }

    if (event.type !== 'change') {
      useFileStore.getState().markDirectoryStale(event.dir || '.');
    }
    this.dispatchEvent(new CustomEvent<FileEvent>('filechange', { detail: event }));

    if (this.shouldRefreshTreeForEvent(event)) {
      this.scheduleDirectoryRefresh(event.dir || '.');
    }
  }

  private shouldRefreshTreeForEvent(event: FileEvent): boolean {
    if (event.dir === '.') return event.type !== 'change';
    if (event.type === 'change') return false;
    return getWatchedDirs().includes(event.dir || '.');
  }

  private scheduleDirectoryRefresh(dirPath: string): void {
    this.pendingRefreshDirs.add(dirPath || '.');

    const now = Date.now();
    const timeSinceLastReload = now - this.lastReloadTime;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const waitTime = Math.max(0, this.debounceMs - timeSinceLastReload);
    const finalWaitTime = Math.min(waitTime, this.maxDebounceMs);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const dirsToRefresh = Array.from(this.pendingRefreshDirs).sort((a, b) => {
        const depthDiff = a.split('/').length - b.split('/').length;
        return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
      });
      this.pendingRefreshDirs.clear();

      void this.refreshDirectories(dirsToRefresh)
        .catch((error) => {
          console.warn('[FileWatcherClient] Failed to refresh changed directories:', error);
        })
        .finally(() => {
          this.lastReloadTime = Date.now();
        });
    }, finalWaitTime);
  }

  private async refreshDirectories(dirPaths: string[]): Promise<void> {
    const store = useFileStore.getState();
    await runDirectoryTasksByDepth(
      dirPaths,
      async (dirPath) => {
        await store.refreshDirectory(dirPath, true);
      },
      { concurrency: WATCHER_REFRESH_CONCURRENCY },
    );
  }

  private scheduleDirSync(dirs: string[]): void {
    if (!this.clientId) return;
    this.syncDirs(dirs);
  }

  private reconnectForWorkspace(): void {
    const nextWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (nextWorkspaceId === this.connectionWorkspaceId) return;

    this.cancelSyncTimer();
    this.clientId = null;
    this._isConnected = false;
    this.connectionWorkspaceId = null;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.dispatchEvent(new CustomEvent('disconnected'));
    this.connect();
  }

  private cancelDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private cancelSyncTimer(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  resetForReconnect(): void {
    this.isManualDisconnect = false;
    this.reconnectAttempts = 0;
  }
}

let globalFileWatcherClient: FileWatcherClient | null = null;

export function getFileWatcherClient(): FileWatcherClient {
  if (!globalFileWatcherClient) {
    globalFileWatcherClient = new FileWatcherClient();
  }
  return globalFileWatcherClient;
}

export function disconnectFileWatcherClient(): void {
  if (globalFileWatcherClient) {
    globalFileWatcherClient.disconnect();
    globalFileWatcherClient = null;
  }
}

export type { FileEvent };
