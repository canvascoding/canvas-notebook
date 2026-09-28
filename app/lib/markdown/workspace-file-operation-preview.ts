import fs from 'node:fs/promises';
import path from 'node:path';

import { filesystemFileVersion } from '@/app/lib/filesystem/file-version';
import {
  listDirectory,
  readFile,
  resolveExistingWorkspacePath,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';

import {
  createWorkspaceFileOperationPlan,
  type WorkspaceFileOperationPlanRequest,
  type WorkspaceFileOperationPreview,
  type WorkspacePlannerEntry,
  type WorkspacePlannerSnapshot,
} from './workspace-file-operation-planner';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';

export class WorkspacePreviewStaleError extends Error {
  constructor() {
    super('Workspace files changed while building the preview. Retry the dry run.');
    this.name = 'WorkspacePreviewStaleError';
  }
}

export class WorkspacePreviewUnavailableError extends Error {
  constructor() {
    super('A workspace path could not be read for the preview. Check access and retry.');
    this.name = 'WorkspacePreviewUnavailableError';
  }
}

export class WorkspacePreviewBlockedError extends Error {
  constructor() {
    super('The preview contains unresolved file or link changes. Review it before retrying.');
    this.name = 'WorkspacePreviewBlockedError';
  }
}

export function assertFreshWorkspaceFileOperationPlan(
  plan: WorkspaceFileOperationPreview,
  expectedPlanId: string,
): void {
  if (plan.planId !== expectedPlanId) throw new WorkspacePreviewStaleError();
  if (plan.readiness !== 'ready') throw new WorkspacePreviewBlockedError();
}

async function workspaceRootVersion(options: WorkspaceFileOperationOptions): Promise<string> {
  try {
    const rootPath = await resolveExistingWorkspacePath('.', options);
    return filesystemFileVersion(await fs.stat(rootPath));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new WorkspacePreviewStaleError();
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new WorkspacePreviewUnavailableError();
    throw error;
  }
}

async function assertSnapshotVersions(
  entries: readonly WorkspacePlannerEntry[],
  options: WorkspaceFileOperationOptions,
): Promise<void> {
  try {
    for (const entry of entries) {
      const fullPath = await resolveExistingWorkspacePath(entry.path, options);
      const stats = await fs.stat(fullPath);
      if (filesystemFileVersion(stats) !== entry.identity) throw new WorkspacePreviewStaleError();
    }
  } catch (error) {
    if (error instanceof WorkspacePreviewStaleError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new WorkspacePreviewStaleError();
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new WorkspacePreviewUnavailableError();
    throw error;
  }
}

/** A read-only, uncached snapshot. No content is read from binary targets. */
export async function buildWorkspacePlannerSnapshot(
  workspaceId: string,
  options: WorkspaceFileOperationOptions,
): Promise<WorkspacePlannerSnapshot> {
  const entries: WorkspacePlannerEntry[] = [];
  const pendingDirectories = ['.'];
  try {
    const rootVersion = await workspaceRootVersion(options);
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop()!;
      const children = await listDirectory(directory, { ...options, includeMetadata: false, includeSymlinks: false });
      for (const child of children) {
        const fullPath = await resolveExistingWorkspacePath(child.path, options);
        const stats = await fs.stat(fullPath);
        const entry: WorkspacePlannerEntry = {
          identity: filesystemFileVersion(stats),
          kind: child.type,
          path: child.path,
        };
        if (child.type === 'directory') {
          pendingDirectories.push(child.path);
        } else if (/\.(?:md|markdown)$/iu.test(child.path)) {
          if (stats.size > MAX_INDEXED_MARKDOWN_BYTES) {
            entry.omissionReason = 'source-too-large';
          } else {
            try {
              const bytes = await readFile(child.path, options);
              const afterRead = await fs.stat(fullPath);
              if (filesystemFileVersion(stats) !== filesystemFileVersion(afterRead)) throw new WorkspacePreviewStaleError();
              if (bytes.byteLength > MAX_INDEXED_MARKDOWN_BYTES) entry.omissionReason = 'source-too-large';
              else entry.markdownContent = bytes.toString('utf8');
            } catch (error) {
              if (error instanceof WorkspacePreviewStaleError) throw error;
              entry.omissionReason = 'source-unreadable';
            }
          }
        }
        entries.push(entry);
      }
    }
    await assertSnapshotVersions(entries, options);
    if (await workspaceRootVersion(options) !== rootVersion) throw new WorkspacePreviewStaleError();
  } catch (error) {
    if (error instanceof WorkspacePreviewStaleError) throw error;
    if (error instanceof Error && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new WorkspacePreviewStaleError();
    }
    if (error instanceof Error && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new WorkspacePreviewUnavailableError();
    }
    throw error;
  }
  return { workspaceId, entries };
}

export async function buildWorkspaceFileOperationPreview(input: {
  kind: WorkspaceFileOperationPlanRequest['kind'];
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  sourceOptions: WorkspaceFileOperationOptions;
  destinationOptions: WorkspaceFileOperationOptions;
  selections: WorkspaceFileOperationPlanRequest['selections'];
  renameOnCollision?: boolean;
}): Promise<WorkspaceFileOperationPreview> {
  const source = await buildWorkspacePlannerSnapshot(input.sourceWorkspaceId, input.sourceOptions);
  const sourceRootVersion = await workspaceRootVersion(input.sourceOptions);
  const destination = input.sourceWorkspaceId === input.destinationWorkspaceId
    ? source
    : await buildWorkspacePlannerSnapshot(input.destinationWorkspaceId, input.destinationOptions);
  if (source !== destination) {
    await assertSnapshotVersions(source.entries, input.sourceOptions);
    if (await workspaceRootVersion(input.sourceOptions) !== sourceRootVersion) throw new WorkspacePreviewStaleError();
  }
  const occupied = new Set(destination.entries.map((entry) => entry.path));
  const selections = input.kind === 'copy' && input.renameOnCollision
    ? input.selections.map((selection) => {
      const extension = path.posix.extname(selection.destinationPath);
      const stem = selection.destinationPath.slice(0, -extension.length || undefined);
      let destinationPath = selection.destinationPath;
      let index = 1;
      while (occupied.has(destinationPath)) {
        destinationPath = `${stem} (${index})${extension}`;
        index += 1;
      }
      occupied.add(destinationPath);
      return { ...selection, destinationPath };
    })
    : input.selections;
  return createWorkspaceFileOperationPlan({
    kind: input.kind,
    sourceWorkspaceId: input.sourceWorkspaceId,
    destinationWorkspaceId: input.destinationWorkspaceId,
    selections,
    snapshots: source === destination ? [source] : [source, destination],
  });
}
