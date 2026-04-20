import { promises as fs, watch as fsWatch, FSWatcher } from 'fs';
import path from 'path';
import { clearFileTreeCache, clearSubtreeCache } from '@/app/lib/utils/file-tree-cache';
import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';

const DATA = process.env.DATA || path.join(process.cwd(), 'data');
const WORKSPACE_BASE_DIR = path.join(DATA, 'workspace');

const IGNORED_PATTERNS = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  '.DS_Store',
  'Thumbs.db',
];

type FileEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

interface FileEvent {
  type: FileEventType;
  path: string;
  relativePath: string;
  dir: string;
  timestamp: number;
}

interface Client {
  id: string;
  send: (event: FileEvent) => void;
}

class FileWatcherService {
  private watchers: Map<string, FSWatcher> = new Map();
  private clients: Map<string, Client> = new Map();
  private subscriptions: Map<string, Set<string>> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvents: FileEvent[] = [];
  private readonly debounceDelay: number = 500;
  private initialized: boolean = false;

  constructor() {
    this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.mkdir(WORKSPACE_BASE_DIR, { recursive: true });
      this.initialized = true;
    } catch (error) {
      console.error('[FileWatcher] Failed to initialize workspace dir:', error);
    }
  }

  public subscribe(client: Client): () => void {
    this.clients.set(client.id, client);
    console.log(`[FileWatcher] Client subscribed: ${client.id} (${this.clients.size} total)`);

    this.subscribeDir(client.id, '.');

    return () => {
      this.unsubscribeAll(client.id);
      this.clients.delete(client.id);
      console.log(`[FileWatcher] Client unsubscribed: ${client.id} (${this.clients.size} remaining)`);
    };
  }

  public subscribeDir(clientId: string, dirPath: string): void {
    if (!this.clients.has(clientId)) return;
    if (this.shouldIgnore(dirPath)) return;

    if (!this.subscriptions.has(dirPath)) {
      this.subscriptions.set(dirPath, new Set());
    }

    const subs = this.subscriptions.get(dirPath)!;
    if (subs.has(clientId)) return;

    subs.add(clientId);

    if (subs.size === 1) {
      this.startWatchingDir(dirPath);
    }
  }

  public unsubscribeDir(clientId: string, dirPath: string): void {
    const subs = this.subscriptions.get(dirPath);
    if (!subs) return;

    subs.delete(clientId);

    if (subs.size === 0) {
      this.subscriptions.delete(dirPath);
      this.stopWatchingPath(this.toFullPath(dirPath));
    }
  }

  public unsubscribeAll(clientId: string): void {
    const dirsToRemove: string[] = [];
    for (const [dirPath, subs] of this.subscriptions) {
      subs.delete(clientId);
      if (subs.size === 0) {
        dirsToRemove.push(dirPath);
      }
    }
    for (const dirPath of dirsToRemove) {
      this.subscriptions.delete(dirPath);
      this.stopWatchingPath(this.toFullPath(dirPath));
    }
  }

  public syncDirs(clientId: string, dirPaths: string[]): void {
    if (!this.clients.has(clientId)) return;

    const current = new Set<string>();
    for (const [dirPath, subs] of this.subscriptions) {
      if (subs.has(clientId)) {
        current.add(dirPath);
      }
    }

    const desired = new Set(dirPaths);
    desired.add('.');

    for (const dir of desired) {
      if (!current.has(dir)) {
        this.subscribeDir(clientId, dir);
      }
    }

    for (const dir of current) {
      if (!desired.has(dir)) {
        this.unsubscribeDir(clientId, dir);
      }
    }
  }

  public getSubscribedDirs(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  private async startWatchingDir(relativeDir: string): Promise<void> {
    const fullPath = this.toFullPath(relativeDir);

    if (this.watchers.has(fullPath)) return;

    try {
      const watcher = fsWatch(
        fullPath,
        { recursive: false },
        (eventType: 'rename' | 'change', filename: string | null) => {
          if (!filename) return;

          const relativeFilePath = relativeDir === '.' ? filename : path.join(relativeDir, filename);
          const fullFilePath = path.join(fullPath, filename);

          this.determineEventType(eventType, relativeFilePath, fullFilePath).then((fileEvent) => {
            if (fileEvent) {
              this.queueEvent(fileEvent);
            }
          });
        }
      );

      this.watchers.set(fullPath, watcher);
    } catch (error) {
      console.warn(`[FileWatcher] Failed to watch directory ${relativeDir}:`, error);
    }
  }

  private async determineEventType(
    eventType: 'rename' | 'change',
    relativePath: string,
    fullPath: string
  ): Promise<FileEvent | null> {
    const timestamp = Date.now();
    const dir = relativePath.includes('/')
      ? relativePath.substring(0, relativePath.lastIndexOf('/'))
      : '.';

    if (eventType === 'change') {
      return {
        type: 'change',
        path: fullPath,
        relativePath,
        dir,
        timestamp,
      };
    }

    try {
      const stats = await fs.stat(fullPath);
      const isDir = stats.isDirectory();
      const isNewDir = isDir && !this.watchers.has(fullPath);

      if (isNewDir) {
        const relativeDir = relativePath;
        const subs = this.subscriptions.get(relativeDir);
        if (subs && subs.size > 0) {
          this.startWatchingDir(relativeDir);
        }
        return {
          type: 'addDir',
          path: fullPath,
          relativePath,
          dir,
          timestamp,
        };
      }

      return {
        type: isDir ? 'addDir' : 'add',
        path: fullPath,
        relativePath,
        dir,
        timestamp,
      };
    } catch {
      const wasDir = this.watchers.has(fullPath);

      if (wasDir) {
        this.stopWatchingPath(fullPath);
        return {
          type: 'unlinkDir',
          path: fullPath,
          relativePath,
          dir,
          timestamp,
        };
      }

      return {
        type: 'unlink',
        path: fullPath,
        relativePath,
        dir,
        timestamp,
      };
    }
  }

  private shouldIgnore(filePath: string): boolean {
    const parts = filePath.split(path.sep);
    return parts.some((part) => IGNORED_PATTERNS.includes(part));
  }

  private queueEvent(event: FileEvent): void {
    this.pendingEvents.push(event);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushEvents();
    }, this.debounceDelay);
  }

  private flushEvents(): void {
    if (this.pendingEvents.length === 0) return;

    const uniqueEvents = new Map<string, FileEvent>();
    for (const event of this.pendingEvents) {
      uniqueEvents.set(event.relativePath, event);
    }

    for (const event of uniqueEvents.values()) {
      const dirPath = event.relativePath.includes('/')
        ? event.relativePath.substring(0, event.relativePath.lastIndexOf('/'))
        : '.';
      clearSubtreeCache(dirPath);
      invalidateFileReferenceCache();
      this.broadcastEvent({ ...event, dir: dirPath });
    }

    this.pendingEvents = [];
  }

  private broadcastEvent(event: FileEvent): void {
    for (const [clientId, client] of this.clients) {
      if (!this.isClientSubscribedToEvent(clientId, event)) {
        continue;
      }
      try {
        client.send(event);
      } catch (error) {
        console.warn(`[FileWatcher] Failed to send to client ${clientId}:`, error);
        this.unsubscribeAll(clientId);
        this.clients.delete(clientId);
      }
    }
  }

  private isClientSubscribedToEvent(clientId: string, event: FileEvent): boolean {
    const eventDir = event.dir || '.';
    const subscribers = this.subscriptions.get(eventDir);
    return subscribers?.has(clientId) ?? false;
  }

  private stopWatchingPath(fullPath: string): void {
    const watcher = this.watchers.get(fullPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(fullPath);
    }
  }

  private toFullPath(relativePath: string): string {
    if (relativePath === '.') return WORKSPACE_BASE_DIR;
    return path.join(WORKSPACE_BASE_DIR, relativePath);
  }

  public stop(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.clients.clear();
    this.subscriptions.clear();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    console.log('[FileWatcher] Stopped all watchers');
  }

  public forceRefresh(): void {
    clearFileTreeCache();
    this.broadcastEvent({
      type: 'change',
      path: WORKSPACE_BASE_DIR,
      relativePath: '.',
      dir: '.',
      timestamp: Date.now(),
    });
  }
}

let fileWatcherInstance: FileWatcherService | null = null;

export function getFileWatcher(): FileWatcherService {
  if (!fileWatcherInstance) {
    fileWatcherInstance = new FileWatcherService();
  }
  return fileWatcherInstance;
}

export type { FileEvent, FileEventType };
