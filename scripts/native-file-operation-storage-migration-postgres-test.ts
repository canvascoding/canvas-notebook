import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { NATIVE_FILE_OPERATION_HANDOFF_STATEMENTS } from '../app/lib/db/native-file-operation-handoff-migration';
import { NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS } from '../app/lib/db/native-file-operation-side-effects-migration';
import { NATIVE_FILE_RESTORE_STATEMENTS } from '../app/lib/db/native-file-operation-restore-migration';

const privateEnvPath = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
const restoreTables = ['collaboration_native_restore_intents', 'collaboration_native_restore_receipts'];
let phase = 'environment';

async function main(): Promise<void> {
  // These optional global migrations cannot run against the shared local DB.
  // Read only DATABASE_URL; never load the private env into process.env.
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvPath)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvPath, 'utf8')).DATABASE_URL;
  assert.ok(connectionString, 'Private local PostgreSQL configuration is required.');
  const url = new URL(connectionString);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `native_restore_global_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^native_restore_global_[a-f0-9]{32}$/u);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c lock_timeout=4000 -c application_name=canvas-native-restore-global-control' });
  const database = new Client({ connectionString, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=4000 -c application_name=canvas-native-restore-global-test` });
  let created = false; let controlConnected = false;
  let backend: number | undefined;
  const dependencyOrder: string[] = [];
  const assertOwnConnection = async () => {
    const row = (await database.query(`SELECT current_schema() AS schema,pg_backend_pid() AS backend,
      current_setting('search_path') AS search_path`)).rows[0];
    assert.equal(row.schema, schema);
    assert.deepEqual(String(row.search_path).split(',').map(part => part.trim()), [schema, 'pg_catalog']);
    if (backend === undefined) backend = row.backend;
    assert.equal(row.backend, backend);
  };
  // Exact same client and unmodified SQL. No public fallback in search_path.
  const migrationTarget = { query: async (sql: string, values?: unknown[]) => {
    await assertOwnConnection();
    if (sql === NATIVE_FILE_OPERATION_HANDOFF_STATEMENTS[0]) dependencyOrder.push('combined');
    if (sql === NATIVE_FILE_OPERATION_SIDE_EFFECT_STATEMENTS[0]) dependencyOrder.push('supplemental');
    if (sql === NATIVE_FILE_RESTORE_STATEMENTS[0]) dependencyOrder.push('restore');
    const result = await database.query(sql, values);
    await assertOwnConnection();
    return result;
  } } as unknown as Parameters<typeof runPostgresMigrations>[0];
  try {
    phase = 'own schema';
    await control.connect(); controlConnected = true;
    const server = (await control.query(`SELECT current_database() AS database,
      current_setting('server_version_num')::integer AS version`)).rows[0];
    assert.equal(server.database, 'canvas_notebook');
    assert.equal(Math.floor(server.version / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await database.connect();
    await assertOwnConnection();
    phase = 'actual full global dispatcher';
    await runPostgresMigrations(migrationTarget);
    await database.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at)
      VALUES('owned-workspace',' native note.md ','Existing title',100,200)`);
    await database.query(`INSERT INTO collaboration_native_restore_intents(operation_id,request_id,intent_text,changes_bundle_proof)
      VALUES('preserved-private-intent','preserved-private-request','{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`);
    const before = (await database.query('SELECT * FROM workspace_file_metadata')).rows;
    const privateBefore = (await database.query('SELECT * FROM collaboration_native_restore_intents')).rows;
    for (let repeat = 0; repeat < 2; repeat++) {
      await runPostgresMigrations(migrationTarget);
      assert.deepEqual((await database.query('SELECT * FROM workspace_file_metadata')).rows, before);
      assert.deepEqual((await database.query('SELECT * FROM collaboration_native_restore_intents')).rows, privateBefore);
    }
    assert.deepEqual(dependencyOrder, Array.from({ length: 3 }, () => ['combined', 'supplemental', 'restore']).flat());
    phase = 'schema-local Restore relations and constraints';
    const relations = await database.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY c.relname`, [schema, restoreTables]);
    assert.deepEqual(relations.rows.map(row => row.relname), [...restoreTables].sort());
    const foreignKeys = await database.query(`SELECT source.relname AS source,target.relname AS target,namespace.nspname AS schema
      FROM pg_constraint constraint_row JOIN pg_class source ON source.oid=constraint_row.conrelid
        JOIN pg_class target ON target.oid=constraint_row.confrelid JOIN pg_namespace namespace ON namespace.oid=target.relnamespace
      WHERE constraint_row.contype='f' AND constraint_row.conrelid='collaboration_native_restore_receipts'::regclass
      ORDER BY target.relname`);
    assert.deepEqual(foreignKeys.rows, ['collaboration_admission_requests','collaboration_documents','collaboration_native_restore_intents']
      .map(target => ({ source: 'collaboration_native_restore_receipts', target, schema })));
    const triggers = await database.query(`SELECT c.relname AS table_name,t.tgname AS name,
      t.tgdeferrable AND t.tginitdeferred AS deferred,function_namespace.nspname AS function_schema
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace function_namespace ON function_namespace.oid=p.pronamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [schema, restoreTables]);
    assert.deepEqual(triggers.rows, [
      { table_name: restoreTables[0], name: 'native_restore_intent_immutable', deferred: false, function_schema: schema },
      { table_name: restoreTables[1], name: 'native_restore_receipt_endstate', deferred: true, function_schema: schema },
      { table_name: restoreTables[1], name: 'native_restore_receipt_immutable', deferred: false, function_schema: schema },
    ]);
    phase = 'actual immutability, foreign key and deferred COMMIT rejection';
    await database.query('BEGIN');
    try {
      await database.query(`INSERT INTO collaboration_native_restore_intents(operation_id,request_id,intent_text,changes_bundle_proof)
        VALUES('owned-operation','owned-request','{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`);
      for (const sql of [
        "UPDATE collaboration_native_restore_intents SET request_id='changed' WHERE operation_id='owned-operation'",
        "DELETE FROM collaboration_native_restore_intents WHERE operation_id='owned-operation'",
      ]) {
        await database.query('SAVEPOINT immutable_attempt');
        await assert.rejects(database.query(sql), { code: '55000' });
        await database.query('ROLLBACK TO SAVEPOINT immutable_attempt');
      }
      await database.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,path,created_at,updated_at)
        VALUES('owned-document','owned-workspace','personal','note.md',100,100);
        INSERT INTO collaboration_admission_requests(request_id,request_digest,intent_text,status,revision,created_at)
        VALUES('owned-request','invalid-test-digest','{}','reserved',1,100)`);
      await database.query('SAVEPOINT missing_membership');
      await assert.rejects(database.query(`INSERT INTO collaboration_native_restore_receipts
        (operation_id,mutation_id,document_id,request_id,changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot)
        VALUES('owned-operation','mutation','missing-document','owned-request',repeat('0',64),'{}',
          encode(sha256(convert_to('{}','UTF8')),'hex'),decode('01','hex'))`), { code: '23503' });
      await database.query('ROLLBACK TO SAVEPOINT missing_membership');
      await database.query(`INSERT INTO collaboration_native_restore_receipts
        (operation_id,mutation_id,document_id,request_id,changes_bundle_proof,receipt_text,receipt_digest,after_state_snapshot)
        VALUES('owned-operation','mutation','owned-document','owned-request',repeat('0',64),'{}',
          encode(sha256(convert_to('{}','UTF8')),'hex'),decode('01','hex'))`);
      for (const sql of [
        "UPDATE collaboration_native_restore_receipts SET mutation_id='changed' WHERE operation_id='owned-operation'",
        "DELETE FROM collaboration_native_restore_receipts WHERE operation_id='owned-operation'",
      ]) {
        await database.query('SAVEPOINT immutable_attempt');
        await assert.rejects(database.query(sql), { code: '55000' });
        await database.query('ROLLBACK TO SAVEPOINT immutable_attempt');
      }
      assert.equal((await database.query('SELECT count(*)::integer AS count FROM collaboration_native_restore_receipts')).rows[0].count, 1);
      await assert.rejects(database.query('COMMIT'), { code: '23514' });
    } finally { await database.query('ROLLBACK'); }
    await assertOwnConnection();
    for (const table of restoreTables) {
      assert.deepEqual((await database.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows,
        [{ count: table === 'collaboration_native_restore_intents' ? 1 : 0 }]);
    }
    assert.deepEqual((await database.query('SELECT * FROM collaboration_native_restore_intents')).rows, privateBefore);
    assert.deepEqual((await database.query('SELECT * FROM workspace_file_metadata')).rows, before);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM collaboration_documents WHERE id='owned-document'")).rows[0].count, 0);
  } finally {
    try { await database.end(); }
    finally {
      try {
        if (controlConnected && created) {
          await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true);
        }
      } finally { await control.end(); }
    }
  }
  console.log('Native Restore PostgreSQL 18 global dispatcher: same owned-schema client, ordered repeated startup, preserved metadata, local FKs/triggers, immutability and actual deferred COMMIT rejection passed; owned schema removed.');
}

main().catch(error => {
  // Configuration values never enter logs, including connection failure output.
  console.error('Owned PostgreSQL global migration fixture failed:', { phase,
    name: error instanceof Error ? error.name : 'unknown', code: (error as { code?: string })?.code ?? null });
  process.exitCode = 1;
});
