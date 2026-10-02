import 'server-only';

import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { CollaborationDocumentRecord, CollaborationLineageRecord, CollaborationRevisionRecord } from '@/app/lib/files/collaboration-repository/types';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';

export type HistoricalCollaborationIdentityEvidence = {
  document: CollaborationDocumentRecord;
  revision: CollaborationRevisionRecord & { historyOnly: false };
  lineage?: CollaborationLineageRecord;
};

export class HistoricalCollaborationEvidenceError extends Error {
  readonly code = 'COLLABORATION_RECOVERY_LEGACY_EVIDENCE_REJECTED';
  constructor(readonly reason: string, options?: ErrorOptions) {
    super(`Historical collaboration evidence rejected: ${reason}.`, options);
    this.name = 'HistoricalCollaborationEvidenceError';
  }
}

type Row = Record<string, unknown>;
type OfflineSqliteDatabase = {
  readonly readonly: boolean;
  defaultSafeIntegers(enabled: boolean): void;
  prepare(sql: string): { all(...parameters: unknown[]): Row[] };
  exec(sql: string): void;
  close(): void;
};
type OfflineSqliteConstructor = new (filename: string, options: { readonly: true; fileMustExist: true }) => OfflineSqliteDatabase;
const offlineRequire = createRequire(import.meta.url);
const MAX_RECORDS = 10_000;
const TABLES = ['collaboration_documents', 'file_revisions', 'file_collaboration_lineages'] as const;

function fail(reason: string): never { throw new HistoricalCollaborationEvidenceError(reason); }
function requireValue(value: unknown, reason: string): asserts value { if (!value) fail(reason); }
function text(value: unknown): string {
  requireValue(typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0'), 'invalid_text');
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function integer(value: unknown, minimum = 0): number {
  if (typeof value === 'bigint') {
    requireValue(value >= BigInt(minimum) && value <= BigInt(Number.MAX_SAFE_INTEGER), 'unsafe_integer');
    return Number(value);
  }
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, 'unsafe_integer');
  return value;
}
function flag(value: unknown): boolean {
  if (value === false || value === 0 || value === BigInt(0)) return false;
  if (value === true || value === 1 || value === BigInt(1)) return true;
  fail('invalid_flag');
}
function enumValue<T extends string>(value: unknown, choices: readonly T[]): T {
  requireValue(typeof value === 'string' && choices.includes(value as T), 'invalid_enum');
  return value as T;
}
function scope(row: Row) {
  const filePath = text(row.path);
  requireValue(filePath !== '.' && normalizeWorkspaceRelativePath(filePath) === filePath, 'noncanonical_path');
  return { organizationId: nullableText(row.organization_id), customerId: nullableText(row.customer_id),
    projectId: nullableText(row.project_id), workspaceId: text(row.workspace_id),
    workspaceType: enumValue(row.workspace_type, ['personal', 'organization', 'team', 'project'] as const), path: filePath };
}

/** Preserve logical IDs and raw epoch values; never infer a lineage from paths. */
export function decodeHistoricalCollaborationIdentity(
  documentRow: Row,
  revisionRow: Row,
  lineageRow?: Row,
): HistoricalCollaborationIdentityEvidence {
  const document: CollaborationDocumentRecord = {
    id: text(documentRow.id), ...scope(documentRow), lineageId: nullableText(documentRow.lineage_id),
    provider: enumValue(documentRow.provider, ['yjs', 'excalidraw'] as const), stateVersion: integer(documentRow.state_version),
    snapshotRevisionId: nullableText(documentRow.snapshot_revision_id),
    status: enumValue(documentRow.status, ['active', 'archived'] as const),
    createdAt: integer(documentRow.created_at), updatedAt: integer(documentRow.updated_at),
  };
  requireValue(document.updatedAt >= document.createdAt, 'invalid_document_timestamp');
  const contentHash = text(revisionRow.content_hash);
  requireValue(/^[a-f0-9]{64}$/u.test(contentHash), 'invalid_content_hash');
  // This column did not exist in the historical SQLite schema. If an evidence
  // file contains it, an explicit history-only row cannot become a checkpoint.
  requireValue(!Object.hasOwn(revisionRow, 'history_only') || !flag(revisionRow.history_only), 'history_only_revision');
  const revision: HistoricalCollaborationIdentityEvidence['revision'] = {
    id: text(revisionRow.id), ...scope(revisionRow), lineageId: nullableText(revisionRow.lineage_id),
    revisionNumber: integer(revisionRow.revision_number, 1), contentHash, sizeBytes: integer(revisionRow.size_bytes),
    createdByUserId: nullableText(revisionRow.created_by_user_id),
    createdByActorType: enumValue(revisionRow.created_by_actor_type, ['user', 'agent', 'automation', 'system'] as const),
    sourceSessionId: nullableText(revisionRow.source_session_id), baseRevisionId: nullableText(revisionRow.base_revision_id),
    createdAt: integer(revisionRow.created_at), historyOnly: false,
  };
  requireValue(document.snapshotRevisionId === revision.id && revision.baseRevisionId !== revision.id, 'revision_binding_mismatch');
  let lineage: CollaborationLineageRecord | undefined;
  if (lineageRow) {
    lineage = { id: text(lineageRow.id), ...scope(lineageRow),
      status: enumValue(lineageRow.status, ['active', 'archived'] as const), createdAt: integer(lineageRow.created_at),
      archivedAt: lineageRow.archived_at === null ? null : integer(lineageRow.archived_at),
      trashEntryId: nullableText(lineageRow.trash_entry_id) };
    requireValue(lineage.status === 'active' ? lineage.archivedAt === null && lineage.trashEntryId === null
      : lineage.archivedAt !== null && lineage.archivedAt >= lineage.createdAt, 'invalid_lineage_archive');
  }
  const sameScope = (record: CollaborationRevisionRecord | CollaborationLineageRecord) =>
    record.workspaceId === document.workspaceId && record.workspaceType === document.workspaceType
    && record.organizationId === document.organizationId && record.customerId === document.customerId
    && record.projectId === document.projectId && record.path === document.path;
  requireValue(sameScope(revision) && (!lineage || sameScope(lineage)), 'foreign_metadata');
  requireValue(document.lineageId === revision.lineageId && document.lineageId === (lineage?.id ?? null), 'lineage_binding_mismatch');
  return { document, revision, ...(lineage ? { lineage } : {}) };
}

function fileHash(filename: string): string {
  const descriptor = openSync(filename, 'r'); const hash = createHash('sha256'); const bytes = Buffer.alloc(1024 * 1024);
  try {
    for (let length = readSync(descriptor, bytes); length > 0; length = readSync(descriptor, bytes)) hash.update(bytes.subarray(0, length));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}

/**
 * Offline evidence extraction only. SQLite is optional external tooling and is
 * loaded only for this explicit call. No normal runtime path imports this file.
 * The input must be a closed, independent SQLite snapshot without WAL sidecars.
 */
export function exportHistoricalCollaborationIdentities(
  sqlitePath: string,
  documentIds: string[],
): HistoricalCollaborationIdentityEvidence[] {
  requireValue(path.isAbsolute(sqlitePath) && !sqlitePath.includes('\0'), 'absolute_evidence_path_required');
  const ids = [...documentIds];
  requireValue(ids.length <= MAX_RECORDS && ids.every((id) => typeof id === 'string' && id.length > 0
    && id === id.trim() && !id.includes('\0')) && new Set(ids).size === ids.length, 'invalid_requested_ids');
  ids.sort((left, right) => left.localeCompare(right));
  const before = lstatSync(sqlitePath);
  requireValue(before.isFile() && !before.isSymbolicLink(), 'regular_evidence_file_required');
  const sidecars = ['-wal', '-shm', '-journal'];
  requireValue(sidecars.every((suffix) => !existsSync(sqlitePath + suffix)), 'evidence_snapshot_has_sidecars');
  const beforeHash = fileHash(sqlitePath);
  let Constructor: OfflineSqliteConstructor;
  try {
    const loaded = offlineRequire('better-sqlite3') as OfflineSqliteConstructor | { default: OfflineSqliteConstructor };
    Constructor = typeof loaded === 'function' ? loaded : loaded.default;
    requireValue(typeof Constructor === 'function', 'sqlite_tooling_unavailable');
  } catch (error) {
    throw new HistoricalCollaborationEvidenceError('external_offline_sqlite_tooling_required', { cause: error });
  }
  const database = new Constructor(sqlitePath, { readonly: true, fileMustExist: true });
  const selectedRecords = new Set<string>(); const result: HistoricalCollaborationIdentityEvidence[] = [];
  try {
    requireValue(database.readonly === true, 'sqlite_readonly_required');
    database.defaultSafeIntegers(true);
    database.exec('BEGIN');
    // These are the actual historical table names. Schema reads do not inspect
    // user/auth/secret rows or allow a view to redirect the selected queries.
    const tables = database.prepare(`SELECT name, type, sql FROM sqlite_schema WHERE name IN (?, ?, ?)`).all(...TABLES);
    requireValue(tables.length === TABLES.length && TABLES.every((table) => tables.some((row) => row.name === table
      && row.type === 'table' && typeof row.sql === 'string' && /^CREATE\s+TABLE\s/iu.test(row.sql.trim()))), 'historical_schema_unavailable');
    const find = (table: typeof TABLES[number], id: string): Row => {
      const rows = database.prepare(`SELECT * FROM "${table}" WHERE id = ? LIMIT 2`).all(id);
      requireValue(rows.length === 1 && rows[0].id === id, 'missing_or_ambiguous_historical_id');
      selectedRecords.add(table + '\0' + id);
      requireValue(selectedRecords.size <= MAX_RECORDS, 'historical_record_limit');
      return rows[0];
    };
    for (const id of ids) {
      const document = find('collaboration_documents', id);
      const revisionId = text(document.snapshot_revision_id);
      const lineageId = nullableText(document.lineage_id);
      const revision = find('file_revisions', revisionId);
      const lineage = lineageId ? find('file_collaboration_lineages', lineageId) : undefined;
      result.push(decodeHistoricalCollaborationIdentity(document, revision, lineage));
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Preserve the original evidence error. */ }
    throw error;
  } finally { database.close(); }
  const after = lstatSync(sqlitePath);
  requireValue(before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.mode === after.mode && beforeHash === fileHash(sqlitePath)
    && sidecars.every((suffix) => !existsSync(sqlitePath + suffix)), 'evidence_file_changed');
  return result;
}
