import { openDb, type SqlConnection } from '@/app/lib/db';
import { getFileFormat } from './metadata';
import { normalizeWorkspacePathParam } from './path-utils';
import type { FileNode } from './types';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

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
      const placeholders = pathChunk.map(() => '?').join(', ');
      const rows = await database.all(
        `SELECT path, title FROM workspace_file_metadata WHERE workspace_id = ? AND path IN (${placeholders})`,
        [params.workspace.workspaceId, ...pathChunk],
      ) as MetadataRow[];
      rows.forEach((row) => metadata.set(row.path, row));

      if (params.userId) {
        const stateRows = await database.all(
          `SELECT path, is_favorite, pinned_at FROM workspace_file_user_states WHERE workspace_id = ? AND user_id = ? AND path IN (${placeholders})`,
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

export async function setWorkspaceFileTitle(params: {
  workspace: WorkspaceContext;
  path: string;
  title: string | null;
}): Promise<void> {
  const path = normalizeFilePath(params.path);
  const title = normalizeTitle(params.title);
  const now = Date.now();
  await withDatabase(async (database) => {
    if (title === null) {
      await database.run('DELETE FROM workspace_file_metadata WHERE workspace_id = ? AND path = ?', [params.workspace.workspaceId, path]);
      return;
    }
    await database.run(`
      INSERT INTO workspace_file_metadata (workspace_id, path, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
    `, [params.workspace.workspaceId, path, title, now, now]);
  });
}

export async function setWorkspaceFileUserState(params: {
  workspace: WorkspaceContext;
  userId: string;
  path: string;
  update: WorkspaceFileUserStateUpdate;
}): Promise<void> {
  const path = normalizeFilePath(params.path);
  const now = Date.now();
  await withDatabase(async (database) => {
    const current = await database.get(
      'SELECT is_favorite, pinned_at FROM workspace_file_user_states WHERE workspace_id = ? AND user_id = ? AND path = ?',
      [params.workspace.workspaceId, params.userId, path],
    ) as UserStateRow | undefined;
    const isFavorite = params.update.isFavorite ?? Boolean(current?.is_favorite);
    const pinnedAt = params.update.pinned === undefined
      ? current?.pinned_at ?? null
      : params.update.pinned ? now : null;
    if (!isFavorite && pinnedAt === null) {
      await database.run('DELETE FROM workspace_file_user_states WHERE workspace_id = ? AND user_id = ? AND path = ?', [params.workspace.workspaceId, params.userId, path]);
      return;
    }
    await database.run(`
      INSERT INTO workspace_file_user_states (workspace_id, user_id, path, is_favorite, pinned_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id, path) DO UPDATE SET
        is_favorite = excluded.is_favorite,
        pinned_at = excluded.pinned_at,
        updated_at = excluded.updated_at
    `, [params.workspace.workspaceId, params.userId, path, isFavorite ? 1 : 0, pinnedAt, now, now]);
  });
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
      WHERE workspace_id = ?
        AND (path = ? OR left(path, length(?) + 1) = ? || '/')
    `, [params.workspaceId, params.newPath, params.newPath, params.newPath]);
    await database.run(`
      UPDATE ${table}
      SET path = ? || substr(path, length(?) + 1)
      WHERE workspace_id = ?
        AND (path = ? OR left(path, length(?) + 1) = ? || '/')
    `, [params.newPath, params.oldPath, params.workspaceId, params.oldPath, params.oldPath, params.oldPath]);
  }
}
