import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext, WorkspaceType } from '@/app/lib/workspaces/types';
import type { PersistedCollaborationState } from './persistence';
import type { CollaborationProjectionRequest } from './projection-scheduler';

// A binary update makes the first predicate true in the same durable write.
// The receipt closes the later crash window between checkpoint commit and
// metadata/share finalization. The final predicate also repairs legacy gaps.
const pendingProjectionPredicate = `(
  y.document_sequence > y.checkpoint_sequence
  OR (p.lifecycle_generation <= y.lifecycle_generation AND p.finalized = 0)
  OR (c.id IS NOT NULL AND c.state_version < y.checkpoint_sequence)
  OR (y.checkpoint_sequence > 0 AND (p.document_id IS NULL
    OR p.lifecycle_generation <> y.lifecycle_generation OR p.projected_sequence < y.checkpoint_sequence
    OR p.serialized_hash IS DISTINCT FROM y.serialized_hash))
)`;
const projectionJoins = `LEFT JOIN collaboration_file_projections p ON p.document_id = y.document_id
  LEFT JOIN collaboration_documents c ON c.id = y.document_id AND c.workspace_id = y.workspace_id
    AND c.path = y.path AND c.status = 'active' AND c.provider = 'yjs'`;

export async function listPendingCollaborationProjections(afterDocumentId = '', limit = 100): Promise<CollaborationProjectionRequest[]> {
  const database = await openDb();
  try {
    const rows = await database.all(`SELECT y.document_id, y.lifecycle_generation, y.document_sequence
      FROM collaboration_yjs_states y ${projectionJoins}
      WHERE y.status = 'active' AND y.document_id > $1 AND ${pendingProjectionPredicate}
      ORDER BY y.document_id LIMIT $2`, [afterDocumentId, Math.max(1, Math.min(500, limit))]) as Array<{
        document_id: string; lifecycle_generation: number; document_sequence: number;
      }>;
    return rows.map((row) => ({ documentId: row.document_id,
      lifecycleGeneration: Number(row.lifecycle_generation), documentSequence: Number(row.document_sequence) }));
  } finally { await database.close(); }
}

export async function hasPendingCollaborationProjection(state: PersistedCollaborationState): Promise<boolean> {
  const database = await openDb();
  try {
    const row = await database.get(`SELECT y.document_id FROM collaboration_yjs_states y ${projectionJoins}
      WHERE y.document_id = $1 AND y.lifecycle_generation = $2 AND y.status = 'active'
        AND ${pendingProjectionPredicate}`, [state.documentId, state.lifecycleGeneration]);
    return Boolean(row);
  } finally { await database.close(); }
}

/** Autocommit before file I/O; even a repeated projection of N is recoverable. */
export async function beginCollaborationProjectionAttempt(state: PersistedCollaborationState): Promise<void> {
  const database = await openDb();
  try {
    const row = await database.get(`INSERT INTO collaboration_file_projections (
        document_id, lifecycle_generation, projected_sequence, finalized, updated_at)
      SELECT document_id, lifecycle_generation, $3, 0, $4 FROM collaboration_yjs_states
      WHERE document_id = $1 AND lifecycle_generation = $2 AND status = 'active' AND document_sequence >= $3
        AND workspace_id = $5 AND path = $6 AND representation = $7 AND schema_version = $8
      ON CONFLICT(document_id) DO UPDATE SET lifecycle_generation = excluded.lifecycle_generation,
        projected_sequence = excluded.projected_sequence, finalized = 0, updated_at = excluded.updated_at,
        revision_id = NULL, canonical_hash = NULL, serialized_hash = NULL
      WHERE collaboration_file_projections.lifecycle_generation < excluded.lifecycle_generation
        OR (collaboration_file_projections.lifecycle_generation = excluded.lifecycle_generation
          AND collaboration_file_projections.projected_sequence <= excluded.projected_sequence)
      RETURNING document_id`, [state.documentId, state.lifecycleGeneration, state.documentSequence, Date.now(),
      state.workspaceId, state.path, state.representation, state.schemaVersion]);
    if (!row) throw new Error('Collaboration projection attempt has a stale document identity.');
  } finally { await database.close(); }
}

/** Called INSIDE the checkpoint metadata transaction, never after its commit. */
export async function recordCollaborationProjectionPending(
  transaction: Pick<SqlConnection, 'get'>,
  state: PersistedCollaborationState,
  result: { revisionId: string },
): Promise<void> {
  if (!state.canonicalHash || !state.serializedHash) throw new Error('Projection receipt requires checkpoint hashes.');
  const row = await transaction.get(`INSERT INTO collaboration_file_projections (
      document_id, lifecycle_generation, projected_sequence, revision_id, canonical_hash, serialized_hash, finalized, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
    ON CONFLICT(document_id) DO UPDATE SET
      lifecycle_generation = excluded.lifecycle_generation, projected_sequence = excluded.projected_sequence,
      revision_id = excluded.revision_id, canonical_hash = excluded.canonical_hash,
      serialized_hash = excluded.serialized_hash, finalized = 0, updated_at = excluded.updated_at
    WHERE collaboration_file_projections.lifecycle_generation < excluded.lifecycle_generation
      OR (collaboration_file_projections.lifecycle_generation = excluded.lifecycle_generation
        AND collaboration_file_projections.projected_sequence <= excluded.projected_sequence)
    RETURNING document_id`, [state.documentId, state.lifecycleGeneration, state.checkpointSequence,
    result.revisionId, state.canonicalHash, state.serializedHash, Date.now()]);
  if (!row) throw new Error('A newer collaboration projection receipt already exists.');
}

/** Called under the same workspace fence, after awaited metadata/share work. */
export async function finalizeCollaborationProjectionReceipt(state: PersistedCollaborationState, revisionId: string): Promise<void> {
  const database = await openDb();
  try {
    const row = await database.get(`UPDATE collaboration_file_projections p SET finalized = 1, updated_at = $1
      WHERE p.document_id = $2 AND p.lifecycle_generation = $3 AND p.projected_sequence = $4
        AND p.revision_id = $5 AND p.canonical_hash = $6 AND p.serialized_hash = $7
        AND EXISTS (SELECT 1 FROM collaboration_yjs_states y WHERE y.document_id = p.document_id
          AND y.lifecycle_generation = p.lifecycle_generation AND y.status = 'active' AND y.path = $8
          AND y.workspace_id = $9 AND y.checkpoint_sequence >= p.projected_sequence)
      RETURNING document_id`, [Date.now(), state.documentId, state.lifecycleGeneration, state.checkpointSequence,
      revisionId, state.canonicalHash, state.serializedHash, state.path, state.workspaceId]);
    if (!row) throw new Error('Collaboration projection receipt changed before finalization.');
  } finally { await database.close(); }
}

/** Internal storage context for projecting ALREADY authorized, persisted Yjs. */
export async function loadCollaborationProjectionWorkspace(state: PersistedCollaborationState): Promise<WorkspaceContext | null> {
  const database = await openDb();
  try {
    const row = await database.get(`SELECT id, organization_id, type, root_relative_path, status
      FROM canvas_workspaces WHERE id = $1 AND status = 'active'`, [state.workspaceId]) as {
        id: string; organization_id: string | null; type: WorkspaceType; root_relative_path: string; status: 'active';
      } | undefined;
    if (!row || row.organization_id !== state.organizationId) return null;
    return {
      workspaceId: row.id, workspaceType: row.type, organizationId: row.organization_id,
      rootPath: workspaceAbsoluteRoot(row.root_relative_path), rootRelativePath: row.root_relative_path,
      status: row.status, legacy: false,
      // This context is not exposed to agents or requests and authorizes no
      // document edits. Current lifecycle and file identity are fenced again.
      permissions: { canRead: true, canWrite: true, canDelete: false,
        canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false },
    };
  } finally { await database.close(); }
}
