import 'server-only';

import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import { EXCALIDRAW_COPY_IMMUTABLE_BODY, EXCALIDRAW_COPY_IMMUTABLE_FUNCTION, EXCALIDRAW_COPY_IMMUTABLE_TRIGGER } from '../db/excalidraw-copy-migration';
import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from '../files/workspace-operation-copy-origin';
import { copyCapture, copyObject, copyHash, copyId, copyInteger, copyInvalid, captureExcalidrawCopyIntent,
  captureExcalidrawCopyBirthReceipt } from './copy-data';
import type { ExcalidrawCopyBirthReceipt, ExcalidrawCopyReceiptStorageIdentity } from './copy-contract';

const TABLE = 'collaboration_excalidraw_copy_receipts';
type Row = Record<string, unknown>;
function storageChanged(): never { return copyInvalid('EXCALIDRAW_COPY_STORAGE_CHANGED'); }
function transactionChanged(): never { return copyInvalid('EXCALIDRAW_COPY_TRANSACTION_CHANGED'); }
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const schema = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value) && !value.startsWith('pg_');
function oid(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || typeof value === 'string' && !/^[1-9][0-9]{0,9}$/u.test(value)) storageChanged();
  const parsed = Number(value); if (!copyInteger(parsed, 1) || parsed > 4294967295) storageChanged(); return parsed;
}
/** Pin at the genuine owner's storage boundary, before historical reads. This
 * observation grants no SQL, filesystem, current actor or publication authority. */
export async function readExcalidrawCopyReceiptStorageIdentityOnConnection(database: SqlConnection,
  schemaName: string): Promise<ExcalidrawCopyReceiptStorageIdentity> {
  if (!schema(schemaName)) storageChanged();
  const relation = await database.get(`SELECT c.oid::bigint AS table_oid,n.oid::bigint AS schema_oid,n.nspname AS schema_name,
    c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,pg_catalog.to_regclass($1)::oid::bigint AS resolved_oid,
    pg_catalog.current_schema() AS current_schema,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_catalog.to_regclass($2)`,
  [TABLE, `${quote(schemaName)}.${quote(TABLE)}`]) as Row | undefined;
  if (!relation || relation.schema_name !== schemaName || relation.current_schema !== schemaName || relation.relkind !== 'r'
    || relation.relpersistence !== 'p' || relation.relrowsecurity !== false || relation.relforcerowsecurity !== false
    || oid(relation.resolved_oid) !== oid(relation.table_oid)) storageChanged();
  const triggers = await database.all(`SELECT t.oid::bigint AS trigger_oid,t.tgname,t.tgtype,t.tgenabled,t.tgisinternal,t.tgnargs,
    t.tgqual::text AS qualification,t.tgattr::text AS attributes,t.tgdeferrable,t.tginitdeferred,t.tgconstraint::bigint AS constraint_oid,
    p.oid::bigint AS function_oid,p.proname,p.pronamespace::bigint AS function_schema,p.prosrc,p.prosecdef,p.proconfig,p.prokind,
    p.pronargs,p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger,l.lanname
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE t.tgrelid=$1::oid ORDER BY t.oid LIMIT 3`, [oid(relation.table_oid)]) as Row[];
  if (triggers.length !== 1) storageChanged();
  const trigger = triggers[0];
  if (trigger.tgname !== EXCALIDRAW_COPY_IMMUTABLE_TRIGGER || Number(trigger.tgtype) !== 27 || !['O', 'A'].includes(String(trigger.tgenabled))
    || trigger.tgisinternal !== false || Number(trigger.tgnargs) !== 0 || trigger.qualification !== null || trigger.attributes !== ''
    || trigger.tgdeferrable !== false || trigger.tginitdeferred !== false || Number(trigger.constraint_oid) !== 0
    || trigger.proname !== EXCALIDRAW_COPY_IMMUTABLE_FUNCTION || oid(trigger.function_schema) !== oid(relation.schema_oid)
    || trigger.prosrc !== EXCALIDRAW_COPY_IMMUTABLE_BODY || trigger.prosecdef !== false || trigger.proconfig !== null
    || trigger.prokind !== 'f' || Number(trigger.pronargs) !== 0 || trigger.returns_trigger !== true || trigger.lanname !== 'plpgsql') storageChanged();
  return Object.freeze({ schemaName, schemaOid: oid(relation.schema_oid), databaseOid: oid(relation.database_oid),
    tableOid: oid(relation.table_oid), functionOid: oid(trigger.function_oid), triggerOid: oid(trigger.trigger_oid) });
}
async function witness(database: SqlConnection): Promise<Row> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS pid,a.backend_start::text AS backend_start,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('search_path') AS search_path,pg_catalog.current_setting('session_replication_role') AS replication,
    pg_catalog.pg_current_xact_id_if_assigned()::text AS xid,
    (SELECT virtualtransaction FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='virtualxid' AND mode='ExclusiveLock' AND granted) AS virtual_transaction
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  if (!row || !copyInteger(Number(row.pid), 1) || typeof row.backend_start !== 'string' || !row.backend_start
    || row.isolation !== 'repeatable read' || row.read_only !== 'on' || row.xid !== null || row.replication !== 'origin'
    || typeof row.search_path !== 'string' || typeof row.virtual_transaction !== 'string' || !/^[0-9]+\/[0-9]+$/u.test(row.virtual_transaction)) transactionChanged();
  return Object.freeze({ ...row });
}
type HistoricalInput = Readonly<{ operationId: string; stageDigest: string; requestHash: string;
  origin: WorkspaceOperationCopyOrigin; storage: ExcalidrawCopyReceiptStorageIdentity }>;
/** Original ledger only. The caller authenticates/re-authorizes the current
 * workspaces and pins original request/storage separately. No stage files,
 * present-day Scene/asset/lineage/registry rows, blob IO, DML or row locks. */
export async function readHistoricalExcalidrawCopyOnConnection(database: SqlConnection,
  supplied: HistoricalInput): Promise<ExcalidrawCopyBirthReceipt | null> {
  const input = copyObject(copyCapture(supplied), ['operationId', 'stageDigest', 'requestHash', 'origin', 'storage']);
  if (!copyId(input.operationId) || !copyHash(input.stageDigest) || !copyHash(input.requestHash)) copyInvalid();
  const origin = decodeWorkspaceOperationCopyOrigin(input.origin);
  const storage = copyObject(input.storage, ['schemaName', 'schemaOid', 'databaseOid', 'tableOid', 'functionOid', 'triggerOid']);
  if (!schema(storage.schemaName)) storageChanged();
  for (const name of ['schemaOid', 'databaseOid', 'tableOid', 'functionOid', 'triggerOid']) if (storage[name] !== oid(storage[name])) storageChanged();
  const before = await witness(database);
  const assertStorage = async () => { if (!equal(await readExcalidrawCopyReceiptStorageIdentityOnConnection(database, storage.schemaName as string), storage)) storageChanged(); };
  await assertStorage(); const table = `${quote(storage.schemaName)}.${quote(TABLE)}`;
  const header = await database.get(`SELECT version,stage_digest,request_hash,native_request_fingerprint,intent_digest,b1_transaction_id,created_at,
    birth_digest,b2_transaction_id,completed_at,octet_length(intent_json::text) AS intent_bytes,octet_length(birth_json::text) AS birth_bytes
    FROM ${table} WHERE workspace_id=$1 AND operation_id=$2`, [origin.destinationScope.workspaceId, input.operationId]) as Row | undefined;
  let receipt: ExcalidrawCopyBirthReceipt | null = null;
  if (header) {
    if (header.version !== 1 || header.stage_digest !== input.stageDigest || header.request_hash !== input.requestHash
      || !copyHash(header.intent_digest) || !copyHash(header.native_request_fingerprint) || !copyHash(header.birth_digest)
      || !copyInteger(Number(header.created_at), 1) || !copyInteger(Number(header.completed_at), 1)
      || !copyInteger(Number(header.intent_bytes), 1) || Number(header.intent_bytes) > 16 * 1024 * 1024
      || !copyInteger(Number(header.birth_bytes), 1) || Number(header.birth_bytes) > 32 * 1024 * 1024) copyInvalid();
    const row = await database.get(`SELECT intent_json,birth_json FROM ${table} WHERE workspace_id=$1 AND operation_id=$2
      AND octet_length(intent_json::text)<=16777216 AND octet_length(birth_json::text)<=33554432`,
    [origin.destinationScope.workspaceId, input.operationId]) as Row | undefined;
    if (!row) copyInvalid();
    const intent = captureExcalidrawCopyIntent(row.intent_json); receipt = captureExcalidrawCopyBirthReceipt(row.birth_json);
    if (intent.operationId !== input.operationId || intent.stageDigest !== input.stageDigest || intent.requestHash !== input.requestHash
      || intent.intentDigest !== header.intent_digest || intent.nativeRequestFingerprint !== header.native_request_fingerprint
      || intent.b1TransactionId !== header.b1_transaction_id || intent.createdAt !== Number(header.created_at) || !equal(intent.origin, origin)
      || !equal(receipt.intent, intent) || receipt.receiptProof !== header.birth_digest || receipt.b2TransactionId !== header.b2_transaction_id
      || receipt.documents.some(document => document.persistedAt !== Number(header.completed_at))) copyInvalid();
  }
  await assertStorage(); if (!equal(await witness(database), before)) transactionChanged(); return receipt;
}
