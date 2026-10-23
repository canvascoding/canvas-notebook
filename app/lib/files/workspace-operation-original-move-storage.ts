import 'server-only';

import type { SqlConnection } from '../db';
import { WORKSPACE_OPERATION_ORIGINAL_MOVE_TABLE_SPECS as specs,
  WORKSPACE_OPERATION_ORIGINAL_MOVE_STATEMENTS, WORKSPACE_OPERATION_ORIGINAL_MOVE_IMMUTABLE_FUNCTION }
  from '../db/workspace-operation-original-move-migration';
import { bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection } from './workspace-operation-original-move-handoff-storage';
import { bindWorkspaceOperationOriginalDeleteStorageOnConnection } from './workspace-operation-original-delete-storage';

type Source = Readonly<{ schemaName: string; schemaOid: number; databaseOid: number }>;
type Row = Record<string, unknown>;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const json = (value: unknown) => JSON.stringify(value);
const sourceBody = /\$\$([\s\S]*)\$\$/u.exec(WORKSPACE_OPERATION_ORIGINAL_MOVE_STATEMENTS.find(sql =>
  sql.startsWith(`CREATE OR REPLACE FUNCTION ${WORKSPACE_OPERATION_ORIGINAL_MOVE_IMMUTABLE_FUNCTION}()`))!)?.[1];
function fail(): never { throw Object.assign(new Error('Original Move storage changed.'), { code: 'ORIGINAL_MOVE_STORAGE_CHANGED', status: 409 }); }
const oid = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > 4294967295) fail(); return n; };
const names = Object.freeze(specs.map(spec => spec.table));

/** The actual owner B retains the same fixed native/metadata storage checks as
 * original Delete, plus the four immutable Move stores. No SQL facade escapes. */
export async function bindWorkspaceOperationOriginalMoveStorageOnConnection(database: SqlConnection, input: Source) {
  const source = Object.freeze({ schemaName: input.schemaName, schemaOid: input.schemaOid, databaseOid: input.databaseOid });
  const shared = await bindWorkspaceOperationOriginalDeleteStorageOnConnection(database, source);
  const handoff = await bindWorkspaceOperationOriginalMoveHandoffStorageOnConnection(database, source);
  const prefix = quote(source.schemaName);
  const relations = await database.all(`SELECT c.relname AS name,c.oid::bigint AS oid,c.relnamespace::bigint AS schema,
    c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname))::oid::bigint AS resolved
    FROM pg_catalog.pg_class c WHERE c.relnamespace=$1::oid AND c.relname=ANY($2::text[]) ORDER BY c.relname COLLATE "C"`,
  [source.schemaOid, names]) as Row[];
  if (relations.length !== names.length || new Set(relations.map(row => row.name)).size !== names.length
    || relations.some(row => !names.includes(row.name as typeof names[number]) || oid(row.schema) !== source.schemaOid
      || oid(row.oid) !== oid(row.resolved) || row.relkind !== 'r' || row.relpersistence !== 'p'
      || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) fail();
  const ids = relations.map(row => oid(row.oid));
  await database.run(`LOCK TABLE ${names.map(name => `${prefix}.${quote(name)}`).join(',')} IN ROW EXCLUSIVE MODE NOWAIT`);
  const inspect = async () => {
    const realm = await database.get(`SELECT pg_catalog.current_schema() AS name,
      pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema,
      (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database`) as Row | undefined;
    if (!realm || realm.name !== source.schemaName || oid(realm.schema) !== source.schemaOid || oid(realm.database) !== source.databaseOid) fail();
    const rows = await database.all(`SELECT c.relname AS name,c.oid::bigint AS oid,c.relnamespace::bigint AS schema,
      c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
      pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname))::oid::bigint AS resolved
      FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::oid[]) ORDER BY c.relname COLLATE "C"`, [ids]) as Row[];
    if (json(rows) !== json(relations)) fail();
    const locks = await database.all(`SELECT DISTINCT relation::bigint AS oid FROM pg_catalog.pg_locks
      WHERE pid=pg_catalog.pg_backend_pid() AND locktype='relation' AND database=$1::oid AND relation=ANY($2::oid[])
      AND granted AND mode IN('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')`, [source.databaseOid, ids]) as Row[];
    if (locks.length !== ids.length || locks.some(row => !ids.includes(oid(row.oid)))) fail();
    const columns = await database.all(`SELECT c.relname AS name,a.attname AS column_name,
      pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attgenerated,a.attidentity
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.oid=ANY($1::oid[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname COLLATE "C",a.attname COLLATE "C" LIMIT 65`, [ids]) as Row[];
    if (columns.length !== specs.reduce((sum,spec) => sum + spec.columns.length, 0)) fail();
    for (const spec of specs) {
      const selected = columns.filter(row => row.name === spec.table);
      if (json(selected.map(row => row.column_name).sort()) !== json([...spec.columns].sort())
        || selected.some(row => row.type !== (row.column_name === 'created_at' ? 'bigint' : 'text') || row.attnotnull !== true
          || row.attgenerated !== '' || row.attidentity !== '' || row.column_name !== 'created_at' && row.default_value !== null)) fail();
    }
    const constraints = await database.all(`SELECT c.oid::bigint AS oid,r.relname AS name,c.contype,c.convalidated,c.conenforced,c.condeferrable,c.condeferred,
      c.confrelid::bigint AS target_oid,t.relname AS target,t.relnamespace::bigint AS target_schema,
      ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns,
      i.indisvalid,i.indisready,i.indislive,i.indimmediate,pg_catalog.pg_get_constraintdef(c.oid,true) AS definition,
      (SELECT count(*)=2 AND bool_and(g.tgisinternal AND g.tgenabled IN('O','A')) FROM pg_catalog.pg_trigger g
        WHERE g.tgconstraint=c.oid AND g.tgrelid=c.conrelid) AS fk_triggers
      FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid=c.conrelid
      LEFT JOIN pg_catalog.pg_class t ON t.oid=c.confrelid LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
      WHERE c.conrelid=ANY($1::oid[]) ORDER BY c.oid LIMIT 129`, [ids]) as Row[];
    if (constraints.length > 128 || constraints.some(row => row.convalidated !== true || row.conenforced !== true
      || row.condeferrable !== false || row.condeferred !== false || !['p','u','f','c','n'].includes(String(row.contype)))) fail();
    for (const spec of specs) {
      for (const columns of [spec.primaryKey, ...spec.uniqueKeys]) {
        const found = constraints.filter(row => row.name === spec.table && row.contype === (columns === spec.primaryKey ? 'p' : 'u') && json(row.columns) === json(columns));
        if (found.length !== 1 || found[0].indisvalid !== true || found[0].indisready !== true || found[0].indislive !== true || found[0].indimmediate !== true) fail();
      }
      for (const fk of spec.foreignKeys) {
        const found = constraints.filter(row => row.name === spec.table && row.contype === 'f' && json(row.columns) === json(fk.columns)
          && row.target === fk.table && Number(row.target_schema) === source.schemaOid && json(row.target_columns) === json(fk.referencedColumns));
        if (found.length !== 1 || found[0].fk_triggers !== true || found[0].indisvalid !== true || found[0].indisready !== true || found[0].indislive !== true) fail();
      }
    }
    const triggers = await database.all(`SELECT t.oid::bigint AS oid,r.relname AS name,t.tgname,t.tgisinternal,t.tgenabled,t.tgtype,t.tgnargs,
      t.tgqual::text AS qualification,t.tgattr::text AS attributes,t.tgdeferrable,t.tginitdeferred,t.tgconstraint::bigint AS constraint_oid,
      p.oid::bigint AS function_oid,p.pronamespace::bigint AS function_schema,p.proname,p.prosrc,p.prosecdef,p.proconfig,p.prokind,p.pronargs,
      p.prorettype='pg_catalog.trigger'::regtype AS returns_trigger,l.lanname,n.nspname AS function_schema_name,
      c.contype,c.convalidated,c.conenforced,c.condeferrable,child.relnamespace::bigint AS child_schema,parent.relnamespace::bigint AS parent_schema
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class r ON r.oid=t.tgrelid JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      LEFT JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint LEFT JOIN pg_catalog.pg_class child ON child.oid=c.conrelid
      LEFT JOIN pg_catalog.pg_class parent ON parent.oid=c.confrelid WHERE t.tgrelid=ANY($1::oid[]) ORDER BY t.oid LIMIT 65`, [ids]) as Row[];
    if (triggers.length > 64 || !sourceBody) fail();
    const found = new Set<string>();
    for (const row of triggers) {
      if (!['O','A'].includes(String(row.tgenabled)) || row.prosecdef !== false || row.proconfig !== null || row.prokind !== 'f'
        || Number(row.pronargs) !== 0 || row.returns_trigger !== true) fail();
      if (row.tgisinternal === true) {
        if (row.contype !== 'f' || row.convalidated !== true || row.conenforced !== true || row.condeferrable !== false
          || Number(row.child_schema) !== source.schemaOid || Number(row.parent_schema) !== source.schemaOid
          || row.function_schema_name !== 'pg_catalog' || row.lanname !== 'internal' || typeof row.proname !== 'string'
          || !/^RI_FKey_(check_ins|check_upd|noaction_del|noaction_upd|restrict_del|restrict_upd)$/u.test(row.proname) || row.prosrc !== row.proname) fail();
      } else {
        const spec = specs.find(spec => spec.table === row.name && spec.immutableTrigger === row.tgname);
        if (!spec) fail();
        if (found.has(spec.table) || Number(row.function_schema) !== source.schemaOid
          || row.proname !== WORKSPACE_OPERATION_ORIGINAL_MOVE_IMMUTABLE_FUNCTION || row.prosrc !== sourceBody || row.lanname !== 'plpgsql'
          || Number(row.tgtype) !== 27 || Number(row.tgnargs) !== 0 || row.qualification !== null || row.attributes !== ''
          || Number(row.constraint_oid) !== 0 || row.tgdeferrable !== false || row.tginitdeferred !== false) fail();
        found.add(spec.table);
      }
    }
    if (found.size !== specs.length) fail();
    return json({ rows, columns, constraints, triggers });
  };
  const expected = await inspect();
  return Object.freeze({ schema: source.schemaName, prefix, assertCurrent: async () => {
    await shared.assertCurrent(); await handoff.assertCurrent(); if (await inspect() !== expected) fail();
  } });
}
