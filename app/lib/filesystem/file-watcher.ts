import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs';
import path from 'path';
import { clearSubtreeCache } from '@/app/lib/utils/file-tree-cache';
import { invalidateFileReferenceCache } from '@/app/lib/filesystem/file-reference-cache';
import { validatePath } from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

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

export type FileEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface FileEvent {
  type: FileEventType;
  workspaceId: string;
  path: string;
  relativePath: string;
  dir: string;
  timestamp: number;
}

export interface FileWatcherServerClient {
  id: string;
  workspaceId: string;
  workspace: WorkspaceContext;
  send: (event: FileEvent) => void;
}

interface Subscription {
  workspace: WorkspaceContext;
  clients: Set<string>;
}

export interface WorkspaceFileMutation {
  workspace: WorkspaceContext;
  type: FileEventType;
  relativePath: string;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '') || '.';
}

function getParentDirectory(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === '.' || !normalized.includes('/')) return '.';
  return normalized.slice(0, normalized.lastIndexOf('/')) || '.';
}

function subscriptionKey(workspaceId: string, dirPath: string): string {
  return `${workspaceId}\0${dirPath}`;
}

export class FileWatcherService {
  private watchers = new Map<string, FSWatcher>();
  private clients = new Map<string, FileWatcherServerClient>();
  private subscriptions = new Map<string, Subscription>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvents: FileEvent[] = [];
  private readonly debounceDelay = 500;
  private clientLastActive = new Map<string, number>();
  private staleCheckInterval: NodeJS.Timeout | null = null;
  private readonly STALE_TIMEOUT_MS = 90_000;

  constructor() {
    this.startStaleCheck();
  }

  public subscribe(client: FileWatcherServerClient): () => void {
    this.clients.set(client.id, client);
    this.touchClient(client.id);
    void fs.mkdir(client.workspace.rootPath, { recursive: true }).then(() => {
      void this.subscribeDir(client.id, '.');
    }).catch((error) => {
      console.error('[FileWatcher] Failed to initialize workspace directory:', error);
    });

    return () => {
      this.removeClient(client.id);
    };
  }

  public touchClient(clientId: string): boolean {
    if (!this.clients.has(clientId)) return false;
    this.clientLastActive.set(clientId, Date.now());
    return true;
  }

  public async subscribeDir(clientId: string, dirPath: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    const normalizedDir = normalizeRelativePath(dirPath);
    if (this.shouldIgnore(normalizedDir)) return;

    let fullPath: string;
    try {
      fullPath = await this.toValidatedFullPath(normalizedDir, client.workspace);
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) return;
    } catch {
      return;
    }

    const subscription = this.getSubscriptionForClient(client, normalizedDir);
    if (subscription.clients.has(clientId)) return;
    subscription.clients.add(clientId);

    if (subscription.clients.size === 1) {
      await this.startWatchingDir(subscription.workspace, normalizedDir);
    }
  }

  public unsubscribeDir(clientId: string, dirPath: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const normalizedDir = normalizeRelativePath(dirPath);
    const key = subscriptionKey(client.workspaceId, normalizedDir);
    const subscription = this.subscriptions.get(key);
    if (!subscription) return;

    subscription.clients.delete(clientId);
    if (subscription.clients.size === 0) {
      this.subscriptions.delete(key);
      this.stopWatchingPath(key);
    }
  }

  public unsubscribeAll(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    for (const [key, subscription] of this.subscriptions) {
      if (!subscription.clients.delete(clientId) || subscription.clients.size > 0) continue;
      this.subscriptions.delete(key);
      this.stopWatchingPath(key);
    }
  }

  public async syncDirs(clientId: string, dirPaths: string[]): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.touchClient(clientId);

    const current = new Set<string>();
    for (const [key, subscription] of this.subscriptions) {
      if (key.startsWith(`${client.workspaceId}\0`) && subscription.clients.has(clientId)) {
        current.add(key.slice(client.workspaceId.length + 1));
      }
    }

    const desired = new Set(dirPaths.map(normalizeRelativePath));
    desired.add('.');

    await Promise.all(
      Array.from(desired)
        .filter((dir) => !current.has(dir))
        .map((dir) => this.subscribeDir(clientId, dir)),
    );

    for (const dir of current) {
      if (!desired.has(dir)) this.unsubscribeDir(clientId, dir);
    }
  }

  public getSubscribedDirs(workspaceId: string): string[] {
    return Array.from(this.subscriptions.entries())
      .filter(([key]) => key.startsWith(`${workspaceId}\0`))
      .map(([key]) => key.slice(workspaceId.length + 1));
  }

  public publishMutation(mutation: WorkspaceFileMutation): void {
    const event = this.createEvent(mutation);
    this.invalidateAndBroadcast(event, mutation.workspace);
  }

  private getSubscriptionForClient(client: FileWatcherServerClient, dirPath: string): Subscription {
    const key = subscriptionKey(client.workspaceId, dirPath);
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = {
        workspace: client.workspace,
        clients: new Set(),
      };
      this.subscriptions.set(key, subscription);
    }
    return subscription;
  }

  private async startWatchingDir(workspace: WorkspaceContext, relativeDir: string): Promise<void> {
    const key = subscriptionKey(workspace.workspaceId, relativeDir);
    if (this.watchers.has(key)) return;

    const fullPath = this.toFullPath(relativeDir, workspace);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) return;
    } catch {
      return;
    }

    try {
      const watcher = fsWatch(fullPath, { recursive: false }, (eventType: 'rename' | 'change', filename: string | null) => {
        if (!filename) return;

        const relativeFilePath = relativeDir === '.'
          ? filename.toString()
          : path.posix.join(relativeDir, filename.toString());
        const fullFilePath = path.join(fullPath, filename.toString());

        void this.determineEventType(eventType, relativeFilePath, fullFilePath, workspace).then((event) => {
          if (event) this.queueEvent(event);
        });
      });

      this.watchers.set(key, watcher);
    } catch (error) {
      console.warn('[FileWatcher] Failed to watch directory:', relativeDir, error);
    }
  }

  private async determineEventType(
    eventType: 'rename' | 'change',
    relativePath: string,
    fullPath: string,
    workspace: WorkspaceContext,
  ): Promise<FileEvent | null> {
    const normalizedPath = normalizeRelativePath(relativePath);
    const dir = getParentDirectory(normalizedPath);

    if (eventType === 'change') {
      return {
        type: 'change',
        workspaceId: workspace.workspaceId,
        path: fullPath,
        relativePath: normalizedPath,
        dir,
        timestamp: Date.now(),
      };
    }

    try {
      const stats = await fs.stat(fullPath);
      const isDir = stats.isDirectory();
      const watcherKey = subscriptionKey(workspace.workspaceId, normalizedPath);
      if (isDir && !this.watchers.has(watcherKey)) {
        const childSubscription = this.subscriptions.get(watcherKey);
        if (childSubscription?.clients.size) {
          await this.startWatchingDir(workspace, normalizedPath);
        }
      }
      return {
        type: isDir ? 'addDir' : 'add',
        workspaceId: workspace.workspaceId,
        path: fullPath,
        relativePath: normalizedPath,
        dir,
        timestamp: Date.now(),
      };
    } catch {
      const watcherKey = subscriptionKey(workspace.workspaceId, normalizedPath);
      const wasDir = this.watchers.has(watcherKey);
      if (wasDir) this.stopWatchingPath(watcherKey);
      return {
        type: wasDir ? 'unlinkDir' : 'unlink',
        workspaceId: workspace.workspaceId,
        path: fullPath,
        relativePath: normalizedPath,
        dir,
        timestamp: Date.now(),
      };
    }
  }

  private shouldIgnore(filePath: string): boolean {
    return filePath.split(/[\\/]/).some((part) => IGNORED_PATTERNS.includes(part));
  }

  private queueEvent(event: FileEvent): void {
    this.pendingEvents.push(event);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushEvents(), this.debounceDelay);
  }

  private flushEvents(): void {
    if (this.pendingEvents.length === 0) return;

    const uniqueEvents = new Map<string, FileEvent>();
    for (const event of this.pendingEvents) {
      uniqueEvents.set(`${event.workspaceId}\0${event.relativePath}`, event);
    }

    for (const event of uniqueEvents.values()) {
      const subscription = this.subscriptions.get(subscriptionKey(event.workspaceId, event.dir));
      const workspace = subscription?.workspace;
      if (workspace) this.invalidateAndBroadcast(event, workspace);
    }

    this.pendingEvents = [];
  }

  private invalidateAndBroadcast(event: FileEvent, workspace: WorkspaceContext): void {
    clearSubtreeCache(event.dir, workspace.workspaceId);
    invalidateFileReferenceCache({ workspace });
    this.broadcastEvent(event);
  }

  private broadcastEvent(event: FileEvent): void {
    for (const [clientId, client] of this.clients) {
      if (client.workspaceId !== event.workspaceId) continue;
      try {
        client.send(event);
        this.touchClient(clientId);
      } catch (error) {
        console.warn(`[FileWatcher] Failed to send to client ${clientId}:`, error);
        this.removeClient(clientId);
      }
    }
  }

  private createEvent(mutation: WorkspaceFileMutation): FileEvent {
    const relativePath = normalizeRelativePath(mutation.relativePath);
    return {
      type: mutation.type,
      workspaceId: mutation.workspace.workspaceId,
      path: this.toFullPath(relativePath, mutation.workspace),
      relativePath,
      dir: getParentDirectory(relativePath),
      timestamp: Date.now(),
    };
  }

  private stopWatchingPath(key: string): void {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    watcher.close();
    this.watchers.delete(key);
  }

  private toFullPath(relativePath: string, workspace: WorkspaceContext): string {
    return validatePath(relativePath, { workspace });
  }

  private async toValidatedFullPath(relativePath: string, workspace: WorkspaceContext): Promise<string> {
    await fs.mkdir(workspace.rootPath, { recursive: true });
    const candidatePath = this.toFullPath(relativePath, workspace);
    const realBase = await fs.realpath(this.toFullPath('.', workspace));
    const realPath = await fs.realpath(candidatePath);
    if (realPath !== realBase && !realPath.startsWith(`${realBase}${path.sep}`)) {
      throw new Error('Invalid path: directory traversal attempt detected');
    }
    return realPath;
  }

  private startStaleCheck(): void {
    if (this.staleCheckInterval) return;
    this.staleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [clientId, lastActive] of this.clientLastActive) {
        if (now - lastActive > this.STALE_TIMEOUT_MS) this.removeClient(clientId);
      }
    }, 15_000);
  }

  private removeClient(clientId: string): void {
    this.unsubscribeAll(clientId);
    this.clients.delete(clientId);
    this.clientLastActive.delete(clientId);
  }

  public stop(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.clients.clear();
    this.clientLastActive.clear();
    this.subscriptions.clear();
    if (this.staleCheckInterval) clearInterval(this.staleCheckInterval);
    this.staleCheckInterval = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }
}

let fileWatcherInstance: FileWatcherService | null = null;

export function getFileWatcher(): FileWatcherService {
  if (!fileWatcherInstance) fileWatcherInstance = new FileWatcherService();
  return fileWatcherInstance;
}

export function publishWorkspaceFileMutation(mutation: WorkspaceFileMutation): void {
  const relativePath = normalizeRelativePath(mutation.relativePath);
  if (fileWatcherInstance) {
    fileWatcherInstance.publishMutation({ ...mutation, relativePath });
    return;
  }

  clearSubtreeCache(getParentDirectory(relativePath), mutation.workspace.workspaceId);
  invalidateFileReferenceCache({ workspace: mutation.workspace });
}
