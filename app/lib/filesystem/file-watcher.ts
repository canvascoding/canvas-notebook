/**
 * File Watcher Service
 *
 * Überwacht das Workspace-Verzeichnis auf Änderungen und
 * benachrichtigt verbundene Clients über SSE.
 *
 * Features:
 * - Rekursives Watching mit fs.watch
 * - Debouncing (500ms) um zu viele Events zu vermeiden
 * - Ignorierte Verzeichnisse: node_modules, .git, .next, dist, build, .cache
 * - Event-Typen: add, change, unlink, addDir, unlinkDir
 */

import { promises as fs, watch as fsWatch, FSWatcher } from 'fs';
import path from 'path';
import { clearFileTreeCache, clearSubtreeCache } from '@/app/lib/utils/file-tree-cache';

const DATA = process.env.DATA || path.join(process.cwd(), 'data');
const WORKSPACE_BASE_DIR = path.join(DATA, 'workspace');

// Ignorierte Verzeichnisse und Dateien
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

// Event-Typen
type FileEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

interface FileEvent {
  type: FileEventType;
  path: string;
  relativePath: string;
  dir: string;
  timestamp: number;
}

// Client-Typ für SSE
interface Client {
  id: string;
  send: (event: FileEvent) => void;
}

class FileWatcherService {
  private watchers: Map<string, FSWatcher> = new Map();
  private clients: Set<Client> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvents: FileEvent[] = [];
  private isWatching: boolean = false;
  private readonly debounceDelay: number = 500;
  private maxDepth: number = 10;

  constructor() {
    this.startWatching();
  }

  /**
   * Startet das File Watching
   */
  private async startWatching(): Promise<void> {
    if (this.isWatching) return;

    try {
      // Stelle sicher, dass das Workspace-Verzeichnis existiert
      await fs.mkdir(WORKSPACE_BASE_DIR, { recursive: true });

      // Starte rekursives Watching
      await this.watchDirectory('.', 0);

      this.isWatching = true;
      console.log('[FileWatcher] Started watching:', WORKSPACE_BASE_DIR);
    } catch (error) {
      console.error('[FileWatcher] Failed to start watching:', error);
    }
  }

  /**
   * Rekursives Watching eines Verzeichnisses
   */
  private async watchDirectory(relativeDir: string, depth: number): Promise<void> {
    if (depth > this.maxDepth) return;

    const fullPath = path.join(WORKSPACE_BASE_DIR, relativeDir);

    // Prüfe ob Verzeichnis ignoriert werden soll
    if (this.shouldIgnore(relativeDir)) return;

    // Watcher für dieses Verzeichnis erstellen
    try {
      const watcher = fsWatch(
        fullPath,
        { recursive: false },
        (eventType: 'rename' | 'change', filename: string | null) => {
          if (!filename) return;

          const relativeFilePath = relativeDir === '.' ? filename : path.join(relativeDir, filename);
          const fullFilePath = path.join(fullPath, filename);

          // Bestimme Event-Typ
          this.determineEventType(eventType, relativeFilePath, fullFilePath).then((fileEvent) => {
            if (fileEvent) {
              this.queueEvent(fileEvent);
            }
          });
        }
      );

      this.watchers.set(fullPath, watcher);

      // Rekursiv Unterverzeichnisse beobachten
      if (depth < this.maxDepth) {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !this.shouldIgnore(entry.name)) {
            const subDir = relativeDir === '.' ? entry.name : path.join(relativeDir, entry.name);
            await this.watchDirectory(subDir, depth + 1);
          }
        }
      }
    } catch (error) {
      console.warn(`[FileWatcher] Failed to watch directory ${relativeDir}:`, error);
    }
  }

  /**
   * Bestimmt den Event-Typ basierend auf fs.watch Event
   */
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

    // 'rename' kann bedeuten: created, deleted, oder renamed
    try {
      const stats = await fs.stat(fullPath);
      const isDir = stats.isDirectory();

      // Prüfe ob wir dieses Verzeichnis bereits beobachten
      const isNewDir = isDir && !this.watchers.has(fullPath);

      if (isNewDir) {
        // Neues Verzeichnis - starte Watching
        await this.watchDirectory(relativePath, 0);
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
      // File existiert nicht mehr - wurde gelöscht
      const wasDir = this.watchers.has(fullPath);

      if (wasDir) {
        // Stoppe Watching für gelöschtes Verzeichnis
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

  /**
   * Prüft ob ein Pfad ignoriert werden soll
   */
  private shouldIgnore(filePath: string): boolean {
    const parts = filePath.split(path.sep);
    return parts.some((part) => IGNORED_PATTERNS.includes(part));
  }

  /**
   * Queued Event mit Debouncing
   */
  private queueEvent(event: FileEvent): void {
    this.pendingEvents.push(event);

    // Clear existing timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new timer
    this.debounceTimer = setTimeout(() => {
      this.flushEvents();
    }, this.debounceDelay);
  }

  /**
   * Verarbeitet alle pending Events
   */
  private flushEvents(): void {
    if (this.pendingEvents.length === 0) return;

    // Dedupliziere Events (nur das neueste pro Pfad)
    const uniqueEvents = new Map<string, FileEvent>();
    for (const event of this.pendingEvents) {
      uniqueEvents.set(event.relativePath, event);
    }

    for (const event of uniqueEvents.values()) {
      const dirPath = event.relativePath.includes('/')
        ? event.relativePath.substring(0, event.relativePath.lastIndexOf('/'))
        : '.';
      clearSubtreeCache(dirPath);
      this.broadcastEvent({ ...event, dir: dirPath });
    }

    // Clear pending events
    this.pendingEvents = [];
  }

  /**
   * Sendet Event an alle verbundenen Clients
   */
  private broadcastEvent(event: FileEvent): void {
    for (const client of this.clients) {
      try {
        client.send(event);
      } catch (error) {
        console.warn(`[FileWatcher] Failed to send to client ${client.id}:`, error);
        this.clients.delete(client);
      }
    }
  }

  /**
   * Stoppt Watching für einen spezifischen Pfad
   */
  private stopWatchingPath(fullPath: string): void {
    const watcher = this.watchers.get(fullPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(fullPath);
    }
  }

  /**
   * Registriert einen neuen Client
   */
  public subscribe(client: Client): () => void {
    this.clients.add(client);
    console.log(`[FileWatcher] Client subscribed: ${client.id} (${this.clients.size} total)`);

    // Return unsubscribe function
    return () => {
      this.clients.delete(client);
      console.log(`[FileWatcher] Client unsubscribed: ${client.id} (${this.clients.size} remaining)`);
    };
  }

  /**
   * Stoppt alle Watcher
   */
  public stop(): void {
    for (const [path, watcher] of this.watchers) {
      watcher.close();
      console.log(`[FileWatcher] Stopped watching: ${path}`);
    }
    this.watchers.clear();
    this.clients.clear();
    this.isWatching = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    console.log('[FileWatcher] Stopped all watchers');
  }

  /**
   * Force refresh - invalideert Cache und benachrichtigt Clients
   */
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

// Singleton-Instanz
let fileWatcherInstance: FileWatcherService | null = null;

export function getFileWatcher(): FileWatcherService {
  if (!fileWatcherInstance) {
    fileWatcherInstance = new FileWatcherService();
  }
  return fileWatcherInstance;
}

export type { FileEvent, FileEventType };
