import 'server-only';

import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  type CollaborationDocumentRecord,
  type FileCollaborationTransaction,
  getRow,
} from './types';

type DocumentRow = {
  id: string;
  lineage_id: string | null;
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  path: string;
  provider: CollaborationDocumentRecord['provider'];
  state_version: number;
  snapshot_revision_id: string | null;
  status: CollaborationDocumentRecord['status'];
  created_at: number;
  updated_at: number;
};

function mapDocument(row: DocumentRow): CollaborationDocumentRecord {
  return {
    id: row.id,
    lineageId: row.lineage_id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    path: row.path,
    provider: row.provider,
    stateVersion: Number(row.state_version),
    snapshotRevisionId: row.snapshot_revision_id,
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getActiveCollaborationDocument(
  transaction: FileCollaborationTransaction,
  workspaceId: string,
  filePath: string,
  provider: CollaborationDocumentRecord['provider'],
): Promise<CollaborationDocumentRecord | null> {
  const row = await getRow<DocumentRow>(transaction, `
    SELECT *
    FROM collaboration_documents
    WHERE workspace_id = $1 AND path = $2 AND provider = $3 AND status = 'active'
    LIMIT 1
  `, [workspaceId, filePath, provider]);
  return row ? mapDocument(row) : null;
}

export async function ensureCollaborationDocument(
  transaction: FileCollaborationTransaction,
  params: {
    id: string;
    lineageId: string;
    workspace: WorkspaceContext;
    path: string;
    provider: CollaborationDocumentRecord['provider'];
    snapshotRevisionId?: string | null;
    nowMs: number;
  },
): Promise<CollaborationDocumentRecord> {
  const row = await getRow<DocumentRow>(transaction, `
    INSERT INTO collaboration_documents (
      id, organization_id, customer_id, project_id, workspace_id, workspace_type,
      path, lineage_id, provider, state_version, snapshot_revision_id, status,
      created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, 'active', $11, $11)
    ON CONFLICT (workspace_id, path, provider) WHERE status = 'active'
    DO UPDATE SET
      lineage_id = COALESCE(collaboration_documents.lineage_id, EXCLUDED.lineage_id),
      snapshot_revision_id = COALESCE(collaboration_documents.snapshot_revision_id, EXCLUDED.snapshot_revision_id),
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `, [
    params.id,
    params.workspace.organizationId ?? null,
    params.workspace.customerId ?? null,
    params.workspace.projectId ?? null,
    params.workspace.workspaceId,
    params.workspace.workspaceType,
    params.path,
    params.lineageId,
    params.provider,
    params.snapshotRevisionId ?? null,
    params.nowMs,
  ]);
  if (!row) throw new Error(`Failed to ensure collaboration document for ${params.path}.`);
  return mapDocument(row);
}

export async function updateCollaborationDocumentCheckpoint(
  transaction: FileCollaborationTransaction,
  params: {
    workspaceId: string;
    path: string;
    documentId: string;
    stateVersion: number;
    revisionId: string;
    nowMs: number;
  },
): Promise<CollaborationDocumentRecord | null> {
  const row = await getRow<DocumentRow>(transaction, `
    UPDATE collaboration_documents
    SET snapshot_revision_id = $1, state_version = $2, updated_at = $3
    WHERE id = $4
      AND workspace_id = $5
      AND path = $6
      AND provider = 'yjs'
      AND status = 'active'
      AND state_version <= $2
    RETURNING *
  `, [
    params.revisionId,
    params.stateVersion,
    params.nowMs,
    params.documentId,
    params.workspaceId,
    params.path,
  ]);
  return row ? mapDocument(row) : null;
}
