import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { runWorkspaceOperationOriginalMoveMigration, WORKSPACE_OPERATION_ORIGINAL_MOVE_TABLE_SPECS } from '../app/lib/db/workspace-operation-original-move-migration';
import * as repository from '../app/lib/files/workspace-operation-original-move-repository';

// Actual PG18 mechanical storage only. The batch dependency is an explicit
// schema-local minimal fixture, not a real job claim, Owner, DA04 or FS result.
const environment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
const MiB = 1024 * 1024, sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const code = (error: unknown) => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
const files = ['app/lib/db/workspace-operation-original-move-migration.ts', 'app/lib/files/workspace-operation-original-move-repository.ts',
  'scripts/workspace-operation-original-move-postgres-test.ts', 'scripts/workspace-operation-original-move-repository-test.ts'];
let phase = 'environment';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  const pinned = await Promise.all(files.map(async filename => [filename, sha(await fs.readFile(path.resolve(filename)))] as const));
  const envStat = await fs.lstat(environment);
  assert(envStat.isFile() && !envStat.isSymbolicLink() && envStat.uid === process.getuid?.() && (envStat.mode & 0o777) === 0o600);
  const url = new URL(parse(await fs.readFile(environment, 'utf8')).DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search + url.hash, '');
  const nonce = randomUUID(), schema = `owned_move_journal_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^owned_move_journal_[a-f0-9]{32}$/u);
  const app = `move-journal-${randomUUID()}`;
  const control = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=20000 -c lock_timeout=1000 -c application_name=owned-move-journal-control' });
  let connected = false, created = false, oid = 0, removed = false, passed = 0;
  const clients = new Set<Client>(), backendPids: number[] = [], calls: string[] = [];
  const connect = async () => {
    const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=30000 -c lock_timeout=100 -c application_name=${app}` });
    client.on('error', () => undefined); clients.add(client); await client.connect();
    backendPids.push(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)); return client;
  };
  const own = async () => {
    const row = (await control.query(`SELECT n.oid,obj_description(n.oid,'pg_namespace') AS marker,
      n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
    assert(row && Number(row.oid) === oid && row.marker === nonce && row.owner === true);
  };
  const adapter = (client: Client): SqlConnection => ({
    get: async (sql, values) => { calls.push(sql); return (await client.query(sql, values)).rows[0]; },
    all: async (sql, values) => { calls.push(sql); return (await client.query(sql, values)).rows; },
    run: async (sql, values) => { calls.push(sql); await client.query(sql, values); },
    close: () => { throw new Error('Repository must not close a borrowed client.'); },
  });
  const transaction = async <T>(client: Client, operation: () => Promise<T>) => {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try { const result = await operation(); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  };
  try {
    await control.connect(); connected = true;
    const server = (await control.query("SELECT current_database() AS database,current_setting('server_version_num')::integer AS version")).rows[0];
    assert.equal(server.database, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    oid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid); await own();
    const client = await connect(), db = adapter(client);
    const group = async (label: string, operation: () => Promise<void>) => { phase = label; await own(); await operation(); await own(); passed++; };
    await client.query('CREATE TABLE workspace_file_operation_batches(batch_id text PRIMARY KEY)');
    await group('actual additive DDL and repeated migration preserve table identities', async () => {
      await transaction(client, () => runWorkspaceOperationOriginalMoveMigration(db));
      const before = (await client.query(`SELECT relname,oid FROM pg_class WHERE relnamespace=$1 AND relkind='r' ORDER BY relname`, [oid])).rows;
      await transaction(client, () => runWorkspaceOperationOriginalMoveMigration(db));
      assert.deepEqual((await client.query(`SELECT relname,oid FROM pg_class WHERE relnamespace=$1 AND relkind='r' ORDER BY relname`, [oid])).rows, before);
      assert.equal(before.length, 5);
      const fk = (await client.query(`SELECT c.convalidated,c.conenforced,n.nspname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace n ON n.oid=target.relnamespace
        WHERE t.relnamespace=$1 AND c.contype='f'`, [oid])).rows;
      assert.equal(fk.length, 4); assert(fk.every(row => row.convalidated && row.conenforced && row.nspname === schema));
    });
    const seed = async (intentText = '{"steps":["physical","native_absence"]}') => {
      const batchId = `move-${randomUUID()}`; await client.query('INSERT INTO workspace_file_operation_batches VALUES($1)', [batchId]);
      const input = { schema, batchId, planId: sha('plan'), workspaceId: 'owned-workspace', requestHash: sha('direct-request'), intentText };
      const inserted = await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveIntentOnConnection(db, input));
      assert.equal(inserted.kind, 'created');
      return { input, original: inserted.row, selected: { schema, batchId, intentDigest: inserted.row.intentDigest } };
    };
    const normal = await seed();
    const parent = { ...normal.selected, parentPath: 'new/shared', producerStep: 'step-0',
      consumerBindingsText: '[{"stepKey":"step-0","kind":"physical"},{"stepKey":"step-1","kind":"projection_absent"}]',
      receiptText: '{"originalProof":"opaque-domain-proof","identity":"actual-fixture-only"}' };
    await group('all four records roundtrip and exact byte idempotence', async () => {
      const inserted = await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(db, parent)); assert.equal(inserted.kind, 'created');
      const again = await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(db, parent)); assert.equal(again.kind, 'existing');
      assert.deepEqual(again, { ...inserted, kind: 'existing' });
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveIntentOnConnection(db, normal.input))).kind, 'existing');
      for (const stepKey of ['step-0', 'step-1']) assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db,
        { ...normal.selected, stepKey, receiptText: JSON.stringify({ kind: stepKey === 'step-0' ? 'moved' : 'projection_absent' }) }))).kind, 'created');
      const final = { ...normal.selected, receiptText: '{"domainVerification":"still-required"}' };
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveReceiptOnConnection(db, final))).kind, 'created');
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveReceiptOnConnection(db, final))).kind, 'existing');
      assert.equal((await repository.readWorkspaceOperationOriginalMoveIntentOnConnection(db, { schema, batchId: normal.input.batchId }))?.intentText, normal.input.intentText);
      assert.equal((await repository.readWorkspaceOperationOriginalMoveParentReceiptOnConnection(db, { ...normal.selected, parentPath: parent.parentPath }))?.consumerBindingsText, parent.consumerBindingsText);
      assert.equal((await repository.listWorkspaceOperationOriginalMoveParentReceiptsOnConnection(db, normal.selected))?.length, 1);
      assert.equal((await repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(db, normal.selected))?.length, 2);
      assert.equal((await repository.readWorkspaceOperationOriginalMoveReceiptOnConnection(db, normal.selected))?.receiptText, final.receiptText);
    });
    await group('changed original metadata, producer, consumers and byte formatting conflict without replacement', async () => {
      for (const patch of [{ planId: sha('other') }, { workspaceId: 'other-workspace' }, { requestHash: sha('other') }, { intentText: normal.input.intentText + '\n' }]) {
        assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveIntentOnConnection(db, { ...normal.input, ...patch }))).kind, 'conflict');
      }
      for (const patch of [{ producerStep: 'step-other' }, { consumerBindingsText: '[{"stepKey":"step-other"}]' }, { receiptText: parent.receiptText + '\n' }]) {
        assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(db, { ...parent, ...patch }))).kind, 'conflict');
      }
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db,
        { ...normal.selected, stepKey: 'step-0', receiptText: 'changed' }))).kind, 'conflict');
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveReceiptOnConnection(db,
        { ...normal.selected, receiptText: 'changed' }))).kind, 'conflict');
    });
    await group('missing original and wrong original digest never create or read child records', async () => {
      for (const selected of [{ ...normal.selected, intentDigest: sha('wrong') }, { ...normal.selected, batchId: `move-${randomUUID()}` }]) {
        assert.equal(await repository.readWorkspaceOperationOriginalMoveReceiptOnConnection(db, selected), null);
        assert.equal(await repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(db, selected), null);
        assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db,
          { ...selected, stepKey: 'missing', receiptText: '{}' }))).kind, 'conflict');
      }
      await assert.rejects(transaction(client, async () => { await client.query(`INSERT INTO workspace_file_operation_move_path_receipts
        (batch_id,intent_digest,step_key,receipt_text,receipt_digest) VALUES($1,$2,'forged','{}',$3)`,
      [normal.input.batchId, sha('wrong'), sha('{}')]); }), error => code(error) === '23503');
    });
    await group('all actual immutable triggers reject UPDATE and DELETE', async () => {
      for (const spec of WORKSPACE_OPERATION_ORIGINAL_MOVE_TABLE_SPECS) for (const verb of ['UPDATE', 'DELETE']) {
        const sql = verb === 'UPDATE' ? `UPDATE ${spec.table} SET created_at=created_at WHERE batch_id=$1` : `DELETE FROM ${spec.table} WHERE batch_id=$1`;
        await assert.rejects(transaction(client, async () => { await client.query(sql, [normal.input.batchId]); }), error => code(error) === '55000');
      }
    });
    await group('literal 4096 byte parent paths use fixed hash keys without B-tree truncation', async () => {
      const longPath = ['a'.repeat(254), ...Array<string>(15).fill('b'.repeat(255)), 'z'].join('/'); assert.equal(Buffer.byteLength(longPath), 4096);
      const input = { ...parent, parentPath: longPath };
      const result = await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(db, input)); assert.equal(result.kind, 'created');
      const read = await repository.readWorkspaceOperationOriginalMoveParentReceiptOnConnection(db, { ...normal.selected, parentPath: longPath });
      assert.equal(read?.parentPath, longPath); assert.equal(read?.parentKey, sha(longPath));
    });
    await group('header-first locks exclude an actual second session then identical retry succeeds', async () => {
      const other = await connect(), otherDb = adapter(other);
      await client.query('BEGIN');
      const pending = { ...normal.selected, stepKey: 'concurrent', receiptText: '{"concurrent":true}' };
      await repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db, pending);
      await assert.rejects(transaction(other, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(otherDb, pending)), error => code(error) === '55P03');
      await client.query('COMMIT');
      assert.equal((await transaction(other, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(otherDb, pending))).kind, 'existing');
      await other.end(); clients.delete(other);
    });
    await group('actual committed insert with lost ACK is resolved on a fresh connection without rewriting history', async () => {
      const pending = { ...normal.selected, stepKey: 'lost-ack', receiptText: '{"original":true}' };
      await client.query('BEGIN'); const first = await repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db, pending);
      const lost = new Error('Synthetic ACK loss after actual PostgreSQL COMMIT');
      await assert.rejects((async () => { await client.query('COMMIT'); throw lost; })(), error => error === lost);
      const fresh = await connect();
      const retry = await transaction(fresh, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(adapter(fresh), pending));
      assert.deepEqual(retry, first.kind === 'conflict' ? first : { ...first, kind: 'existing' }); await fresh.end(); clients.delete(fresh);
    });
    await group('list row and total-byte gates return only null payload sentinel on overflow', async () => {
      const item = await seed();
      for (const stepKey of ['a', 'b']) await transaction(client, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db,
        { ...item.selected, stepKey, receiptText: '1234567890' }));
      const captured: unknown[][] = [], observed: SqlConnection = { ...db, all: async (sql, values) => { const rows = await db.all(sql, values); captured.push(rows); return rows; } };
      await assert.rejects(repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(observed, { ...item.selected, maxRows: 1 }), error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_LIMIT');
      await assert.rejects(repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(observed, { ...item.selected, maxTotalBytes: 19 }), error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_LIMIT');
      assert(captured.every(rows => rows.length === 1 && (rows[0] as Record<string, unknown>).receiptText === null));
      assert.equal((await repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(db, { ...item.selected, maxRows: 2, maxTotalBytes: 20 }))?.length, 2);
      const empty = await seed(); assert.deepEqual(await repository.listWorkspaceOperationOriginalMoveParentReceiptsOnConnection(db, empty.selected), []);
    });
    await group('concurrent raw append between header and list is measured in the payload statement snapshot', async () => {
      const item = await seed(), other = await connect(); let announced!: () => void, release!: () => void;
      const first = new Promise<void>(resolve => { announced = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const observed: SqlConnection = { ...db, get: async (sql, values) => { const row = await db.get(sql, values); announced(); await gate; return row; } };
      const listed = repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(observed, { ...item.selected, maxTotalBytes: 1 });
      await first;
      await other.query(`INSERT INTO workspace_file_operation_move_path_receipts(batch_id,intent_digest,step_key,receipt_text,receipt_digest)
        VALUES($1,$2,'late','two',$3)`, [item.selected.batchId, item.selected.intentDigest, sha('two')]);
      release(); await assert.rejects(listed, error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_LIMIT'); await other.end(); clients.delete(other);
    });
    await group('actual 1000-row boundary succeeds and 1001-row sentinel refuses payload', async () => {
      const item = await seed();
      await client.query(`INSERT INTO workspace_file_operation_move_path_receipts(batch_id,intent_digest,step_key,receipt_text,receipt_digest)
        SELECT $1,$2,lpad(n::text,4,'0'),'x',$3 FROM generate_series(1,1000) n`, [item.selected.batchId, item.selected.intentDigest, sha('x')]);
      assert.equal((await repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(db,
        { ...item.selected, maxRows: 1000, maxTotalBytes: 1000 }))?.length, 1000);
      await client.query(`INSERT INTO workspace_file_operation_move_path_receipts(batch_id,intent_digest,step_key,receipt_text,receipt_digest)
        VALUES($1,$2,'1001','x',$3)`, [item.selected.batchId, item.selected.intentDigest, sha('x')]);
      await assert.rejects(repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(db, item.selected),
        error => code(error) === 'ORIGINAL_MOVE_REPOSITORY_LIMIT');
    });
    await group('real SQL digest and consumer JSON constraints reject forged records', async () => {
      await assert.rejects(transaction(client, async () => { await client.query(`INSERT INTO workspace_file_operation_move_path_receipts
        (batch_id,intent_digest,step_key,receipt_text,receipt_digest) VALUES($1,$2,'wrong-sha','{}',$3)`,
      [normal.input.batchId, normal.selected.intentDigest, sha('wrong')]); }), error => code(error) === '23514');
      await assert.rejects(transaction(client, async () => { await client.query(`INSERT INTO workspace_file_operation_move_parent_receipts
        (batch_id,intent_digest,parent_key,parent_path,producer_step,consumer_bindings_text,consumer_bindings_digest,receipt_text,receipt_digest)
        VALUES($1,$2,$3,'bad/parent','step','{}',$4,'{}',$4)`, [normal.input.batchId, normal.selected.intentDigest, sha('bad/parent'), sha('{}')]); }),
      error => ['23514', '22023'].includes(String(code(error))));
    });
    await group('actual exact 16MiB intent, 64MiB path and 1MiB compact receipts roundtrip', async () => {
      const item = await seed('i'.repeat(16 * MiB)); assert.equal(item.original.intentText.length, 16 * MiB);
      const large = { ...item.selected, stepKey: 'large', receiptText: 'x'.repeat(64 * MiB) };
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db, large))).kind, 'created');
      assert.equal((await repository.readWorkspaceOperationOriginalMovePathReceiptOnConnection(db, { ...item.selected, stepKey: 'large' }))?.receiptText.length, 64 * MiB);
      await assert.rejects(repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db, { ...large, stepKey: 'oversize', receiptText: large.receiptText + 'x' }));
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveReceiptOnConnection(db,
        { ...item.selected, receiptText: 'f'.repeat(MiB) }))).kind, 'created');
      assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMoveParentReceiptOnConnection(db,
        { ...item.selected, parentPath: 'bounded/parent', producerStep: 'large', consumerBindingsText: '[{}]', receiptText: 'p'.repeat(MiB - 4) }))).kind, 'created');
    });
    await group('actual Unicode step keys retain PostgreSQL C UTF-8 byte ordering', async () => {
      const item = await seed(), expected = ['\uE000', '\u{10000}'];
      for (const stepKey of [...expected].reverse()) {
        assert.equal((await transaction(client, () => repository.insertWorkspaceOperationOriginalMovePathReceiptOnConnection(db,
          { ...item.selected, stepKey, receiptText: '{}' }))).kind, 'created');
      }
      const listed = await repository.listWorkspaceOperationOriginalMovePathReceiptsOnConnection(db, item.selected);
      assert.deepEqual(listed?.map(row => row.stepKey), expected);
    });
    await group('repository never issues transaction, checkout, close or authority SQL', async () => {
      const operational = calls.filter(sql => !sql.startsWith('CREATE ') && !sql.startsWith('DO '));
      assert(operational.every(sql => /^\s*(?:SELECT|INSERT|WITH)\b/u.test(sql)));
      assert(operational.every(sql => !/\b(?:BEGIN|COMMIT|ROLLBACK|pg_advisory|set_config)\b/iu.test(sql)));
      for (const [filename, expected] of pinned) assert.equal(sha(await fs.readFile(path.resolve(filename))), expected, 'Fixture source changed during PostgreSQL checks');
    });
  } finally {
    const priorPhase = phase;
    phase = 'owned cleanup';
    const errors: unknown[] = [];
    for (const client of clients) try { await client.end(); } catch (error) { errors.push(error); }
    clients.clear();
    if (created && connected) {
      try {
        await own();
        const sessions = (await control.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1 OR pid=ANY($2::integer[])', [app, backendPids])).rows;
        assert.equal(sessions.length, 0);
        await control.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1 OR oid=$2', [schema, oid])).rows.length, 0); removed = true;
      } catch (error) { errors.push(error); }
    }
    if (connected) try { await control.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Owned PostgreSQL journal fixture cleanup could not be confirmed');
    if (created) assert(removed);
    phase = priorPhase;
  }
  console.log(`Original Move journal: ${passed} actual PG18 groups passed; owned schema and clients removed. Mechanical records only; no Owner/FS/DA04/runtime/container started.`);
}
void main().catch(error => { console.error(JSON.stringify({ phase, name: error instanceof Error ? error.name : 'unknown', code: code(error) ?? 'unclassified' })); process.exitCode = 1; });
