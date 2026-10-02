import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import type { CollaborationDocumentRecord, CollaborationLineageRecord, CollaborationRevisionRecord } from '@/app/lib/files/collaboration-repository/types';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { authoritativeCollaborationSnapshot } from './checkpoint';
import { serializeCanonicalText, type PersistedCollaborationState } from './persistence';
import { recoveryHash } from './recovery-plan';
import { decodeRecoveryState, recoveryStateFingerprint, recoveryPostgresInteger } from './recovery-evidence';

export type HistoricalCollaborationIdentityImport = {
  operation: 'import_historical_identity';
  workspace: WorkspaceContext;
  expectedState: PersistedCollaborationState;
  expectedFileHash: string;
  /** Read the scoped file again while the caller retains its offline locks. */
  readCurrentFile: () => Promise<Uint8Array>;
  document: CollaborationDocumentRecord;
  revision: CollaborationRevisionRecord & { historyOnly: false };
  lineage?: CollaborationLineageRecord;
};

export class HistoricalCollaborationIdentityImportError extends Error {
  readonly code = 'COLLABORATION_RECOVERY_IDENTITY_IMPORT_REJECTED';
  constructor(readonly reason: string) {
    super(`Historical collaboration identity import rejected: ${reason}.`);
    this.name = 'HistoricalCollaborationIdentityImportError';
  }
}

type Row = Record<string, unknown>;
function reject(reason: string): never { throw new HistoricalCollaborationIdentityImportError(reason); }
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) reject(reason); }
const integer = recoveryPostgresInteger;
function validPath(value: string): boolean {
  try { return value !== '.' && normalizeWorkspaceRelativePath(value) === value; }
  catch { return false; }
}
function matchingRow(row: Row, fields: Row): boolean {
  return Object.entries(fields).every(([key, value]) => typeof value === 'number'
    ? integer(row[key]) === value : row[key] === value);
}
function scopedFields(workspace: WorkspaceContext, path: string): Row {
  return { organization_id: workspace.organizationId ?? null, customer_id: workspace.customerId ?? null,
    project_id: workspace.projectId ?? null, workspace_id: workspace.workspaceId, workspace_type: workspace.workspaceType, path };
}

/**
 * Explicit offline metadata import, never an SQLite read fallback. The caller
 * owns its SQL transaction, offline room/workspace fences, verified backup and
 * the read-only source evidence. This function grants no authority from source
 * metadata and never changes Yjs, file bytes, existing identities or revisions.
 */
export async function importHistoricalCollaborationIdentity(
  transaction: SqlConnection,
  input: HistoricalCollaborationIdentityImport,
): Promise<{ status: 'imported' | 'already_imported'; documentId: string; revisionId: string }> {
  // Capture mutable inputs before the first await, including the original binary.
  const workspace = { ...input.workspace };
  const expectedState = { ...input.expectedState, yjsState: Uint8Array.from(input.expectedState.yjsState),
    stateVector: Uint8Array.from(input.expectedState.stateVector),
    ...(input.expectedState.projectionError ? { projectionError: { ...input.expectedState.projectionError } } : {}) };
  const document = { ...input.document }; const revision = { ...input.revision };
  const lineage = input.lineage ? { ...input.lineage } : undefined;
  const expectedFileHash = input.expectedFileHash; const readCurrentFile = input.readCurrentFile;
  requireValue(input.operation === 'import_historical_identity', 'explicit_operation_required');
  requireValue(validPath(expectedState.path) && validPath(workspace.rootRelativePath ?? ''), 'noncanonical_path');
  requireValue(/^[a-f0-9]{64}$/u.test(expectedFileHash), 'invalid_file_hash');
  requireValue(expectedState.status === 'active' && !expectedState.degraded && !expectedState.projectionError
    && expectedState.documentSequence === expectedState.checkpointSequence && expectedState.checkpointSequence > 0,
  'state_not_verified_checkpoint');
  requireValue(expectedState.workspaceId === workspace.workspaceId
    && expectedState.organizationId === (workspace.organizationId ?? null), 'state_scope_mismatch');
  requireValue(document.id === expectedState.documentId && document.provider === 'yjs' && document.status === 'active'
    && document.stateVersion === expectedState.checkpointSequence && document.snapshotRevisionId === revision.id,
  'document_identity_mismatch');
  const scope = scopedFields(workspace, expectedState.path);
  const recordScope = (record: CollaborationDocumentRecord | CollaborationRevisionRecord | CollaborationLineageRecord) =>
    record.workspaceId === workspace.workspaceId && record.workspaceType === workspace.workspaceType
    && record.organizationId === (workspace.organizationId ?? null) && record.customerId === (workspace.customerId ?? null)
    && record.projectId === (workspace.projectId ?? null) && record.path === expectedState.path;
  requireValue(recordScope(document) && recordScope(revision) && (!lineage || recordScope(lineage)), 'historical_scope_mismatch');
  requireValue(document.lineageId === revision.lineageId && document.lineageId === (lineage?.id ?? null), 'lineage_binding_mismatch');
  requireValue(!lineage || (lineage.status === 'active' && lineage.archivedAt === null && lineage.trashEntryId === null), 'historical_lineage_archived');
  requireValue(revision.historyOnly === false && revision.contentHash === expectedFileHash
    && expectedState.serializedHash === expectedFileHash && integer(revision.revisionNumber) > 0
    && ['user', 'agent', 'automation', 'system'].includes(revision.createdByActorType), 'historical_revision_mismatch');
  for (const record of [document, revision, ...(lineage ? [lineage] : [])]) {
    requireValue(typeof record.id === 'string' && record.id.length > 0 && !record.id.includes('\0'), 'invalid_historical_id');
    integer(record.createdAt);
  }
  integer(document.stateVersion); integer(document.updatedAt); integer(revision.sizeBytes);
  requireValue(document.updatedAt >= document.createdAt, 'invalid_document_timestamp');

  const liveWorkspace = await transaction.get(`SELECT id, organization_id, customer_id, project_id, type,
    root_relative_path, status FROM canvas_workspaces WHERE id = $1 FOR UPDATE`, [workspace.workspaceId]) as Row | undefined;
  requireValue(liveWorkspace && matchingRow(liveWorkspace, { id: workspace.workspaceId,
    organization_id: workspace.organizationId ?? null, customer_id: workspace.customerId ?? null,
    project_id: workspace.projectId ?? null, type: workspace.workspaceType,
    root_relative_path: workspace.rootRelativePath, status: 'active' }), 'workspace_changed');
  const stateRow = await transaction.get('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE',
    [expectedState.documentId]) as Row | undefined;
  requireValue(stateRow && recoveryStateFingerprint(decodeRecoveryState(stateRow)) === recoveryStateFingerprint(expectedState), 'state_changed');
  // Validate the binary and its state vector independently of historical hashes.
  const canonical = authoritativeCollaborationSnapshot(expectedState).canonicalContent;
  requireValue(recoveryHash(canonical) === expectedState.canonicalHash
    && recoveryHash(serializeCanonicalText(canonical, expectedState)) === expectedFileHash, 'snapshot_hash_mismatch');
  const receipt = await transaction.get(`SELECT * FROM collaboration_file_projections
    WHERE document_id = $1 FOR UPDATE`, [expectedState.documentId]) as Row | undefined;
  requireValue(!receipt || matchingRow(receipt, { document_id: expectedState.documentId,
    lifecycle_generation: expectedState.lifecycleGeneration, projected_sequence: expectedState.checkpointSequence,
    revision_id: revision.id, canonical_hash: expectedState.canonicalHash, serialized_hash: expectedFileHash }),
  'projection_receipt_conflict');
  const file = await readCurrentFile();
  requireValue(file instanceof Uint8Array && recoveryHash(file) === expectedFileHash
    && file.byteLength === revision.sizeBytes, 'file_changed');

  const trash = await transaction.all(`SELECT original_path FROM workspace_trash_entries
    WHERE workspace_id = $1 AND status <> 'restored' FOR SHARE`, [workspace.workspaceId]) as Row[];
  requireValue(!trash.some((row) => typeof row.original_path === 'string'
    && (row.original_path === expectedState.path || expectedState.path.startsWith(row.original_path + '/'))), 'path_is_trashed');

  const documentFields = { id: document.id, ...scope, lineage_id: document.lineageId, provider: document.provider,
    state_version: document.stateVersion, snapshot_revision_id: document.snapshotRevisionId, status: 'active',
    created_at: document.createdAt, updated_at: document.updatedAt, yjs_state_lifecycle: 'initialized' };
  const revisionFields = { id: revision.id, ...scope, lineage_id: revision.lineageId, revision_number: revision.revisionNumber,
    content_hash: revision.contentHash, size_bytes: revision.sizeBytes, created_by_user_id: revision.createdByUserId,
    created_by_actor_type: revision.createdByActorType, source_session_id: revision.sourceSessionId,
    base_revision_id: revision.baseRevisionId, created_at: revision.createdAt, history_only: false };
  const lineageFields = lineage ? { id: lineage.id, ...scope, status: 'active', created_at: lineage.createdAt,
    archived_at: null, trash_entry_id: null } : null;
  const documents = await transaction.all(`SELECT * FROM collaboration_documents WHERE id = $1
    OR (workspace_id = $2 AND path = $3) OR ($4::text IS NOT NULL AND lineage_id = $4) FOR UPDATE`,
  [document.id, workspace.workspaceId, expectedState.path, document.lineageId]) as Row[];
  requireValue(documents.length === 0 || (documents.length === 1 && matchingRow(documents[0], documentFields)), 'existing_document_conflict');
  const lineages = await transaction.all(`SELECT * FROM file_collaboration_lineages WHERE ($1::text IS NOT NULL AND id = $1)
    OR (workspace_id = $2 AND path = $3) FOR UPDATE`, [lineage?.id ?? null, workspace.workspaceId, expectedState.path]) as Row[];
  requireValue(lineages.length === 0 || (lineages.length === 1 && lineageFields && matchingRow(lineages[0], lineageFields)), 'existing_lineage_conflict');
  const revisions = await transaction.all(`SELECT * FROM file_revisions WHERE id = $1
    OR (workspace_id = $2 AND path = $3) OR ($4::text IS NOT NULL AND lineage_id = $4) FOR UPDATE`,
  [revision.id, workspace.workspaceId, expectedState.path, revision.lineageId]) as Row[];
  const existingRevision = revisions.find((row) => row.id === revision.id);
  requireValue(revisions.every((row) => row.id === revision.id ? matchingRow(row, revisionFields)
    // An existing older revision belongs to this same historical lineage. It
    // remains unchanged; a newer checkpoint or unbound path history conflicts.
    : revision.lineageId !== null && matchingRow(row, { ...scope, lineage_id: revision.lineageId })
      && integer(row.revision_number) < revision.revisionNumber), 'existing_revision_conflict');
  if (revision.baseRevisionId !== null) {
    const base = await transaction.get(`SELECT * FROM file_revisions WHERE id = $1 FOR SHARE`, [revision.baseRevisionId]) as Row | undefined;
    requireValue(base && matchingRow(base, { ...scope, lineage_id: revision.lineageId })
      && integer(base.revision_number) < revision.revisionNumber, 'base_revision_not_verified');
  }
  const allExist = documents.length === 1 && existingRevision && (!lineage || lineages.length === 1);
  if (allExist) return { status: 'already_imported', documentId: document.id, revisionId: revision.id };

  // A caller may catch an error and continue its transaction: never leave a
  // half-import behind if a constraint or concurrent insert rejects a write.
  await transaction.run('SAVEPOINT collaboration_historical_identity_import');
  try {
    for (const [table, fields, existing] of [
      ['file_collaboration_lineages', lineageFields, lineages.length],
      ['file_revisions', revisionFields, existingRevision ? 1 : 0],
      ['collaboration_documents', documentFields, documents.length],
    ] as const) {
      if (!fields || existing) continue;
      const entries = Object.entries(fields);
      await transaction.run(`INSERT INTO ${table} (${entries.map(([key]) => key).join(', ')})
        VALUES (${entries.map((_, index) => '$' + (index + 1)).join(', ')})`, entries.map(([, value]) => value));
    }
    await transaction.run('RELEASE SAVEPOINT collaboration_historical_identity_import');
  } catch (error) {
    await transaction.run('ROLLBACK TO SAVEPOINT collaboration_historical_identity_import');
    await transaction.run('RELEASE SAVEPOINT collaboration_historical_identity_import');
    throw error;
  }
  return { status: 'imported', documentId: document.id, revisionId: revision.id };
}
