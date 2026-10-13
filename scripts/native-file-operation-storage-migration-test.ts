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
const restoreTables = ['collaboration_native_restore_intents', 'collaboration_native_restore_receipts'];
const restoreTriggers = [
  ['collaboration_native_restore_intents', 'native_restore_intent_immutable', false],
  ['collaboration_native_restore_receipts', 'native_restore_receipt_immutable', false],
  ['collaboration_native_restore_receipts', 'native_restore_receipt_endstate', true],
];

async function main(): Promise<void> {
  const database = new PGlite();
  const migrationTarget = database as unknown as Parameters<typeof runPostgresMigrations>[0];
  const allTables = [...tables, ...restoreTables];
  try {
    // Exercise the actual complete startup migration, not the new arrays alone.
    await runPostgresMigrations(migrationTarget);
    await database.exec(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
      VALUES('storage-migration-workspace',' native note.md ','Existing title',100,200)`);
    await database.exec(`INSERT INTO collaboration_native_restore_intents(operation_id,request_id,intent_text,changes_bundle_proof)
      VALUES('preserved-private-intent','preserved-private-request','{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`);
    const before = (await database.query('SELECT * FROM workspace_file_metadata')).rows;
    const privateBefore = (await database.query('SELECT * FROM collaboration_native_restore_intents')).rows;
    for (let repeat = 0; repeat < 2; repeat++) {
      await runPostgresMigrations(migrationTarget);
      assert.deepEqual((await database.query('SELECT * FROM workspace_file_metadata')).rows, before);
      assert.deepEqual((await database.query('SELECT * FROM collaboration_native_restore_intents')).rows, privateBefore);
    }
    const relations = await database.query<{ name: string }>(`SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [allTables]);
    assert.deepEqual(relations.rows.map(row => row.name), [...allTables].sort());
    const triggers = await database.query<{ table_name: string; name: string; deferred: boolean }>(`
      SELECT c.relname AS table_name,t.tgname AS name,t.tgdeferrable AND t.tginitdeferred AS deferred
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal
      ORDER BY c.relname,t.tgname`, [allTables]);
    assert.deepEqual(triggers.rows.map(row => [row.table_name,row.name,row.deferred]),
      [...expectedTriggers, ...restoreTriggers].sort(([leftTable,leftName], [rightTable,rightName]) =>
        String(leftTable).localeCompare(String(rightTable)) || String(leftName).localeCompare(String(rightName))));
    const foreignKeys = await database.query<{ source: string; target: string; schema: string }>(`
      SELECT source.relname AS source,target.relname AS target,namespace.nspname AS schema
      FROM pg_constraint constraint_row JOIN pg_class source ON source.oid=constraint_row.conrelid
        JOIN pg_class target ON target.oid=constraint_row.confrelid JOIN pg_namespace namespace ON namespace.oid=target.relnamespace
      WHERE constraint_row.contype='f' AND constraint_row.conrelid='collaboration_native_restore_receipts'::regclass
      ORDER BY target.relname`);
    assert.deepEqual(foreignKeys.rows, ['collaboration_admission_requests','collaboration_documents','collaboration_native_restore_intents']
      .map(target => ({ source: 'collaboration_native_restore_receipts', target, schema: 'public' })));
    await database.exec('BEGIN');
    try {
      await database.exec(`INSERT INTO collaboration_native_restore_intents(operation_id,request_id,intent_text,changes_bundle_proof)
        VALUES('global-restore-operation','global-restore-request','{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`);
      for (const sql of [
        "UPDATE collaboration_native_restore_intents SET request_id='changed' WHERE operation_id='global-restore-operation'",
        "DELETE FROM collaboration_native_restore_intents WHERE operation_id='global-restore-operation'",
      ]) {
        await database.exec('SAVEPOINT immutable_attempt');
        await assert.rejects(database.exec(sql), (error: unknown) => (error as { code?: string })?.code === '55000');
        await database.exec('ROLLBACK TO SAVEPOINT immutable_attempt');
      }
      await database.exec(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,path,created_at,updated_at)
        VALUES('global-restore-document','global-restore-workspace','personal','note.md',100,100);
        INSERT INTO collaboration_admission_requests(request_id,request_digest,intent_text,status,revision,created_at)
        VALUES('global-restore-request','invalid-test-digest','{}','reserved',1,100)`);
      await database.exec('SAVEPOINT missing_membership');
      await assert.rejects(database.exec(`INSERT INTO collaboration_native_restore_receipts
        (operation_id,mutation_id,document_id,request_id,changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot)
        VALUES('global-restore-operation','mutation','missing-document','global-restore-request',repeat('0',64),'{}',
          encode(sha256(convert_to('{}','UTF8')),'hex'),decode('01','hex'))`),
      (error: unknown) => (error as { code?: string })?.code === '23503');
      await database.exec('ROLLBACK TO SAVEPOINT missing_membership');
      // Deliberately invalid receipt passes immediate FKs; the actual global
      // deferred endstate guard must reject COMMIT without archive/outcome authority.
      await database.exec(`INSERT INTO collaboration_native_restore_receipts
        (operation_id,mutation_id,document_id,request_id,changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot)
        VALUES('global-restore-operation','mutation','global-restore-document','global-restore-request',repeat('0',64),'{}',
          encode(sha256(convert_to('{}','UTF8')),'hex'),decode('01','hex'))`);
      for (const sql of [
        "UPDATE collaboration_native_restore_receipts SET mutation_id='changed' WHERE operation_id='global-restore-operation'",
        "DELETE FROM collaboration_native_restore_receipts WHERE operation_id='global-restore-operation'",
      ]) {
        await database.exec('SAVEPOINT immutable_attempt');
        await assert.rejects(database.exec(sql), (error: unknown) => (error as { code?: string })?.code === '55000');
        await database.exec('ROLLBACK TO SAVEPOINT immutable_attempt');
      }
      assert.equal((await database.query<{ count: number }>('SELECT count(*)::integer AS count FROM collaboration_native_restore_receipts')).rows[0].count, 1);
      await assert.rejects(database.exec('COMMIT'), (error: unknown) => (error as { code?: string })?.code === '23514');
    } finally { await database.exec('ROLLBACK'); }
    // The globally installed before-insert guard must reject an unbound stage
    // before FK handling; no private record or normal metadata may be changed.
    await assert.rejects(database.exec(`INSERT INTO collaboration_native_file_operation_side_effect_stages
      (operation_id,request_id,stage_text,stage_digest)
      VALUES('unbound-operation','unbound-request','{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`),
    (error: unknown) => (error as { code?: string })?.code === '23514');
    for (const table of allTables) {
      assert.deepEqual((await database.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows,
        [{ count: table === 'collaboration_native_restore_intents' ? 1 : 0 }]);
    }
    assert.deepEqual((await database.query('SELECT * FROM collaboration_native_restore_intents')).rows, privateBefore);
    assert.deepEqual((await database.query('SELECT * FROM workspace_file_metadata')).rows, before);
  } finally { await database.close(); }
  console.log('Native file operation storage: actual PGlite startup migration, repeatability, preserved metadata, Restore FKs/immutability/deferred COMMIT guards passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
