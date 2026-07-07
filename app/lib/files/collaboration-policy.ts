import 'server-only';

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { openOrganizationBootstrapDatabase } from '@/app/lib/organization/bootstrap';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type FileCollaborationStrategy = 'crdt_text' | 'revision_check' | 'exclusive_lock';
export type FileActorType = 'user' | 'agent' | 'automation' | 'system';
export type FileLockType = 'edit' | 'upload' | 'agent_write';
export type FileLockStatus = 'active' | 'released' | 'expired' | 'force_released';

export interface FileRevisionRecord {
  id: string;
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
  provider: 'yjs';
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
    | 'FILE_LOCK_PERMISSION_DENIED';
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

type FileRevisionRow = {
  id: string;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  content_hash: string;
  size_bytes: number;
  created_by_user_id: string | null;
  created_by_actor_type: FileActorType;
  source_session_id: string | null;
  base_revision_id: string | null;
  created_at: number;
};

type FileLockRow = {
  id: string;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  revision_id: string | null;
  locked_by_user_id: string | null;
  locked_by_session_id: string | null;
  lock_type: FileLockType;
  status: FileLockStatus;
  expires_at: number;
  created_at: number;
  updated_at: number;
};

type CollaborationDocumentRow = {
  id: string;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  provider: 'yjs';
  state_version: number;
  snapshot_revision_id: string | null;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
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
  if (EXCLUSIVE_LOCK_EXTENSIONS.has(extension)) return 'exclusive_lock';
  return 'revision_check';
}

export function workspaceRequiresCollaborationPolicy(workspace: WorkspaceContext): boolean {
  return workspace.workspaceType === 'team' || workspace.workspaceType === 'project';
}

function mapRevision(row: FileRevisionRow | undefined): FileRevisionRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    createdByUserId: row.created_by_user_id,
    createdByActorType: row.created_by_actor_type,
    sourceSessionId: row.source_session_id,
    baseRevisionId: row.base_revision_id,
    createdAt: row.created_at,
  };
}

function mapLock(row: FileLockRow | undefined): FileLockRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    revisionId: row.revision_id,
    lockedByUserId: row.locked_by_user_id,
    lockedBySessionId: row.locked_by_session_id,
    lockType: row.lock_type,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDocument(row: CollaborationDocumentRow | undefined): CollaborationDocumentRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    provider: row.provider,
    stateVersion: row.state_version,
    snapshotRevisionId: row.snapshot_revision_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function expireStaleLocks(sqlite: Sqlite, workspaceId: string, filePath: string, nowMs: number): void {
  sqlite.prepare(`
    UPDATE file_locks
    SET status = 'expired', updated_at = ?
    WHERE workspace_id = ?
      AND path = ?
      AND status = 'active'
      AND expires_at <= ?
  `).run(nowMs, workspaceId, filePath, nowMs);
}

function getLatestRevision(sqlite: Sqlite, workspaceId: string, filePath: string): FileRevisionRecord | null {
  const row = sqlite.prepare(`
    SELECT *
    FROM file_revisions
    WHERE workspace_id = ? AND path = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(workspaceId, filePath) as FileRevisionRow | undefined;
  return mapRevision(row);
}

function getActiveLock(sqlite: Sqlite, workspaceId: string, filePath: string, nowMs: number): FileLockRecord | null {
  expireStaleLocks(sqlite, workspaceId, filePath, nowMs);
  const row = sqlite.prepare(`
    SELECT *
    FROM file_locks
    WHERE workspace_id = ?
      AND path = ?
      AND status = 'active'
      AND expires_at > ?
    ORDER BY updated_at DESC, rowid DESC
    LIMIT 1
  `).get(workspaceId, filePath, nowMs) as FileLockRow | undefined;
  return mapLock(row);
}

function getCollaborationDocument(
  sqlite: Sqlite,
  workspaceId: string,
  filePath: string,
): CollaborationDocumentRecord | null {
  const row = sqlite.prepare(`
    SELECT *
    FROM collaboration_documents
    WHERE workspace_id = ?
      AND path = ?
      AND provider = 'yjs'
      AND status = 'active'
    LIMIT 1
  `).get(workspaceId, filePath) as CollaborationDocumentRow | undefined;
  return mapDocument(row);
}

function ensureCollaborationDocument(
  sqlite: Sqlite,
  workspace: WorkspaceContext,
  filePath: string,
  snapshotRevisionId: string | null,
  nowMs: number,
): CollaborationDocumentRecord {
  const existing = getCollaborationDocument(sqlite, workspace.workspaceId, filePath);
  if (existing) return existing;

  const id = `collab-doc-${randomUUID()}`;
  sqlite.prepare(`
    INSERT INTO collaboration_documents (
      id, organization_id, customer_id, project_id, workspace_id, workspace_type, path,
      provider, state_version, snapshot_revision_id, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'yjs', 0, ?, 'active', ?, ?)
  `).run(
    id,
    workspace.organizationId ?? null,
    workspace.customerId ?? null,
    workspace.projectId ?? null,
    workspace.workspaceId,
    workspace.workspaceType,
    filePath,
    snapshotRevisionId,
    nowMs,
    nowMs,
  );

  const created = getCollaborationDocument(sqlite, workspace.workspaceId, filePath);
  if (!created) {
    throw new Error(`Failed to create collaboration document for ${filePath}.`);
  }
  return created;
}

function buildState(params: {
  sqlite: Sqlite;
  workspace: WorkspaceContext;
  path: string;
  nowMs: number;
  latestRevision?: FileRevisionRecord | null;
  ensureDocument?: boolean;
}): FileCollaborationState {
  const strategy = detectFileCollaborationStrategy(params.path);
  const requiresPolicy = workspaceRequiresCollaborationPolicy(params.workspace);
  const latestRevision = params.latestRevision ?? getLatestRevision(params.sqlite, params.workspace.workspaceId, params.path);
  const activeLock = requiresPolicy ? getActiveLock(params.sqlite, params.workspace.workspaceId, params.path, params.nowMs) : null;
  const crdtCapable = requiresPolicy && strategy === 'crdt_text';
  const document = crdtCapable
    ? params.ensureDocument
      ? ensureCollaborationDocument(params.sqlite, params.workspace, params.path, latestRevision?.id ?? null, params.nowMs)
      : getCollaborationDocument(params.sqlite, params.workspace.workspaceId, params.path)
    : null;

  return {
    path: params.path,
    strategy,
    crdtCapable,
    lockRequired: requiresPolicy && strategy === 'exclusive_lock',
    requiresRevisionCheck: requiresPolicy,
    latestRevision,
    activeLock,
    document,
  };
}

export function getFileCollaborationState(params: {
  workspace: WorkspaceContext;
  path: string;
  ensureDocument?: boolean;
  nowMs?: number;
}): FileCollaborationState {
  const normalizedPath = normalizeWorkspacePath(params.path);
  return withCollaborationDatabase(Boolean(params.ensureDocument), (sqlite) => buildState({
    sqlite,
    workspace: params.workspace,
    path: normalizedPath,
    nowMs: params.nowMs ?? Date.now(),
    ensureDocument: params.ensureDocument,
  }));
}

export function ensureFileRevisionForCurrentContent(params: {
  workspace: WorkspaceContext;
  path: string;
  contentHash: string;
  sizeBytes: number;
  actorUserId?: string | null;
  actorType?: FileActorType;
  sourceSessionId?: string | null;
  baseRevisionId?: string | null;
  nowMs?: number;
}): FileRevisionRecord {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();

  return withCollaborationDatabase(true, (sqlite) => {
    const latest = getLatestRevision(sqlite, params.workspace.workspaceId, normalizedPath);
    if (latest?.contentHash === params.contentHash && latest.sizeBytes === params.sizeBytes) {
      return latest;
    }

    const id = `file-rev-${randomUUID()}`;
    sqlite.prepare(`
      INSERT INTO file_revisions (
        id, organization_id, customer_id, project_id, workspace_id, workspace_type, path,
        content_hash, size_bytes, created_by_user_id, created_by_actor_type,
        source_session_id, base_revision_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.workspace.organizationId ?? null,
      params.workspace.customerId ?? null,
      params.workspace.projectId ?? null,
      params.workspace.workspaceId,
      params.workspace.workspaceType,
      normalizedPath,
      params.contentHash,
      params.sizeBytes,
      params.actorUserId ?? null,
      params.actorType ?? 'system',
      params.sourceSessionId ?? null,
      params.baseRevisionId ?? latest?.id ?? null,
      nowMs,
    );

    const created = getLatestRevision(sqlite, params.workspace.workspaceId, normalizedPath);
    if (!created) {
      throw new Error(`Failed to create file revision for ${normalizedPath}.`);
    }

    if (detectFileCollaborationStrategy(normalizedPath) === 'crdt_text' && workspaceRequiresCollaborationPolicy(params.workspace)) {
      ensureCollaborationDocument(sqlite, params.workspace, normalizedPath, created.id, nowMs);
    }

    return created;
  });
}

function isSameActor(lock: FileLockRecord, userId?: string | null, sessionId?: string | null): boolean {
  if (sessionId && lock.lockedBySessionId && lock.lockedBySessionId === sessionId) return true;
  return Boolean(userId && lock.lockedByUserId && lock.lockedByUserId === userId);
}

export function assertFileCollaborationWriteAllowed(params: {
  workspace: WorkspaceContext;
  path: string;
  actorUserId?: string | null;
  actorSessionId?: string | null;
  actorType?: FileActorType;
  baseRevisionId?: string | null;
  nowMs?: number;
}): FileCollaborationState {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();

  return withCollaborationDatabase(true, (sqlite) => {
    const latestRevision = getLatestRevision(sqlite, params.workspace.workspaceId, normalizedPath);
    const state = buildState({
      sqlite,
      workspace: params.workspace,
      path: normalizedPath,
      nowMs,
      latestRevision,
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

    return state;
  });
}

function normalizeLockTtl(ttlMs?: number): number {
  if (!ttlMs || !Number.isFinite(ttlMs)) return DEFAULT_LOCK_TTL_MS;
  return Math.max(30_000, Math.min(Math.trunc(ttlMs), MAX_LOCK_TTL_MS));
}

export function acquireFileLock(params: {
  workspace: WorkspaceContext;
  path: string;
  lockedByUserId: string;
  lockedBySessionId?: string | null;
  lockType?: FileLockType;
  ttlMs?: number;
  baseRevisionId?: string | null;
  nowMs?: number;
}): { lock: FileLockRecord; state: FileCollaborationState } {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();
  const expiresAt = nowMs + normalizeLockTtl(params.ttlMs);

  return withCollaborationDatabase(true, (sqlite) => {
    const latestRevision = getLatestRevision(sqlite, params.workspace.workspaceId, normalizedPath);
    const activeLock = getActiveLock(sqlite, params.workspace.workspaceId, normalizedPath, nowMs);

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

      sqlite.prepare(`
        UPDATE file_locks
        SET expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(expiresAt, nowMs, activeLock.id);
      const refreshed = getActiveLock(sqlite, params.workspace.workspaceId, normalizedPath, nowMs);
      if (!refreshed) {
        throw new Error(`Failed to refresh active lock for ${normalizedPath}.`);
      }
      return {
        lock: refreshed,
        state: buildState({ sqlite, workspace: params.workspace, path: normalizedPath, nowMs, latestRevision }),
      };
    }

    const id = `file-lock-${randomUUID()}`;
    sqlite.prepare(`
      INSERT INTO file_locks (
        id, organization_id, customer_id, project_id, workspace_id, workspace_type, path,
        revision_id, locked_by_user_id, locked_by_session_id, lock_type, status,
        expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      id,
      params.workspace.organizationId ?? null,
      params.workspace.customerId ?? null,
      params.workspace.projectId ?? null,
      params.workspace.workspaceId,
      params.workspace.workspaceType,
      normalizedPath,
      params.baseRevisionId ?? latestRevision?.id ?? null,
      params.lockedByUserId,
      params.lockedBySessionId ?? null,
      params.lockType ?? 'edit',
      expiresAt,
      nowMs,
      nowMs,
    );

    const lock = getActiveLock(sqlite, params.workspace.workspaceId, normalizedPath, nowMs);
    if (!lock) {
      throw new Error(`Failed to create active lock for ${normalizedPath}.`);
    }

    return {
      lock,
      state: buildState({ sqlite, workspace: params.workspace, path: normalizedPath, nowMs, latestRevision }),
    };
  });
}

export function releaseFileLock(params: {
  workspace: WorkspaceContext;
  path?: string;
  lockId?: string;
  actorUserId: string;
  actorSessionId?: string | null;
  force?: boolean;
  nowMs?: number;
}): FileLockRecord {
  const nowMs = params.nowMs ?? Date.now();

  return withCollaborationDatabase(true, (sqlite) => {
    const lock = params.lockId
      ? mapLock(sqlite.prepare(`
          SELECT *
          FROM file_locks
          WHERE id = ? AND workspace_id = ?
          LIMIT 1
        `).get(params.lockId, params.workspace.workspaceId) as FileLockRow | undefined)
      : params.path
        ? getActiveLock(sqlite, params.workspace.workspaceId, normalizeWorkspacePath(params.path), nowMs)
        : null;

    if (!lock) {
      throw new FileCollaborationPolicyError({
        code: 'FILE_LOCK_NOT_FOUND',
        status: 404,
        message: 'File lock was not found.',
        path: params.path ? normalizeWorkspacePath(params.path) : '',
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
    sqlite.prepare(`
      UPDATE file_locks
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, nowMs, lock.id);

    return {
      ...lock,
      status: nextStatus,
      updatedAt: nowMs,
    };
  });
}

export function expireActiveFileLocks(params: {
  workspace: WorkspaceContext;
  path: string;
  nowMs?: number;
}): void {
  const normalizedPath = normalizeWorkspacePath(params.path);
  const nowMs = params.nowMs ?? Date.now();
  withCollaborationDatabase(true, (sqlite) => {
    expireStaleLocks(sqlite, params.workspace.workspaceId, normalizedPath, nowMs);
  });
}
