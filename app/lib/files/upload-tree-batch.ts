import type { FileNode } from './types';
import type { WorkspaceUploadCommit } from './upload-result';
import { getParentDirectories } from './path-utils';

/** HTTP results may arrive after a newer watcher event. Keep a bounded event history. */
export class UploadVersionGuard {
  private sequence = 0;
  private versions = new Map<string, { sequence: number; version?: string }>();
  snapshot(): number { return this.sequence; }
  observe(workspaceId: string | null, path: string, version?: string): void {
    const key = `${workspaceId}\0${path}`;
    this.versions.delete(key);
    this.versions.set(key, { sequence: ++this.sequence, version });
    if (this.versions.size > 4096) this.versions.delete(this.versions.keys().next().value!);
  }
  accepts(workspaceId: string | null, result: WorkspaceUploadCommit, since: number): boolean {
    for (const parent of getParentDirectories(`${result.targetPath}/_`)) {
      const observed = this.versions.get(`${workspaceId}\0${parent}`);
      if (observed && observed.sequence > since && (parent !== result.targetPath || !result.fileVersion || observed.version !== result.fileVersion)) return false;
    }
    const current = this.versions.get(`${workspaceId}\0${result.targetPath}`);
    // If an entry was evicted, prefer an authoritative directory read.
    return Boolean(current) || this.sequence === since;
  }
}

export const uploadVersionGuard = new UploadVersionGuard();

/** One batch survives all individual image conversions in an upload job. */
export class UploadTreeBatch {
  private pending = new Map<string, WorkspaceUploadCommit>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly directories = new Set<string>();
  constructor(
    private readonly accepts: (result: WorkspaceUploadCommit) => boolean,
    private readonly publish: (nodes: FileNode[], directories: string[]) => void,
    private readonly intervalMs = 500,
  ) {}
  add(result: WorkspaceUploadCommit): void {
    this.pending.set(result.targetPath, result);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const nodes: FileNode[] = [];
    const directories = new Set<string>();
    for (const result of this.pending.values()) {
      for (const parent of ['.', ...getParentDirectories(result.targetPath)]) {
        this.directories.add(parent);
        directories.add(parent);
      }
      if (result.node && this.accepts(result)) nodes.push(result.node);
    }
    this.pending.clear();
    if (directories.size) this.publish(nodes, [...directories]);
  }
}
