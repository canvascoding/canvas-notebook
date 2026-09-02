import 'server-only';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import { ensureActiveFileLineage } from './lineage-revision-repository';
import type { FileCollaborationTransaction } from './types';

type ArchivedLineageRow = {
  id: string;
};

async function materializeLegacyLineagesInPathScope(
  transaction: FileCollaborationTransaction,
  params: {
    workspace: WorkspaceContext;
    path: string;
    nowMs: number;
    createLineageId: () => string;
  },
): Promise<void> {
  const rows = await transaction.all(`
    SELECT DISTINCT path
    FROM file_revisions
    WHERE workspace_id = $1
      AND lineage_id IS NULL
      AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
    ORDER BY path
  `, [params.workspace.workspaceId, params.path]) as Array<{ path: string }>;

  for (const row of rows) {
    await ensureActiveFileLineage(transaction, {
      id: params.createLineageId(),
      workspace: params.workspace,
      path: row.path,
      nowMs: params.nowMs,
    });
  }
}

async function archiveActivePathScope(
  transaction: FileCollaborationTransaction,
  params: {
    workspaceId: string;
    path: string;
    nowMs: number;
    trashEntryId?: string | null;
  },
): Promise<void> {
  await transaction.run(`
    UPDATE file_collaboration_lineages
    SET status = 'archived', archived_at = $1, trash_entry_id = $2
    WHERE workspace_id = $3
      AND status = 'active'
      AND (path = $4 OR left(path, char_length($4) + 1) = $4 || '/')
  `, [params.nowMs, params.trashEntryId ?? null, params.workspaceId, params.path]);
  await transaction.run(`
    UPDATE collaboration_documents
    SET status = 'archived', updated_at = $1
    WHERE workspace_id = $2
      AND status = 'active'
      AND (path = $3 OR left(path, char_length($3) + 1) = $3 || '/')
  `, [params.nowMs, params.workspaceId, params.path]);
  await transaction.run(`
    UPDATE file_locks
    SET status = 'released', updated_at = $1
    WHERE workspace_id = $2
      AND status = 'active'
      AND (path = $3 OR left(path, char_length($3) + 1) = $3 || '/')
  `, [params.nowMs, params.workspaceId, params.path]);
  await archivePersistedCollaborationStatePathScopes(transaction, {
    workspaceId: params.workspaceId,
    paths: [params.path],
    nowMs: params.nowMs,
  });
}

export async function archivePersistedCollaborationStatePathScopes(
  transaction: FileCollaborationTransaction,
  params: {
    workspaceId: string;
    paths: string[];
    nowMs: number;
  },
): Promise<void> {
  for (const filePath of params.paths) {
    await transaction.run(`
      UPDATE collaboration_agent_operations
      SET status = 'cancelled',
          cancel_requested_at = $1,
          error_code = 'document_deleted',
          updated_at = $1,
          cas_version = cas_version + 1
      WHERE document_id IN (
        SELECT document_id
        FROM collaboration_yjs_states
        WHERE workspace_id = $2
          AND status = 'active'
          AND (path = $3 OR left(path, char_length($3) + 1) = $3 || '/')
      )
        AND status NOT IN (
          'checkpointed_file', 'cancelled', 'expired', 'superseded',
          'failed', 'rejected', 'reverted'
        )
    `, [params.nowMs, params.workspaceId, filePath]);
    await transaction.run(`
      UPDATE collaboration_yjs_states
      SET status = 'archived', lifecycle_generation = lifecycle_generation + 1
      WHERE workspace_id = $1
        AND status = 'active'
        AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
    `, [params.workspaceId, filePath]);
    await transaction.run(`
      UPDATE collaboration_excalidraw_states
      SET status = 'archived', lifecycle_generation = lifecycle_generation + 1
      WHERE workspace_id = $1
        AND status = 'active'
        AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
    `, [params.workspaceId, filePath]);
  }
}

async function remapActivePathScope(
  transaction: FileCollaborationTransaction,
  table:
    | 'file_collaboration_lineages'
    | 'collaboration_documents'
    | 'file_locks'
    | 'collaboration_yjs_states'
    | 'collaboration_excalidraw_states',
  params: {
    workspaceId: string;
    oldPath: string;
    newPath: string;
  },
): Promise<void> {
  await transaction.run(`
    UPDATE ${table}
    SET path = $1 || substring(path FROM char_length($2) + 1)
    WHERE workspace_id = $3
      AND status = 'active'
      AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
  `, [params.newPath, params.oldPath, params.workspaceId]);
}

export async function movePersistedCollaborationStatePathScope(
  transaction: FileCollaborationTransaction,
  params: {
    workspaceId: string;
    oldPath: string;
    newPath: string;
  },
): Promise<void> {
  await remapActivePathScope(transaction, 'collaboration_yjs_states', params);
  await moveExcalidrawCollaborationStatePathScope(transaction, params);
}

export async function moveExcalidrawCollaborationStatePathScope(
  transaction: FileCollaborationTransaction,
  params: {
    workspaceId: string;
    oldPath: string;
    newPath: string;
  },
): Promise<void> {
  await remapActivePathScope(transaction, 'collaboration_excalidraw_states', params);
}

export async function reactivatePersistedCollaborationStatePathScope(
  transaction: FileCollaborationTransaction,
  params: {
    workspaceId: string;
    path: string;
  },
): Promise<void> {
  await transaction.run(`
    UPDATE collaboration_yjs_states
    SET status = 'active', lifecycle_generation = lifecycle_generation + 1, degraded = 0
    WHERE workspace_id = $1
      AND path = $2
      AND status = 'archived'
  `, [params.workspaceId, params.path]);
  await transaction.run(`
    UPDATE collaboration_excalidraw_states
    SET status = 'active', lifecycle_generation = lifecycle_generation + 1, degraded_reason = NULL
    WHERE workspace_id = $1
      AND path = $2
      AND status = 'archived'
  `, [params.workspaceId, params.path]);
}

export async function archiveFileCollaborationPathScopes(
  transaction: FileCollaborationTransaction,
  params: {
    workspace: WorkspaceContext;
    entries: Array<{ path: string; trashEntryId: string | null }>;
    nowMs: number;
    createLineageId: () => string;
  },
): Promise<void> {
  for (const entry of params.entries) {
    await materializeLegacyLineagesInPathScope(transaction, {
      workspace: params.workspace,
      path: entry.path,
      nowMs: params.nowMs,
      createLineageId: params.createLineageId,
    });
    await archiveActivePathScope(transaction, {
      workspaceId: params.workspace.workspaceId,
      path: entry.path,
      nowMs: params.nowMs,
      trashEntryId: entry.trashEntryId,
    });
  }
}

export async function restoreFileCollaborationPathScope(
  transaction: FileCollaborationTransaction,
  params: {
    workspaceId: string;
    path: string;
    trashEntryId: string;
    nowMs: number;
  },
): Promise<boolean> {
  const archived = await transaction.all(`
    SELECT id
    FROM file_collaboration_lineages
    WHERE workspace_id = $1
      AND status = 'archived'
      AND trash_entry_id = $3
      AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
    ORDER BY archived_at DESC, id DESC
    FOR UPDATE
  `, [params.workspaceId, params.path, params.trashEntryId]) as ArchivedLineageRow[];
  if (archived.length === 0) return false;

  await archiveActivePathScope(transaction, {
    workspaceId: params.workspaceId,
    path: params.path,
    nowMs: params.nowMs,
  });
  await transaction.run(`
    UPDATE file_collaboration_lineages
    SET status = 'active', archived_at = NULL, trash_entry_id = NULL
    WHERE id = ANY($1::text[])
  `, [archived.map((lineage) => lineage.id)]);
  await transaction.run(`
    WITH latest_documents AS (
      SELECT DISTINCT ON (lineage_id, provider) id
      FROM collaboration_documents
      WHERE lineage_id = ANY($1::text[])
        AND status = 'archived'
      ORDER BY lineage_id, provider, updated_at DESC, id DESC
    )
    UPDATE collaboration_documents AS documents
    SET status = 'active', updated_at = $2
    FROM latest_documents
    WHERE documents.id = latest_documents.id
  `, [archived.map((lineage) => lineage.id), params.nowMs]);
  await transaction.run(`
    UPDATE collaboration_yjs_states AS states
    SET status = 'active', lifecycle_generation = lifecycle_generation + 1, degraded = 0
    WHERE states.status = 'archived'
      AND states.document_id IN (
        SELECT documents.id
        FROM collaboration_documents AS documents
        WHERE documents.lineage_id = ANY($1::text[])
          AND documents.provider = 'yjs'
          AND documents.status = 'active'
      )
  `, [archived.map((lineage) => lineage.id)]);
  await transaction.run(`
    UPDATE collaboration_excalidraw_states AS states
    SET status = 'active', lifecycle_generation = lifecycle_generation + 1, degraded_reason = NULL
    WHERE states.status = 'archived'
      AND states.document_id IN (
        SELECT documents.id
        FROM collaboration_documents AS documents
        WHERE documents.lineage_id = ANY($1::text[])
          AND documents.provider = 'excalidraw'
          AND documents.status = 'active'
      )
  `, [archived.map((lineage) => lineage.id)]);
  return true;
}

export async function initializeCopiedFileCollaborationPathScopes(
  transaction: FileCollaborationTransaction,
  params: {
    workspace: WorkspaceContext;
    paths: string[];
    nowMs: number;
    createLineageId: () => string;
  },
): Promise<void> {
  for (const filePath of params.paths) {
    await materializeLegacyLineagesInPathScope(transaction, {
      workspace: params.workspace,
      path: filePath,
      nowMs: params.nowMs,
      createLineageId: params.createLineageId,
    });
    await archiveActivePathScope(transaction, {
      workspaceId: params.workspace.workspaceId,
      path: filePath,
      nowMs: params.nowMs,
    });
    await ensureActiveFileLineage(transaction, {
      id: params.createLineageId(),
      workspace: params.workspace,
      path: filePath,
      nowMs: params.nowMs,
    });
  }
}

export async function moveFileCollaborationPathScope(
  transaction: FileCollaborationTransaction,
  params: {
    workspace: WorkspaceContext;
    oldPath: string;
    newPath: string;
    nowMs: number;
    createLineageId: () => string;
  },
): Promise<void> {
  await materializeLegacyLineagesInPathScope(transaction, {
    workspace: params.workspace,
    path: params.oldPath,
    nowMs: params.nowMs,
    createLineageId: params.createLineageId,
  });
  await archiveActivePathScope(transaction, {
    workspaceId: params.workspace.workspaceId,
    path: params.newPath,
    nowMs: params.nowMs,
  });

  for (const table of [
    'file_collaboration_lineages',
    'collaboration_documents',
    'file_locks',
  ] as const) {
    await remapActivePathScope(transaction, table, {
      workspaceId: params.workspace.workspaceId,
      oldPath: params.oldPath,
      newPath: params.newPath,
    });
  }
  await movePersistedCollaborationStatePathScope(transaction, {
    workspaceId: params.workspace.workspaceId,
    oldPath: params.oldPath,
    newPath: params.newPath,
  });
}
