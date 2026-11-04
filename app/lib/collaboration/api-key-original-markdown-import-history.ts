import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { ApiKeyOriginalMarkdownImportOrigin } from '../api-keys/document-read-principal';
import { MarkdownFileImportError } from './markdown-file-import';
import type { MarkdownOriginalImportSelectionV1 } from './markdown-original-import-contract';
import { apiKeyOriginalMarkdownImportOperationId, apiKeyOriginalMarkdownImportRequestId,
  apiKeyOriginalMarkdownImportPathVisible, decodeApiKeyOriginalMarkdownImportOrigin,
  decodeApiKeyOriginalMarkdownImportRecordV2, apiKeyOriginalMarkdownImportRecordDigest,
  apiKeyOriginalMarkdownImportRequestDigest, serializeApiKeyOriginalMarkdownImportRecordV2,
  type ApiKeyOriginalMarkdownImportRecordV2 } from './api-key-original-markdown-import-contract';

type Row = Record<string, unknown>;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function reject(code: MarkdownFileImportError['code'] = 'MARKDOWN_IMPORT_REQUEST_CONFLICT'): never {
  throw new MarkdownFileImportError(code);
}

/** Storage facts only. This does not create a principal or authenticate an
 * origin. The coordinator holds its genuine current key phase throughout. */
async function assertStorage(database: SqlConnection, origin: ApiKeyOriginalMarkdownImportOrigin): Promise<void> {
  const names = ['collaboration_original_markdown_import_api_keys', 'collaboration_markdown_file_import_receipts'];
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

/** No current pathname, document registry, projection or native content read.
 * Rotation changes current authority, never the original attribution. A native
 * receipt without its atomic key sidecar is an error, not permission to replay. */
export async function readApiKeyOriginalMarkdownImportRecordOnConnection(database: SqlConnection,
  currentInput: ApiKeyOriginalMarkdownImportOrigin, callerOperationId: string,
  expectedSelection?: MarkdownOriginalImportSelectionV1): Promise<ApiKeyOriginalMarkdownImportRecordV2 | null> {
  const current = decodeApiKeyOriginalMarkdownImportOrigin(currentInput);
  const operationId = apiKeyOriginalMarkdownImportOperationId(current, callerOperationId);
  await assertStorage(database, current);
  const prefix = quote(current.schema);
  const row = await database.get(`SELECT o.version,o.workspace_id,o.operation_id,o.request_digest,o.original_digest,o.import_fingerprint,
    CASE WHEN octet_length(o.original_text) BETWEEN 1 AND 65536 THEN o.original_text END AS original_text,
    o.created_at,r.version AS receipt_version,r.organization_id,r.actor_user_id,r.actor_session_id,r.request_id,
    r.request_fingerprint,r.created_at AS receipt_created_at,
    CASE WHEN octet_length(r.private_result::text) BETWEEN 1 AND 32768 THEN r.private_result::text END AS receipt_text,
    CASE WHEN octet_length(r.after_state_snapshot) BETWEEN 1 AND 8388608
      THEN 'yjs-snapshot-sha256-v1:'||encode(sha256(r.after_state_snapshot),'hex') END AS snapshot_proof,
    r.live_yjs_state_sha256,r.live_state_vector_sha256
    FROM ${prefix}.collaboration_original_markdown_import_api_keys o
    FULL JOIN ${prefix}.collaboration_markdown_file_import_receipts r USING(workspace_id,operation_id)
    WHERE coalesce(o.workspace_id,r.workspace_id)=$1 AND coalesce(o.operation_id,r.operation_id)=$2`,
  [current.workspaceId, operationId]) as Row | undefined;
  if (!row) return null;
  if (row.version !== 2 || row.workspace_id !== current.workspaceId || row.operation_id !== operationId
    || typeof row.original_text !== 'string' || typeof row.original_digest !== 'string'
    || createHash('sha256').update(row.original_text).digest('hex') !== row.original_digest) reject();
  let record: ApiKeyOriginalMarkdownImportRecordV2;
  try { record = decodeApiKeyOriginalMarkdownImportRecordV2(row.original_text); } catch { return reject(); }
  if (record.callerOperationId !== callerOperationId || apiKeyOriginalMarkdownImportRecordDigest(record) !== row.original_digest
    || apiKeyOriginalMarkdownImportRequestDigest(record) !== row.request_digest
    || Object.keys(current).some(key => !['credentialId', 'purpose', 'entryPoint'].includes(key)
      && Reflect.get(current, key) !== Reflect.get(record.origin, key))
    || current.entryPoint === 'mcp' && !apiKeyOriginalMarkdownImportPathVisible(record.selection.path)
    || expectedSelection && !equal(expectedSelection, record.selection)) reject();
  let stored: unknown;
  try { stored = typeof row.receipt_text === 'string' ? JSON.parse(row.receipt_text) : null; } catch { return reject(); }
  const receipt = record.receipt;
  if (row.receipt_version !== 1 || row.organization_id !== record.origin.organizationId
    || row.actor_user_id !== record.origin.userId || row.actor_session_id !== null
    || row.request_id !== apiKeyOriginalMarkdownImportRequestId(operationId)
    || row.import_fingerprint !== receipt.requestFingerprint || row.request_fingerprint !== receipt.requestFingerprint
    || !equal(stored, receipt) || Number(row.created_at) !== receipt.target.persistedAt
    || Number(row.receipt_created_at) !== receipt.target.persistedAt || row.snapshot_proof !== receipt.target.initialStateProof
    || ![row.live_yjs_state_sha256, row.live_state_vector_sha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) reject();
  return record;
}

export async function insertApiKeyOriginalMarkdownImportRecordOnConnection(database: SqlConnection,
  input: ApiKeyOriginalMarkdownImportRecordV2): Promise<void> {
  const record = decodeApiKeyOriginalMarkdownImportRecordV2(input), { selection, origin, receipt } = record;
  await assertStorage(database, origin);
  await database.run(`INSERT INTO ${quote(origin.schema)}.collaboration_original_markdown_import_api_keys
    (workspace_id,operation_id,version,request_digest,original_text,original_digest,import_fingerprint,created_at)
    VALUES($1,$2,2,$3,$4,$5,$6,$7)`, [selection.workspaceId, selection.operationId,
    apiKeyOriginalMarkdownImportRequestDigest(record), serializeApiKeyOriginalMarkdownImportRecordV2(record),
    apiKeyOriginalMarkdownImportRecordDigest(record), receipt.requestFingerprint, receipt.target.persistedAt]);
  const observed = await readApiKeyOriginalMarkdownImportRecordOnConnection(database, origin, record.callerOperationId, selection);
  if (!observed || !equal(observed, record)) reject('MARKDOWN_IMPORT_COMMIT_UNCONFIRMED');
}
