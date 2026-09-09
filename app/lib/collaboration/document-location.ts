import 'server-only';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import type { TextCollaborationRepresentation } from './types';

export type CollaborationDocumentLocation = {
  workspaceId: string;
  documentId: string;
  path: string;
  // Identity metadata precedes the first session. Null means that no Yjs
  // generation has been created yet, not that the document was deleted.
  lifecycleGeneration: number | null;
  representation: TextCollaborationRepresentation | null;
};

/** Resolve committed identity metadata, including after missed rename events. */
export async function resolveCollaborationDocumentLocation(
  workspaceId: string,
  documentId: string,
): Promise<CollaborationDocumentLocation | null> {
  if (getDatabaseProvider() !== 'postgres') throw new Error('Live collaboration requires Postgres.');
  // A filesystem rename can be visible before its metadata commit or rollback.
  // Read under the same workspace lock so intermediate paths are never exposed.
  return withWorkspaceMutationLock(workspaceId, async () => {
    const database = await openDb();
    try {
      const row = await database.get(`
        SELECT document.id AS document_id, document.path, state.lifecycle_generation, state.representation
        FROM collaboration_documents AS document
        LEFT JOIN collaboration_yjs_states AS state ON state.document_id = document.id
        WHERE document.id = $1 AND document.workspace_id = $2
          AND document.provider = 'yjs' AND document.status = 'active'
          AND ((state.document_id IS NULL AND document.state_version = 0)
            OR (state.workspace_id = document.workspace_id AND state.path = document.path AND state.status = 'active'))
        LIMIT 1
      `, [documentId, workspaceId]) as {
        document_id: string; path: string; lifecycle_generation: number | string | null;
        representation: TextCollaborationRepresentation | null;
      } | undefined;
      return row ? { workspaceId, documentId: row.document_id, path: row.path,
        lifecycleGeneration: row.lifecycle_generation === null ? null : Number(row.lifecycle_generation),
        representation: row.representation } : null;
    } finally { await database.close(); }
  });
}
