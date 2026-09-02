import 'server-only';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  type CollaborationLineageRecord,
  type CollaborationRevisionRecord,
  type FileCollaborationTransaction,
  getRow,
} from './types';

type LineageRow = {
  id: string;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  status: 'active' | 'archived';
  created_at: number;
  archived_at: number | null;
  trash_entry_id: string | null;
};

type RevisionRow = {
  id: string;
  lineage_id: string | null;
  revision_number: number;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  content_hash: string;
  size_bytes: number;
  created_by_user_id: string | null;
  created_by_actor_type: CollaborationRevisionRecord['createdByActorType'];
  source_session_id: string | null;
  base_revision_id: string | null;
  created_at: number;
};

function mapLineage(row: LineageRow): CollaborationLineageRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    status: row.status,
    createdAt: Number(row.created_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    trashEntryId: row.trash_entry_id,
  };
}

function mapRevision(row: RevisionRow): CollaborationRevisionRecord {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    revisionNumber: Number(row.revision_number),
    organizationId: row.organization_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    contentHash: row.content_hash,
    sizeBytes: Number(row.size_bytes),
    createdByUserId: row.created_by_user_id,
    createdByActorType: row.created_by_actor_type,
    sourceSessionId: row.source_session_id,
    baseRevisionId: row.base_revision_id,
    createdAt: Number(row.created_at),
  };
}

export async function getActiveFileLineage(
  transaction: FileCollaborationTransaction,
  workspaceId: string,
  filePath: string,
): Promise<CollaborationLineageRecord | null> {
  const row = await getRow<LineageRow>(transaction, `
    SELECT *
    FROM file_collaboration_lineages
    WHERE workspace_id = $1 AND path = $2 AND status = 'active'
    LIMIT 1
  `, [workspaceId, filePath]);
  return row ? mapLineage(row) : null;
}

export async function ensureActiveFileLineage(
  transaction: FileCollaborationTransaction,
  params: {
    id: string;
    workspace: WorkspaceContext;
    path: string;
    nowMs: number;
  },
): Promise<CollaborationLineageRecord> {
  const row = await getRow<LineageRow>(transaction, `
    INSERT INTO file_collaboration_lineages (
      id, organization_id, customer_id, project_id, workspace_id, workspace_type,
      path, status, created_at, archived_at, trash_entry_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, NULL, NULL)
    ON CONFLICT (workspace_id, path) WHERE status = 'active'
    DO UPDATE SET
      organization_id = COALESCE(file_collaboration_lineages.organization_id, EXCLUDED.organization_id),
      customer_id = COALESCE(file_collaboration_lineages.customer_id, EXCLUDED.customer_id),
      project_id = COALESCE(file_collaboration_lineages.project_id, EXCLUDED.project_id)
    RETURNING *
  `, [
    params.id,
    params.workspace.organizationId ?? null,
    params.workspace.customerId ?? null,
    params.workspace.projectId ?? null,
    params.workspace.workspaceId,
    params.workspace.workspaceType,
    params.path,
    params.nowMs,
  ]);
  if (!row) throw new Error(`Failed to ensure collaboration lineage for ${params.path}.`);

  await transaction.run(`
    UPDATE file_revisions
    SET lineage_id = $1
    WHERE workspace_id = $2 AND path = $3 AND lineage_id IS NULL
  `, [row.id, params.workspace.workspaceId, params.path]);
  return mapLineage(row);
}

export async function getLatestFileRevisionForLineage(
  transaction: FileCollaborationTransaction,
  lineageId: string,
): Promise<CollaborationRevisionRecord | null> {
  const row = await getRow<RevisionRow>(transaction, `
    SELECT *
    FROM file_revisions
    WHERE lineage_id = $1
    ORDER BY revision_number DESC, id DESC
    LIMIT 1
  `, [lineageId]);
  return row ? mapRevision(row) : null;
}

export async function getLatestFileRevision(
  transaction: FileCollaborationTransaction,
  workspaceId: string,
  filePath: string,
): Promise<CollaborationRevisionRecord | null> {
  const lineage = await getActiveFileLineage(transaction, workspaceId, filePath);
  if (lineage) return getLatestFileRevisionForLineage(transaction, lineage.id);

  const row = await getRow<RevisionRow>(transaction, `
    SELECT *
    FROM file_revisions
    WHERE workspace_id = $1 AND path = $2 AND lineage_id IS NULL
    ORDER BY revision_number DESC, id DESC
    LIMIT 1
  `, [workspaceId, filePath]);
  return row ? mapRevision(row) : null;
}

export async function appendFileRevision(
  transaction: FileCollaborationTransaction,
  params: {
    id: string;
    lineageId: string;
    workspace: WorkspaceContext;
    path: string;
    contentHash: string;
    sizeBytes: number;
    createdByUserId?: string | null;
    createdByActorType: CollaborationRevisionRecord['createdByActorType'];
    sourceSessionId?: string | null;
    baseRevisionId?: string | null;
    nowMs: number;
  },
): Promise<CollaborationRevisionRecord> {
  const lineage = await getRow<{ id: string }>(transaction, `
    SELECT id
    FROM file_collaboration_lineages
    WHERE id = $1 AND status = 'active'
    FOR UPDATE
  `, [params.lineageId]);
  if (!lineage) throw new Error(`Active collaboration lineage ${params.lineageId} was not found.`);

  const nextRevision = await getRow<{ revision_number: number }>(transaction, `
    SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
    FROM file_revisions
    WHERE lineage_id = $1
  `, [params.lineageId]);
  const revisionNumber = Number(nextRevision?.revision_number ?? 1);
  const row = await getRow<RevisionRow>(transaction, `
    INSERT INTO file_revisions (
      id, organization_id, customer_id, project_id, workspace_id, workspace_type,
      path, content_hash, size_bytes, created_by_user_id, created_by_actor_type,
      source_session_id, base_revision_id, lineage_id, revision_number, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING *
  `, [
    params.id,
    params.workspace.organizationId ?? null,
    params.workspace.customerId ?? null,
    params.workspace.projectId ?? null,
    params.workspace.workspaceId,
    params.workspace.workspaceType,
    params.path,
    params.contentHash,
    params.sizeBytes,
    params.createdByUserId ?? null,
    params.createdByActorType,
    params.sourceSessionId ?? null,
    params.baseRevisionId ?? null,
    params.lineageId,
    revisionNumber,
    params.nowMs,
  ]);
  if (!row) throw new Error(`Failed to append collaboration revision for ${params.path}.`);
  return mapRevision(row);
}
