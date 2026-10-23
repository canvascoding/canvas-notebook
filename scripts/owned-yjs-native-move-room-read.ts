/** Move-only read adapter; original full/narrow target and room guards remain. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { writePrivateJson } from './lib/owned-yjs-authority-qa';
import { assertOwnedNativeFileRoomDatabaseOnConnection, requireOwnedNativeFileRoomTarget } from './lib/owned-yjs-native-delete-links-room-target';
import type { OwnedRestartRoomEvidence } from './lib/owned-yjs-restart-room-read';

/** Test-only availability contention in the actual room-owner lock domain.
 * The original reader below remains unchanged when this explicit mode is absent. */
async function holdSharedMoveRoom(target: Awaited<ReturnType<typeof requireOwnedNativeFileRoomTarget>>): Promise<void> {
  const { readOwnedRestartRoomOnConnection } = await import('./lib/owned-yjs-restart-room-read');
  const { lockIdentity } = await import('../app/lib/collaboration/room-owner');
  const lock = lockIdentity(target.input.room.documentId);
  const observation = path.join(target.receipt.fixtureRoot, `native-move-shared-holder-${randomUUID()}.json`);
  const database = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, query_timeout: 6_000, application_name: 'owned_native_move_shared_holder' });
  let began = false, locked = false, identity: { pid: number; backendStart: string } | undefined;
  let command: 'release' | Error | undefined, bytes = '';
  const onData = (chunk: string) => {
    bytes += chunk;
    if (bytes.length > 16 || !'release\n'.startsWith(bytes)) command = new Error('Invalid owned holder command.');
    else if (bytes === 'release\n') command = 'release';
  };
  const onEnd = () => { command ??= new Error('Owned holder input closed before release.'); };
  const onStop = () => { command = new Error('Owned holder stopped.'); };
  const failures: unknown[] = [];
  let result: Record<string, unknown> | undefined, failed = false, primary: unknown;
  process.stdin.setEncoding('utf8'); process.stdin.on('data', onData); process.stdin.once('end', onEnd);
  process.once('SIGTERM', onStop); process.once('SIGINT', onStop);
  const assertHeld = async () => {
    assert(identity);
    const row = (await database.query(`SELECT a.pid::integer AS pid,
      extract(epoch FROM a.backend_start)::text AS backend_start,
      pg_catalog.current_setting('transaction_read_only') AS read_only,
      pg_catalog.pg_current_xact_id_if_assigned()::text AS xid,
      (SELECT count(*)::integer FROM pg_catalog.pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory'
        AND l.granted AND l.mode='ShareLock' AND l.database=$1::oid
        AND l.classid::bigint=$2 AND l.objid::bigint=$3 AND l.objsubid=1) AS held
      FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`,
    [target.receipt.databaseOid, lock.high, lock.low])).rows[0];
    assert.equal(row?.pid, identity.pid); assert.equal(row.backend_start, identity.backendStart);
    assert.equal(row.read_only, 'on'); assert.equal(row.xid, null); assert.equal(row.held, 1);
  };
  try {
    await database.connect(); began = true;
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertOwnedNativeFileRoomDatabaseOnConnection(database, target.receipt);
    const room = await readOwnedRestartRoomOnConnection(database, target.input.room);
    assert.equal(room.released, true, 'Only a genuinely normally released exact native room can be held.');
    assert.equal(room.version.sequence, target.input.expectedSession.documentSequence);
    assert.equal(room.version.stateProof, target.input.expectedSession.stateProof);
    assert.equal(room.version.vectorSha256, target.expectedVectorSha256);
    const facts = (await database.query(`SELECT a.pid::integer AS pid,
      extract(epoch FROM a.backend_start)::text AS backend_start
      FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`)).rows[0];
    assert(Number.isSafeInteger(facts?.pid) && facts.pid > 0 && typeof facts.backend_start === 'string' && facts.backend_start);
    identity = { pid: facts.pid, backendStart: facts.backend_start };
    assert.equal((await database.query('SELECT pg_catalog.pg_try_advisory_lock_shared($1::bigint) AS locked', [lock.key])).rows[0]?.locked, true);
    locked = true; await assertHeld();
    result = { version: 1, kind: 'owned-native-move-shared-holder', phase: 'held', nonce: target.receipt.nonce,
      workspaceId: target.input.room.expectedWorkspaceId, documentId: target.input.room.documentId,
      databaseOid: target.receipt.databaseOid, ...identity, key: lock.key, high: lock.high, low: lock.low,
      mode: 'ShareLock', lockCount: 1, scopeProof: room.scopeProof, ownerEpoch: room.ownerEpoch };
    await writePrivateJson(observation, result, true);
    process.stdout.write(JSON.stringify(result) + '\n');
    const deadline = performance.now() + 90_000;
    while (command === undefined && performance.now() < deadline) {
      // A fresh bounded query also prevents an inherited idle-TX timeout from
      // silently ending the holder. No timeout setting or application row changes.
      await assertHeld();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(command, 'release', 'The owned shared holder was not explicitly released within its fixed 90-second bound.');
  } catch (error) { failed = true; primary = error; }
  finally {
    process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.destroy();
    process.removeListener('SIGTERM', onStop); process.removeListener('SIGINT', onStop);
    if (locked) try {
      assert.equal((await database.query('SELECT pg_catalog.pg_advisory_unlock_shared($1::bigint) AS unlocked', [lock.key])).rows[0]?.unlocked, true);
    } catch (error) { failures.push(error); }
    if (began) try { await database.query('ROLLBACK'); } catch (error) { failures.push(error); }
    try { await database.end(); } catch (error) { failures.push(error); }
  }
  // Independently observe that the exact former backend/start tuple and its
  // exact room lock disappeared. End() alone is not a server-side close proof.
  if (identity) {
    const observer = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000, query_timeout: 6_000, application_name: 'owned_native_move_shared_holder_close' });
    let observationBegan = false;
    try {
      await observer.connect(); observationBegan = true;
      await observer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assertOwnedNativeFileRoomDatabaseOnConnection(observer, target.receipt);
      const deadline = performance.now() + 1_000;
      let absent = false;
      do {
        const row = (await observer.query(`SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a
          WHERE a.pid=$1 AND extract(epoch FROM a.backend_start)::text=$2) AS backend_absent,
          NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
            WHERE l.pid=$1 AND extract(epoch FROM a.backend_start)::text=$2 AND l.locktype='advisory'
            AND l.granted AND l.database=$3::oid AND l.classid::bigint=$4 AND l.objid::bigint=$5 AND l.objsubid=1) AS lock_absent`,
        [identity.pid, identity.backendStart, target.receipt.databaseOid, lock.high, lock.low])).rows[0];
        absent = row?.backend_absent === true && row.lock_absent === true;
        if (!absent) { await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()'); await new Promise(resolve => setTimeout(resolve, 25)); }
      } while (!absent && performance.now() < deadline);
      assert(absent, 'The exact shared holder backend and key remain live.');
    } catch (error) { failures.push(error); }
    finally {
      if (observationBegan) try { await observer.query('ROLLBACK'); } catch (error) { failures.push(error); }
      try { await observer.end(); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failed ? [primary, ...failures] : failures, 'Owned shared holder cleanup remains unconfirmed.');
  if (failed) throw primary;
  assert(result);
  const closed = { ...result, phase: 'closed', lockCount: 0, backendAbsent: true, lockAbsent: true };
  await writePrivateJson(observation, closed);
  process.stdout.write(JSON.stringify(closed) + '\n');
}

async function main(): Promise<void> {
  assert(process.argv.length === 3 || process.argv.length === 4 && process.argv[3] === '--hold-shared');
  assert(process.argv[2].length <= 8 * 1024);
  const started = performance.now();
  const target = await requireOwnedNativeFileRoomTarget(JSON.parse(Buffer.from(process.argv[2], 'base64url').toString()),
    process.env, 'tests/workspace-operation-native-move.spec.ts');
  if (process.argv.length === 4) { await holdSharedMoveRoom(target); return; }
  const observation = path.join(target.receipt.fixtureRoot, `native-room-observation-${randomUUID()}.json`);
  const phases: { phase: string; milliseconds: number; activeResources?: string[] }[] = [];
  const record = async (phase: string, resources = false) => {
    phases.push({ phase, milliseconds: performance.now() - started,
      ...(resources ? { activeResources: process.getActiveResourcesInfo().slice(0, 256) } : {}) });
    await writePrivateJson(observation, { version: 1, phases }, phases.length === 1);
  };
  await record('narrow-target-guard-complete');
  const { readOwnedRestartRoomOnConnection } = await import('./lib/owned-yjs-restart-room-read');
  const database = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 10_000 });
  let result: OwnedRestartRoomEvidence | undefined, beginAttempted = false, failed = false, primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await database.connect(); await record('client-connected');
    beginAttempted = true; await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await record('readonly-transaction-open');
    await assertOwnedNativeFileRoomDatabaseOnConnection(database, target.receipt); await record('database-identity-confirmed');
    result = await readOwnedRestartRoomOnConnection(database, target.input.room);
    assert.equal(result.version.sequence, target.input.expectedSession.documentSequence);
    assert.equal(result.version.stateProof, target.input.expectedSession.stateProof);
    assert.equal(result.version.vectorSha256, target.expectedVectorSha256);
    await record('original-room-read-complete');
  } catch (error) {
    failed = true; primaryError = error;
  } finally {
    if (beginAttempted) {
      try { await database.query('ROLLBACK'); await record('readonly-transaction-closed'); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await database.end(); await record('client-closed'); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'Owned native file room observation cleanup failed.');
  if (failed) throw primaryError;
  assert(result);
  process.stdout.write(JSON.stringify(result));
  await record('result-written', true);
}

void main().catch(() => {
  console.error('Owned native file room observation remained unavailable.'); process.exitCode = 1;
});
