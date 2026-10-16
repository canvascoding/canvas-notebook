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
  // Normalized original AST at SHA48a24c11… before this batching change.
  constraints: '747e2003dd79df6ab9574249bca5e4d4f499d89f3896e4ef7fca6c1cfd8dda53',
  triggers: '8a34374b0a51cd1223cbc9d819d1ccda918974eeab20d5f5ce7c9b4bc12ee667',
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
  immutableSource: string; initializeSource: string } };
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const native = createRequire(file), loaded = { exports: {} as Module };
// The test VM exposes metadata solely to construct declared catalogue rows.
// No production export, SQL result override or capability is added.
new Function('require', 'module', 'exports', `${compiled}\nmodule.exports.fixtureFacts={names,expectedColumns,immutableSource,initializeSource};`)(
  (name: string) => name === 'server-only' ? {} : native(name), loaded, loaded.exports);
const { names, expectedColumns, immutableSource, initializeSource } = loaded.exports.fixtureFacts;
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
  for (const spec of specs) {
    unique(spec.table, 'p', spec.primaryKey);
    for (const columns of spec.uniqueKeys) unique(spec.table, 'u', columns);
    for (const fk of spec.foreignKeys) foreign(spec.table, fk.columns, fk.table, fk.referencedColumns);
  }
  for (const spec of [...specs.map(spec => ({ table: spec.table, name: spec.immutableTrigger, immutable: true })),
    { table: 'collaboration_yjs_states', name: 'collaboration_yjs_state_initialized', immutable: false }]) {
    triggers.push({ oid: nextOid++, table_name: spec.table, tgname: spec.name, tgtype: spec.immutable ? 27 : 5,
      tgenabled: 'O', tgisinternal: false, tgnargs: 0, qualification: null, attributes: '', tgdeferrable: false,
      tginitdeferred: false, constraint_oid: 0, function_oid: spec.immutable ? 5000 : 5001, function_schema: 21,
      function_schema_name: realm.schema_name, proname: spec.immutable ? WORKSPACE_OPERATION_ORIGINAL_DELETE_IMMUTABLE_FUNCTION : 'mark_collaboration_yjs_state_initialized',
      prosrc: spec.immutable ? immutableSource : initializeSource, prosecdef: false, proconfig: null,
      prokind: 'f', pronargs: 0, returns_trigger: true, lanname: 'plpgsql' });
  }
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
      return structuredClone(sql.startsWith('WITH current_relations') ? result.snapshot : realm); },
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
  assert.equal(names.length, 16); assert.equal(h.calls.length, 4);
  await storage.assertCurrent(); await storage.assertCurrent();
  assert.equal(h.calls.length, 6);
  const inspections = h.calls.filter(call => call.sql.startsWith('WITH current_relations'));
  assert.equal(inspections.length, 3);
  for (const call of inspections) {
    assert.equal(call.method, 'get'); assert.equal(call.sql.includes(';'), false);
    assert.deepEqual(call.parameters, [names.map(relationOid), 21, 31, '"storage_fixture"', names]);
    assert.match(call.sql, /CROSS JOIN LATERAL/u); assert.match(call.sql, /LIMIT 129/u);
    assert.equal((call.sql.match(/LIMIT 257/gu) ?? []).length, 2);
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
