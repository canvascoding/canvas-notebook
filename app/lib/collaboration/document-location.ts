import 'server-only';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import type { TextCollaborationRepresentation } from './types';

export type CollaborationDocumentLocation = {
  workspaceId: string;
  documentId: string;
  path: string;
  lifecycleGeneration: number;
  representation: TextCollaborationRepresentation;
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
        SELECT state.document_id, state.path, state.lifecycle_generation, state.representation
        FROM collaboration_yjs_states AS state
        INNER JOIN collaboration_documents AS document
          ON document.id = state.document_id AND document.workspace_id = state.workspace_id
          AND document.path = state.path AND document.provider = 'yjs' AND document.status = 'active'
        WHERE state.document_id = ? AND state.workspace_id = ? AND state.status = 'active'
        LIMIT 1
      `, [documentId, workspaceId]) as {
        document_id: string; path: string; lifecycle_generation: number | string;
        representation: TextCollaborationRepresentation;
      } | undefined;
      return row ? { workspaceId, documentId: row.document_id, path: row.path,
        lifecycleGeneration: Number(row.lifecycle_generation), representation: row.representation } : null;
    } finally { await database.close(); }
  });
}
