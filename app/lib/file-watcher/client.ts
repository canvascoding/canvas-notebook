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

interface FileEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  relativePath: string;
  dir: string;
  timestamp: number;
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
  private lastReloadTime = 0;
  private debounceMs = 1000;
  private maxDebounceMs = 5000;
  private _isConnected = false;
  private storeUnsubscribe: (() => void) | null = null;

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
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (this.refCount === 0) {
          this.disconnect();
        }
      }, FileWatcherClient.DISCONNECT_GRACE_MS);
    }
  }

  syncDirs(dirs: string[]): void {
    if (!this.clientId) return;

    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      if (!this.clientId) return;
      fetch('/api/files/watch', {
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

    const eventSource = new EventSource('/api/files/watch', {
      withCredentials: true,
    });

    this.eventSource = eventSource;

    eventSource.onopen = () => {
      this.reconnectAttempts = 0;
    };

    eventSource.addEventListener('connected', (message: MessageEvent) => {
      try {
        const data = JSON.parse(message.data);
        if (data.clientId) {
          this.clientId = data.clientId;
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
    this.cancelDisconnectTimer();
    this.cancelSyncTimer();

    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

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
    this.dispatchEvent(new CustomEvent<FileEvent>('filechange', { detail: event }));

    this.scheduleVisibleRefresh();
  }

  private scheduleVisibleRefresh(): void {
    const now = Date.now();
    const timeSinceLastReload = now - this.lastReloadTime;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const waitTime = Math.max(0, this.debounceMs - timeSinceLastReload);
    const finalWaitTime = Math.min(waitTime, this.maxDebounceMs);

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void useFileStore.getState().refreshVisibleTree()
        .catch((error) => {
          console.warn('[FileWatcherClient] Failed to refresh visible file tree:', error);
        })
        .finally(() => {
          this.lastReloadTime = Date.now();
        });
    }, finalWaitTime);
  }

  private scheduleDirSync(dirs: string[]): void {
    if (!this.clientId) return;
    this.syncDirs(dirs);
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
