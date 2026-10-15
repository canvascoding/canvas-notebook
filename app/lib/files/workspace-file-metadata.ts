import 'server-only';

import { constants, promises as fs } from 'node:fs';
import type { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { getFileFormat } from './metadata';
import { normalizeWorkspacePathParam } from './path-utils';
import type { FileNode } from './types';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection, WorkspaceRequestPrincipalError } from '../workspaces/request-principal';
import { executeLifecycleTransaction } from '../collaboration/lifecycle-transaction';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { readWorkspaceDocumentCatalogue, WorkspaceDocumentCatalogueError } from '../collaboration/workspace-document-catalogue';
import { assertWorkspacePathHasNoAliases, resolveExistingWorkspacePath, WorkspacePathAliasError } from '../workspaces/path-guard';
import { filesystemFileVersion } from '../filesystem/file-version';
import { withWorkspaceMutationLock, WorkspaceMutationLockError } from './workspace-mutation-lock';
import { lockFileCollaborationPaths } from './collaboration-repository/transaction';
import { withWorkspaceSideEffectWriterFenceOnConnection, withWorkspaceSideEffectWriterMutationOnConnection,
  WorkspaceSideEffectWriterFenceError, type WorkspaceSideEffectWriterTarget } from './workspace-side-effect-writer-fence';
import type { WorkspaceFileMetadataTarget } from './workspace-file-metadata-contract';

const TITLE_MAX_LENGTH = 160;
const PATH_QUERY_CHUNK_SIZE = 400;

type MetadataRow = { path: string; title: string | null };
type UserStateRow = { path: string; is_favorite: number | boolean; pinned_at: number | null };

export type WorkspaceFileUserStateUpdate = {
  isFavorite?: boolean;
  pinned?: boolean;
};

function normalizeFilePath(value: string): string {
  const normalized = normalizeWorkspacePathParam(value);
  if (!normalized) throw new Error('A valid file path is required.');
  return normalized;
}

function normalizeTitle(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) return null;
  if (normalized.length > TITLE_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`File titles must be ${TITLE_MAX_LENGTH} characters or fewer.`);
  }
  return normalized;
}

async function withDatabase<T>(operation: (database: SqlConnection) => Promise<T>): Promise<T> {
  const database = await openDb();
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function enrichWorkspaceFileNodes(params: {
  nodes: FileNode[];
  workspace: WorkspaceContext;
  userId?: string | null;
}): Promise<FileNode[]> {
  const paths: string[] = [];
  const collect = (nodes: FileNode[]) => nodes.forEach((node) => {
    paths.push(node.path);
    if (node.children) collect(node.children);
  });
  collect(params.nodes);
  if (paths.length === 0) return params.nodes;

  const normalizedPaths = [...new Set(paths.map(normalizeFilePath))];
  const metadata = new Map<string, MetadataRow>();
  const userStates = new Map<string, UserStateRow>();

  await withDatabase(async (database) => {
    for (const pathChunk of chunks(normalizedPaths, PATH_QUERY_CHUNK_SIZE)) {
      const placeholders = pathChunk.map((_, index) => `$${index + 2}`).join(', ');
      const rows = await database.all(
        `SELECT path, title FROM workspace_file_metadata WHERE workspace_id = $1 AND path IN (${placeholders})`,
        [params.workspace.workspaceId, ...pathChunk],
      ) as MetadataRow[];
      rows.forEach((row) => metadata.set(row.path, row));

      if (params.userId) {
        const statePlaceholders = pathChunk.map((_, index) => `$${index + 3}`).join(', ');
        const stateRows = await database.all(
          `SELECT path, is_favorite, pinned_at FROM workspace_file_user_states WHERE workspace_id = $1 AND user_id = $2 AND path IN (${statePlaceholders})`,
          [params.workspace.workspaceId, params.userId, ...pathChunk],
        ) as UserStateRow[];
        stateRows.forEach((row) => userStates.set(row.path, row));
      }
    }
  });

  const enrich = (node: FileNode): FileNode => {
    const row = metadata.get(node.path);
    const userState = userStates.get(node.path);
    return {
      ...node,
      title: row?.title ?? null,
      format: getFileFormat(node),
      isFavorite: Boolean(userState?.is_favorite),
      pinnedAt: userState?.pinned_at ?? null,
      ...(node.children ? { children: node.children.map(enrich) } : {}),
    };
  };

  return params.nodes.map(enrich);
}

async function setWorkspaceFileTitle(database: SqlConnection, params: {
  workspaceId: string; path: string; title: string | null; table: string; now: number;
}): Promise<void> {
  if (params.title === null) {
    await database.run(`DELETE FROM ${params.table} WHERE workspace_id=$1 AND path=$2`, [params.workspaceId, params.path]);
    return;
  }
  await database.run(`INSERT INTO ${params.table} (workspace_id,path,title,created_at,updated_at)
    VALUES($1,$2,$3,$4,$4) ON CONFLICT(workspace_id,path)
    DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`,
  [params.workspaceId,params.path,params.title,params.now]);
}

async function setWorkspaceFileUserState(database: SqlConnection, params: {
  workspaceId: string; userId: string; path: string; update: WorkspaceFileUserStateUpdate; table: string; now: number;
}): Promise<void> {
  // The exact-path advisory lock also covers an absent per-user row. Patch only
  // supplied columns; a concurrent favorite and pin cannot erase each other.
  await database.run(`INSERT INTO ${params.table} AS existing (workspace_id,user_id,path,is_favorite,pinned_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(workspace_id,user_id,path) DO UPDATE SET
      is_favorite=CASE WHEN $7 THEN excluded.is_favorite ELSE existing.is_favorite END,
      pinned_at=CASE WHEN $8 THEN excluded.pinned_at ELSE existing.pinned_at END,
      updated_at=excluded.updated_at`,
  [params.workspaceId,params.userId,params.path,params.update.isFavorite ? 1 : 0,
    params.update.pinned ? params.now : null,params.now,params.update.isFavorite !== undefined,params.update.pinned !== undefined]);
  await database.run(`DELETE FROM ${params.table} WHERE workspace_id=$1 AND user_id=$2 AND path=$3
    AND is_favorite=0 AND pinned_at IS NULL`, [params.workspaceId,params.userId,params.path]);
}

export class WorkspaceFileMetadataWriteError extends Error {
  constructor(readonly code: 'FILE_METADATA_INVALID' | 'FILE_METADATA_SCOPE_CHANGED' | 'FILE_METADATA_COMMIT_UNCONFIRMED',
    readonly status: 400 | 409 | 503) {
    super(code === 'FILE_METADATA_INVALID' ? 'Read the file information and supply its target reference with valid metadata fields.'
      : code === 'FILE_METADATA_SCOPE_CHANGED' ? 'The file changed. Read its current information before updating metadata.'
        : 'The metadata commit could not be confirmed. Read the current state before making another request.');
    this.name = 'WorkspaceFileMetadataWriteError';
  }
}
const invalidMetadata = (): never => { throw new WorkspaceFileMetadataWriteError('FILE_METADATA_INVALID',400); };
const changedMetadata = (): never => { throw new WorkspaceFileMetadataWriteError('FILE_METADATA_SCOPE_CHANGED',409); };
const metadataId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
function metadataObject(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !Object.getOwnPropertyDescriptor(value,key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value,key),'value'))) return invalidMetadata();
  return value as Record<string,unknown>;
}
type MetadataWrite = { path: string; expectedTarget: WorkspaceFileMetadataTarget; title?: string | null;
  isFavorite?: boolean; pinned?: boolean };
function captureMetadataWrite(value: unknown): MetadataWrite {
  const body = metadataObject(value), expected = metadataObject(body.expectedTarget);
  const fields = ['title','isFavorite','pinned'];
  if (Object.keys(body).some(key => !['path','expectedTarget',...fields].includes(key))
    || !fields.some(key => Object.prototype.hasOwnProperty.call(body,key))
    || typeof body.path !== 'string' || !isCanonicalAdmissionPath(body.path)
    || expected.version !== 1 || !metadataId(expected.workspaceId) || expected.path !== body.path
    || expected.kind !== 'native_file' && expected.kind !== 'filesystem') return invalidMetadata();
  const targetKeys = ['version','workspaceId','path','kind', ...(expected.kind === 'native_file'
    ? ['documentId','lifecycleGeneration'] : ['fileVersion','entryType'])];
  if (Reflect.ownKeys(expected).length !== targetKeys.length || targetKeys.some(key => !Object.prototype.hasOwnProperty.call(expected,key))) return invalidMetadata();
  if (expected.kind === 'native_file') {
    if (!metadataId(expected.documentId) || !Number.isSafeInteger(expected.lifecycleGeneration) || Number(expected.lifecycleGeneration) < 1) return invalidMetadata();
  } else if (typeof expected.fileVersion !== 'string' || expected.fileVersion.length > 1024
    || !/^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+(?:\.[0-9]+)?:-?[0-9]+(?:\.[0-9]+)?$/u.test(expected.fileVersion)
    || expected.entryType !== 'file' && expected.entryType !== 'directory') return invalidMetadata();
  if (Object.prototype.hasOwnProperty.call(body,'title') && body.title !== null && typeof body.title !== 'string'
    || ['isFavorite','pinned'].some(key => Object.prototype.hasOwnProperty.call(body,key) && typeof body[key] !== 'boolean')) return invalidMetadata();
  let title: string | null | undefined;
  try { if (Object.prototype.hasOwnProperty.call(body,'title')) title=normalizeTitle(body.title as string | null); }
  catch { return invalidMetadata(); }
  return Object.freeze({ path: body.path, expectedTarget: Object.freeze({ ...expected }) as WorkspaceFileMetadataTarget,
    ...(title === undefined ? {} : { title }),
    ...(body.isFavorite === undefined ? {} : { isFavorite: body.isFavorite as boolean }),
    ...(body.pinned === undefined ? {} : { pinned: body.pinned as boolean }) });
}

async function withPhysicalMetadataTarget<T>(database: SqlConnection, workspace: WorkspaceContext,
  target: Extract<WorkspaceFileMetadataTarget,{kind:'filesystem'}>, operation: () => Promise<T>): Promise<T> {
  // The legacy physical resolver trims the whole input. Never check a
  // different admission/authority path or attach its identity to this name.
  if (target.path !== target.path.trim()) changedMetadata();
  const lock = await database.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS locked',
    [collaborationAdmissionLockKey(workspace.workspaceId)]) as { locked?: boolean } | undefined;
  if (lock?.locked !== true) throw new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_BUSY');
  const check = async () => {
    const reservation = await database.get(`SELECT s.request_id FROM collaboration_admission_scopes s
      JOIN collaboration_admission_requests r ON r.request_id=s.request_id
      WHERE s.workspace_id=$1 AND r.status NOT IN ('committed','cancelled')
        AND (s.path=$2 OR s.kind='subtree' AND (s.path='' OR left($2,length(s.path)+1)=s.path||'/')) LIMIT 1`,
    [workspace.workspaceId,target.path]);
    if (reservation) throw new WorkspaceSideEffectWriterFenceError('SIDE_EFFECT_WRITER_BUSY');
    const documents = await readWorkspaceDocumentCatalogue(database,workspace,{ paths:[target.path] });
    if (documents.some(document => document.path === target.path && document.authority !== 'pristine')) changedMetadata();
    await assertWorkspacePathHasNoAliases(workspace,target.path,{ readOnly:true });
    return resolveExistingWorkspacePath(workspace,target.path);
  };
  const fullPath = await check();
  const handle = await fs.open(fullPath,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const assertFile = async () => {
      const currentPath = await check();
      const [held,current] = await Promise.all([handle.stat(),fs.lstat(currentPath)]);
      if (currentPath !== fullPath || filesystemFileVersion(held) !== target.fileVersion
        || filesystemFileVersion(current) !== target.fileVersion || current.isSymbolicLink()
        || target.entryType === 'file' && (!held.isFile() || !current.isFile())
        || target.entryType === 'directory' && (!held.isDirectory() || !current.isDirectory())) changedMetadata();
    };
    await assertFile(); const result = await operation(); await assertFile(); return result;
  } finally { await handle.close(); }
}

/** Only this real request factory dispatches normal metadata writes. The
 * physical branch holds kernel -> shared PG; native content remains writable.
 * Legacy move/delete metadata is a separate existing lifecycle-owned family. */
export async function updateWorkspaceFileMetadata(request: NextRequest, value: unknown): Promise<WorkspaceContext> {
  const input = captureMetadataWrite(value), target = input.expectedTarget;
  let prepared = false;
  try { return await withWorkspaceRequestPrincipal(request,{ permission:input.title === undefined ? 'canRead' : 'canWrite' }, principal =>
    withWorkspaceMutationLock(target.workspaceId, () => executeLifecycleTransaction({
      openConnection:openDb,
      execute: async database => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
        const workspace = await withWorkspaceRequestPrincipalOnConnection(database,principal,async access => {
          const workspace = access.workspace;
          if (workspace.workspaceId !== target.workspaceId || !workspace.permissions.canRead
            || input.title !== undefined && !workspace.permissions.canWrite) changedMetadata();
          const schema = await database.get('SELECT current_schema() AS name') as { name: string };
          const quote = (s:string) => `"${s.replaceAll('"','""')}"`;
          const prefix=quote(schema.name);
          const write = async () => {
            await lockFileCollaborationPaths(database,workspace.workspaceId,[input.path]);
            await access.assertCurrent();
            const now=Date.now();
            if (input.title !== undefined) await setWorkspaceFileTitle(database,{ workspaceId:workspace.workspaceId,
              path:input.path,title:input.title,table:`${prefix}.workspace_file_metadata`,now });
            if (input.isFavorite !== undefined || input.pinned !== undefined) await setWorkspaceFileUserState(database,{
              workspaceId:workspace.workspaceId,userId:access.userId,path:input.path,
              update:{ isFavorite:input.isFavorite,pinned:input.pinned },table:`${prefix}.workspace_file_user_states`,now });
            await access.assertCurrent();
          };
          if (target.kind === 'native_file') {
            // Resolve server-owned lineage/representation on this exact TX.
            // The shared fence then checks every registry/state binding afresh.
            const row = await database.get(`SELECT d.lineage_id,s.representation,s.schema_version FROM collaboration_documents d
              JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1 AND d.workspace_id=$2 AND d.path=$3
                AND s.lifecycle_generation=$4`,[target.documentId,workspace.workspaceId,input.path,target.lifecycleGeneration]) as
              { lineage_id:string; representation:WorkspaceSideEffectWriterTarget['representation']; schema_version:number } | undefined;
            if (!row) return changedMetadata();
            const native:WorkspaceSideEffectWriterTarget={ kind:'native_file',documentId:target.documentId,lineageId:row.lineage_id,
              workspaceId:workspace.workspaceId,organizationId:workspace.organizationId ?? null,path:input.path,
              lifecycleGeneration:target.lifecycleGeneration,representation:row.representation,schemaVersion:row.schema_version };
            await withWorkspaceSideEffectWriterFenceOnConnection(database,{ workspace,targets:[native] },() =>
              withWorkspaceSideEffectWriterMutationOnConnection(database,native,write));
          } else await withPhysicalMetadataTarget(database,workspace,target,write);
          return workspace;
        });
        prepared = true;
        return workspace;
      },
      // Discard first in the existing transaction helper. No blind retry of
      // pin-now and no success based on a merely similar current row.
      recoverCommitted:async () => { throw new WorkspaceFileMetadataWriteError('FILE_METADATA_COMMIT_UNCONFIRMED',503); },
    }))); } catch (error) {
    // Also retain the unknown-outcome contract when discard itself fails
    // or confirmed COMMIT is followed by a connection/kernel close failure.
    // No retry and no second release on that unresolved connection.
    if (prepared) throw new WorkspaceFileMetadataWriteError('FILE_METADATA_COMMIT_UNCONFIRMED',503);
    throw error;
  }
}

export function metadataFileWriteFailure(error: unknown): { code:string; status:number; message:string } | null {
  if (error instanceof WorkspaceFileMetadataWriteError) return { code:error.code,status:error.status,message:error.message };
  if (error instanceof WorkspaceRequestPrincipalError) {
    const status=error.code === 'PRINCIPAL_AUTH_REVOKED' ? 401 : error.code === 'PRINCIPAL_ACCESS_DENIED' ? 403
      : ['PRINCIPAL_SCOPE_CHANGED','PRINCIPAL_INVALID'].includes(error.code) ? 409 : 503;
    return { code:error.code,status,message:status === 401 ? 'Sign in again before updating file metadata.'
      : status === 403 ? 'Current workspace permission is required.' : 'The current workspace access could not be confirmed. Read it again.' };
  }
  if (error instanceof WorkspaceSideEffectWriterFenceError) return { code:error.code,status:409,
    message:error.code === 'SIDE_EFFECT_WRITER_BUSY' ? 'A file transition is in progress. Retry after it completes.' : 'The document changed. Read its current information again.' };
  if (error instanceof WorkspaceDocumentCatalogueError || error instanceof WorkspacePathAliasError) return {
    code:'FILE_METADATA_SCOPE_CHANGED',status:409,message:'The document authority changed. Read its current information again.' };
  if (error instanceof WorkspaceMutationLockError) return { code:error.code,status:503,message:'Workspace files are busy. Retry after the current operation completes.' };
  const code=error && typeof error === 'object' ? Reflect.get(error,'code') : undefined;
  if (['ENOENT','ENOTDIR','ELOOP'].includes(String(code))) return { code:'FILE_METADATA_SCOPE_CHANGED',status:409,message:'The file changed. Read its current information again.' };
  if (['55P03','57014','25P04'].includes(String(code))) return { code:'FILE_METADATA_UNAVAILABLE',status:503,
    message:'The metadata update could not finish within its database deadline. Read the current state before retrying.' };
  return null;
}

export async function moveWorkspaceFileMetadata(params: {
  workspace: WorkspaceContext;
  oldPath: string;
  newPath: string;
}): Promise<void> {
  const oldPath = normalizeFilePath(params.oldPath);
  const newPath = normalizeFilePath(params.newPath);
  if (oldPath === newPath) return;
  await withDatabase(async (database) => {
    await database.run('BEGIN');
    try {
      await moveWorkspaceFileMetadataOnConnection(database, {
        workspaceId: params.workspace.workspaceId,
        oldPath,
        newPath,
      });
      await database.run('COMMIT');
    } catch (error) {
      try { await database.run('ROLLBACK'); } catch {}
      throw error;
    }
  });
}

export async function moveWorkspaceFileMetadataOnConnection(
  database: SqlConnection,
  params: { workspaceId: string; oldPath: string; newPath: string },
): Promise<void> {
  for (const table of ['workspace_file_metadata', 'workspace_file_user_states']) {
    await database.run(`
      DELETE FROM ${table}
      WHERE workspace_id = $1
        AND (path = $2 OR substr(path, 1, length($3) + 1) = $4 || '/')
    `, [params.workspaceId, params.newPath, params.newPath, params.newPath]);
    await database.run(`
      UPDATE ${table}
      SET path = $1 || substr(path, length($2) + 1)
      WHERE workspace_id = $3
        AND (path = $4 OR substr(path, 1, length($5) + 1) = $6 || '/')
    `, [params.newPath, params.oldPath, params.workspaceId, params.oldPath, params.oldPath, params.oldPath]);
  }
}

export async function deleteWorkspaceFileMetadata(params: {
  workspace: WorkspaceContext;
  path: string;
}): Promise<void> {
  const filePath = normalizeFilePath(params.path);
  await withDatabase(async (database) => {
    await database.run('BEGIN');
    try {
      for (const table of ['workspace_file_metadata', 'workspace_file_user_states']) {
        await database.run(`
          DELETE FROM ${table}
          WHERE workspace_id = $1
            AND (path = $2 OR substr(path, 1, length($3) + 1) = $4 || '/')
        `, [params.workspace.workspaceId, filePath, filePath, filePath]);
      }
      await database.run('COMMIT');
    } catch (error) {
      try { await database.run('ROLLBACK'); } catch {}
      throw error;
    }
  });
}
