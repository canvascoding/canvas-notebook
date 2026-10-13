import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runPostgresMigrations } from '../app/lib/db/postgres';

const tables = [
  'collaboration_native_file_operation_intents',
  'collaboration_native_file_operation_receipts',
  'collaboration_native_file_operation_side_effect_stages',
  'collaboration_native_file_operation_side_effect_receipts',
];
const expectedTriggers = [
  ['collaboration_native_file_operation_intents', 'native_file_intent_immutable', false],
  ['collaboration_native_file_operation_receipts', 'native_file_receipt_immutable', false],
  ['collaboration_native_file_operation_receipts', 'native_file_receipt_endstate', true],
  ['collaboration_native_file_operation_side_effect_stages', 'native_file_side_effect_stage_guard', false],
  ['collaboration_native_file_operation_side_effect_stages', 'native_file_side_effect_stage_immutable', false],
  ['collaboration_native_file_operation_side_effect_stages', 'native_file_side_effect_stage_complete', true],
  ['collaboration_native_file_operation_side_effect_receipts', 'native_file_side_effect_receipt_immutable', false],
  ['collaboration_native_file_operation_side_effect_receipts', 'native_file_side_effect_receipt_guard', true],
];

async function main(): Promise<void> {
  const database = new PGlite();
  const migrationTarget = database as unknown as Parameters<typeof runPostgresMigrations>[0];
  try {
    // Exercise the actual complete startup migration, not the new arrays alone.
    await runPostgresMigrations(migrationTarget);
    await database.exec(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
      VALUES('storage-migration-workspace',' native note.md ','Existing title',100,200)`);
    const before = (await database.query('SELECT * FROM workspace_file_metadata')).rows;
    for (let repeat = 0; repeat < 2; repeat++) {
      await runPostgresMigrations(migrationTarget);
      assert.deepEqual((await database.query('SELECT * FROM workspace_file_metadata')).rows, before);
    }
    const relations = await database.query<{ name: string }>(`SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [tables]);
    assert.deepEqual(relations.rows.map(row => row.name), [...tables].sort());
    const triggers = await database.query<{ table_name: string; name: string; deferred: boolean }>(`
      SELECT c.relname AS table_name,t.tgname AS name,t.tgdeferrable AND t.tginitdeferred AS deferred
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal
      ORDER BY c.relname,t.tgname`, [tables]);
    assert.deepEqual(triggers.rows.map(row => [row.table_name,row.name,row.deferred]),
      expectedTriggers.sort(([leftTable,leftName], [rightTable,rightName]) =>
        String(leftTable).localeCompare(String(rightTable)) || String(leftName).localeCompare(String(rightName))));
    // The globally installed before-insert guard must reject an unbound stage
    // before FK handling; no private record or normal metadata may be changed.
    await assert.rejects(database.exec(`INSERT INTO collaboration_native_file_operation_side_effect_stages
      (operation_id,request_id,stage_text,stage_digest)
      VALUES('unbound-operation','unbound-request','{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`),
    (error: unknown) => (error as { code?: string })?.code === '23514');
    for (const table of tables) {
      assert.deepEqual((await database.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows, [{ count: 0 }]);
    }
    assert.deepEqual((await database.query('SELECT * FROM workspace_file_metadata')).rows, before);
  } finally { await database.close(); }
  console.log('Native file operation storage: actual PGlite startup migration, repeatability, preserved metadata and receipt guards passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
