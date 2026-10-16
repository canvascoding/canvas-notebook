import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import type { SqlConnection } from '../db';
import { COLLABORATION_NATIVE_COPY_IMMUTABLE_BODY, COLLABORATION_NATIVE_COPY_IMMUTABLE_FUNCTION,
  COLLABORATION_NATIVE_COPY_IMMUTABLE_TRIGGER } from '../db/collaboration-native-copy-migration';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { isCollaborationStateProof } from './state-proof';
import type { NativeCopyReceipt, NativeCopyDocumentReceipt } from './native-copy-persistence';

const TABLE = 'collaboration_native_copy_receipts';
const MAX_COMPACT_BYTES = 8 * 1024 * 1024;
// jsonb::text adds whitespace to the compact JSON accepted by the original writer.
const MAX_SQL_BYTES = 2 * MAX_COMPACT_BYTES;
type Row = Record<string, unknown>;
type Code = 'NATIVE_COPY_HISTORY_INVALID' | 'NATIVE_COPY_HISTORY_TOO_LARGE'
  | 'NATIVE_COPY_HISTORY_STORAGE_CHANGED' | 'NATIVE_COPY_HISTORY_SCOPE_CHANGED'
  | 'NATIVE_COPY_HISTORY_TRANSACTION_CHANGED' | 'NATIVE_COPY_HISTORY_UNCONFIRMED';

export class NativeCopyHistoryError extends Error {
  readonly status = 409;
  constructor(readonly code: Code) { super(code); this.name = 'NativeCopyHistoryError'; }
}
function fail(code: Code = 'NATIVE_COPY_HISTORY_INVALID'): never { throw new NativeCopyHistoryError(code); }
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
function oid(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 4294967295) fail('NATIVE_COPY_HISTORY_STORAGE_CHANGED');
  return number;
}
function schema(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value) && !value.startsWith('pg_');
}
function record(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) fail();
  return value as Row;
}
function array(value: unknown, maximum = Number.MAX_SAFE_INTEGER): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Literal storage identities. These data neither authorize a reader nor confer
 * claim, lifecycle, principal, connection or mutation capabilities. */
export type NativeCopyReceiptStorageIdentity = Readonly<{
  schemaName: string; schemaOid: number; databaseOid: number; tableOid: number; functionOid: number; triggerOid: number;
}>;

/** The caller chooses the already proven operation schema. Never infer a new
 * authority realm from a caller-controlled search_path during recovery. */
export async function readNativeCopyReceiptStorageIdentityOnConnection(database: SqlConnection,
  schemaName: string): Promise<NativeCopyReceiptStorageIdentity> {
  if (!schema(schemaName)) fail('NATIVE_COPY_HISTORY_STORAGE_CHANGED');
  const relation = await database.get(`SELECT c.oid::bigint AS table_oid,n.oid::bigint AS schema_oid,
    n.nspname AS schema_name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass($1)::oid::bigint AS resolved_oid,pg_catalog.current_schema() AS current_schema,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid=pg_catalog.to_regclass($2)`, [TABLE, `${quote(schemaName)}.${quote(TABLE)}`]) as Row | undefined;
  if (!relation || relation.schema_name !== schemaName || relation.current_schema !== schemaName
    || relation.relkind !== 'r' || relation.relpersistence !== 'p' || relation.relrowsecurity !== false
    || relation.relforcerowsecurity !== false || oid(relation.resolved_oid) !== oid(relation.table_oid)) {
    fail('NATIVE_COPY_HISTORY_STORAGE_CHANGED');
  }
  const triggers = await database.all(`SELECT t.oid::bigint AS trigger_oid,t.tgname,t.tgtype,t.tgenabled,t.tgisinternal,
    t.tgnargs,t.tgqual::text AS qualification,t.tgattr::text AS attributes,t.tgdeferrable,t.tginitdeferred,
    t.tgconstraint::bigint AS constraint_oid,p.oid::bigint AS function_oid,p.proname,p.pronamespace::bigint AS function_schema,
    p.prosrc,p.prosecdef,p.proconfig,p.prokind,p.pronargs,p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger,l.lanname
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE t.tgrelid=$1::oid ORDER BY t.oid LIMIT 3`,
  [oid(relation.table_oid)]) as Row[];
  if (triggers.length !== 1) fail('NATIVE_COPY_HISTORY_STORAGE_CHANGED');
  const trigger = triggers[0];
  if (trigger.tgname !== COLLABORATION_NATIVE_COPY_IMMUTABLE_TRIGGER || Number(trigger.tgtype) !== 27
    || !['O', 'A'].includes(String(trigger.tgenabled)) || trigger.tgisinternal !== false || Number(trigger.tgnargs) !== 0
    || trigger.qualification !== null || trigger.attributes !== '' || trigger.tgdeferrable !== false
    || trigger.tginitdeferred !== false || Number(trigger.constraint_oid) !== 0
    || trigger.proname !== COLLABORATION_NATIVE_COPY_IMMUTABLE_FUNCTION || oid(trigger.function_schema) !== oid(relation.schema_oid)
    || trigger.prosrc !== COLLABORATION_NATIVE_COPY_IMMUTABLE_BODY || trigger.prosecdef !== false || trigger.proconfig !== null
    || trigger.prokind !== 'f' || Number(trigger.pronargs) !== 0 || trigger.returns_trigger !== true || trigger.lanname !== 'plpgsql') {
    fail('NATIVE_COPY_HISTORY_STORAGE_CHANGED');
  }
  return Object.freeze({ schemaName, schemaOid: oid(relation.schema_oid), databaseOid: oid(relation.database_oid),
    tableOid: oid(relation.table_oid), functionOid: oid(trigger.function_oid), triggerOid: oid(trigger.trigger_oid) });
}

type HistoryInput = Readonly<{
  storage: NativeCopyReceiptStorageIdentity;
  workspaceId: string; organizationId: string | null; operationId: string; actorUserId: string; actorSessionId: string | null;
  kind: 'native_clone' | 'native_restore' | 'markdown_import'; requestFingerprint: string; publicationFingerprint: string | null;
}>;

async function transactionWitness(database: SqlConnection) {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS pid,a.backend_start::text AS backend_start,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.pg_current_xact_id_if_assigned()::text AS xid,
    (SELECT virtualtransaction FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='virtualxid' AND mode='ExclusiveLock' AND granted) AS virtual_transaction
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  if (!row || !integer(Number(row.pid), 1) || typeof row.backend_start !== 'string' || !row.backend_start
    || row.isolation !== 'repeatable read' || row.read_only !== 'on' || row.xid !== null
    || typeof row.search_path !== 'string' || typeof row.virtual_transaction !== 'string'
    || !/^[0-9]+\/[0-9]+$/u.test(row.virtual_transaction)) fail('NATIVE_COPY_HISTORY_TRANSACTION_CHANGED');
  return Object.freeze({ ...row });
}

function checkedInput(value: HistoryInput): HistoryInput {
  const captured = captureWorkspaceOperationNativePlanData(value, reason => fail(reason === 'too-large'
    ? 'NATIVE_COPY_HISTORY_TOO_LARGE' : 'NATIVE_COPY_HISTORY_INVALID')) as HistoryInput;
  record(captured, ['storage', 'workspaceId', 'organizationId', 'operationId', 'actorUserId', 'actorSessionId',
    'kind', 'requestFingerprint', 'publicationFingerprint']);
  const storage = record(captured.storage, ['schemaName', 'schemaOid', 'databaseOid', 'tableOid', 'functionOid', 'triggerOid']);
  if (!schema(storage.schemaName) || !id(captured.workspaceId) || !id(captured.operationId) || !id(captured.actorUserId)
    || captured.organizationId !== null && !id(captured.organizationId)
    || captured.actorSessionId !== null && !id(captured.actorSessionId)
    || !['native_clone', 'native_restore', 'markdown_import'].includes(captured.kind)
    || !hash(captured.requestFingerprint) || captured.publicationFingerprint !== null && !hash(captured.publicationFingerprint)) fail();
  for (const key of ['schemaOid', 'databaseOid', 'tableOid', 'functionOid', 'triggerOid']) {
    if (!integer(storage[key], 1) || storage[key] !== oid(storage[key])) fail();
  }
  return freeze(captured);
}

function checkedReceipt(value: unknown, scopes: unknown, input: HistoryInput): NativeCopyReceipt {
  // Bounds are checked in SQL before either JSONB value is transferred.
  const body = record(value, ['version', 'operationId', 'workspaceId', 'requestFingerprint', 'documents']);
  if (body.version !== 1 || body.operationId !== input.operationId || body.workspaceId !== input.workspaceId
    || body.requestFingerprint !== input.requestFingerprint) fail();
  const paths = array(scopes);
  if (!paths.length || paths.some(scope => !isCanonicalAdmissionPath(scope))
    || new Set(paths).size !== paths.length) fail();
  const cloneIds = new Set<string>(), lineageIds = new Set<string>(), clonePaths = new Set<string>();
  const sourceIds = new Set<string>();
  const documents: NativeCopyDocumentReceipt[] = [];
  for (const item of array(body.documents, 10_000)) {
    const document = record(item, ['version', 'source', 'clone', 'blockIdMapping']);
    const source = record(document.source, ['documentId', 'lifecycleGeneration', 'stateProof', 'documentSequence']);
    const clone = record(document.clone, ['documentId', 'lineageId', 'path', 'lifecycleGeneration', 'stateProof', 'initialSequence']);
    if (document.version !== 1 || !id(source.documentId) || !integer(source.lifecycleGeneration, 1)
      || !integer(source.documentSequence) || !isCollaborationStateProof(source.stateProof)
      || !id(clone.documentId) || clone.documentId === source.documentId || !id(clone.lineageId)
      || !isCanonicalAdmissionPath(clone.path)
      || clone.lifecycleGeneration !== 1 || clone.initialSequence !== 0 || !isCollaborationStateProof(clone.stateProof)
      || !paths.some(scope => clone.path === scope || (clone.path as string).startsWith(`${scope}/`))
      || cloneIds.has(clone.documentId) || lineageIds.has(clone.lineageId) || clonePaths.has(clone.path)) fail();
    cloneIds.add(clone.documentId); lineageIds.add(clone.lineageId); clonePaths.add(clone.path); sourceIds.add(source.documentId);
    if (!document.blockIdMapping || typeof document.blockIdMapping !== 'object' || Array.isArray(document.blockIdMapping)
      || Object.getPrototypeOf(document.blockIdMapping) !== Object.prototype) fail();
    // Source block IDs are dictionary keys, not DTO field names. The original
    // clone supports long IDs and names such as "constructor" or "__proto__".
    // Read data descriptors and create own properties without assigning a prototype.
    const mapping = Reflect.ownKeys(document.blockIdMapping).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(document.blockIdMapping, key);
      if (typeof key !== 'string' || !key || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      return [key, descriptor.value] as const;
    });
    const oldIds = new Set(mapping.map(([key]) => key)), newIds = mapping.map(([, mapped]) => mapped);
    if (mapping.some(([, mapped]) => !id(mapped) || oldIds.has(mapped as string))
      || new Set(newIds).size !== newIds.length) fail();
    documents.push({ version: 1, source: { documentId: source.documentId as string,
      lifecycleGeneration: source.lifecycleGeneration as number, stateProof: source.stateProof as string,
      documentSequence: source.documentSequence as number }, clone: { documentId: clone.documentId as string,
      lineageId: clone.lineageId as string, path: clone.path as string, lifecycleGeneration: 1,
      stateProof: clone.stateProof as string, initialSequence: 0 }, blockIdMapping: Object.fromEntries(mapping) });
  }
  if ([...cloneIds].some(cloneId => sourceIds.has(cloneId))) fail();
  const captured = { version: 1 as const, operationId: body.operationId as string, workspaceId: body.workspaceId as string,
    requestFingerprint: body.requestFingerprint as string, documents };
  if (Buffer.byteLength(JSON.stringify(captured)) > MAX_COMPACT_BYTES) fail('NATIVE_COPY_HISTORY_TOO_LARGE');
  return freeze({ ...captured, publicationStatus: 'published' });
}

/** Immutable historical facts only. Caller must authenticate and reauthorize
 * the current actor/workspaces and bind original request pins independently.
 * Opens no connection/TX, takes no row locks and never reads current documents.
 * A returned receipt cannot authorize a clone, publication or journal resume. */
export async function readHistoricalNativeWorkspaceCopyReceiptOnConnection(database: SqlConnection,
  supplied: HistoryInput): Promise<NativeCopyReceipt | null> {
  const input = checkedInput(supplied), before = await transactionWitness(database);
  const assertStorage = async () => {
    if (!isDeepStrictEqual(await readNativeCopyReceiptStorageIdentityOnConnection(database, input.storage.schemaName), input.storage)) {
      fail('NATIVE_COPY_HISTORY_STORAGE_CHANGED');
    }
  };
  await assertStorage();
  const table = `${quote(input.storage.schemaName)}.${quote(TABLE)}`;
  const header = await database.get(`SELECT version,publication_status,
    octet_length(workspace_id) AS workspace_bytes,octet_length(operation_id) AS operation_bytes,
    octet_length(actor_user_id) AS actor_bytes,octet_length(actor_session_id) AS session_bytes,
    octet_length(organization_id) AS organization_bytes,octet_length(kind) AS kind_bytes,
    octet_length(request_fingerprint) AS request_bytes,octet_length(publication_fingerprint) AS publication_bytes,
    octet_length(scope_paths::text) AS scope_bytes,octet_length(private_result::text) AS result_bytes
    FROM ${table} WHERE workspace_id=$1 AND operation_id=$2`, [input.workspaceId, input.operationId]) as Row | undefined;
  let receipt: NativeCopyReceipt | null = null;
  if (header) {
    const size = (key: string, maximum: number, nullable = false) => {
      const value = header[key];
      if (nullable && value === null) return;
      const bytes = Number(value);
      if (!integer(bytes) || bytes > maximum) fail('NATIVE_COPY_HISTORY_TOO_LARGE');
    };
    for (const key of ['workspace_bytes', 'operation_bytes', 'actor_bytes']) size(key, 1024);
    for (const key of ['session_bytes', 'organization_bytes']) size(key, 1024, true);
    size('kind_bytes', 32); size('request_bytes', 64); size('publication_bytes', 64, true);
    size('scope_bytes', MAX_SQL_BYTES); size('result_bytes', MAX_SQL_BYTES);
    if (header.version !== 1) fail();
    if (header.publication_status !== 'published') fail('NATIVE_COPY_HISTORY_UNCONFIRMED');
    // Repeat bounds in the payload SELECT itself. A concurrent alteration can
    // never make a formerly bounded header release an oversized JSON value.
    const row = await database.get(`SELECT workspace_id,operation_id,organization_id,actor_user_id,actor_session_id,
      version,kind,request_fingerprint,publication_fingerprint,publication_status,
      CASE WHEN octet_length(scope_paths::text)<=$3 THEN scope_paths ELSE NULL END AS scope_paths,
      CASE WHEN octet_length(private_result::text)<=$3 THEN private_result ELSE NULL END AS private_result
      FROM ${table} WHERE workspace_id=$1 AND operation_id=$2
        AND octet_length(workspace_id)<=1024 AND octet_length(operation_id)<=1024
        AND octet_length(actor_user_id)<=1024 AND (actor_session_id IS NULL OR octet_length(actor_session_id)<=1024)
        AND (organization_id IS NULL OR octet_length(organization_id)<=1024) AND octet_length(kind)<=32
        AND octet_length(request_fingerprint)<=64 AND (publication_fingerprint IS NULL OR octet_length(publication_fingerprint)<=64)`,
    [input.workspaceId, input.operationId, MAX_SQL_BYTES]) as Row | undefined;
    if (!row || row.workspace_id !== input.workspaceId || row.operation_id !== input.operationId || row.version !== 1
      || row.organization_id !== input.organizationId || row.actor_user_id !== input.actorUserId || row.actor_session_id !== input.actorSessionId
      || row.kind !== input.kind || row.request_fingerprint !== input.requestFingerprint
      || row.publication_fingerprint !== input.publicationFingerprint || row.publication_status !== 'published') {
      fail('NATIVE_COPY_HISTORY_SCOPE_CHANGED');
    }
    if (row.scope_paths === null || row.private_result === null) fail('NATIVE_COPY_HISTORY_TOO_LARGE');
    receipt = checkedReceipt(row.private_result, row.scope_paths, input);
  }
  await assertStorage();
  if (!isDeepStrictEqual(await transactionWitness(database), before)) fail('NATIVE_COPY_HISTORY_TRANSACTION_CHANGED');
  return receipt;
}
