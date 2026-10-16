import 'server-only';

import { getTableConfig, type AnyPgTable } from 'drizzle-orm/pg-core';
import type { SqlConnection } from '../db';
import { collaborationDocuments, collaborationFileProjections, fileCollaborationLineages, workspaceTrashEntries,
  publicFileShares, fileGuestInvitations, fileLocks, workspaceFileMetadata, workspaceFileUserStates } from '../db/schema';
import { NATIVE_FILE_SIDE_EFFECT_ROW_SPECS } from '../db/native-file-operation-side-effects-migration';
import { WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS, WORKSPACE_OPERATION_ORIGINAL_DELETE_STATEMENTS,
  WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION } from '../db/workspace-operation-original-delete-migration';

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
    ...typed('document_lifecycle_generation schema_version run_generation base_document_sequence cas_version trigger_depth created_at updated_at', 'bigint'),
    ...typed('cancel_requested_at applied_at persisted_at checkpointed_at expires_at applied_document_sequence', 'bigint', true),
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

async function assertRealm(database: SqlConnection, source: Source): Promise<void> {
  const row = await database.get(`SELECT pg_catalog.current_schema() AS schema_name,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid`) as Row | undefined;
  if (!row || row.schema_name !== source.schemaName || oid(row.schema_oid) !== source.schemaOid
    || oid(row.database_oid) !== source.databaseOid) fail();
}
async function relations(database: SqlConnection, source: Source, prefix: string): Promise<Row[]> {
  const rows = await database.all(`SELECT n.name,pg_catalog.to_regclass(pg_catalog.quote_ident(n.name))::oid::bigint AS resolved,
    c.oid::bigint AS oid,c.relnamespace::bigint AS schema_oid,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_catalog.unnest($2::text[]) n(name) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass($1||'.'||pg_catalog.quote_ident(n.name)) ORDER BY n.name COLLATE "C"`, [prefix, names]) as Row[];
  if (rows.length !== names.length || new Set(rows.map(row => row.name)).size !== names.length
    || rows.some(row => typeof row.name !== 'string' || !names.includes(row.name) || oid(row.oid) !== oid(row.resolved)
      || oid(row.schema_oid) !== source.schemaOid || row.relkind !== 'r' || row.relpersistence !== 'p'
      || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) fail();
  return rows;
}
async function assertLocks(database: SqlConnection, source: Source, relationOids: number[]): Promise<void> {
  const rows = await database.all(`SELECT DISTINCT relation::bigint AS oid FROM pg_catalog.pg_locks
    WHERE locktype='relation' AND pid=pg_catalog.pg_backend_pid() AND database=$1::oid AND relation=ANY($2::oid[])
      AND granted AND mode IN('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')`,
  [source.databaseOid, relationOids]) as Row[];
  if (rows.length !== relationOids.length || new Set(rows.map(row => oid(row.oid))).size !== relationOids.length
    || rows.some(row => !relationOids.includes(oid(row.oid)))) fail();
}
async function assertColumns(database: SqlConnection, relationRows: Row[]): Promise<void> {
  for (const row of relationRows) {
    const columns = await database.all(`SELECT a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS "notNull" FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname COLLATE "C" LIMIT 129`, [row.oid]) as Column[];
    const expected = expectedColumns[row.name as string];
    if (!expected || key(normalizedColumns(columns)) !== key(normalizedColumns(expected))) fail();
  }
  for (const spec of NATIVE_FILE_SIDE_EFFECT_ROW_SPECS) {
    if (key([...spec.columns].sort()) !== key(expectedColumns[spec.table].map(column => column.name).sort())) fail();
  }
}

async function constraints(database: SqlConnection, source: Source, relationOids: number[]): Promise<Row[]> {
  return database.all(`SELECT c.oid::bigint AS oid,child.relname AS table_name,c.contype,c.convalidated,c.condeferrable,c.condeferred,c.conenforced,
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
    WHERE c.conrelid=ANY($1::oid[]) AND child.relnamespace=$2::oid ORDER BY c.oid LIMIT 257`,
  [relationOids, source.schemaOid]) as Promise<Row[]>;
}
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

async function triggers(database: SqlConnection, source: Source, relationOids: number[]): Promise<Row[]> {
  const rows = await database.all(`SELECT t.oid::bigint AS oid,c.relname AS table_name,t.tgname,t.tgtype,t.tgenabled,t.tgisinternal,t.tgnargs,
    t.tgqual::text AS qualification,t.tgattr::text AS attributes,t.tgdeferrable,t.tginitdeferred,t.tgconstraint::bigint AS constraint_oid,
    p.oid::bigint AS function_oid,p.proname,p.pronamespace::bigint AS function_schema,n.nspname AS function_schema_name,
    p.prosrc,p.prosecdef,p.proconfig,p.prokind,p.pronargs,p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger,l.lanname,
    f.contype,f.convalidated,f.conenforced,f.condeferrable,
    child.relnamespace::bigint AS child_schema,parent.relnamespace::bigint AS parent_schema
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang LEFT JOIN pg_catalog.pg_constraint f ON f.oid=t.tgconstraint
      LEFT JOIN pg_catalog.pg_class child ON child.oid=f.conrelid LEFT JOIN pg_catalog.pg_class parent ON parent.oid=f.confrelid
    WHERE t.tgrelid=ANY($1::oid[]) ORDER BY t.oid LIMIT 257`, [relationOids]) as Row[];
  if (rows.length > 256 || !immutableSource) fail();
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
    if ((!spec && !initialization) || Number(row.function_schema) !== source.schemaOid
      || row.proname !== (spec ? WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION : 'mark_collaboration_yjs_state_initialized')
      || row.prosrc !== (spec ? immutableSource : initializeSource) || row.lanname !== 'plpgsql'
      || row.prosecdef !== false || row.proconfig !== null || row.prokind !== 'f' || Number(row.pronargs) !== 0
      || row.returns_trigger !== true || Number(row.tgtype) !== (spec ? 27 : 5) || Number(row.tgnargs) !== 0
      || row.qualification !== null || row.attributes !== '' || Number(row.constraint_oid) !== 0
      || row.tgdeferrable !== false || row.tginitdeferred !== false) fail();
    const identity = `${String(row.table_name)}:${String(row.tgname)}`;
    if (found.has(identity)) fail(); found.add(identity);
  }
  if (found.size !== WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS.length + 1) fail();
  return rows;
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
    await assertRealm(database, original);
    const current = await relations(database, original, prefix);
    if (key(current) !== key(initial)) fail();
    await assertLocks(database, original, relationOids);
    await assertColumns(database, current);
    const currentConstraints = await constraints(database, original, relationOids); assertConstraints(currentConstraints, original);
    const currentTriggers = await triggers(database, original, relationOids);
    await assertRealm(database, original);
    return key({ constraints: currentConstraints, triggers: currentTriggers });
  };
  const expected = await inspect();
  return Object.freeze({ schema, prefix, assertCurrent: async () => { if (await inspect() !== expected) fail(); } });
}
