import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import { MarkdownFileImportError } from './markdown-file-import';
import type { PristineOriginalRequestScopeExpectation } from './markdown-file-import-persistence';
import { decodeMarkdownOriginalImportRecordV1, markdownOriginalImportRecordDigest,
  markdownOriginalImportRequestDigest, markdownOriginalImportRequestId,
  type MarkdownOriginalImportRecordV1, type MarkdownOriginalImportSelectionV1 } from './markdown-original-import-contract';

type Row = Record<string, unknown>;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function reject(code: MarkdownFileImportError['code'] = 'MARKDOWN_IMPORT_REQUEST_CONFLICT'): never {
  throw new MarkdownFileImportError(code);
}

/** Historical facts only. The coordinating caller must hold its genuine
 * current Principal phase before and after every read or insertion. An origin
 * value, a stored record and this module never grant mutation authority. */
export async function assertMarkdownOriginalImportStorageOnConnection(database: SqlConnection,
  origin: PristineOriginalRequestScopeExpectation): Promise<void> {
  const names = ['collaboration_original_markdown_imports', 'collaboration_markdown_file_import_receipts'];
  const rows = await database.all(`SELECT n.name,c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,
    c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,
    pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved
    FROM pg_catalog.unnest($2::text[]) n(name) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(n.name))`, [quote(origin.schema), names]) as Row[];
  if (rows.length !== names.length || new Set(rows.map(row => row.name)).size !== names.length || rows.some(row =>
    !names.includes(String(row.name)) || !Number.isSafeInteger(Number(row.oid)) || Number(row.oid) < 1
    || Number(row.schema_oid) !== origin.schemaOid || Number(row.resolved) !== Number(row.oid)
    || row.relkind !== 'r' || row.relpersistence !== 'p' || row.relrowsecurity !== false
    || row.relforcerowsecurity !== false || row.relispartition !== false)) reject('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
}

/** Never reads today's pathname, projection, registry or native content. A
 * later move, archive or D2 at the original path cannot become this import. */
export async function readMarkdownOriginalImportRecordOnConnection(database: SqlConnection,
  current: PristineOriginalRequestScopeExpectation, operationId: string,
  expectedSelection?: MarkdownOriginalImportSelectionV1): Promise<MarkdownOriginalImportRecordV1 | null> {
  await assertMarkdownOriginalImportStorageOnConnection(database, current);
  const prefix = quote(current.schema);
  const row = await database.get(`SELECT o.version,o.workspace_id,o.operation_id,o.request_digest,o.original_digest,o.import_fingerprint,
    CASE WHEN octet_length(o.original_text) BETWEEN 1 AND 65536 THEN o.original_text END AS original_text,
    o.created_at,r.version AS receipt_version,r.organization_id,r.actor_user_id,r.actor_session_id,r.request_id,
    r.request_fingerprint,r.created_at AS receipt_created_at,
    CASE WHEN octet_length(r.private_result::text) BETWEEN 1 AND 32768 THEN r.private_result::text END AS receipt_text,
    CASE WHEN octet_length(r.after_state_snapshot) BETWEEN 1 AND 8388608
      THEN 'yjs-snapshot-sha256-v1:'||encode(sha256(r.after_state_snapshot),'hex') END AS snapshot_proof,
    r.live_yjs_state_sha256,r.live_state_vector_sha256
    FROM ${prefix}.collaboration_original_markdown_imports o
    LEFT JOIN ${prefix}.collaboration_markdown_file_import_receipts r USING(workspace_id,operation_id)
    WHERE o.workspace_id=$1 AND o.operation_id=$2`, [current.workspaceId, operationId]) as Row | undefined;
  if (!row) return null;
  if (row.version !== 1 || row.workspace_id !== current.workspaceId || row.operation_id !== operationId
    || typeof row.original_text !== 'string' || typeof row.original_digest !== 'string'
    || createHash('sha256').update(row.original_text).digest('hex') !== row.original_digest) reject();
  let record: MarkdownOriginalImportRecordV1;
  try { record = decodeMarkdownOriginalImportRecordV1(JSON.parse(row.original_text)); }
  catch { return reject(); }
  if (markdownOriginalImportRecordDigest(record) !== row.original_digest
    || row.request_digest !== markdownOriginalImportRequestDigest(record.selection, record.origin.userId)
    || record.selection.operationId !== operationId || record.selection.workspaceId !== current.workspaceId
    || Object.keys(current).some(key => key !== 'sessionId' && Reflect.get(current, key) !== Reflect.get(record.origin, key))) {
    reject();
  }
  if (expectedSelection && !equal(expectedSelection, record.selection)) reject();
  const receipt = record.receipt;
  let stored: unknown;
  try { stored = typeof row.receipt_text === 'string' ? JSON.parse(row.receipt_text) : null; }
  catch { return reject(); }
  if (row.receipt_version !== 1 || row.organization_id !== record.origin.organizationId
    || row.actor_user_id !== record.origin.userId || row.actor_session_id !== record.origin.sessionId
    || row.request_id !== markdownOriginalImportRequestId(record.selection.operationId)
    || row.import_fingerprint !== receipt.requestFingerprint || row.request_fingerprint !== receipt.requestFingerprint
    || !equal(stored, receipt) || Number(row.created_at) !== receipt.target.persistedAt
    || Number(row.receipt_created_at) !== receipt.target.persistedAt || row.snapshot_proof !== receipt.target.initialStateProof
    || ![row.live_yjs_state_sha256, row.live_state_vector_sha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) reject();
  return record;
}
