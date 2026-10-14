/** Test-only direct-pg row adapter. Application code must not import this module. */
import assert from 'node:assert/strict';
import type { PersistedCollaborationState } from '../../app/lib/collaboration/persistence';

export type OwnedYjsStorageRow = {
  document_id: string; workspace_id: string; organization_id: string | null; path: string;
  representation: PersistedCollaborationState['representation']; lifecycle_generation: number | string;
  schema_version: number | string; yjs_state: Buffer; state_vector: Buffer;
  document_sequence: number | string; persisted_at: number | string; checkpointed_at: number | string | null;
  checkpoint_sequence: number | string; canonical_hash: string | null; serialized_hash: string | null;
  newline_style: string; has_bom: unknown; degraded: unknown; status: PersistedCollaborationState['status'];
  projection_error_code: string | null; projection_error_phase: string | null;
  projection_error_sequence: number | string | null; projection_error_generation: number | string | null;
  projection_error_permanent: unknown;
};

function sqlFlag(value: unknown): boolean {
  assert(value === 0 || value === 1 || value === '0' || value === '1', 'Owned native SQL flag is unavailable.');
  return value === 1 || value === '1';
}

/** No runtime imports, global pg parser changes or native content reconstruction. */
export function ownedYjsStateFromSqlRow(row: OwnedYjsStorageRow): PersistedCollaborationState {
  const hasBom = sqlFlag(row.has_bom), degraded = sqlFlag(row.degraded);
  // Validate even if an absent/stale error would otherwise omit the mapped flag.
  const permanent = sqlFlag(row.projection_error_permanent);
  const boundError = typeof row.projection_error_code === 'string' && row.projection_error_code.length > 0
    && Number(row.projection_error_generation) === Number(row.lifecycle_generation);
  assert(!permanent || boundError, 'Owned native permanent error binding is unavailable.');
  return {
    documentId: row.document_id, workspaceId: row.workspace_id, organizationId: row.organization_id, path: row.path,
    representation: row.representation, lifecycleGeneration: Number(row.lifecycle_generation), schemaVersion: Number(row.schema_version),
    yjsState: row.yjs_state, stateVector: row.state_vector, documentSequence: Number(row.document_sequence), persistedAt: Number(row.persisted_at),
    checkpointedAt: row.checkpointed_at === null ? null : Number(row.checkpointed_at), checkpointSequence: Number(row.checkpoint_sequence),
    canonicalHash: row.canonical_hash, serializedHash: row.serialized_hash, newlineStyle: row.newline_style === 'crlf' ? 'crlf' : 'lf',
    hasBom, degraded, status: row.status,
    ...(row.projection_error_code && Number(row.projection_error_generation) === Number(row.lifecycle_generation) ? {
      projectionError: { code: row.projection_error_code, phase: row.projection_error_phase as string | undefined,
        sequence: Number(row.projection_error_sequence), permanent },
    } : {}),
  };
}
