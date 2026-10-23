import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import type { PersistedCollaborationState } from './persistence';
import { CollaborationCopyPublicationPendingError, COLLABORATION_CHECKPOINT_ERROR_CODES } from './checkpoint-errors';

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
    // Legacy/import-only projections retain their original contract. A pending
    // create birth can be consumed only by the module-private authenticated
    // I04 phase; no background/recovery caller may adopt a later peer inode.
    const exists = await database.get(`SELECT to_regclass('collaboration_markdown_create_births') IS NOT NULL AS available,
      to_regclass('collaboration_native_copy_receipts') IS NOT NULL AS copy_available,
      to_regclass('collaboration_native_copy_markdown_births') IS NOT NULL AS raw_copy_available`) as {
        available?: boolean; copy_available?: boolean; raw_copy_available?: boolean } | undefined;
    if (exists?.available === true) {
      // Advancing native generation cannot erase an unfinished physical birth.
      const birth = await database.get(`SELECT * FROM collaboration_markdown_create_births WHERE document_id=$1`,
      [state.documentId]) as Record<string, unknown> | undefined;
      if (birth) {
        const { assertAuthenticatedMarkdownBirthProjectionAllowed } = await import('./markdown-file-import-persistence');
        await assertAuthenticatedMarkdownBirthProjectionAllowed(database, state, birth);
      }
    }
    // A clone's file namespace belongs to its Copy/Restore owner until that
    // owner's physical publication is confirmed. Existing room drain targets
    // have no clone birth here and retain their normal checkpoint contract.
    if (exists?.copy_available === true && await database.get(`SELECT 1 AS pending
      FROM collaboration_native_copy_receipts
      WHERE workspace_id=$1 AND organization_id IS NOT DISTINCT FROM $2
        AND kind IN ('native_clone','native_restore')
        AND publication_status IN ('native_committed','publication_failed')
        AND private_result @> $3::jsonb LIMIT 1`, [state.workspaceId, state.organizationId,
      JSON.stringify({ documents: [{ clone: { documentId: state.documentId } }] })])) {
      throw new CollaborationCopyPublicationPendingError();
    }
    // Actual Raw-Copy births have no fabricated CloneReceipt.documents entry.
    // They retain their original Copy's publication fence across later native
    // sequences/generations. Only genuine B2 publication releases the projector.
    if (exists?.raw_copy_available === true && await database.get(`SELECT 1 AS pending
      FROM collaboration_native_copy_markdown_births b
      LEFT JOIN collaboration_native_copy_receipts p ON p.workspace_id=b.workspace_id AND p.operation_id=b.parent_operation_id
      WHERE b.document_id=$1 AND (b.workspace_id IS DISTINCT FROM $2 OR p.operation_id IS NULL
        OR p.organization_id IS DISTINCT FROM $3 OR p.kind IS DISTINCT FROM 'native_clone'
        OR p.publication_fingerprint IS DISTINCT FROM b.stage_digest
        OR p.publication_status IS DISTINCT FROM 'published') LIMIT 1`,
    [state.documentId,state.workspaceId,state.organizationId])) {
      throw new CollaborationCopyPublicationPendingError();
    }
  } finally {
    if (!transaction) await (database as SqlConnection).close();
  }
}
