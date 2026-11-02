import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { readNativeTestDatabaseConfig, assertNativeTestDatabaseTarget } from './helpers/native-test-database-config';

let phase = 'managed configuration';
async function main(): Promise<void> {
  const config = await readNativeTestDatabaseConfig();
  const { connectionString } = config;
  const schema = `native_peer_room_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^native_peer_room_[a-f0-9]{32}$/u);
  const previous = { ...process.env };
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  let created = false, dataRoot: string | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    await control.connect();
    await assertNativeTestDatabaseTarget(control, config);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    const { COLLABORATION_ROOM_RELEASE_UP_SQL } = await import('../app/lib/db/collaboration-room-owner-migration');
    const { COLLABORATION_ADMISSION_STATEMENTS } = await import('../app/lib/db/collaboration-admission-migration');
    await control.query('BEGIN');
    await control.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
    await control.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await control.query(statement);
    await control.query('COMMIT');
    dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-native-peer-room-'));
    Object.assign(process.env, { DATABASE_URL: connectionString, CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external',
      CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true', CANVAS_POSTGRES_VECTOR_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000` });
    delete process.env.NEXT_PHASE;
    const database = await import('../app/lib/db'); closeDatabase = database.closeDatabaseConnections;
    const pool = database.getPostgresRuntimeQueryable(); assert(pool);
    const { assertNativePeerRoomAdmissionOpen } = await import('../app/lib/collaboration/peer-room-admission');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { NATIVE_PEER_ADMISSION_BUSY_REASON } = await import('../app/lib/collaboration/failure');
    const scope = { documentId: `peer-${randomUUID()}`, workspaceId: `workspace-${randomUUID()}`, organizationId: null,
      path: 'document.md', representation: 'tiptap_blocks' as const, lifecycleGeneration: 1, schemaVersion: 1 };
    const key = collaborationAdmissionLockKey(scope.workspaceId);
    const busy = (error: unknown) => !!error && typeof error === 'object'
      && Reflect.get(error, 'reason') === NATIVE_PEER_ADMISSION_BUSY_REASON;
    const notBusy = (error: unknown) => { assert(!busy(error)); return true; };
    const trace: string[] = [];
    let loseAcknowledgement: 'ROLLBACK' | 'COMMIT' | undefined;
    let loseCloseAcknowledgement = false;
    const connect = pool.connect.bind(pool);
    const observeRelease = (client: import('pg').PoolClient) => {
      const release = client.release.bind(client);
      client.release = error => {
        release(error);
        if (loseCloseAcknowledgement) {
          loseCloseAcknowledgement = false;
          throw Object.assign(new Error('Owned fixture loses an actual pool release acknowledgement.'), { code: 'ADMISSION_CONFLICT' });
        }
      };
      return client;
    };
    pool.connect = ((callback?: (...args: unknown[]) => unknown) => {
      if (callback) return connect((error, client, release) => {
        if (client) observeRelease(client);
        callback(error, client, release);
      });
      return connect().then(observeRelease);
    }) as typeof pool.connect;
    pool.on('connect', client => {
      const query = client.query.bind(client);
      client.query = (async (...args: unknown[]) => {
        const result = await Reflect.apply(query, client, args);
        const sql = typeof args[0] === 'string' ? args[0] : undefined;
        if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') trace.push(sql);
        if (sql && sql === loseAcknowledgement) {
          loseAcknowledgement = undefined;
          throw Object.assign(new Error('Owned fixture loses an actual SQL acknowledgement.'), { code: 'ADMISSION_CONFLICT' });
        }
        return result;
      }) as typeof client.query;
    });
    // Force the observer to attach to every connection this fixture uses.
    assert.equal(pool.totalCount, 0);
    phase = 'shared reader and ordinary admission';
    await control.query('BEGIN');
    await control.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key]);
    await assertNativePeerRoomAdmissionOpen(scope);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'COMMIT']);
    await control.query('ROLLBACK');
    console.log('PASS actual shared reader and native peer room admission coexist.');

    phase = 'drawing is outside native text admission';
    await assert.rejects(assertNativePeerRoomAdmissionOpen({ ...scope, representation: 'excalidraw_scene' }), error => {
      notBusy(error); assert.equal(Reflect.get(error as object, 'code'), 'ADMISSION_INVALID_REQUEST'); return true;
    });
    assert.deepEqual(trace.splice(0), []);
    console.log('PASS a drawing cannot enter the native text gate or acquire a new SQL session.');

    phase = 'exclusive writer contention';
    await control.query('BEGIN'); await control.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
    await assert.rejects(assertNativePeerRoomAdmissionOpen(scope), busy);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'ROLLBACK']);
    assert.equal(pool.waitingCount, 0); assert.equal(pool.idleCount, pool.totalCount);
    await control.query('ROLLBACK');
    await assertNativePeerRoomAdmissionOpen(scope);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'COMMIT']);
    console.log('PASS actual writer conflict settles ROLLBACK and pool release before busy; a new admission succeeds after release.');

    phase = 'reserved document';
    const requestId = randomUUID();
    await control.query(`INSERT INTO "${schema}".collaboration_admission_requests
      (request_id,request_digest,intent_text,status,revision,created_at) VALUES($1,$2,'{}','reserved',1,1)`,
      [requestId,'a'.repeat(64)]);
    await control.query(`INSERT INTO "${schema}".collaboration_admission_targets
      (request_id,document_id,snapshot_text,active) VALUES($1,$2,'{}',true)`, [requestId,scope.documentId]);
    await assert.rejects(assertNativePeerRoomAdmissionOpen(scope), busy);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'ROLLBACK']);
    await control.query(`DELETE FROM "${schema}".collaboration_admission_targets WHERE request_id=$1`, [requestId]);
    console.log('PASS an actual reserved document cannot be joined.');

    phase = 'lost rollback acknowledgement';
    await control.query('BEGIN'); await control.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
    loseAcknowledgement = 'ROLLBACK';
    await assert.rejects(assertNativePeerRoomAdmissionOpen(scope), notBusy);
    assert.equal(loseAcknowledgement, undefined);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'ROLLBACK']);
    await control.query('ROLLBACK');
    console.log('PASS a lost real ROLLBACK acknowledgement never becomes a busy/retry signal.');

    phase = 'lost release acknowledgement after rollback';
    await control.query('BEGIN'); await control.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
    loseCloseAcknowledgement = true;
    await assert.rejects(assertNativePeerRoomAdmissionOpen(scope), notBusy);
    assert.equal(loseCloseAcknowledgement, false);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'ROLLBACK']);
    await control.query('ROLLBACK');
    console.log('PASS a lost real release acknowledgement after ROLLBACK never becomes a busy/retry signal.');

    phase = 'lost commit acknowledgement';
    loseAcknowledgement = 'COMMIT';
    await assert.rejects(assertNativePeerRoomAdmissionOpen(scope), notBusy);
    assert.equal(loseAcknowledgement, undefined);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'COMMIT']);
    console.log('PASS a lost real COMMIT acknowledgement never becomes a busy/retry signal.');

    phase = 'lost release acknowledgement after commit';
    loseCloseAcknowledgement = true;
    await assert.rejects(assertNativePeerRoomAdmissionOpen(scope), notBusy);
    assert.equal(loseCloseAcknowledgement, false);
    assert.deepEqual(trace.splice(0), ['BEGIN', 'COMMIT']);
    console.log('PASS a lost real release acknowledgement after COMMIT never becomes a busy/retry signal.');

    phase = 'actual SQL failure';
    await control.query(`DROP TABLE "${schema}".collaboration_admission_scopes`);
    await assert.rejects(assertNativePeerRoomAdmissionOpen(scope), error => {
      notBusy(error); assert.equal(Reflect.get(error as object, 'code'), '42P01'); return true;
    });
    assert.deepEqual(trace.splice(0), ['BEGIN', 'ROLLBACK']);
    console.log('PASS an actual SQL failure remains terminal and retains its original error.');
    assert.equal(pool.waitingCount, 0);
    phase = 'cleanup';
  } finally {
    try { await closeDatabase?.(); }
    finally {
      try { await control.query('ROLLBACK'); if (created) {
        await control.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true);
      } } finally {
        await control.end();
        if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    }
  }
}
void main().catch(error => {
  console.error('Native peer room admission fixture failed:', { phase,
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? 'unclassified' : 'unclassified' });
  process.exitCode = 1;
});
