import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, test } from 'node:test';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_ORIGINAL_DELETE_TABLE_SPECS as specs,
  WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION } from '../app/lib/db/workspace-operation-original-delete-migration';
import type * as Storage from '../app/lib/files/workspace-operation-original-delete-storage';

// Declared catalogue facts test only the mechanical checker and statement
// shape. They prove neither actual PostgreSQL DDL/locks nor Owner authority.
const file = path.resolve('app/lib/files/workspace-operation-original-delete-storage.ts');
const source = fs.readFileSync(file, 'utf8'), hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sourceHash = hash(source), ownPath = path.resolve('scripts/workspace-operation-original-delete-storage-batch-test.ts');
const ownHash = hash(fs.readFileSync(ownPath, 'utf8'));
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), printer = ts.createPrinter({ removeComments: true });
function body(name: string): readonly ts.Statement[] {
  const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(found && ts.isFunctionDeclaration(found) && found.body);
  return found.body.statements;
}
const statementsHash = (nodes: readonly ts.Statement[]) => hash(nodes.map(node => printer.printNode(ts.EmitHint.Unspecified, node, ast)).join('\n'));
const baseline = {
  // Normalized original AST at SHA48a24c11… before batching. The trigger
  // baseline additionally includes the already-existing native edit guard,
  // confirmed unchanged against the source before fingerprinting.
  constraints: '747e2003dd79df6ab9574249bca5e4d4f499d89f3896e4ef7fca6c1cfd8dda53',
  triggers: '223cb06da120e5b620c0502f628c40125aec21a36e6af8f9093fd7d249261a54',
  realm: '33b59401508feb78d4d229f436e23c97cc018b50d7a11db84aa192762d1c7f92',
  relations: '0a400f9b24ef728cdd62d6cbde673b8f3042d7537aed3d53e8c018d0a7c04c5f',
  locks: '1a8ea73bc4d5c7b5b6e676e81587be1c5e34783b6df8254ba622efcfae345889',
  columnComparison: '036be715de98548cf2d3c718c9ddf7cfacda8d7edef0a3fd84b2e25624aa1a1b',
};
test('all six original semantic validator blocks retain their original AST', () => {
  const columnLoop = body('assertColumns').find(ts.isForOfStatement);
  assert(columnLoop && ts.isBlock(columnLoop.statement));
  assert.deepEqual({ constraints: statementsHash(body('assertConstraints')), triggers: statementsHash(body('assertTriggers')),
    realm: statementsHash(body('assertRealmRow')), relations: statementsHash(body('assertRelations').slice(0, 1)),
    locks: statementsHash(body('assertLocks')), columnComparison: statementsHash(columnLoop.statement.statements.slice(-2)),
  }, baseline);
});

type Row = Record<string, unknown>;
type Column = { name: string; type: string; notNull: boolean };
type Module = typeof Storage & { fixtureFacts: { names: string[]; expectedColumns: Record<string, Column[]>;
  immutableSource: string; initializeSource: string; nativeLinkScopeSource: string; nativeEditGuardSource: string } };
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const native = createRequire(file), loaded = { exports: {} as Module };
// The test VM exposes metadata solely to construct declared catalogue rows.
// No production export, SQL result override or capability is added.
new Function('require', 'module', 'exports', `${compiled}\nmodule.exports.fixtureFacts={names,expectedColumns,immutableSource,initializeSource,nativeLinkScopeSource,nativeEditGuardSource};`)(
  (name: string) => name === 'server-only' ? {} : native(name), loaded, loaded.exports);
const { names, expectedColumns, immutableSource, initializeSource, nativeLinkScopeSource, nativeEditGuardSource } = loaded.exports.fixtureFacts;
const nativeLinkTable = 'collaboration_native_link_mutation_receipts';
const realm = { schema_name: 'storage_fixture', schema_oid: '21', database_oid: '31' };
const binding = { schemaName: realm.schema_name, schemaOid: 21, databaseOid: 31 };
const relationOid = (name: string) => { const index = names.indexOf(name); assert(index >= 0); return 1000 + index; };
function facts(): Row {
  let nextOid = 3000;
  const constraints: Row[] = [], triggers: Row[] = [];
  const valid = { convalidated: true, conenforced: true, condeferrable: false, condeferred: false,
    indisvalid: true, indisready: true, indislive: true, indimmediate: true };
  const unique = (table: string, type: string, columns: readonly string[]) => constraints.push({ ...valid,
    oid: nextOid++, table_name: table, contype: type, columns: [...columns], definition: `${type}:${columns.join(',')}` });
  const foreign = (table: string, columns: readonly string[], target: string, targetColumns: readonly string[]) => {
    const id = nextOid++;
    constraints.push({ ...valid, oid: id, table_name: table, contype: 'f', columns: [...columns], target_table: target,
      target_schema: 21, target_oid: names.includes(target) ? relationOid(target) : 2000,
      target_columns: [...targetColumns], definition: `foreign:${table}:${columns.join(',')}`, fk_triggers: true });
    for (const suffix of ['ins', 'upd']) triggers.push({ oid: nextOid++, table_name: table, tgname: `RI_${id}_${suffix}`,
      tgenabled: 'O', tgisinternal: true, contype: 'f', convalidated: true, conenforced: true, condeferrable: false,
      child_schema: 21, parent_schema: 21, function_schema_name: 'pg_catalog', lanname: 'internal', prosecdef: false,
      proconfig: null, prokind: 'f', pronargs: 0, returns_trigger: true, proname: `RI_FKey_check_${suffix}`,
      prosrc: `RI_FKey_check_${suffix}` });
  };
  foreign('public_file_shares', ['created_by_user_id'], 'user', ['id']);
  foreign('file_guest_invitations', ['created_by_user_id'], 'user', ['id']);
  foreign('workspace_trash_entries', ['workspace_id'], 'canvas_workspaces', ['id']);
  unique(nativeLinkTable, 'p', ['operation_id']);
  unique(nativeLinkTable, 'u', ['document_id', 'actor_user_id', 'actor_id', 'actor_type', 'actor_session_id', 'request_id']);
  foreign(nativeLinkTable, ['document_id'], 'collaboration_documents', ['id']);
  for (const spec of specs) {
    unique(spec.table, 'p', spec.primaryKey);
    for (const columns of spec.uniqueKeys) unique(spec.table, 'u', columns);
    for (const fk of spec.foreignKeys) foreign(spec.table, fk.columns, fk.table, fk.referencedColumns);
  }
  for (const spec of [...specs.map(spec => ({ table: spec.table, name: spec.immutableTrigger, immutable: true, nativeEdit: false })),
    { table: 'collaboration_yjs_states', name: 'collaboration_yjs_state_initialized', immutable: false, nativeEdit: false },
    { table: 'collaboration_agent_operations', name: 'native_edit_operation_guard', immutable: false, nativeEdit: true }]) {
    triggers.push({ oid: nextOid++, table_name: spec.table, tgname: spec.name, tgtype: spec.immutable ? 27 : spec.nativeEdit ? 31 : 5,
      tgenabled: 'O', tgisinternal: false, tgnargs: 0, qualification: null, attributes: '', tgdeferrable: false,
      tginitdeferred: false, constraint_oid: 0, function_oid: spec.immutable ? 5000 : spec.nativeEdit ? 5003 : 5001, function_schema: 21,
      function_schema_name: realm.schema_name, proname: spec.immutable ? WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION
        : spec.nativeEdit ? 'canvas_native_edit_operation_guard' : 'mark_collaboration_yjs_state_initialized',
      prosrc: spec.immutable ? immutableSource : spec.nativeEdit ? nativeEditGuardSource : initializeSource, prosecdef: false, proconfig: null,
      prokind: 'f', pronargs: 0, returns_trigger: true, lanname: 'plpgsql' });
  }
  triggers.push({ oid: nextOid++, table_name: nativeLinkTable, tgname: 'native_link_mutation_receipt_scope', tgtype: 31,
    tgenabled: 'O', tgisinternal: false, tgnargs: 0, qualification: null, attributes: '', tgdeferrable: false,
    tginitdeferred: false, constraint_oid: 0, function_oid: 5002, function_schema: 21,
    function_schema_name: realm.schema_name, proname: 'validate_native_link_mutation_receipt_scope',
    prosrc: nativeLinkScopeSource, prosecdef: false, proconfig: null, prokind: 'f', pronargs: 0, returns_trigger: true, lanname: 'plpgsql' });
  return { ...realm, relations: names.map(name => ({ name, resolved: relationOid(name), oid: relationOid(name), schema_oid: 21,
    relkind: 'r', relpersistence: 'p', relrowsecurity: false, relforcerowsecurity: false })),
  columns: names.map(name => ({ relation_oid: relationOid(name), columns: expectedColumns[name].map(column =>
    // Deliberately different JSON key order from scalar SELECT/Drizzle.
    ({ notNull: column.notNull, type: column.type, name: column.name })) })),
  constraints, triggers, locks: names.map(name => ({ oid: relationOid(name) })) };
}
type Harness = { snapshot: Row; calls: Array<{ method: string; sql: string; parameters: unknown[] }>; database: SqlConnection };
function harness(): Harness {
  const result: Harness = { snapshot: facts(), calls: [], database: undefined! };
  const call = (method: string, sql: string, parameters: unknown[] = []) => result.calls.push({ method, sql, parameters });
  result.database = {
    get: async (sql, parameters = []) => { call('get', sql, parameters);
      if (!sql.startsWith('WITH current_relations')) return structuredClone(realm);
      // Keep one complete catalogue model for every existing mutator, and
      // project the two bounded result partitions exactly as the SQL does.
      const snapshot = structuredClone(result.snapshot), constraints = snapshot.constraints as Row[];
      const partitioned = { ...snapshot, constraints: constraints.filter(row => row.table_name !== nativeLinkTable),
        native_link_constraints: constraints.filter(row => row.table_name === nativeLinkTable) };
      // Declared SQL-result model: the digest covers every snapshot fact. This
      // does not claim to execute PostgreSQL's JSONB serialization or SHA-256.
      const fingerprint = hash(JSON.stringify(partitioned));
      return sql.includes('SELECT s.*,') ? { ...partitioned, fingerprint } : { fingerprint }; },
    all: async (sql, parameters = []) => { call('all', sql, parameters);
      assert(sql.includes('pg_catalog.unnest($2::text[])'));
      return (facts().relations as Row[]).map(row => ({ ...row, oid: String(row.oid), resolved: String(row.resolved), schema_oid: '21' })); },
    run: async (sql, parameters = []) => { call('run', sql, parameters); assert(sql.startsWith('LOCK TABLE ')); },
    close: () => { throw new Error('Mechanical storage must not close its borrowed connection.'); },
  };
  return result;
}
test('initial binding uses four roundtrips and each fresh full inspection exactly one structured SELECT', async () => {
  const h = harness(), storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
  assert.equal(names.filter(name => name !== nativeLinkTable).length, 16);
  assert.equal(names.length, 17); assert.equal(names.filter(name => name === nativeLinkTable).length, 1); assert.equal(h.calls.length, 4);
  await storage.assertCurrent(); await storage.assertCurrent();
  assert.equal(h.calls.length, 6);
  const inspections = h.calls.filter(call => call.sql.startsWith('WITH current_relations'));
  assert.equal(inspections.length, 3);
  for (const call of inspections) {
    assert.equal(call.method, 'get'); assert.equal(call.sql.includes(';'), false);
    assert.deepEqual(call.parameters, [names.map(relationOid), 21, 31, '"storage_fixture"', names]);
    assert.match(call.sql, /CROSS JOIN LATERAL/u); assert.match(call.sql, /LIMIT 129/u);
    assert.equal((call.sql.match(/LIMIT 257/gu) ?? []).length, 2);
    assert.equal((call.sql.match(/LIMIT 65/gu) ?? []).length, 1);
    assert.match(call.sql, /AS native_link_constraints/u);
    assert.match(call.sql, /WHERE c\.conrelid=ANY\(\$1::oid\[\]\)/u);
    assert.match(call.sql, /WHERE t\.tgrelid=ANY\(\$1::oid\[\]\)/u);
    for (const gate of ['pg_catalog.pg_locks', 'pg_catalog.pg_attribute', 'pg_catalog.pg_constraint', 'pg_catalog.pg_trigger',
      'pg_catalog.pg_proc', 'pg_catalog.pg_namespace', 'pg_catalog.pg_database', 'prosrc', 'prosecdef', 'proconfig']) assert(call.sql.includes(gate));
  }
  assert.equal(h.calls.filter(call => call.method === 'run').length, 1);
  for (const name of names) assert(h.calls[2].sql.includes(`"storage_fixture"."${name}"`));
});
const rows = (snapshot: Row, key: string) => snapshot[key] as Row[];
const trigger = (snapshot: Row) => rows(snapshot, 'triggers').find(row => row.tgisinternal === false)!;
const mutate: Array<[string, (snapshot: Row) => void]> = [
  ['database realm', s => { s.database_oid = 32; }], ['schema name', s => { s.schema_name = 'other'; }],
  ['schema OID', s => { s.schema_oid = 22; }], ['missing relation', s => { rows(s, 'relations').pop(); }],
  ['unqualified shadow', s => { rows(s, 'relations')[0].resolved = 999; }],
  ['relation replacement', s => { rows(s, 'relations')[0].resolved = rows(s, 'relations')[0].oid = 999; }],
  ['RLS', s => { rows(s, 'relations')[0].relrowsecurity = true; }],
  ['temporary relation', s => { rows(s, 'relations')[0].relpersistence = 't'; }],
  ['missing own lock', s => { rows(s, 'locks').pop(); }], ['foreign lock OID', s => { rows(s, 'locks')[0].oid = 999; }],
  ['missing column group', s => { rows(s, 'columns').pop(); }],
  ['duplicate column OID', s => { rows(s, 'columns')[0].relation_oid = rows(s, 'columns')[1].relation_oid; }],
  ['extra column', s => { (rows(s, 'columns')[0].columns as Row[]).push({ name: 'extra', type: 'text', notNull: true }); }],
  ['wrong column type', s => { (rows(s, 'columns')[0].columns as Row[])[0].type = 'integer'; }],
  ['wrong column nullability', s => { const c = (rows(s, 'columns')[0].columns as Row[])[0]; c.notNull = !c.notNull; }],
  ['129 column overflow sentinel', s => { rows(s, 'columns')[0].columns = Array.from({ length: 129 }, (_, i) => ({ name: `extra${i}`, type: 'text', notNull: true })); }],
  ['nonprimitive JSON column', s => { (rows(s, 'columns')[0].columns as unknown[])[0] = null; }],
  ['missing required PK', s => { s.constraints = rows(s, 'constraints').filter(row => row.contype !== 'p'); }],
  ['invalid unique index', s => { rows(s, 'constraints').find(row => row.contype === 'p')!.indisvalid = false; }],
  ['unready unique index', s => { rows(s, 'constraints').find(row => row.contype === 'p')!.indisready = false; }],
  ['foreign FK namespace', s => { rows(s, 'constraints').find(row => row.contype === 'f')!.target_schema = 22; }],
  ['fresh constraint fingerprint', s => { rows(s, 'constraints')[0].definition = 'different still-validated definition'; }],
  ['257 constraint overflow sentinel', s => { s.constraints = Array.from({ length: 257 }, () => rows(s, 'constraints')[0]); }],
  ['disabled trigger', s => { trigger(s).tgenabled = 'D'; }], ['unknown user trigger', s => { trigger(s).tgname = 'unknown'; }],
  ['changed immutable source', s => { trigger(s).prosrc = 'BEGIN RETURN OLD; END'; }],
  ['fresh function OID fingerprint', s => { trigger(s).function_oid = 9999; }],
  ['security definer function', s => { trigger(s).prosecdef = true; }],
  ['function settings', s => { trigger(s).proconfig = ['search_path=public']; }],
  ['function namespace', s => { trigger(s).function_schema = 22; }],
  ['unknown internal function', s => { rows(s, 'triggers').find(row => row.tgisinternal === true)!.proname = 'unapproved'; }],
  ['257 trigger overflow sentinel', s => { s.triggers = Array.from({ length: 257 }, () => rows(s, 'triggers')[0]); }],
];
for (const [label, change] of mutate) test(`fresh one-statement inspection rejects ${label}`, async () => {
  const h = harness(), storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
  change(h.snapshot);
  await assert.rejects(storage.assertCurrent(), { code: 'ORIGINAL_DELETE_STORAGE_CHANGED', status: 409 });
  assert.equal(h.calls.length, 5, 'No hidden second query or successful cache hit.');
});
const nativeConstraint = (snapshot: Row, type: string) => rows(snapshot, 'constraints').find(row => row.table_name === nativeLinkTable && row.contype === type)!;
function fillConstraintPartition(snapshot: Row, native: boolean, count: number): void {
  const constraints = rows(snapshot, 'constraints'), current = constraints.filter(row => (row.table_name === nativeLinkTable) === native);
  assert(current.length <= count);
  for (let index = current.length; index < count; index++) constraints.push({ oid: (native ? 20_000 : 10_000) + index,
    table_name: native ? nativeLinkTable : 'collaboration_documents', contype: 'c', convalidated: true, conenforced: true,
    condeferrable: false, condeferred: false, definition: `declared-${native ? 'native' : 'original'}-check-${index}` });
}
test('original 256 and added native 64 constraint budgets are independent in one fresh inspection', async () => {
  const h = harness();
  fillConstraintPartition(h.snapshot, false, 256); fillConstraintPartition(h.snapshot, true, 64);
  assert.equal(rows(h.snapshot, 'constraints').length, 320);
  const storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
  await storage.assertCurrent();
  assert.equal(h.calls.length, 5, 'Both bounded partitions share the same fresh structured SELECT.');
});
for (const phase of ['initial', 'fresh'] as const) test(`${phase} inspection rejects 65 native constraints without raising the original budget`, async () => {
  const h = harness();
  if (phase === 'initial') {
    fillConstraintPartition(h.snapshot, true, 65);
    await assert.rejects(loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding), { code: 'ORIGINAL_DELETE_STORAGE_CHANGED', status: 409 });
    assert.equal(h.calls.length, 4);
  } else {
    const storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
    fillConstraintPartition(h.snapshot, true, 65);
    await assert.rejects(storage.assertCurrent(), { code: 'ORIGINAL_DELETE_STORAGE_CHANGED', status: 409 });
    assert.equal(h.calls.length, 5);
  }
});
for (const native of [false, true]) test(`fresh inspection independently pins the ${native ? 'native' : 'original'} constraint partition`, async () => {
  const h = harness();
  fillConstraintPartition(h.snapshot, false, 256); fillConstraintPartition(h.snapshot, true, 64);
  const unchanged = JSON.stringify(rows(h.snapshot, 'constraints').filter(row => (row.table_name === nativeLinkTable) !== native));
  const storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
  rows(h.snapshot, 'constraints').find(row => (row.table_name === nativeLinkTable) === native && row.contype === 'c')!.definition = 'changed valid check';
  assert.equal(JSON.stringify(rows(h.snapshot, 'constraints').filter(row => (row.table_name === nativeLinkTable) !== native)), unchanged);
  await assert.rejects(storage.assertCurrent(), { code: 'ORIGINAL_DELETE_STORAGE_CHANGED', status: 409 });
  assert.equal(h.calls.length, 5);
});
const nativeScope = (snapshot: Row) => rows(snapshot, 'triggers').find(row => row.table_name === nativeLinkTable && row.tgname === 'native_link_mutation_receipt_scope')!;
const nativeForeignTrigger = (snapshot: Row) => rows(snapshot, 'triggers').find(row => row.table_name === nativeLinkTable && row.tgisinternal === true)!;
const nativeMutate: Array<[string, (snapshot: Row) => void]> = [
  ['missing native edit guard', s => { s.triggers = rows(s, 'triggers').filter(row => row.tgname !== 'native_edit_operation_guard'); }],
  ['disabled native edit guard', s => { rows(s, 'triggers').find(row => row.tgname === 'native_edit_operation_guard')!.tgenabled = 'D'; }],
  ['changed native edit guard body', s => { rows(s, 'triggers').find(row => row.tgname === 'native_edit_operation_guard')!.prosrc = 'BEGIN RETURN NEW; END'; }],
  ['missing native PK', s => { s.constraints = rows(s, 'constraints').filter(row => row !== nativeConstraint(s, 'p')); }],
  ['duplicate native PK', s => { rows(s, 'constraints').push({ ...nativeConstraint(s, 'p'), oid: 9999 }); }],
  ['wrong native PK columns', s => { nativeConstraint(s, 'p').columns = ['document_id']; }],
  ['invalid native PK index', s => { nativeConstraint(s, 'p').indisvalid = false; }],
  ['unready native PK index', s => { nativeConstraint(s, 'p').indisready = false; }],
  ['nonlive native PK index', s => { nativeConstraint(s, 'p').indislive = false; }],
  ['deferred native PK index', s => { nativeConstraint(s, 'p').indimmediate = false; }],
  ['missing native request unique', s => { s.constraints = rows(s, 'constraints').filter(row => row !== nativeConstraint(s, 'u')); }],
  ['duplicate native request unique', s => { rows(s, 'constraints').push({ ...nativeConstraint(s, 'u'), oid: 9999 }); }],
  ['wrong native request unique columns', s => { nativeConstraint(s, 'u').columns = ['document_id', 'request_id']; }],
  ['unvalidated native request unique', s => { nativeConstraint(s, 'u').convalidated = false; }],
  ['unenforced native request unique', s => { nativeConstraint(s, 'u').conenforced = false; }],
  ['deferrable native request unique', s => { nativeConstraint(s, 'u').condeferrable = true; }],
  ['deferred native request unique', s => { nativeConstraint(s, 'u').condeferred = true; }],
  ['nonimmediate native request unique', s => { nativeConstraint(s, 'u').indimmediate = false; }],
  ['missing native FK', s => { s.constraints = rows(s, 'constraints').filter(row => row !== nativeConstraint(s, 'f')); }],
  ['duplicate native FK', s => { rows(s, 'constraints').push({ ...nativeConstraint(s, 'f'), oid: 9999 }); }],
  ['wrong native FK child columns', s => { nativeConstraint(s, 'f').columns = ['workspace_id']; }],
  ['wrong native FK parent table', s => { nativeConstraint(s, 'f').target_table = 'file_collaboration_lineages'; }],
  ['wrong native FK parent columns', s => { nativeConstraint(s, 'f').target_columns = ['lineage_id']; }],
  ['foreign native FK parent schema', s => { nativeConstraint(s, 'f').target_schema = 22; }],
  ['unvalidated native FK', s => { nativeConstraint(s, 'f').convalidated = false; }],
  ['missing native FK triggers', s => { nativeConstraint(s, 'f').fk_triggers = false; }],
  ['invalid native FK parent index', s => { nativeConstraint(s, 'f').indisvalid = false; }],
  ['unknown internal native FK trigger function', s => { nativeForeignTrigger(s).proname = 'unapproved'; }],
  ['disabled internal native FK trigger', s => { nativeForeignTrigger(s).tgenabled = 'D'; }],
  ['foreign internal native FK trigger schema', s => { nativeForeignTrigger(s).child_schema = 22; }],
  ['missing native scope trigger', s => { s.triggers = rows(s, 'triggers').filter(row => row !== nativeScope(s)); }],
  ['duplicate native scope trigger', s => { rows(s, 'triggers').push({ ...nativeScope(s), oid: 9999 }); }],
  ['disabled native scope trigger', s => { nativeScope(s).tgenabled = 'D'; }],
  ['internal relabelled native scope trigger', s => { nativeScope(s).tgisinternal = true; }],
  ['wrong native scope trigger name', s => { nativeScope(s).tgname = 'forged_scope'; }],
  ['wrong native scope trigger table', s => { nativeScope(s).table_name = 'collaboration_documents'; }],
  ['wrong native scope trigger events', s => { nativeScope(s).tgtype = 5; }],
  ['native scope trigger arguments', s => { nativeScope(s).tgnargs = 1; }],
  ['native scope trigger predicate', s => { nativeScope(s).qualification = 'true'; }],
  ['native scope trigger attribute restriction', s => { nativeScope(s).attributes = '1'; }],
  ['native scope trigger constraint', s => { nativeScope(s).constraint_oid = 9000; }],
  ['deferrable native scope trigger', s => { nativeScope(s).tgdeferrable = true; }],
  ['initially deferred native scope trigger', s => { nativeScope(s).tginitdeferred = true; }],
  ['foreign native scope function schema', s => { nativeScope(s).function_schema = 22; }],
  ['wrong native scope function name', s => { nativeScope(s).proname = 'other_function'; }],
  ['changed native scope function body', s => { nativeScope(s).prosrc = 'BEGIN RETURN NEW; END'; }],
  ['security-definer native scope function', s => { nativeScope(s).prosecdef = true; }],
  ['native scope function settings', s => { nativeScope(s).proconfig = ['search_path=public']; }],
  ['wrong native scope function kind', s => { nativeScope(s).prokind = 'p'; }],
  ['native scope function arguments', s => { nativeScope(s).pronargs = 1; }],
  ['wrong native scope function return type', s => { nativeScope(s).returns_trigger = false; }],
  ['wrong native scope function language', s => { nativeScope(s).lanname = 'sql'; }],
  ['unknown extra native user trigger', s => { rows(s, 'triggers').push({ ...nativeScope(s), oid: 9999, tgname: 'unapproved_extra_trigger' }); }],
];
for (const [label, change] of nativeMutate) for (const phase of ['initial', 'fresh'] as const) test(`${phase} bounded inspection rejects ${label}`, async () => {
  const h = harness();
  if (phase === 'initial') {
    change(h.snapshot);
    await assert.rejects(loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding), { code: 'ORIGINAL_DELETE_STORAGE_CHANGED', status: 409 });
    assert.equal(h.calls.length, 4, 'Initial native-receipt checks stay in the same bounded inspection.');
  } else {
    const storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
    change(h.snapshot);
    await assert.rejects(storage.assertCurrent(), { code: 'ORIGINAL_DELETE_STORAGE_CHANGED', status: 409 });
    assert.equal(h.calls.length, 5, 'No hidden second query or successful cache hit.');
  }
});
for (const [label, change] of [
  ['native scope function OID', (s: Row) => { nativeScope(s).function_oid = 9999; }],
  ['native unique definition', (s: Row) => { nativeConstraint(s, 'u').definition = 'changed but still individually usable'; }],
] as const) test(`fresh inspection pins the original ${label} fingerprint`, async () => {
  const h = harness(), storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
  change(h.snapshot); await assert.rejects(storage.assertCurrent(), { code: 'ORIGINAL_DELETE_STORAGE_CHANGED', status: 409 });
  assert.equal(h.calls.length, 5);
});
test('SQL rejection preserves its original failure without a cached successful inspection', async () => {
  const h = harness(), storage = await loaded.exports.bindWorkspaceOperationOriginalDeleteStorageOnConnection(h.database, binding);
  const failure = new Error('declared-catalogue-query-failure');
  h.database.get = async () => { throw failure; };
  await assert.rejects(storage.assertCurrent(), error => error === failure);
});
let complete = false;
const watchdog = setTimeout(() => { console.error('storage batch fixture incomplete'); process.exitCode = 1; }, 20_000);
process.on('beforeExit', () => { if (!complete) process.exitCode = 1; });
after(() => {
  clearTimeout(watchdog);
  assert.equal(hash(fs.readFileSync(file, 'utf8')), sourceHash);
  assert.equal(hash(fs.readFileSync(ownPath, 'utf8')), ownHash);
  complete = true;
});
