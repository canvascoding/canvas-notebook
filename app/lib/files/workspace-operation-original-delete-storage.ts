import 'server-only';

import { getTableConfig, type AnyPgTable } from 'drizzle-orm/pg-core';
import type { SqlConnection } from '../db';
import { collaborationDocuments, collaborationFileProjections, fileCollaborationLineages, workspaceTrashEntries,
  publicFileShares, fileGuestInvitations, fileLocks, workspaceFileMetadata, workspaceFileUserStates } from '../db/schema';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS } from '../db/native-file-operation-side-effects-migration';
import { WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS, WORKSPACE_OPERATION_ORIGINAL_DELETE_STATEMENTS,
  WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION } from '../db/workspace-operation-original-delete-migration';
import { NATIVE_LINK_MUTATION_RECEIPT_STATEMENTS } from '../db/native-link-mutation-migration';
import { NATIVE_DOCUMENT_EDIT_OPERATION_STATEMENTS } from '../db/native-document-edit-operation-migration';

type Row = Record<string, unknown>;
type Column = Readonly<{ name: string; type: string; notNull: boolean }>;
type Source = Readonly<{ schemaName: string; schemaOid: number; databaseOid: number }>;
export type WorkspaceOperationOriginalDeleteStorage = Readonly<{
  schema: string; prefix: string; assertCurrent: () => Promise<void>;
}>;
export class WorkspaceOperationOriginalDeleteStorageError extends Error {
  readonly code = 'ORIGINAL_DELETE_STORAGE_CHANGED';
  readonly status = 409;
  constructor() { super('Original Delete storage changed.'); this.name = 'WorkspaceOperationOriginalDeleteStorageError'; }
}
function fail(): never { throw new WorkspaceOperationOriginalDeleteStorageError(); }
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const key = (value: unknown) => JSON.stringify(value);
function oid(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 4294967295) fail();
  return Number(value);
}
const columnsOf = (table: AnyPgTable): Column[] => getTableConfig(table).columns.map(column =>
  ({ name: column.name, type: column.getSQLType(), notNull: column.notNull || column.primary }));
const typed = (names: string, type: string, nullable = false): Column[] => names.split(' ').map(name => ({ name, type, notNull: !nullable }));

// These two native stores are defined by fixed startup SQL rather than Drizzle.
// Include their additive room-owner/projection and agent snapshot/grant fields.
const nativeColumns: Readonly<Record<string, readonly Column[]>> = {
  collaboration_yjs_states: [
    ...typed('document_id workspace_id path representation status', 'text'),
    ...typed('organization_id canonical_hash serialized_hash projection_error_code projection_error_phase projection_error_cause room_owner_token room_owner_backend_start', 'text', true),
    ...typed('newline_style', 'text'), ...typed('yjs_state state_vector', 'bytea'),
    ...typed('lifecycle_generation schema_version document_sequence persisted_at checkpoint_sequence has_bom degraded compaction_count projection_error_permanent room_owner_epoch', 'bigint'),
    ...typed('checkpointed_at compacted_at projection_error_sequence projection_error_generation', 'bigint', true),
    ...typed('room_owner_backend_pid', 'integer', true),
  ],
  collaboration_agent_operations: [
    ...typed('operation_id document_id workspace_id initiated_by_user_id actor_id idempotency_key payload_hash operation_type requested_mode atomicity status action_keys_json', 'text'),
    ...typed('document_path document_representation organization_id agent_run_id actor_session_id supersedes_operation_id operation_payload reverse_payload resulting_state_vector_hash file_edit_request_json checkpoint_revision_id version_revision_id result_json error_code correlation_id causation_id expected_canonical_hash direct_edit_grant_id', 'text', true),
    ...typed('base_state_vector', 'bytea'), ...typed('resulting_state_snapshot version_content_snapshot', 'bytea', true),
    ...typed('native_edit_original_json native_edit_after_json', 'jsonb', true),
    ...typed('document_lifecycle_generation schema_version run_generation base_document_sequence cas_version trigger_depth created_at updated_at', 'bigint'),
    ...typed('cancel_requested_at applied_at persisted_at checkpointed_at expires_at applied_document_sequence', 'bigint', true),
  ],
  collaboration_native_link_mutation_receipts: [
    ...typed('operation_id document_id workspace_id path representation actor_user_id actor_id actor_type request_id request_hash authorized_prepared_proof before_state_proof after_state_proof', 'text'),
    ...typed('organization_id actor_session_id', 'text', true),
    ...typed('lifecycle_generation schema_version before_sequence after_sequence persisted_at', 'bigint'),
    ...typed('before_state_vector after_state_vector after_state_snapshot', 'bytea'), ...typed('inverse_recipes', 'jsonb'),
  ],
};
const drizzleColumns: Readonly<Record<string, readonly Column[]>> = {
  collaboration_documents: columnsOf(collaborationDocuments), file_collaboration_lineages: columnsOf(fileCollaborationLineages),
  collaboration_file_projections: columnsOf(collaborationFileProjections), workspace_trash_entries: columnsOf(workspaceTrashEntries),
  public_file_shares: columnsOf(publicFileShares), file_guest_invitations: columnsOf(fileGuestInvitations), file_locks: columnsOf(fileLocks),
  workspace_file_metadata: columnsOf(workspaceFileMetadata), workspace_file_user_states: columnsOf(workspaceFileUserStates),
};
const ledgerColumns = Object.fromEntries(WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS.map(spec =>
  [spec.table, spec.columns.map(name => ({ name, type: name === 'created_at' ? 'bigint' : 'text', notNull: true }))])) as Record<string, Column[]>;
const expectedColumns: Readonly<Record<string, readonly Column[]>> = { ...nativeColumns, ...drizzleColumns, ...ledgerColumns };
const names = Object.freeze(Object.keys(expectedColumns).sort());
const normalizedColumns = (columns: readonly Column[]) => [...columns].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const immutableStatement = WORKSPACE_OPERATION_ORIGINAL_DELETE_STATEMENTS.find(statement =>
  statement.startsWith(`CREATE OR REPLACE FUNCTION ${WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION}()`));
const immutableSource = immutableStatement && /\$\$([\s\S]*)\$\$/u.exec(immutableStatement)?.[1];
const nativeLinkScopeStatement = NATIVE_LINK_MUTATION_RECEIPT_STATEMENTS.find(statement =>
  statement.startsWith('CREATE OR REPLACE FUNCTION validate_native_link_mutation_receipt_scope()'));
const nativeLinkScopeSource = nativeLinkScopeStatement && /\$\$([\s\S]*)\$\$/u.exec(nativeLinkScopeStatement)?.[1];
const nativeEditGuardStatement = NATIVE_DOCUMENT_EDIT_OPERATION_STATEMENTS.find(statement =>
  statement.startsWith('CREATE OR REPLACE FUNCTION canvas_native_edit_operation_guard()'));
const nativeEditGuardSource = nativeEditGuardStatement && /\$\$([\s\S]*)\$\$/u.exec(nativeEditGuardStatement)?.[1];
const initializeSource = `
    BEGIN
      UPDATE collaboration_documents SET yjs_state_lifecycle = 'initialized'
      WHERE id = NEW.document_id AND provider = 'yjs';
      RETURN NEW;
    END `;
const riFunctions = new Set(['RI_FKey_check_ins', 'RI_FKey_check_upd', 'RI_FKey_noaction_del', 'RI_FKey_noaction_upd',
  'RI_FKey_restrict_del', 'RI_FKey_restrict_upd', 'RI_FKey_cascade_del', 'RI_FKey_cascade_upd',
  'RI_FKey_setnull_del', 'RI_FKey_setnull_upd', 'RI_FKey_setdefault_del', 'RI_FKey_setdefault_upd']);

function captureSource(source: Source): Source {
  if (!source || Object.getPrototypeOf(source) !== Object.prototype || Reflect.ownKeys(source).length !== 3
    || ['schemaName', 'schemaOid', 'databaseOid'].some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(source, name);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) fail();
  const schemaName = source.schemaName;
  if (typeof schemaName !== 'string' || !schemaName || Buffer.byteLength(schemaName) > 63
    || /[\u0000-\u001f\u007f]/u.test(schemaName) || Buffer.from(schemaName).toString('utf8') !== schemaName) fail();
  return Object.freeze({ schemaName, schemaOid: oid(source.schemaOid), databaseOid: oid(source.databaseOid) });
}

function assertRealmRow(row: Row | undefined, source: Source): void {
  if (!row || row.schema_name !== source.schemaName || oid(row.schema_oid) !== source.schemaOid
    || oid(row.database_oid) !== source.databaseOid) fail();
}
async function assertRealm(database: SqlConnection, source: Source): Promise<void> {
  assertRealmRow(await database.get(`SELECT pg_catalog.current_schema() AS schema_name,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid`) as Row | undefined, source);
}
function assertRelations(rows: Row[], source: Source): Row[] {
  if (rows.length !== names.length || new Set(rows.map(row => row.name)).size !== names.length
    || rows.some(row => typeof row.name !== 'string' || !names.includes(row.name) || oid(row.oid) !== oid(row.resolved)
      || oid(row.schema_oid) !== source.schemaOid || row.relkind !== 'r' || row.relpersistence !== 'p'
      || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) fail();
  // PostgreSQL bigint scalars and JSON numbers use different wire types. Use
  // one exact primitive form without dropping any selected relation fact.
  return rows.map(row => ({ name: row.name, resolved: oid(row.resolved), oid: oid(row.oid), schema_oid: oid(row.schema_oid),
    relkind: row.relkind, relpersistence: row.relpersistence, relrowsecurity: row.relrowsecurity, relforcerowsecurity: row.relforcerowsecurity }));
}
async function relations(database: SqlConnection, source: Source, prefix: string): Promise<Row[]> {
  const rows = await database.all(`SELECT n.name,pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved,
    c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_catalog.unnest($2::text[]) n(name) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(n.name)) ORDER BY n.name COLLATE "C"`, [prefix, names]) as Row[];
  return assertRelations(rows, source);
}
function assertLocks(rows: Row[], relationOids: number[]): void {
  if (rows.length !== relationOids.length || new Set(rows.map(row => oid(row.oid))).size !== relationOids.length
    || rows.some(row => !relationOids.includes(oid(row.oid)))) fail();
}
function assertColumns(groups: Row[], relationRows: Row[]): void {
  if (groups.length !== relationRows.length || new Set(groups.map(group => oid(group.relation_oid))).size !== groups.length) fail();
  for (const row of relationRows) {
    const group = groups.find(group => oid(group.relation_oid) === oid(row.oid));
    if (!group || Object.keys(group).length !== 2 || !Object.hasOwn(group, 'columns')
      || !Array.isArray(group.columns) || group.columns.length > 128) fail();
    const columns: Column[] = boundedRows(group.columns, 129).map(column => {
      if (Object.keys(column).length !== 3 || typeof column.name !== 'string' || typeof column.type !== 'string'
        || typeof column.notNull !== 'boolean') fail();
      // jsonb object key order is not the SELECT/Drizzle property order.
      return { name: column.name, type: column.type, notNull: column.notNull };
    });
    const expected = expectedColumns[row.name as string];
    if (!expected || key(normalizedColumns(columns)) !== key(normalizedColumns(expected))) fail();
  }
  for (const spec of NATIVE_FILE_SIDE_EFFECT_ROW_SPECS) {
    if (key([...spec.columns].sort()) !== key(expectedColumns[spec.table].map(column => column.name).sort())) fail();
  }
}

const constraintsSql = `SELECT c.oid::bigint AS oid,child.relname AS table_name,c.contype,c.convalidated,c.condeferrable,c.condeferred,c.conenforced,
    c.confrelid::bigint AS target_oid,parent.relname AS target_table,parent.relnamespace::bigint AS target_schema,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns,
    i.indisvalid,i.indisready,i.indislive,i.indimmediate,pg_catalog.pg_get_constraintdef(c.oid,true) AS definition,
    (SELECT count(*)=2 AND bool_and(t.tgisinternal AND t.tgenabled IN('O','A')) FROM pg_catalog.pg_trigger t
      WHERE t.tgconstraint=c.oid AND t.tgrelid=c.conrelid) AS fk_triggers
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class child ON child.oid=c.conrelid
      LEFT JOIN pg_catalog.pg_class parent ON parent.oid=c.confrelid LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
    WHERE c.conrelid=ANY($1::oid[]) AND child.relnamespace=$2::oid
      AND child.relname <> 'collaboration_native_link_mutation_receipts' ORDER BY c.oid LIMIT 257`;
// Keep the original sixteen-relation budget intact. The additive receipt
// catalogue has its own fixed sentinel within the same statement snapshot.
const nativeLinkConstraintsSql = constraintsSql.replace("child.relname <>", "child.relname =").replace('LIMIT 257', 'LIMIT 65');
function assertConstraints(rows: Row[], source: Source): void {
  if (rows.length > 256) fail();
  const usable = (row: Row) => row.convalidated === true && row.conenforced === true
    && row.condeferrable === false && row.condeferred === false;
  const unique = (table: string, type: string, columns: readonly string[]) => {
    const matches = rows.filter(row => row.table_name === table && row.contype === type && key(row.columns) === key(columns));
    if (matches.length !== 1 || !usable(matches[0]) || matches[0].indisvalid !== true || matches[0].indisready !== true
      || matches[0].indislive !== true || matches[0].indimmediate !== true) fail();
  };
  const foreign = (table: string, columns: readonly string[], target: string, targetColumns: readonly string[]) => {
    const matches = rows.filter(row => row.table_name === table && row.contype === 'f' && key(row.columns) === key(columns)
      && row.target_table === target && Number(row.target_schema) === source.schemaOid && key(row.target_columns) === key(targetColumns));
    if (matches.length !== 1 || !usable(matches[0]) || matches[0].fk_triggers !== true
      || matches[0].indisvalid !== true || matches[0].indisready !== true || matches[0].indislive !== true) fail();
  };
  foreign('public_file_shares', ['created_by_user_id'], 'user', ['id']);
  foreign('file_guest_invitations', ['created_by_user_id'], 'user', ['id']);
  foreign('workspace_trash_entries', ['workspace_id'], 'canvas_workspaces', ['id']);
  for (const spec of WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS) {
    unique(spec.table, 'p', spec.primaryKey);
    for (const columns of spec.uniqueKeys) unique(spec.table, 'u', columns);
    for (const fk of spec.foreignKeys) foreign(spec.table, fk.columns, fk.table, fk.referencedColumns);
  }
}

const triggersSql = `SELECT t.oid::bigint AS oid,c.relname AS table_name,t.tgname,t.tgtype,t.tgenabled,t.tgisinternal,t.tgnargs,
    t.tgqual::text AS qualification,t.tgattr::text AS attributes,t.tgdeferrable,t.tginitdeferred,t.tgconstraint::bigint AS constraint_oid,
    p.oid::bigint AS function_oid,p.proname,p.pronamespace::bigint AS function_schema,n.nspname AS function_schema_name,
    p.prosrc,p.prosecdef,p.proconfig,p.prokind,p.pronargs,p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger,l.lanname,
    f.contype,f.convalidated,f.conenforced,f.condeferrable,
    child.relnamespace::bigint AS child_schema,parent.relnamespace::bigint AS parent_schema
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang LEFT JOIN pg_catalog.pg_constraint f ON f.oid=t.tgconstraint
      LEFT JOIN pg_catalog.pg_class child ON child.oid=f.conrelid LEFT JOIN pg_catalog.pg_class parent ON parent.oid=f.confrelid
    WHERE t.tgrelid=ANY($1::oid[]) ORDER BY t.oid LIMIT 257`;
function assertTriggers(rows: Row[], source: Source): Row[] {
  if (rows.length > 256 || !immutableSource || !nativeEditGuardSource) fail();
  const found = new Set<string>();
  for (const row of rows) {
    if (row.tgenabled !== 'O' && row.tgenabled !== 'A') fail();
    if (row.tgisinternal === true) {
      if (row.contype !== 'f' || row.convalidated !== true || row.conenforced !== true || row.condeferrable !== false
        || Number(row.child_schema) !== source.schemaOid || Number(row.parent_schema) !== source.schemaOid
        || row.function_schema_name !== 'pg_catalog' || row.lanname !== 'internal' || row.prosecdef !== false
        || row.proconfig !== null || row.prokind !== 'f' || Number(row.pronargs) !== 0 || row.returns_trigger !== true
        || typeof row.proname !== 'string' || !riFunctions.has(row.proname) || row.prosrc !== row.proname) fail();
      continue;
    }
    const spec = WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS.find(spec => spec.table === row.table_name
      && spec.immutableTrigger === row.tgname);
    const initialization = row.table_name === 'collaboration_yjs_states' && row.tgname === 'collaboration_yjs_state_initialized';
    const nativeEdit = row.table_name === 'collaboration_agent_operations' && row.tgname === 'native_edit_operation_guard';
    if ((!spec && !initialization && !nativeEdit) || Number(row.function_schema) !== source.schemaOid
      || row.proname !== (spec ? WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION
        : nativeEdit ? 'canvas_native_edit_operation_guard' : 'mark_collaboration_yjs_state_initialized')
      || row.prosrc !== (spec ? immutableSource : nativeEdit ? nativeEditGuardSource : initializeSource) || row.lanname !== 'plpgsql'
      || row.prosecdef !== false || row.proconfig !== null || row.prokind !== 'f' || Number(row.pronargs) !== 0
      || row.returns_trigger !== true || Number(row.tgtype) !== (spec ? 27 : nativeEdit ? 31 : 5) || Number(row.tgnargs) !== 0
      || row.qualification !== null || row.attributes !== '' || Number(row.constraint_oid) !== 0
      || row.tgdeferrable !== false || row.tginitdeferred !== false) fail();
    const identity = `${String(row.table_name)}:${String(row.tgname)}`;
    if (found.has(identity)) fail(); found.add(identity);
  }
  if (found.size !== WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS.length + 2) fail();
  return rows;
}

function assertNativeLinkReceiptConstraints(rows: Row[], source: Source): void {
  if (rows.length > 64) fail();
  const table = 'collaboration_native_link_mutation_receipts';
  const required: Array<{ type: string; columns: string[]; target?: string }> = [
    { type: 'p', columns: ['operation_id'] },
    { type: 'u', columns: ['document_id', 'actor_user_id', 'actor_id', 'actor_type', 'actor_session_id', 'request_id'] },
    { type: 'f', columns: ['document_id'], target: 'collaboration_documents' },
  ];
  for (const expected of required) {
    const matching = rows.filter(row => row.table_name === table && row.contype === expected.type && key(row.columns) === key(expected.columns));
    const row = matching[0];
    if (matching.length !== 1 || row.convalidated !== true || row.conenforced !== true || row.condeferrable !== false
      || row.condeferred !== false || row.indisvalid !== true || row.indisready !== true || row.indislive !== true
      || (expected.type !== 'f' ? row.indimmediate !== true : row.target_table !== expected.target
        || Number(row.target_schema) !== source.schemaOid || key(row.target_columns) !== key(['id']) || row.fk_triggers !== true)) fail();
  }
}
const nativeLinkReceiptScope = (row: Row) => row.table_name === 'collaboration_native_link_mutation_receipts'
  && row.tgname === 'native_link_mutation_receipt_scope';
function assertNativeLinkReceiptScope(rows: Row[], source: Source): void {
  const matching = rows.filter(nativeLinkReceiptScope), row = matching[0];
  if (!nativeLinkScopeSource || matching.length !== 1 || !['O', 'A'].includes(String(row.tgenabled)) || row.tgisinternal !== false
    || Number(row.function_schema) !== source.schemaOid || row.proname !== 'validate_native_link_mutation_receipt_scope'
    || row.prosrc !== nativeLinkScopeSource || row.lanname !== 'plpgsql' || row.prosecdef !== false || row.proconfig !== null
    || row.prokind !== 'f' || Number(row.pronargs) !== 0 || row.returns_trigger !== true || Number(row.tgtype) !== 31
    || Number(row.tgnargs) !== 0 || row.qualification !== null || row.attributes !== '' || Number(row.constraint_oid) !== 0
    || row.tgdeferrable !== false || row.tginitdeferred !== false) fail();
}

function boundedRows(value: unknown, limit: number): Row[] {
  if (!Array.isArray(value) || value.length > limit || value.some(row => !row || typeof row !== 'object'
    || Object.getPrototypeOf(row) !== Object.prototype)) fail();
  return value;
}

/** One statement and one catalogue snapshot on the original B. Every section
 * is bound to the originally locked OIDs, never a caller-supplied relation list.
 * LIMIT sentinels stay local to each relation/constraint/trigger subquery. */
async function inspectStorage(database: SqlConnection, source: Source, prefix: string, relationOids: number[]): Promise<Row> {
  const snapshot = await database.get(`WITH current_relations AS MATERIALIZED (
    SELECT n.name,pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved,
      c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_catalog.unnest($5::text[]) n(name) LEFT JOIN pg_catalog.pg_class c
        ON c.oid=pg_catalog.to_regclass($4||'.'||pg_catalog.quote_ident(n.name))
  ), current_columns AS MATERIALIZED (
    SELECT r.oid::bigint AS relation_oid,cols.columns FROM pg_catalog.unnest($1::oid[]) r(oid)
      CROSS JOIN LATERAL (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.name COLLATE "C"),'[]'::jsonb) AS columns
        FROM (SELECT a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull"
          FROM pg_catalog.pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped
          ORDER BY a.attname COLLATE "C" LIMIT 129) a) cols
  ), current_constraints AS MATERIALIZED (${constraintsSql}),
  current_native_link_constraints AS MATERIALIZED (${nativeLinkConstraintsSql}), current_triggers AS MATERIALIZED (${triggersSql}),
  current_locks AS MATERIALIZED (
    SELECT DISTINCT relation::bigint AS oid FROM pg_catalog.pg_locks
      WHERE locktype='relation' AND pid=pg_catalog.pg_backend_pid() AND database=$3::oid AND relation=ANY($1::oid[])
        AND granted AND mode IN('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
  ) SELECT pg_catalog.current_schema() AS schema_name,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.name COLLATE "C"),'[]'::jsonb) FROM current_relations r) AS relations,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.relation_oid),'[]'::jsonb) FROM current_columns c) AS columns,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid),'[]'::jsonb) FROM current_constraints c) AS constraints,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid),'[]'::jsonb) FROM current_native_link_constraints c) AS native_link_constraints,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid),'[]'::jsonb) FROM current_triggers t) AS triggers,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l) ORDER BY l.oid),'[]'::jsonb) FROM current_locks l) AS locks`,
  [relationOids, source.schemaOid, source.databaseOid, prefix, names]) as Row | undefined;
  if (!snapshot) fail();
  return snapshot;
}

/** Fixed SQL storage checks only. The genuine Owner supplies its actual B and
 * retains all Claim/Actor/Exclusive/transaction authority. No caller-selected
 * relation list, pool checkout, transaction command or raw B escapes here. */
export async function bindWorkspaceOperationOriginalDeleteStorageOnConnection(database: SqlConnection,
  source: Source): Promise<WorkspaceOperationOriginalDeleteStorage> {
  const original = captureSource(source), schema = original.schemaName, prefix = quote(schema);
  await assertRealm(database, original);
  const initial = await relations(database, original, prefix), relationOids = initial.map(row => oid(row.oid));
  await database.run(`LOCK TABLE ${names.map(name => `${prefix}.${quote(name)}`).join(',')} IN ROW EXCLUSIVE MODE NOWAIT`);
  const inspect = async () => {
    const snapshot = await inspectStorage(database, original, prefix, relationOids);
    assertRealmRow(snapshot, original);
    const current = assertRelations(boundedRows(snapshot.relations, names.length), original);
    if (key(current) !== key(initial)) fail();
    assertLocks(boundedRows(snapshot.locks, names.length), relationOids);
    assertColumns(boundedRows(snapshot.columns, names.length), current);
    const currentConstraints = boundedRows(snapshot.constraints, 257); assertConstraints(currentConstraints, original);
    const nativeLinkConstraints = boundedRows(snapshot.native_link_constraints, 65);
    assertNativeLinkReceiptConstraints(nativeLinkConstraints, original);
    const currentTriggers = boundedRows(snapshot.triggers, 257);
    assertNativeLinkReceiptScope(currentTriggers, original);
    assertTriggers(currentTriggers.filter(row => !nativeLinkReceiptScope(row)), original);
    return key({ constraints: currentConstraints, nativeLinkConstraints, triggers: currentTriggers });
  };
  const expected = await inspect();
  return Object.freeze({ schema, prefix, assertCurrent: async () => { if (await inspect() !== expected) fail(); } });
}
