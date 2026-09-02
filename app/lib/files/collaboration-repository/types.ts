import type { SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type FileCollaborationTransaction = SqlConnection;

export type CollaborationLineageRecord = {
  id: string;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  path: string;
  status: 'active' | 'archived';
  createdAt: number;
  archivedAt: number | null;
  trashEntryId: string | null;
};

export type CollaborationRevisionRecord = {
  id: string;
  lineageId: string | null;
  revisionNumber: number;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  path: string;
  contentHash: string;
  sizeBytes: number;
  createdByUserId: string | null;
  createdByActorType: 'user' | 'agent' | 'automation' | 'system';
  sourceSessionId: string | null;
  baseRevisionId: string | null;
  createdAt: number;
};

export type CollaborationLockRecord = {
  id: string;
  lineageId: string | null;
  organizationId: string | null;
  customerId: string | null;
  projectId: string | null;
  workspaceId: string;
  workspaceType: WorkspaceContext['workspaceType'];
  path: string;
  revisionId: string | null;
  lockedByUserId: string | null;
  lockedBySessionId: string | null;
  lockType: 'edit' | 'upload' | 'agent_write';
  status: 'active' | 'released' | 'expired' | 'force_released';
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

export type CollaborationDocumentRecord = {
  id: string;
  lineageId: string | null;
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
};

export async function getRow<T>(
  connection: SqlConnection,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return await connection.get(sql, params) as T | undefined;
}
