import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import type { PersistedCollaborationState } from './persistence';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from './checkpoint-errors';

/** Same identity/scope predicate for recovery scans and the file-write fence. */
export const currentProjectionIdentityJoins = `
  INNER JOIN collaboration_documents c ON c.id = y.document_id
    AND c.workspace_id = y.workspace_id AND c.path = y.path
    AND c.provider = 'yjs' AND c.status = 'active'
    AND c.organization_id IS NOT DISTINCT FROM y.organization_id
  INNER JOIN canvas_workspaces w ON w.id = y.workspace_id AND w.status = 'active'
    AND w.organization_id IS NOT DISTINCT FROM y.organization_id AND w.type = c.workspace_type`;

export class CollaborationProjectionIdentityError extends Error {
  readonly code = COLLABORATION_CHECKPOINT_ERROR_CODES.identityMismatch;
  constructor() {
    super('Collaboration projection no longer owns the current document identity or workspace scope.');
    this.name = 'CollaborationProjectionIdentityError';
  }
}

/** Call under the workspace mutation lock, before any receipt or file mutation. */
export async function assertCurrentCollaborationProjectionIdentity(
  state: PersistedCollaborationState,
  transaction?: Pick<SqlConnection, 'get'>,
): Promise<void> {
  const database = transaction ?? await openDb();
  try {
    const row = await database.get(`SELECT y.document_id FROM collaboration_yjs_states y
      ${currentProjectionIdentityJoins}
      WHERE y.document_id = $1 AND y.workspace_id = $2 AND y.path = $3
        AND y.organization_id IS NOT DISTINCT FROM $4
        AND y.lifecycle_generation = $5 AND y.representation = $6 AND y.schema_version = $7
        AND y.status = 'active'`, [state.documentId, state.workspaceId, state.path, state.organizationId,
      state.lifecycleGeneration, state.representation, state.schemaVersion]);
    if (!row) throw new CollaborationProjectionIdentityError();
  } finally {
    if (!transaction) await (database as SqlConnection).close();
  }
}
