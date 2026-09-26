import 'server-only';

import type { FileVersionCenterTransaction } from './database';

/**
 * Lock the existing collaboration identity in the same row order as file
 * revision/checkpoint initialization: lineage, document, then Yjs state.
 * A joined FOR UPDATE can lock those joined rows in planner-dependent order,
 * deadlocking against the lineage-then-document checkpoint UPSERTs.
 *
 * The caller must still read and validate the complete scoped identity after
 * this returns. Null means a row disappeared, was rebound, or never existed.
 */
export async function lockProposalDocumentIdentityRows(
  sql: FileVersionCenterTransaction,
  input: { documentId: string; workspaceId: string },
): Promise<string | null> {
  const values = [input.documentId, input.workspaceId];
  const reference = (await sql.query<{ lineage_id: string | null }>(`
    SELECT lineage_id FROM collaboration_documents WHERE id = $1 AND workspace_id = $2
  `, values)).rows[0];
  if (!reference?.lineage_id) return null;
  const lineage = (await sql.query<{ id: string }>(`
    SELECT id FROM file_collaboration_lineages WHERE id = $1 AND workspace_id = $2 FOR UPDATE
  `, [reference.lineage_id, input.workspaceId])).rows[0];
  if (!lineage) return null;
  const document = (await sql.query<{ lineage_id: string | null }>(`
    SELECT lineage_id FROM collaboration_documents WHERE id = $1 AND workspace_id = $2 FOR UPDATE
  `, values)).rows[0];
  if (document?.lineage_id !== reference.lineage_id) return null;
  const state = (await sql.query<{ document_id: string }>(`
    SELECT document_id FROM collaboration_yjs_states WHERE document_id = $1 AND workspace_id = $2 FOR UPDATE
  `, values)).rows[0];
  return state ? reference.lineage_id : null;
}
