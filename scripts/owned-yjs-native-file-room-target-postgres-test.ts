/** Actual PG18 identity observations only. No host, browser, native seed or application grant. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { privateBytes, writePrivateJson, type OwnedYjsReceipt } from './lib/owned-yjs-authority-qa';
import { assertOwnedNativeFileRoomDatabaseOnConnection } from './lib/owned-yjs-native-file-room-target';

type ExpectedIdentity = Pick<OwnedYjsReceipt, 'createAcknowledged' | 'nonce' | 'databaseName' | 'databaseOid' | 'databaseOwner' | 'ownerMarker'>;
type Incarnation = { name: string; oid: string; owner: string; marker: string | null };
type OwnedClient = { client: Client; closed: boolean };
let stage = 'private configuration';

async function runOwnedNativeFileRoomTargetPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  const connectionString = parse(await privateBytes('/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env')).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert(!url.search && !url.hash);
  const nonce = randomUUID().replaceAll('-', ''), databaseName = `canvas_yjs_e2e_${nonce}`;
  const marker = randomBytes(24).toString('hex');
  assert.match(databaseName, /^canvas_yjs_e2e_[a-f0-9]{32}$/u); assert.match(marker, /^[a-f0-9]{48}$/u);
  const databaseUrl = new URL(url); databaseUrl.pathname = `/${databaseName}`;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 10_000,
    application_name: `room-target-${nonce}-control`, options: '-c statement_timeout=10000 -c lock_timeout=1000' });
  const clients: OwnedClient[] = [], incarnations: Incarnation[] = [];
  let controlConnected = false, root: string | undefined, completed = 0, roleExercised = false;
  let createAcknowledged = false, ledgerWritten = false, expected: ExpectedIdentity | undefined;
  let primaryFailed = false, primaryFailure: unknown;
  let controlIdentity: { name: string; oid: string; owner: string; role: string; pid: number; start: string } | undefined;
  let rootIdentity: { dev: number; ino: number } | undefined;
  const close = async (owned: OwnedClient) => {
    if (!owned.closed) { await owned.client.end(); owned.closed = true; }
  };
  const closeAll = async () => {
    const outcomes = await Promise.allSettled(clients.map(close));
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Owned identity clients did not all close.');
  };
  const readControl = async () => (await control.query(`SELECT current_database() AS name,d.oid::text AS oid,
    pg_get_userbyid(d.datdba) AS owner,current_user AS role,pg_backend_pid() AS pid,
    a.backend_start::text AS start,current_setting('server_version_num') AS version
    FROM pg_database d JOIN pg_stat_activity a ON a.pid=pg_backend_pid() WHERE d.datname=current_database()`)).rows[0];
  const assertControl = async () => {
    assert(controlConnected && controlIdentity);
    const actual = await readControl();
    for (const key of ['name', 'oid', 'owner', 'role', 'pid', 'start'] as const) assert.equal(actual[key], controlIdentity[key]);
    assert.equal(Math.floor(Number(actual.version) / 10000), 18);
  };
  const databaseRow = async (): Promise<Incarnation | undefined> => {
    await assertControl();
    return (await control.query(`SELECT datname AS name,oid::text AS oid,pg_get_userbyid(datdba) AS owner,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [databaseName])).rows[0];
  };
  const assertIncarnation = async (original: Incarnation) => {
    assert.equal(original.name, databaseName); assert.match(original.oid, /^\d+$/u);
    assert(controlIdentity && original.owner === controlIdentity.owner);
    const actual = await databaseRow(); assert(actual);
    for (const key of ['name', 'oid', 'owner', 'marker'] as const) assert.equal(actual[key], original[key]);
  };
  const persistExpected = async () => {
    assert(root && rootIdentity);
    const held = await fs.lstat(root);
    assert(held.isDirectory() && !held.isSymbolicLink() && held.uid === process.getuid?.() && (held.mode & 0o777) === 0o700);
    assert.equal(held.dev, rootIdentity.dev); assert.equal(held.ino, rootIdentity.ino); assert.equal(await fs.realpath(root), root);
    await writePrivateJson(path.join(root, 'expected-database.json'), { version: 1, nonce, createAcknowledged,
      databaseName, databaseOwner: controlIdentity?.owner, ownerMarker: marker, rootIdentity,
      incarnations }, !ledgerWritten); ledgerWritten = true;
    await privateBytes(path.join(root, 'expected-database.json'));
  };
  const create = async (): Promise<ExpectedIdentity> => {
    assert.equal(await databaseRow(), undefined);
    await assertControl(); await persistExpected(); // Intent exists before the actual CREATE.
    await control.query(`CREATE DATABASE "${databaseName}"`); createAcknowledged = true;
    await persistExpected(); // Persist the real acknowledgement before the first post-CREATE read.
    const created = await databaseRow(); assert(created && controlIdentity);
    assert.equal(created.name, databaseName); assert.equal(created.owner, controlIdentity.owner);
    assert.match(created.oid, /^\d+$/u); assert.equal(created.marker, null);
    incarnations.push(created); await persistExpected();
    await assertIncarnation(created);
    await control.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    created.marker = marker; await assertIncarnation(created); await persistExpected();
    // This is only an expected SQL identity DTO. It cannot certify a browser/build/request receipt.
    return Object.freeze({ createAcknowledged: true, nonce, databaseName, databaseOid: created.oid,
      databaseOwner: created.owner, ownerMarker: marker });
  };
  const drop = async (original: Incarnation) => {
    await closeAll(); assert(clients.every(owned => owned.closed)); await assertIncarnation(original);
    assert.equal((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datid=$1::oid OR datname=$2',
      [original.oid, databaseName])).rows[0].count, 0, 'No session may remain before the non-FORCE owned database drop.');
    await assertControl(); await control.query(`DROP DATABASE "${databaseName}"`);
    assert.equal((await control.query('SELECT count(*)::int AS count FROM pg_database WHERE oid=$1::oid OR datname=$2',
      [original.oid, databaseName])).rows[0].count, 0); createAcknowledged = false; await persistExpected();
  };
  const connect = async (): Promise<OwnedClient> => {
    const owned = { client: new Client({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 5_000,
      query_timeout: 10_000, application_name: `room-target-${nonce}-reader`,
      options: '-c statement_timeout=10000 -c lock_timeout=1000' }), closed: false };
    clients.push(owned); await owned.client.connect(); return owned;
  };
  const observe = async (receipt: ExpectedIdentity, mode: string, rejected: boolean, setup?: (client: Client) => Promise<void>) => {
    const owned = await connect(); let began = false, nextQueries = 0, failure: unknown, failed = false;
    const cleanupErrors: unknown[] = [];
    try {
      await owned.client.query(mode); began = true; if (setup) await setup(owned.client);
      const operation = async () => {
        // The adapter consumes only the expected identity fields; it mints no opaque application capability.
        await assertOwnedNativeFileRoomDatabaseOnConnection(owned.client, receipt as OwnedYjsReceipt);
        nextQueries++;
        assert.equal((await owned.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid > 0, true);
      };
      if (rejected) await assert.rejects(operation); else await operation();
      assert.equal(nextQueries, rejected ? 0 : 1, 'A mismatch must stop before a subsequent room observation.');
    } catch (error) { failed = true; failure = error; }
    finally {
      if (began) try { await owned.client.query('ROLLBACK'); } catch (error) { cleanupErrors.push(error); }
      try { await close(owned); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, 'Owned observation cleanup failed.');
    if (failed) throw failure;
  };
  const fixture = async (name: string, run: () => Promise<void>) => {
    stage = name; await run(); console.log(`ok ${++completed} - ${name}`);
  };
  const rr = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
  try {
    stage = 'actual managed PG18 and owned database'; await control.connect(); controlConnected = true;
    const found = await readControl(); assert.equal(found.name, 'canvas_notebook'); assert.equal(found.owner, found.role);
    assert.equal(found.role, decodeURIComponent(url.username)); assert.match(found.oid, /^\d+$/u);
    assert.equal(Math.floor(Number(found.version) / 10000), 18);
    controlIdentity = { name: found.name, oid: found.oid, owner: found.owner, role: found.role, pid: found.pid, start: found.start };
    root = await fs.mkdtemp(path.join(tmpdir(), 'canvas-room-target-pg-')); await fs.chmod(root, 0o700); root = await fs.realpath(root);
    const rootStat = await fs.lstat(root); rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    expected = await create(); const original = incarnations[0];
    await fixture('actual owned READ ONLY REPEATABLE READ connection is accepted', () => observe(expected!, rr, false));
    await fixture('actual writable transaction is rejected before observation', () => observe(expected!, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE', true));
    await fixture('actual READ ONLY READ COMMITTED transaction is rejected', () => observe(expected!, 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', true));
    await fixture('unacknowledged and mismatched expected database namespace is rejected', async () => {
      const foreignNonce = randomUUID().replaceAll('-', '');
      for (const patch of [{ createAcknowledged: false }, { nonce: foreignNonce },
        { nonce: foreignNonce, databaseName: `canvas_yjs_e2e_${foreignNonce}` }]) await observe({ ...expected!, ...patch }, rr, true);
    });
    await fixture('expected OID owner and marker mismatches are rejected on the borrowed connection', async () => {
      for (const patch of [{ databaseOid: (BigInt(expected!.databaseOid!) + BigInt(1)).toString() },
        { databaseOwner: `foreign_${nonce}` }, { ownerMarker: randomBytes(24).toString('hex') }]) await observe({ ...expected!, ...patch }, rr, true);
    });
    stage = 'existing safe role discovery'; await assertControl();
    const role = (await control.query(`SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) AND NOT rolcanlogin
      AND rolname<>current_user AND pg_has_role(current_user,oid,'SET') ORDER BY rolname LIMIT 1`,
    [['pg_read_all_settings', 'pg_read_all_stats', 'pg_monitor']])).rows[0]?.rolname as string | undefined;
    if (role) await fixture('actual SET LOCAL ROLE differs from the bound database owner', async () => {
      assert.match(role, /^pg_[a-z_]+$/u);
      await observe(expected!, rr, true, async client => {
        await client.query(`SET LOCAL ROLE "${role}"`);
        assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, role);
      }); roleExercised = true;
    });
    else console.log('not exercised - no existing safe SET ROLE membership is available');
    await fixture('actual owned database marker drift rejects the original expected identity', async () => {
      const changedMarker = randomBytes(24).toString('hex');
      await assertIncarnation(original); await control.query(`COMMENT ON DATABASE "${databaseName}" IS '${changedMarker}'`);
      original.marker = changedMarker;
      try { await observe(expected!, rr, true); }
      finally {
        await assertIncarnation(original); await control.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
        original.marker = marker; await assertIncarnation(original);
      }
    });
    await fixture('drop and recreate with identical name owner and marker rejects the old OID', async () => {
      const historical = expected!; await drop(original); expected = await create();
      assert.notEqual(expected.databaseOid, historical.databaseOid);
      assert.equal(expected.databaseName, historical.databaseName); assert.equal(expected.databaseOwner, historical.databaseOwner);
      assert.equal(expected.ownerMarker, historical.ownerMarker);
      await observe(historical, rr, true); await observe(expected, rr, false);
    });
    assert.equal(completed, roleExercised ? 8 : 7);
  } catch (error) { primaryFailed = true; primaryFailure = error; }
  finally {
    const failedStage = stage; stage = 'owned client and database cleanup'; const cleanupErrors: unknown[] = [];
    let databasesAbsent = false, controlEnded = false;
    try { await closeAll(); } catch (error) { cleanupErrors.push(error); }
    try {
      if (controlConnected && controlIdentity) {
        const current = await databaseRow();
        if (current) {
          assert(createAcknowledged, 'An unacknowledged database must not be adopted for cleanup.');
          const original = incarnations.find(entry => entry.oid === current.oid); assert(original);
          await drop(original);
        }
        await assertControl();
        assert.equal((await control.query('SELECT count(*)::int AS count FROM pg_database WHERE datname=$1 OR oid=ANY($2::oid[])',
          [databaseName, incarnations.map(entry => entry.oid)])).rows[0].count, 0);
        assert.equal((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 OR datid=ANY($2::oid[])',
          [databaseName, incarnations.map(entry => entry.oid)])).rows[0].count, 0);
        databasesAbsent = true;
      }
    } catch (error) { cleanupErrors.push(error); }
    try { await control.end(); controlEnded = true; } catch (error) { cleanupErrors.push(error); }
    try {
      if (root && rootIdentity) {
        if (databasesAbsent && controlEnded && clients.every(owned => owned.closed) && cleanupErrors.length === 0) {
          const current = await fs.lstat(root);
          assert(current.isDirectory() && !current.isSymbolicLink() && current.uid === process.getuid?.() && (current.mode & 0o777) === 0o700);
          assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino);
          assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true });
          await assert.rejects(() => fs.lstat(root!), { code: 'ENOENT' });
        } else {
          console.error(`Owned database/client cleanup is uncertain; private evidence directory retained: ${root}`);
        }
      }
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(primaryFailed ? [primaryFailure, ...cleanupErrors] : cleanupErrors,
      'Owned database identity fixture cleanup remained unconfirmed.');
    stage = failedStage;
  }
  if (primaryFailed) throw primaryFailure;
  console.log(`Passed ${completed} actual database identity groups; owned database incarnations, sessions and temporary root are absent.`);
  console.log('No browser, build, request authority or native room state is certified by this fixture.');
}

let completed = false;
const incomplete = () => { if (!completed) { process.exitCode = 1; console.error('Owned room target fixture did not complete assertions and cleanup.'); } };
process.once('beforeExit', incomplete);
const watchdog = setTimeout(() => { incomplete(); process.exit(1); }, 120_000);
watchdog.ref();
void runOwnedNativeFileRoomTargetPostgresTest().then(() => {
  console.log('owned-room-target-postgres: COMPLETED: assertions and cleanup settled.');
}).catch(() => {
  process.exitCode = 1; console.error(`Owned room target PostgreSQL fixture failed during ${stage}; no success is certified.`);
}).finally(() => { completed = true; clearTimeout(watchdog); process.removeListener('beforeExit', incomplete); });
