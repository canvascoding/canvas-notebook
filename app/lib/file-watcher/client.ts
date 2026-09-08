import { useFilePresenceStore } from '@/app/store/file-presence-store';
import { invalidateFileReferenceValidationCache } from '@/app/lib/chat/validate-file-paths';
import { previewMayDependOn, previewDependencyDirectories } from '@/app/lib/files/preview-dependencies';
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
    for (const dir of previewDependencyDirectories(currentFile.path, currentFile.content)) dirs.add(dir);
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
  private debounceMs = 500;
  private firstPendingAt: number | null = null;
  private fileVersions = new Map<string, string>();
  private versionTimer: ReturnType<typeof setTimeout> | null = null;
  private _isConnected = false;
  private storeUnsubscribe: (() => void) | null = null;
  private workspaceUnsubscribe: (() => void) | null = null;
  private connectionWorkspaceId: string | null = null;
  private connectionGeneration = 0;
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
          state.currentFile?.content !== prevState.currentFile?.content ||
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

    if ((this.eventSource || this._isConnected) && this.connectionWorkspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
      this.reconnectForWorkspace();
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

    const generation = this.connectionGeneration;
    const workspaceId = this.connectionWorkspaceId;
    const clientId = this.clientId;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (!clientId || generation !== this.connectionGeneration || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
      fetch(watcherUrl(workspaceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ clientId, dirs }),
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
    const generation = ++this.connectionGeneration;
    const isCurrent = () => this.eventSource === eventSource && this.connectionGeneration === generation
      && useWorkspaceStore.getState().activeWorkspaceId === workspaceId;

    eventSource.onopen = () => {
      if (!isCurrent()) return;
      this.reconnectAttempts = 0;
    };

    eventSource.addEventListener('connected', (message: MessageEvent) => {
      if (!isCurrent()) return;
      try {
        const data = JSON.parse(message.data);
        if (data.clientId && (!this.connectionWorkspaceId || !data.workspaceId || data.workspaceId === this.connectionWorkspaceId)) {
          this.clientId = data.clientId;
          this.connectionWorkspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : this.connectionWorkspaceId;
          this._isConnected = true;
          this.dispatchEvent(new CustomEvent('connected'));

          this.scheduleDirSync(getWatchedDirs());
          this.revalidateAfterConnect();
        }
      } catch {}
    });

    eventSource.addEventListener('filechange', (message: MessageEvent) => {
      if (!isCurrent()) return;
      try {
        const event: FileEvent = JSON.parse(message.data);
        this.handleFileChange(event);
      } catch (error) {
        console.warn('[FileWatcherClient] Failed to parse event:', error);
      }
    });

    eventSource.addEventListener('heartbeat', () => {});

    eventSource.onerror = () => {
      if (!isCurrent()) return;
      this.cancelPendingWork();
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
    this.connectionGeneration += 1;
    this.cancelPendingWork();
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
    this.firstPendingAt = null;
    this.fileVersions.clear();
    if (this.versionTimer) clearTimeout(this.versionTimer);
    this.versionTimer = null;

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

    if (event.type === 'rename' || event.type === 'unlink' || event.type === 'unlinkDir') this.fileVersions.clear();
    else if (event.fileVersion) {
      if (this.fileVersions.get(event.relativePath) === event.fileVersion) return;
      this.fileVersions.delete(event.relativePath);
      this.fileVersions.set(event.relativePath, event.fileVersion);
      if (this.fileVersions.size > 2048) this.fileVersions.delete(this.fileVersions.keys().next().value!);
    } else this.fileVersions.delete(event.relativePath);

    if (event.type === 'add' || event.type === 'addDir') useFilePresenceStore.getState().restorePath(event.relativePath);
    const current = useFileStore.getState().currentFile;
    this.scheduleWorkspaceVersion();
    if (current && previewMayDependOn(current.path, current.content, event.relativePath)) {
      useFileStore.setState((state) => ({ previewDependencyVersion: state.previewDependencyVersion + 1 }));
    }
    for (const path of event.mutation ? [event.mutation.oldPath, event.mutation.newPath] : [event.relativePath]) {
      invalidateFileReferenceValidationCache({ workspaceId: activeWorkspaceId, path });
    }
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

    if ((event.type === 'change' || event.type === 'add')
      && useFileStore.getState().currentFile?.path === event.relativePath) {
      void useFileStore.getState().refreshCurrentFileContent(event.relativePath);
    }
    useFileStore.getState().markDirectoryStale(event.dir || '.');
    this.dispatchEvent(new CustomEvent<FileEvent>('filechange', { detail: event }));

    if (this.shouldRefreshTreeForEvent(event)) {
      this.scheduleDirectoryRefresh(event.dir || '.');
    }
  }

  private shouldRefreshTreeForEvent(event: FileEvent): boolean {
    if (event.dir === '.') return true;
    return getWatchedDirs().includes(event.dir || '.');
  }

  private scheduleDirectoryRefresh(dirPath: string): void {
    this.pendingRefreshDirs.add(dirPath || '.');
    const workspaceId = this.connectionWorkspaceId;
    const generation = this.connectionGeneration;

    const now = Date.now();
    this.firstPendingAt ??= now;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const finalWaitTime = Math.max(0, Math.max(this.firstPendingAt + this.debounceMs, this.lastReloadTime + this.debounceMs) - now);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.firstPendingAt = null;
      if (generation !== this.connectionGeneration || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
      const dirsToRefresh = Array.from(this.pendingRefreshDirs).sort((a, b) => {
        const depthDiff = a.split('/').length - b.split('/').length;
        return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
      });
      this.pendingRefreshDirs.clear();
      this.lastReloadTime = Date.now();

      void this.refreshDirectories(dirsToRefresh, workspaceId, generation)
        .catch((error) => {
          console.warn('[FileWatcherClient] Failed to refresh changed directories:', error);
        });
    }, finalWaitTime);
  }

  private async refreshDirectories(dirPaths: string[], workspaceId: string | null, generation: number): Promise<void> {
    const store = useFileStore.getState();
    await runDirectoryTasksByDepth(
      dirPaths,
      async (dirPath) => {
        if (generation === this.connectionGeneration && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) await store.revalidateDirectory(dirPath, workspaceId, true);
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

    this.cancelPendingWork();
    this.connectionGeneration += 1;
    this.reconnectAttempts = 0;
    this.lastReloadTime = 0;
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

  private cancelPendingWork(): void {
    this.cancelSyncTimer();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.debounceTimer = null; this.reconnectTimer = null;
    this.pendingRefreshDirs.clear(); this.pendingDeletions.clear();
    this.firstPendingAt = null;
    this.fileVersions.clear();
    if (this.versionTimer) clearTimeout(this.versionTimer);
    this.versionTimer = null;
  }

  private scheduleWorkspaceVersion(): void {
    if (this.versionTimer) return;
    const generation = this.connectionGeneration;
    const workspaceId = this.connectionWorkspaceId;
    this.versionTimer = setTimeout(() => {
      this.versionTimer = null;
      if (this.connectionGeneration === generation && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        useFileStore.setState((state) => ({ workspaceFileVersion: state.workspaceFileVersion + 1 }));
      }
    }, 500);
  }

  private revalidateAfterConnect(): void {
    const store = useFileStore.getState();
    invalidateFileReferenceValidationCache({ workspaceId: this.connectionWorkspaceId });
    useFileStore.setState((state) => ({ workspaceFileVersion: state.workspaceFileVersion + 1, previewDependencyVersion: state.previewDependencyVersion + 1 }));
    void store.refreshVisibleTree().catch((error) => console.warn('[FileWatcherClient] Reconnect refresh failed:', error));
    if (store.currentFile && store.currentFileWorkspaceId === this.connectionWorkspaceId) void store.refreshCurrentFileContent(store.currentFile.path);
  }

  reconnectNow(): void {
    this.cancelPendingWork();
    this.eventSource?.close(); this.eventSource = null;
    this._isConnected = false; this.clientId = null;
    this.reconnectAttempts = 0;
    if (this.refCount > 0) this.connect();
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
