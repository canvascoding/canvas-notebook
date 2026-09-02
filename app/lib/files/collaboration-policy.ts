import 'server-only';

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { workspaceSupportsRealtimeTextCollaboration } from '@/app/lib/collaboration/capabilities';
import {
  appendFileRevision as appendPostgresFileRevision,
  ensureActiveFileLineage as ensurePostgresActiveFileLineage,
  ensureCollaborationDocument as ensurePostgresCollaborationDocument,
  expireFileLocksForPath as expirePostgresFileLocksForPath,
  getActiveCollaborationDocument as getPostgresCollaborationDocument,
  getActiveFileLock as getPostgresActiveFileLock,
  getFileLockById as getPostgresFileLockById,
  getLatestFileRevision as getPostgresLatestFileRevision,
  getLatestFileRevisionForLineage as getPostgresLatestFileRevisionForLineage,
  insertFileLock as insertPostgresFileLock,
  lockFileCollaborationPaths,
  refreshFileLock as refreshPostgresFileLock,
  updateCollaborationDocumentCheckpoint as updatePostgresCollaborationDocumentCheckpoint,
  updateFileLockStatus as updatePostgresFileLockStatus,
  withFileCollaborationTransaction,
  type FileCollaborationTransaction,
} from '@/app/lib/files/collaboration-repository';
import { openOrganizationBootstrapDatabase } from '@/app/lib/organization/bootstrap';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type FileCollaborationStrategy = 'crdt_text' | 'excalidraw_scene' | 'revision_check' | 'exclusive_lock';
export type FileActorType = 'user' | 'agent' | 'automation' | 'system';
export type FileLockType = 'edit' | 'upload' | 'agent_write';
export type FileLockStatus = 'active' | 'released' | 'expired' | 'force_released';

export interface FileRevisionRecord {
  id: string;
  lineageId: string | null;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  path: string;
  contentHash: string;
  sizeBytes: number;
  createdByUserId: string | null;
  createdByActorType: FileActorType;
  sourceSessionId: string | null;
  baseRevisionId: string | null;
  createdAt: number;
}

export interface FileLockRecord {
  id: string;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  path: string;
  revisionId: string | null;
  lockedByUserId: string | null;
  lockedBySessionId: string | null;
  lockType: FileLockType;
  status: FileLockStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CollaborationDocumentRecord {
  id: string;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  path: string;
  provider: 'yjs' | 'excalidraw';
  stateVersion: number;
  snapshotRevisionId: string | null;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

export interface FileCollaborationState {
  path: string;
  strategy: FileCollaborationStrategy;
  crdtCapable: boolean;
  sceneCapable: boolean;
  lockRequired: boolean;
  requiresRevisionCheck: boolean;
  latestRevision: FileRevisionRecord | null;
  activeLock: FileLockRecord | null;
  document: CollaborationDocumentRecord | null;
}

export class FileCollaborationPolicyError extends Error {
  readonly code:
    | 'FILE_LOCKED'
    | 'FILE_LOCK_REQUIRED'
    | 'FILE_REVISION_ID_CONFLICT'
    | 'FILE_LOCK_NOT_FOUND'
    | 'FILE_LOCK_PERMISSION_DENIED'
    | 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED';
  readonly status: 403 | 404 | 409 | 423;
  readonly path: string;
  readonly currentRevisionId: string | null;
  readonly baseRevisionId: string | null;
  readonly activeLock: FileLockRecord | null;

  constructor(params: {
    code: FileCollaborationPolicyError['code'];
    status: FileCollaborationPolicyError['status'];
    message: string;
    path: string;
    currentRevisionId?: string | null;
    baseRevisionId?: string | null;
    activeLock?: FileLockRecord | null;
  }) {
    super(params.message);
    this.name = 'FileCollaborationPolicyError';
    this.code = params.code;
    this.status = params.status;
    this.path = params.path;
    this.currentRevisionId = params.currentRevisionId ?? null;
    this.baseRevisionId = params.baseRevisionId ?? null;
    this.activeLock = params.activeLock ?? null;
  }
}

const CRDT_TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const EXCALIDRAW_EXTENSIONS = new Set(['excalidraw']);
const EXCLUSIVE_LOCK_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'mp4',
  'webm',
  'ogv',
  'mov',
  'wav',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
  'zip',
  'tar',
  'gz',
  '7z',
]);

const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;
const MAX_LOCK_TTL_MS = 4 * 60 * 60 * 1000;

type Sqlite = InstanceType<typeof Database>;

type FileCollaborationLineageRow = {
  id: string;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  status: 'active' | 'archived';
  created_at: number;
  archived_at: number | null;
  trash_entry_id: string | null;
};

type FileCollaborationLineage = {
  id: string;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  path: string;
  status: 'active' | 'archived';
  createdAt: number;
  archivedAt: number | null;
  trashEntryId: string | null;
};

function normalizeWorkspacePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/')).replace(/^\/+/u, '');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) {
    throw new Error(`Invalid workspace file path: ${filePath}`);
  }
  return normalized;
}

function fileExtension(filePath: string): string {
  const base = path.posix.basename(filePath).toLowerCase();
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(dotIndex + 1) : '';
}

export function detectFileCollaborationStrategy(filePath: string): FileCollaborationStrategy {
  const extension = fileExtension(filePath);
  if (CRDT_TEXT_EXTENSIONS.has(extension)) return 'crdt_text';
  if (EXCALIDRAW_EXTENSIONS.has(extension)) return 'excalidraw_scene';
  if (EXCLUSIVE_LOCK_EXTENSIONS.has(extension)) return 'exclusive_lock';
  return 'revision_check';
}

export function workspaceRequiresCollaborationPolicy(workspace: WorkspaceContext): boolean {
  return workspace.workspaceType === 'organization' || workspace.workspaceType === 'team' || workspace.workspaceType === 'project';
}

function mapLineage(row: FileCollaborationLineageRow | undefined): FileCollaborationLineage | null {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    status: row.status,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    trashEntryId: row.trash_entry_id,
  };
}

function withCollaborationDatabase<T>(write: boolean, callback: (sqlite: Sqlite) => T): T {
  const sqlite = openOrganizationBootstrapDatabase();
  try {
    if (write) sqlite.exec('BEGIN IMMEDIATE');
    const result = callback(sqlite);
    if (write) sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    if (write && sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.close();
  }
}

function getActiveLineage(sqlite: Sqlite, workspaceId: string, filePath: string): FileCollaborationLineage | null {
  const row = sqlite.prepare(`
    SELECT *
    FROM file_collaboration_lineages
    WHERE workspace_id = ? AND path = ? AND status = 'active'
    LIMIT 1
  `).get(workspaceId, filePath) as FileCollaborationLineageRow | undefined;
  return mapLineage(row);
}

function createActiveLineage(
  sqlite: Sqlite,
  workspace: WorkspaceContext,
  filePath: string,
  nowMs: number,
): FileCollaborationLineage {
  const id = `file-lineage-${randomUUID()}`;
  sqlite.prepare(`
    INSERT INTO file_collaboration_lineages (
      id, workspace_id, workspace_type, path, status, created_at, archived_at, trash_entry_id
    )
    VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL)
  `).run(id, workspace.workspaceId, workspace.workspaceType, filePath, nowMs);

  const lineage = getActiveLineage(sqlite, workspace.workspaceId, filePath);
  if (!lineage) throw new Error(`Failed to create collaboration lineage for ${filePath}.`);
  return lineage;
}

function ensureActiveLineage(
  sqlite: Sqlite,
  workspace: WorkspaceContext,
  filePath: string,
  nowMs: number,
): FileCollaborationLineage {
  const existing = getActiveLineage(sqlite, workspace.workspaceId, filePath);
  if (existing) return existing;

  const lineage = createActiveLineage(sqlite, workspace, filePath, nowMs);
  // Adopt pre-lineage records exactly once. Their path was the only identity
  // available before file lineages were introduced.
  sqlite.prepare(`
    UPDATE file_revisions
    SET lineage_id = ?
    WHERE workspace_id = ? AND path = ? AND lineage_id IS NULL
  `).run(lineage.id, workspace.workspaceId, filePath);
  return lineage;
}

function pathScopeCondition(filePath: string): { exact: string; descendant: string } {
  return { exact: filePath, descendant: `${filePath}/%` };
}

function materializeLegacyLineagesInPathScope(
  sqlite: Sqlite,
  workspace: WorkspaceContext,
  filePath: string,
  nowMs: number,
): void {
  const scope = pathScopeCondition(filePath);
  const rows = sqlite.prepare(`
    SELECT DISTINCT path
    FROM file_revisions
    WHERE workspace_id = ?
      AND lineage_id IS NULL
      AND (path = ? OR path LIKE ?)
  `).all(workspace.workspaceId, scope.exact, scope.descendant) as Array<{ path: string }>;
  for (const row of rows) {
    ensureActiveLineage(sqlite, workspace, row.path, nowMs);
  }
}

function archivePathScope(
  sqlite: Sqlite,
  workspaceId: string,
  filePath: string,
  nowMs: number,
  trashEntryId: string | null = null,
): void {
  const scope = pathScopeCondition(filePath);
  sqlite.prepare(`
    UPDATE file_collaboration_lineages
    SET status = 'archived', archived_at = ?, trash_entry_id = ?
    WHERE workspace_id = ?
      AND status = 'active'
      AND (path = ? OR path LIKE ?)
  `).run(nowMs, trashEntryId, workspaceId, scope.exact, scope.descendant);
  sqlite.prepare(`
    UPDATE collaboration_documents
    SET status = 'archived', updated_at = ?
    WHERE workspace_id = ?
      AND status = 'active'
      AND (path = ? OR path LIKE ?)
  `).run(nowMs, workspaceId, scope.exact, scope.descendant);
  sqlite.prepare(`
    UPDATE file_locks
    SET status = 'released', updated_at = ?
    WHERE workspace_id = ?
      AND status = 'active'
      AND (path = ? OR path LIKE ?)
  `).run(nowMs, workspaceId, scope.exact, scope.descendant);
}

function remapActivePathScope(
  sqlite: Sqlite,
  table: 'file_collaboration_lineages' | 'collaboration_documents' | 'file_locks',
  workspaceId: string,
  oldPath: string,
  newPath: string,
): void {
  const scope = pathScopeCondition(oldPath);
  sqlite.prepare(`
    UPDATE ${table}
    SET path = ? || substr(path, length(?) + 1)
    WHERE workspace_id = ?
      AND status = 'active'
      AND (path = ? OR path LIKE ?)
  `).run(newPath, oldPath, workspaceId, scope.exact, scope.descendant);
}

function collaborationProviderForStrategy(
  workspace: WorkspaceContext,
  strategy: FileCollaborationStrategy,
): CollaborationDocumentRecord['provider'] | null {
  if (strategy === 'crdt_text' && workspaceSupportsRealtimeTextCollaboration(workspace)) {
    return 'yjs';
  }
  if (strategy === 'excalidraw_scene' && workspaceRequiresCollaborationPolicy(workspace)) {
    return 'excalidraw';
  }
  return null;
}

async function buildPostgresState(params: {
  transaction: FileCollaborationTransaction;
  workspace: WorkspaceContext;
  path: string;
  nowMs: number;
  latestRevision?: FileRevisionRecord | null;
  lineageId?: string | null;
  ensureDocument?: boolean;
}): Promise<FileCollaborationState> {
  const strategy = detectFileCollaborationStrategy(params.path);
  const requiresPolicy = workspaceRequiresCollaborationPolicy(params.workspace);
  const latestRevision = params.latestRevision ?? await getPostgresLatestFileRevision(
    params.transaction,
    params.workspace.workspaceId,
    params.path,
  );
  const activeLock = requiresPolicy
    ? await getPostgresActiveFileLock(params.transaction, params.workspace.workspaceId, params.path, params.nowMs)
    : null;
  const provider = collaborationProviderForStrategy(params.workspace, strategy);
  const crdtCapable = provider === 'yjs';
  const sceneCapable = provider === 'excalidraw';
  const document = provider
    ? params.ensureDocument
      ? await ensurePostgresCollaborationDocument(params.transaction, {
          id: `collab-doc-${randomUUID()}`,
          lineageId: params.lineageId ?? (() => {
            throw new Error(`Collaboration lineage is required for ${params.path}.`);
          })(),
          workspace: params.workspace,
          path: params.path,
          provider,
          snapshotRevisionId: latestRevision?.id ?? null,
          nowMs: params.nowMs,
        })
      : await getPostgresCollaborationDocument(
          params.transaction,
          params.workspace.workspaceId,
          params.path,
          provider,
        )
    : null;

  return {
    path: params.path,
    strategy,
    crdtCapable,
    sceneCapable,
    lockRequired: requiresPolicy && strategy === 'exclusive_lock',
    requiresRevisionCheck: requiresPolicy,
    latestRevision,
    activeLock,
    document,
  };
}

export async function getFileCollaborationState(params: {
  workspace: WorkspaceContext;
  path: string;
  ensureDocument?: boolean;
  nowMs?: number;
}): Promise<FileCollaborationState> {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();
  return withFileCollaborationTransaction(async (transaction) => {
    if (params.ensureDocument) {
      await lockFileCollaborationPaths(transaction, params.workspace.workspaceId, [normalizedPath]);
    }
    const lineage = params.ensureDocument
      ? await ensurePostgresActiveFileLineage(transaction, {
          id: `file-lineage-${randomUUID()}`,
          workspace: params.workspace,
          path: normalizedPath,
          nowMs,
        })
      : null;
    return buildPostgresState({
      transaction,
      workspace: params.workspace,
      path: normalizedPath,
      nowMs,
      latestRevision: lineage
        ? await getPostgresLatestFileRevisionForLineage(transaction, lineage.id)
        : undefined,
      lineageId: lineage?.id,
      ensureDocument: params.ensureDocument,
    });
  });
}

/**
 * Advances the file-facing collaboration projection only after the matching
 * Yjs sequence has been materialized as a verified file revision.
 */
export async function markCollaborationDocumentCheckpoint(params: {
  workspace: WorkspaceContext;
  path: string;
  documentId: string;
  stateVersion: number;
  snapshotRevisionId: string;
  nowMs?: number;
}): Promise<CollaborationDocumentRecord | null> {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();
  return withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, params.workspace.workspaceId, [normalizedPath]);
    return updatePostgresCollaborationDocumentCheckpoint(transaction, {
      workspaceId: params.workspace.workspaceId,
      path: normalizedPath,
      documentId: params.documentId,
      stateVersion: params.stateVersion,
      revisionId: params.snapshotRevisionId,
      nowMs,
    });
  });
}

export async function ensureFileRevisionForCurrentContent(params: {
  workspace: WorkspaceContext;
  path: string;
  contentHash: string;
  sizeBytes: number;
  actorUserId?: string | null;
  actorType?: FileActorType;
  sourceSessionId?: string | null;
  baseRevisionId?: string | null;
  nowMs?: number;
}): Promise<FileRevisionRecord> {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();

  return withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, params.workspace.workspaceId, [normalizedPath]);
    const lineage = await ensurePostgresActiveFileLineage(transaction, {
      id: `file-lineage-${randomUUID()}`,
      workspace: params.workspace,
      path: normalizedPath,
      nowMs,
    });
    const latest = await getPostgresLatestFileRevisionForLineage(transaction, lineage.id);
    const collaborationProvider = collaborationProviderForStrategy(
      params.workspace,
      detectFileCollaborationStrategy(normalizedPath),
    );
    if (latest?.contentHash === params.contentHash && latest.sizeBytes === params.sizeBytes) {
      if (collaborationProvider) {
        await ensurePostgresCollaborationDocument(transaction, {
          id: `collab-doc-${randomUUID()}`,
          lineageId: lineage.id,
          workspace: params.workspace,
          path: normalizedPath,
          provider: collaborationProvider,
          snapshotRevisionId: latest.id,
          nowMs,
        });
      }
      return latest;
    }

    const created = await appendPostgresFileRevision(transaction, {
      id: `file-rev-${randomUUID()}`,
      lineageId: lineage.id,
      workspace: params.workspace,
      path: normalizedPath,
      contentHash: params.contentHash,
      sizeBytes: params.sizeBytes,
      createdByUserId: params.actorUserId ?? null,
      createdByActorType: params.actorType ?? 'system',
      sourceSessionId: params.sourceSessionId ?? null,
      baseRevisionId: params.baseRevisionId ?? latest?.id ?? null,
      nowMs,
    });

    if (collaborationProvider) {
      await ensurePostgresCollaborationDocument(transaction, {
        id: `collab-doc-${randomUUID()}`,
        lineageId: lineage.id,
        workspace: params.workspace,
        path: normalizedPath,
        provider: collaborationProvider,
        snapshotRevisionId: created.id,
        nowMs,
      });
    }

    return created;
  });
}

/**
 * Marks the active revision streams for deleted paths as archived. Historical
 * revisions remain available through their lineage, but the path can safely be
 * reused by a different file without inheriting old locks or CRDT state.
 */
export function archiveFileCollaborationPaths(params: {
  workspace: WorkspaceContext;
  paths: Array<string | { path: string; trashEntryId?: string | null }>;
  nowMs?: number;
}): void {
  const entries = new Map<string, string | null>();
  for (const entry of params.paths) {
    const filePath = normalizeWorkspacePath(typeof entry === 'string' ? entry : entry.path);
    entries.set(filePath, typeof entry === 'string' ? null : entry.trashEntryId ?? null);
  }
  if (entries.size === 0) return;
  const nowMs = params.nowMs ?? Date.now();

  withCollaborationDatabase(true, (sqlite) => {
    for (const [filePath, trashEntryId] of entries) {
      materializeLegacyLineagesInPathScope(sqlite, params.workspace, filePath, nowMs);
      archivePathScope(sqlite, params.workspace.workspaceId, filePath, nowMs, trashEntryId);
    }
  });
}

/** Restores the exact lineage associated with a workspace trash entry. */
export function restoreFileCollaborationPath(params: {
  workspace: WorkspaceContext;
  path: string;
  trashEntryId: string;
  nowMs?: number;
}): void {
  const filePath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();

  withCollaborationDatabase(true, (sqlite) => {
    const archived = sqlite.prepare(`
      SELECT *
      FROM file_collaboration_lineages
      WHERE workspace_id = ?
        AND path = ?
        AND status = 'archived'
        AND trash_entry_id = ?
      ORDER BY archived_at DESC, rowid DESC
      LIMIT 1
    `).get(params.workspace.workspaceId, filePath, params.trashEntryId) as FileCollaborationLineageRow | undefined;
    if (!archived) return;

    archivePathScope(sqlite, params.workspace.workspaceId, filePath, nowMs);
    sqlite.prepare(`
      UPDATE file_collaboration_lineages
      SET status = 'active', archived_at = NULL, trash_entry_id = NULL
      WHERE id = ?
    `).run(archived.id);
  });
}

/**
 * Starts independent revision streams for copied paths. Copying is deliberately
 * not a rename: its future edits must never join the source file's history.
 */
export function initializeCopiedFileCollaborationPaths(params: {
  workspace: WorkspaceContext;
  paths: string[];
  nowMs?: number;
}): void {
  const paths = [...new Set(params.paths.map(normalizeWorkspacePath))];
  if (paths.length === 0) return;
  const nowMs = params.nowMs ?? Date.now();

  withCollaborationDatabase(true, (sqlite) => {
    for (const filePath of paths) {
      materializeLegacyLineagesInPathScope(sqlite, params.workspace, filePath, nowMs);
      archivePathScope(sqlite, params.workspace.workspaceId, filePath, nowMs);
      createActiveLineage(sqlite, params.workspace, filePath, nowMs);
    }
  });
}

/**
 * Moves the active identity of a file (or directory tree) to its new path.
 * Any inactive history already associated with the destination stays archived.
 */
export function moveFileCollaborationPath(params: {
  workspace: WorkspaceContext;
  oldPath: string;
  newPath: string;
  nowMs?: number;
}): void {
  const oldPath = normalizeWorkspacePath(params.oldPath);
  const newPath = normalizeWorkspacePath(params.newPath);
  if (oldPath === newPath) return;
  const nowMs = params.nowMs ?? Date.now();

  withCollaborationDatabase(true, (sqlite) => {
    materializeLegacyLineagesInPathScope(sqlite, params.workspace, oldPath, nowMs);
    // An overwritten destination may still have an active lineage despite the
    // physical rename replacing its file. Archive it before moving the source.
    archivePathScope(sqlite, params.workspace.workspaceId, newPath, nowMs);
    remapActivePathScope(sqlite, 'file_collaboration_lineages', params.workspace.workspaceId, oldPath, newPath);
    remapActivePathScope(sqlite, 'collaboration_documents', params.workspace.workspaceId, oldPath, newPath);
    remapActivePathScope(sqlite, 'file_locks', params.workspace.workspaceId, oldPath, newPath);
  });
}

function isSameActor(lock: FileLockRecord, userId?: string | null, sessionId?: string | null): boolean {
  if (sessionId && lock.lockedBySessionId && lock.lockedBySessionId === sessionId) return true;
  return Boolean(userId && lock.lockedByUserId && lock.lockedByUserId === userId);
}

export async function assertFileCollaborationWriteAllowed(params: {
  workspace: WorkspaceContext;
  path: string;
  actorUserId?: string | null;
  actorSessionId?: string | null;
  actorType?: FileActorType;
  baseRevisionId?: string | null;
  nowMs?: number;
}): Promise<FileCollaborationState> {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();

  return withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, params.workspace.workspaceId, [normalizedPath]);
    const lineage = await ensurePostgresActiveFileLineage(transaction, {
      id: `file-lineage-${randomUUID()}`,
      workspace: params.workspace,
      path: normalizedPath,
      nowMs,
    });
    const latestRevision = await getPostgresLatestFileRevisionForLineage(transaction, lineage.id);
    const state = await buildPostgresState({
      transaction,
      workspace: params.workspace,
      path: normalizedPath,
      nowMs,
      latestRevision,
      lineageId: lineage.id,
      ensureDocument: false,
    });

    if (
      params.baseRevisionId
      && latestRevision?.id
      && params.baseRevisionId !== latestRevision.id
    ) {
      throw new FileCollaborationPolicyError({
        code: 'FILE_REVISION_ID_CONFLICT',
        status: 409,
        message: 'File revision conflict: this file changed after it was loaded. Reload the latest version before saving.',
        path: normalizedPath,
        currentRevisionId: latestRevision.id,
        baseRevisionId: params.baseRevisionId,
      });
    }

    if (state.activeLock && !isSameActor(state.activeLock, params.actorUserId, params.actorSessionId)) {
      throw new FileCollaborationPolicyError({
        code: 'FILE_LOCKED',
        status: 423,
        message: 'File is locked by another active editor. Wait for the lock to expire or ask an owner/admin to release it.',
        path: normalizedPath,
        currentRevisionId: latestRevision?.id ?? null,
        baseRevisionId: params.baseRevisionId ?? null,
        activeLock: state.activeLock,
      });
    }

    if (state.lockRequired && latestRevision?.id && !state.activeLock) {
      throw new FileCollaborationPolicyError({
        code: 'FILE_LOCK_REQUIRED',
        status: 423,
        message: 'File requires an active edit lock before it can be changed.',
        path: normalizedPath,
        currentRevisionId: latestRevision.id,
        baseRevisionId: params.baseRevisionId ?? null,
      });
    }

    if ((state.crdtCapable || state.sceneCapable) && state.document) {
      throw new FileCollaborationPolicyError({
        code: 'COLLABORATION_ACTIVE_WHOLE_FILE_WRITE_BLOCKED',
        status: 409,
        message: 'This file has an active collaboration document. Apply edits through the collaboration service instead of replacing the whole file.',
        path: normalizedPath,
        currentRevisionId: latestRevision?.id ?? null,
        baseRevisionId: params.baseRevisionId ?? null,
      });
    }

    return state;
  });
}

function normalizeLockTtl(ttlMs?: number): number {
  if (!ttlMs || !Number.isFinite(ttlMs)) return DEFAULT_LOCK_TTL_MS;
  return Math.max(30_000, Math.min(Math.trunc(ttlMs), MAX_LOCK_TTL_MS));
}

export async function acquireFileLock(params: {
  workspace: WorkspaceContext;
  path: string;
  lockedByUserId: string;
  lockedBySessionId?: string | null;
  lockType?: FileLockType;
  ttlMs?: number;
  baseRevisionId?: string | null;
  nowMs?: number;
}): Promise<{ lock: FileLockRecord; state: FileCollaborationState }> {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();
  const expiresAt = nowMs + normalizeLockTtl(params.ttlMs);

  return withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, params.workspace.workspaceId, [normalizedPath]);
    await expirePostgresFileLocksForPath(transaction, params.workspace.workspaceId, normalizedPath, nowMs);
    const lineage = await ensurePostgresActiveFileLineage(transaction, {
      id: `file-lineage-${randomUUID()}`,
      workspace: params.workspace,
      path: normalizedPath,
      nowMs,
    });
    const latestRevision = await getPostgresLatestFileRevisionForLineage(transaction, lineage.id);
    const activeLock = await getPostgresActiveFileLock(
      transaction,
      params.workspace.workspaceId,
      normalizedPath,
      nowMs,
    );

    if (
      params.baseRevisionId
      && latestRevision?.id
      && params.baseRevisionId !== latestRevision.id
    ) {
      throw new FileCollaborationPolicyError({
        code: 'FILE_REVISION_ID_CONFLICT',
        status: 409,
        message: 'File revision conflict: this file changed after it was loaded. Reload the latest version before locking.',
        path: normalizedPath,
        currentRevisionId: latestRevision.id,
        baseRevisionId: params.baseRevisionId,
      });
    }

    if (activeLock) {
      if (!isSameActor(activeLock, params.lockedByUserId, params.lockedBySessionId)) {
        throw new FileCollaborationPolicyError({
          code: 'FILE_LOCKED',
          status: 423,
          message: 'File is already locked by another active editor.',
          path: normalizedPath,
          currentRevisionId: latestRevision?.id ?? null,
          baseRevisionId: params.baseRevisionId ?? null,
          activeLock,
        });
      }

      const refreshed = await refreshPostgresFileLock(transaction, activeLock.id, expiresAt, nowMs);
      if (!refreshed) {
        throw new Error(`Failed to refresh active lock for ${normalizedPath}.`);
      }
      return {
        lock: refreshed,
        state: await buildPostgresState({
          transaction,
          workspace: params.workspace,
          path: normalizedPath,
          nowMs,
          latestRevision,
          lineageId: lineage.id,
        }),
      };
    }

    const lock = await insertPostgresFileLock(transaction, {
      id: `file-lock-${randomUUID()}`,
      lineageId: lineage.id,
      organizationId: params.workspace.organizationId ?? null,
      customerId: params.workspace.customerId ?? null,
      projectId: params.workspace.projectId ?? null,
      workspaceId: params.workspace.workspaceId,
      workspaceType: params.workspace.workspaceType,
      path: normalizedPath,
      revisionId: params.baseRevisionId ?? latestRevision?.id ?? null,
      lockedByUserId: params.lockedByUserId,
      lockedBySessionId: params.lockedBySessionId ?? null,
      lockType: params.lockType ?? 'edit',
      expiresAt,
      nowMs,
    });

    return {
      lock,
      state: await buildPostgresState({
        transaction,
        workspace: params.workspace,
        path: normalizedPath,
        nowMs,
        latestRevision,
        lineageId: lineage.id,
      }),
    };
  });
}

export async function releaseFileLock(params: {
  workspace: WorkspaceContext;
  path?: string;
  lockId?: string;
  actorUserId: string;
  actorSessionId?: string | null;
  force?: boolean;
  nowMs?: number;
}): Promise<FileLockRecord> {
  const nowMs = params.nowMs ?? Date.now();

  return withFileCollaborationTransaction(async (transaction) => {
    const requestedPath = params.path ? normalizeWorkspacePath(params.path) : null;
    let lock = params.lockId
      ? await getPostgresFileLockById(transaction, params.workspace.workspaceId, params.lockId)
      : null;
    const lockPath = requestedPath ?? lock?.path ?? null;
    if (lockPath) {
      await lockFileCollaborationPaths(transaction, params.workspace.workspaceId, [lockPath]);
      await expirePostgresFileLocksForPath(transaction, params.workspace.workspaceId, lockPath, nowMs);
      lock = params.lockId
        ? await getPostgresFileLockById(transaction, params.workspace.workspaceId, params.lockId)
        : await getPostgresActiveFileLock(transaction, params.workspace.workspaceId, lockPath, nowMs);
    }

    if (!lock || lock.status !== 'active') {
      throw new FileCollaborationPolicyError({
        code: 'FILE_LOCK_NOT_FOUND',
        status: 404,
        message: 'File lock was not found.',
        path: requestedPath ?? lock?.path ?? '',
      });
    }

    if (!params.force && !isSameActor(lock, params.actorUserId, params.actorSessionId)) {
      throw new FileCollaborationPolicyError({
        code: 'FILE_LOCK_PERMISSION_DENIED',
        status: 403,
        message: 'Only the lock owner or an owner/admin force release can release this file lock.',
        path: lock.path,
        activeLock: lock,
      });
    }

    const nextStatus: FileLockStatus = params.force && !isSameActor(lock, params.actorUserId, params.actorSessionId)
      ? 'force_released'
      : 'released';
    const released = await updatePostgresFileLockStatus(transaction, lock.id, nextStatus, nowMs);
    if (!released) {
      throw new FileCollaborationPolicyError({
        code: 'FILE_LOCK_NOT_FOUND',
        status: 404,
        message: 'File lock was not found.',
        path: lock.path,
      });
    }
    return released;
  });
}

export async function expireActiveFileLocks(params: {
  workspace: WorkspaceContext;
  path: string;
  nowMs?: number;
}): Promise<void> {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();
  await withFileCollaborationTransaction(async (transaction) => {
    await lockFileCollaborationPaths(transaction, params.workspace.workspaceId, [normalizedPath]);
    await expirePostgresFileLocksForPath(transaction, params.workspace.workspaceId, normalizedPath, nowMs);
  });
}
