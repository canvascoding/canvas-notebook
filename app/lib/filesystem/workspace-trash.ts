import 'server-only';

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { and, eq, lte } from 'drizzle-orm';

import { db } from '@/app/lib/db';
import { workspaceTrashEntries } from '@/app/lib/db/schema';
import { resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';
import { ensureWorkspaceRoot, resolveExistingWorkspacePath, resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const DEFAULT_WORKSPACE_TRASH_RETENTION_DAYS = 30;

export type WorkspaceTrashStatus = 'trashed' | 'restored' | 'purged';
export type WorkspaceTrashItemType = 'file' | 'directory' | 'other';

export interface WorkspaceTrashEntry {
  id: string;
  organizationId: string | null;
  workspaceId: string;
  workspaceType: string;
  ownerUserId: string | null;
  originalPath: string;
  trashRelativePath: string;
  entryName: string;
  itemType: WorkspaceTrashItemType;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
  status: WorkspaceTrashStatus;
  deletedByUserId: string | null;
  restoredByUserId: string | null;
  purgedByUserId: string | null;
  deletedAt: Date;
  expiresAt: Date;
  restoredAt: Date | null;
  purgedAt: Date | null;
  metadataJson: string | null;
}

export interface TrashWorkspacePathsResult {
  trashed: WorkspaceTrashEntry[];
  failed: { path: string; error: string }[];
}

export interface PurgeWorkspaceTrashResult {
  purged: string[];
  failed: { id: string; error: string }[];
}

interface PathSummary {
  itemType: WorkspaceTrashItemType;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
}

function retentionDays(): number {
  const configured = Number.parseInt(process.env.WORKSPACE_TRASH_RETENTION_DAYS || '', 10);
  if (Number.isFinite(configured) && configured > 0 && configured <= 3650) return configured;
  return DEFAULT_WORKSPACE_TRASH_RETENTION_DAYS;
}

function expiresAtFrom(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + retentionDays() * 24 * 60 * 60 * 1000);
}

function normalizeOriginalPath(workspace: WorkspaceContext, userPath: string): string {
  const relativePath = resolveWorkspacePath(workspace, userPath).relativePath;
  if (relativePath === '.') {
    throw new Error('Workspace root cannot be moved to trash.');
  }
  return relativePath;
}

function safeTrashSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function isSameOrDescendantPath(candidate: string, parentPath: string): boolean {
  return candidate === parentPath || candidate.startsWith(`${parentPath}/`);
}

function dedupeNestedPaths(workspace: WorkspaceContext, paths: string[]): { requested: string; originalPath: string }[] {
  const normalized = paths.map((requested) => ({
    requested,
    originalPath: normalizeOriginalPath(workspace, requested),
  }));
  normalized.sort((a, b) => a.originalPath.localeCompare(b.originalPath));

  const selected: { requested: string; originalPath: string }[] = [];
  for (const candidate of normalized) {
    if (selected.some((existing) => isSameOrDescendantPath(candidate.originalPath, existing.originalPath))) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

function trashRootForWorkspace(workspace: WorkspaceContext): string {
  const scope = workspace.workspaceType === 'personal' ? 'personal' : workspace.workspaceType;
  return path.join(
    resolveWorkspaceDataRoot(),
    '.trash',
    'workspaces',
    safeTrashSegment(scope, 'workspace'),
    safeTrashSegment(workspace.organizationId, 'no-org'),
    safeTrashSegment(workspace.workspaceId, 'legacy'),
  );
}

function trashRelativePathFor(workspace: WorkspaceContext, entryId: string, originalPath: string): string {
  const scope = workspace.workspaceType === 'personal' ? 'personal' : workspace.workspaceType;
  return path.posix.join(
    '.trash',
    'workspaces',
    safeTrashSegment(scope, 'workspace'),
    safeTrashSegment(workspace.organizationId, 'no-org'),
    safeTrashSegment(workspace.workspaceId, 'legacy'),
    entryId,
    path.posix.basename(originalPath),
  );
}

function absoluteDataPath(relativePath: string): string {
  const dataRoot = path.resolve(resolveWorkspaceDataRoot());
  const target = path.resolve(dataRoot, relativePath);
  if (target !== dataRoot && !target.startsWith(`${dataRoot}${path.sep}`)) {
    throw new Error('Trash path resolves outside data root.');
  }
  return target;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function movePath(sourcePath: string, destinationPath: string, recursive: boolean): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')) {
      throw error;
    }
    await fs.cp(sourcePath, destinationPath, { recursive, force: false, errorOnExist: true });
    await fs.rm(sourcePath, { recursive, force: false });
  }
}

async function summarizePath(targetPath: string): Promise<PathSummary> {
  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    return {
      itemType: stats.isFile() ? 'file' : 'other',
      sizeBytes: stats.size,
      fileCount: stats.isFile() ? 1 : 0,
      directoryCount: 0,
    };
  }

  let sizeBytes = 0;
  let fileCount = 0;
  let directoryCount = 1;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const child = await summarizePath(path.join(targetPath, entry.name));
    sizeBytes += child.sizeBytes;
    fileCount += child.fileCount;
    directoryCount += child.directoryCount;
  }

  return { itemType: 'directory', sizeBytes, fileCount, directoryCount };
}

function mapTrashRow(row: typeof workspaceTrashEntries.$inferSelect): WorkspaceTrashEntry {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    workspaceType: row.workspaceType,
    ownerUserId: row.ownerUserId,
    originalPath: row.originalPath,
    trashRelativePath: row.trashRelativePath,
    entryName: row.entryName,
    itemType: row.itemType as WorkspaceTrashItemType,
    sizeBytes: row.sizeBytes,
    fileCount: row.fileCount,
    directoryCount: row.directoryCount,
    status: row.status as WorkspaceTrashStatus,
    deletedByUserId: row.deletedByUserId,
    restoredByUserId: row.restoredByUserId,
    purgedByUserId: row.purgedByUserId,
    deletedAt: row.deletedAt,
    expiresAt: row.expiresAt,
    restoredAt: row.restoredAt,
    purgedAt: row.purgedAt,
    metadataJson: row.metadataJson,
  };
}

export async function trashWorkspacePaths(params: {
  workspace: WorkspaceContext;
  paths: string[];
  deletedByUserId: string;
  now?: Date;
}): Promise<TrashWorkspacePathsResult> {
  await ensureWorkspaceRoot(params.workspace);
  const now = params.now ?? new Date();
  const expiresAt = expiresAtFrom(now);
  const result: TrashWorkspacePathsResult = { trashed: [], failed: [] };

  let candidates: { requested: string; originalPath: string }[];
  try {
    candidates = dedupeNestedPaths(params.workspace, params.paths);
  } catch (error) {
    return {
      trashed: [],
      failed: params.paths.map((candidate) => ({
        path: candidate,
        error: error instanceof Error ? error.message : 'Invalid path',
      })),
    };
  }

  for (const candidate of candidates) {
    try {
      const sourcePath = await resolveExistingWorkspacePath(params.workspace, candidate.originalPath);
      const summary = await summarizePath(sourcePath);
      const id = `trash-${randomUUID()}`;
      const trashRelativePath = trashRelativePathFor(params.workspace, id, candidate.originalPath);
      const trashPath = absoluteDataPath(trashRelativePath);
      await fs.mkdir(trashRootForWorkspace(params.workspace), { recursive: true });
      await movePath(sourcePath, trashPath, summary.itemType === 'directory');

      const rows = await db.insert(workspaceTrashEntries).values({
        id,
        organizationId: params.workspace.organizationId ?? null,
        workspaceId: params.workspace.workspaceId,
        workspaceType: params.workspace.workspaceType,
        ownerUserId: params.workspace.ownerUserId ?? null,
        originalPath: candidate.originalPath,
        trashRelativePath,
        entryName: path.posix.basename(candidate.originalPath),
        itemType: summary.itemType,
        sizeBytes: summary.sizeBytes,
        fileCount: summary.fileCount,
        directoryCount: summary.directoryCount,
        status: 'trashed',
        deletedByUserId: params.deletedByUserId,
        deletedAt: now,
        expiresAt,
        metadataJson: JSON.stringify({
          retentionDays: retentionDays(),
          workspaceType: params.workspace.workspaceType,
          requestedPath: candidate.requested,
        }),
      }).returning();

      result.trashed.push(mapTrashRow(rows[0]));
    } catch (error) {
      result.failed.push({
        path: candidate.requested,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return result;
}

export async function listWorkspaceTrashEntries(params: {
  workspace: WorkspaceContext;
  status?: WorkspaceTrashStatus;
}): Promise<WorkspaceTrashEntry[]> {
  const status = params.status ?? 'trashed';
  const rows = await db.select()
    .from(workspaceTrashEntries)
    .where(and(
      eq(workspaceTrashEntries.workspaceId, params.workspace.workspaceId),
      eq(workspaceTrashEntries.status, status),
    ));
  return rows.map(mapTrashRow);
}

export async function restoreWorkspaceTrashEntry(params: {
  workspace: WorkspaceContext;
  entryId: string;
  restoredByUserId: string;
  overwrite?: boolean;
  now?: Date;
}): Promise<WorkspaceTrashEntry> {
  const row = await db.query.workspaceTrashEntries.findFirst({
    where: and(
      eq(workspaceTrashEntries.id, params.entryId),
      eq(workspaceTrashEntries.workspaceId, params.workspace.workspaceId),
      eq(workspaceTrashEntries.status, 'trashed'),
    ),
  });
  if (!row) throw new Error('Trash entry not found.');

  const trashPath = absoluteDataPath(row.trashRelativePath);
  const restoreResolution = resolveWorkspacePath(params.workspace, row.originalPath);
  const destinationPath = restoreResolution.absolutePath;
  const destinationExists = await pathExists(destinationPath);
  if (destinationExists && params.overwrite !== true) {
    throw new Error(`Restore target already exists: ${row.originalPath}`);
  }

  if (destinationExists) {
    await fs.rm(destinationPath, { recursive: true, force: true });
  }

  await movePath(trashPath, destinationPath, row.itemType === 'directory');
  const restoredAt = params.now ?? new Date();
  const restoredRows = await db.update(workspaceTrashEntries)
    .set({
      status: 'restored',
      restoredByUserId: params.restoredByUserId,
      restoredAt,
    })
    .where(eq(workspaceTrashEntries.id, row.id))
    .returning();

  return mapTrashRow(restoredRows[0]);
}

export async function purgeExpiredWorkspaceTrash(params: {
  now?: Date;
  limit?: number;
  purgedByUserId?: string | null;
} = {}): Promise<PurgeWorkspaceTrashResult> {
  const now = params.now ?? new Date();
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
  const rows = await db.select()
    .from(workspaceTrashEntries)
    .where(and(
      eq(workspaceTrashEntries.status, 'trashed'),
      lte(workspaceTrashEntries.expiresAt, now),
    ))
    .limit(limit);

  const result: PurgeWorkspaceTrashResult = { purged: [], failed: [] };
  for (const row of rows) {
    try {
      await fs.rm(absoluteDataPath(row.trashRelativePath), { recursive: true, force: true });
      await db.update(workspaceTrashEntries)
        .set({
          status: 'purged',
          purgedAt: now,
          purgedByUserId: params.purgedByUserId ?? null,
        })
        .where(eq(workspaceTrashEntries.id, row.id));
      result.purged.push(row.id);
    } catch (error) {
      result.failed.push({
        id: row.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return result;
}
