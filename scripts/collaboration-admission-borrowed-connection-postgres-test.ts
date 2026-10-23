import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import { collaborationAdmissionActionDigest, collaborationAdmissionLockKey, CollaborationAdmissionError,
  type CollaborationAdmissionDocument, type CollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionService, reserveCollaborationAdmissionOnConnection } from '../app/lib/collaboration/room-admission';
import { createCollaborationAdmissionQuiescenceService, proveCollaborationAdmissionQuiescenceOnConnection }
  from '../app/lib/collaboration/room-admission-quiescence';
import { requireCollaborationAdmissionMutationRequest } from '../app/lib/collaboration/room-admission-handoff';
import { lockIdentity } from '../app/lib/collaboration/room-owner';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import { COLLABORATION_ROOM_OWNER_UP_SQL, COLLABORATION_ROOM_RELEASE_UP_SQL }
  from '../app/lib/db/collaboration-room-owner-migration';

const prefix = 'canvas_admission_borrowed_test_';
const generated = /^canvas_admission_borrowed_test_[0-9a-f]{32}$/u;
const normalize = (sql: string) => sql.replace(/\s+/gu, ' ').trim().toUpperCase();
function errorCode(...codes: CollaborationAdmissionError['code'][]) {
  return (error: unknown) => error instanceof CollaborationAdmissionError && codes.includes(error.code);
}
function guardedUrl(): URL {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres', 'A guarded managed PostgreSQL environment is required.');
  const url = new URL(process.env.DATABASE_URL ?? 'invalid:');
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '55433' && decodeURIComponent(url.pathname.slice(1)) === 'canvas_notebook',
  'Borrowed admission regression accepts only managed loopback PG18 at 55433/canvas_notebook.');
  return url;
}
function encoded(text: string) {
  const doc = new Y.Doc();
  try { doc.getText('content').insert(0, text); return [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]; }
  finally { doc.destroy(); }
}

async function run(): Promise<void> {
  const url = guardedUrl(), nonce = randomUUID().replaceAll('-', ''), schema = `${prefix}${nonce}`;
  assert(generated.test(schema));
  const quoted = `"${schema}"`, application = `canvas-admission-borrowed-${nonce}`;
  const clients = new Set<Client>(), errors: unknown[] = [], checked: string[] = [];
  const backendPids = new Set<number>(); let created = false, control: Client | undefined;
  const connect = async (label: string, privateSchema = true) => {
    const client = new Client({ connectionString: url.toString(), application_name: `${application}-${label}`,
      connectionTimeoutMillis: 3000, query_timeout: 15000,
      options: `-c statement_timeout=12000 -c lock_timeout=4000${privateSchema ? ` -c search_path=${schema}` : ''}` });
    clients.add(client); client.on('error', error => { errors.push(error); }); await client.connect();
    const identity = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]; backendPids.add(identity.pid);
    return client;
  };
  const close = async (client: Client) => { await client.end(); clients.delete(client); };
  let forwarded = 0, forbidden = 0, closeCalls = 0;
  const borrowed = (client: Client): SqlConnection => {
    const query = async (sql: string, values: unknown[] = []) => {
      forwarded++;
      assert(!/^(?:BEGIN|START TRANSACTION|COMMIT|ROLLBACK|END|CLOSE|SAVEPOINT|RELEASE)\b/u.test(normalize(sql)),
        'An OnConnection core must never control the caller transaction.');
      return client.query(sql, values);
    };
    return Object.freeze({ get: async (sql: string, values?: unknown[]) => (await query(sql, values)).rows[0],
      all: async (sql: string, values?: unknown[]) => (await query(sql, values)).rows,
      run: async (sql: string, values?: unknown[]) => ({ changes: (await query(sql, values)).rowCount ?? 0 }),
      close: async () => { closeCalls++; forbidden++; throw new Error('An OnConnection core must never close B.'); } });
  };
  const factory = () => async (): Promise<SqlConnection> => {
    const client = await connect('service');
    return { get: async (sql, values = []) => (await client.query(sql, values)).rows[0],
      all: async (sql, values = []) => (await client.query(sql, values)).rows,
      run: async (sql, values = []) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
      close: async () => close(client) };
  };
  const state = (label: string): CollaborationAdmissionDocument => ({ documentId: `doc-${label}-${nonce}`,
    workspaceId: `workspace-${label}-${nonce}`, organizationId: null, path: `${label}.md`,
    representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, status: 'active' });
  const request = (doc: CollaborationAdmissionDocument): CollaborationAdmissionRequest => {
    const actionPayloadText = JSON.stringify({ kind: 'borrowed-regression', documentId: doc.documentId });
    return { requestId: randomUUID(), actorId: `actor-${nonce}`, action: 'move', actionPayloadText,
      actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
      scopes: [{ workspaceId: doc.workspaceId, organizationId: null, path: doc.path, kind: 'exact' }], expectedDocuments: [doc] };
  };
  const seed = async (doc: CollaborationAdmissionDocument) => {
    const [update, vector] = encoded(doc.documentId);
    await control!.query(`INSERT INTO ${quoted}.collaboration_yjs_states(document_id,workspace_id,organization_id,path,
      representation,lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,
      checkpointed_at,checkpoint_sequence,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
      VALUES($1,$2,NULL,$3,'plain_text',1,1,$4,$5,0,100,100,0,NULL,NULL,'lf',0,0,'active')`,
    [doc.documentId, doc.workspaceId, doc.path, update, vector]);
  };
  const txIdentity = async (client: Client) => (await client.query(`SELECT pg_backend_pid() AS pid,
    extract(epoch FROM a.backend_start)::text AS start,pg_current_xact_id()::text AS transaction
    FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`)).rows[0];
  const counts = async (requestId: string) => Number((await control!.query(
    `SELECT count(*) AS n FROM ${quoted}.collaboration_admission_requests WHERE request_id=$1`, [requestId])).rows[0].n);
  try {
    control = await connect('control', false);
    const server = (await control.query(`SELECT current_database() AS database,current_setting('server_version_num') AS version,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS source`)).rows[0];
    assert.equal(server.database, 'canvas_notebook'); assert.equal(Math.floor(Number(server.version) / 10000), 18); assert.equal(server.source, true);
    await control.query(`CREATE SCHEMA ${quoted}`); created = true;
    await control.query(`CREATE TABLE ${quoted}.collaboration_yjs_states (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    const migration = await connect('migration');
    await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL); await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const sql of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(sql);
    await close(migration);

    const owner = await connect('owner'), contender = await connect('contender'), database = borrowed(owner);
    const original = state('original'), intent = request(original); await seed(original);
    const workspaceKey = collaborationAdmissionLockKey(original.workspaceId), roomKey = lockIdentity(original.documentId).key;
    await owner.query('SELECT pg_advisory_lock($1::bigint)', [workspaceKey]);
    await owner.query('SELECT pg_advisory_lock($1::bigint)', [roomKey]);
    await owner.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
    const before = await txIdentity(owner);
    const reserved = await reserveCollaborationAdmissionOnConnection(database, intent);
    const proof = await proveCollaborationAdmissionQuiescenceOnConnection(database, intent, original.documentId);
    assert.equal(proof.kind, 'vacant'); assert.equal(reserved.status, 'reserved');
    assert.deepEqual(await txIdentity(owner), before, 'Reserve and Prove must borrow the same original B and XID.');
    assert.equal(await counts(intent.requestId), 0, 'A returned value remains invisible until the owner commits.');
    assert.throws(() => requireCollaborationAdmissionMutationRequest(database, 'move'), errorCode('ADMISSION_RECOVERY_REQUIRED'));
    await owner.query('COMMIT'); assert.equal(await counts(intent.requestId), 1);
    assert.equal((await contender.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [workspaceKey])).rows[0].held, false);
    assert.equal((await contender.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [roomKey])).rows[0].held, false);
    checked.push('actual owner B/XID, caller commit visibility, no mutation authority, and retained workspace/room session guards');

    await owner.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); const second = await txIdentity(owner);
    assert.notEqual(second.transaction, before.transaction); assert.equal(second.pid, before.pid); assert.equal(second.start, before.start);
    assert.equal((await reserveCollaborationAdmissionOnConnection(database, intent)).status, 'draining');
    const repeated = await proveCollaborationAdmissionQuiescenceOnConnection(database, intent, original.documentId, { lockTimeout: '50ms' });
    assert.equal(repeated.proofText, proof.proofText); assert.equal((await owner.query('SHOW lock_timeout')).rows[0].lock_timeout, '50ms');
    assert.deepEqual(await txIdentity(owner), second); await owner.query('ROLLBACK');
    assert.equal((await contender.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [roomKey])).rows[0].held, false);
    checked.push('new owner transaction on the same backend, exact proof retry, bounded wait policy, and rollback retains outer guards');

    const rollbackDoc = state('rollback'), rollbackRequest = request(rollbackDoc); await seed(rollbackDoc);
    await owner.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
    await reserveCollaborationAdmissionOnConnection(database, rollbackRequest);
    await proveCollaborationAdmissionQuiescenceOnConnection(database, rollbackRequest, rollbackDoc.documentId);
    await owner.query('ROLLBACK'); assert.equal(await counts(rollbackRequest.requestId), 0);
    assert.equal(Number((await control.query(`SELECT count(*) AS n FROM ${quoted}.collaboration_admission_targets WHERE request_id=$1`,
      [rollbackRequest.requestId])).rows[0].n), 0);
    checked.push('outer rollback removes every provisional header/target/proof without core commit or close');

    await owner.query('BEGIN');
    await assert.rejects(reserveCollaborationAdmissionOnConnection(database, { ...intent, actorId: 'changed-actor' }), errorCode('ADMISSION_REQUEST_CHANGED'));
    await owner.query('ROLLBACK'); await owner.query('BEGIN');
    await assert.rejects(reserveCollaborationAdmissionOnConnection(database, { ...intent, requestId: randomUUID() }), errorCode('ADMISSION_CONFLICT'));
    await owner.query('ROLLBACK');
    checked.push('original request identity and overlapping reservation remain strict');

    const drift = state('drift'), driftRequest = request(drift); await seed(drift); await owner.query('BEGIN');
    await reserveCollaborationAdmissionOnConnection(database, driftRequest);
    const [driftBytes, driftVector] = encoded('changed bytes at unchanged sequence');
    await owner.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2 WHERE document_id=$3', [driftBytes, driftVector, drift.documentId]);
    await assert.rejects(proveCollaborationAdmissionQuiescenceOnConnection(database, driftRequest, drift.documentId), errorCode('ADMISSION_SCOPE_CHANGED'));
    await owner.query('ROLLBACK'); assert.equal(await counts(driftRequest.requestId), 0);
    checked.push('same-sequence native byte/vector drift cannot become a retained quiescence proof');

    const busy = state('busy'), busyRequest = request(busy); await seed(busy); await owner.query('BEGIN');
    await reserveCollaborationAdmissionOnConnection(database, busyRequest); await owner.query('COMMIT');
    await contender.query('SELECT pg_advisory_lock($1::bigint)', [lockIdentity(busy.documentId).key]);
    await owner.query('BEGIN');
    await assert.rejects(proveCollaborationAdmissionQuiescenceOnConnection(database, busyRequest, busy.documentId), errorCode('ADMISSION_CONFLICT'));
    await owner.query('ROLLBACK'); await contender.query('SELECT pg_advisory_unlock($1::bigint)', [lockIdentity(busy.documentId).key]);
    assert.equal((await control.query(`SELECT status FROM ${quoted}.collaboration_admission_requests WHERE request_id=$1`, [busyRequest.requestId])).rows[0].status, 'reserved');
    checked.push('real foreign room session contention fails nonblocking before proof writes');

    const stale = state('stale'), staleRequest = request(stale); await seed(stale);
    await control.query(`UPDATE ${quoted}.collaboration_yjs_states SET room_owner_epoch=1,room_owner_token='stale-owner',
      room_owner_backend_pid=$1,room_owner_backend_start=$2 WHERE document_id=$3`, [before.pid, before.start, stale.documentId]);
    await owner.query('BEGIN'); await reserveCollaborationAdmissionOnConnection(database, staleRequest);
    await assert.rejects(proveCollaborationAdmissionQuiescenceOnConnection(database, staleRequest, stale.documentId), errorCode('ADMISSION_RECOVERY_REQUIRED'));
    await owner.query('ROLLBACK');
    assert.equal((await control.query(`SELECT room_owner_token FROM ${quoted}.collaboration_yjs_states WHERE document_id=$1`, [stale.documentId])).rows[0].room_owner_token, 'stale-owner');
    checked.push('an available room guard cannot clear or authorize a stale owner tuple');

    const beforeInvalid = forwarded; let getters = 0;
    await assert.rejects(proveCollaborationAdmissionQuiescenceOnConnection(database, intent, 'not-a-member'), errorCode('ADMISSION_INVALID_REQUEST'));
    const wait = Object.defineProperty({}, 'lockTimeout', { enumerable: true, get() { getters++; return '4s'; } });
    await assert.rejects(proveCollaborationAdmissionQuiescenceOnConnection(database, intent, original.documentId,
      wait as { lockTimeout: '4s' }), errorCode('ADMISSION_INVALID_REQUEST'));
    assert.equal(forwarded, beforeInvalid); assert.equal(getters, 0); assert.equal(closeCalls, 0); assert.equal(forbidden, 0);
    checked.push('nonmember target and accessor wait policy fail before SQL without invoking accessors');

    await close(owner); await close(contender);
    const admission = createCollaborationAdmissionService({ openConnection: factory() });
    const quiescence = createCollaborationAdmissionQuiescenceService({ openConnection: factory() });
    const serviceReservation = await admission.reserve(intent), serviceProof = await quiescence.prove(intent, original.documentId);
    assert.equal(serviceReservation.status, 'draining'); assert.equal(serviceProof.proofText, proof.proofText);
    const freshDoc = state('service'), freshRequest = request(freshDoc); await seed(freshDoc);
    await admission.reserve(freshRequest); const serviceFirst = await quiescence.prove(freshRequest, freshDoc.documentId);
    const verification = await connect('verification'); await verification.query('BEGIN');
    const coreAgain = await proveCollaborationAdmissionQuiescenceOnConnection(borrowed(verification), freshRequest, freshDoc.documentId);
    assert.equal(coreAgain.proofText, serviceFirst.proofText); await verification.query('ROLLBACK'); await close(verification);
    checked.push('existing independent Service wrappers and borrowed cores reuse the identical canonical retained proof');
    assert.equal(errors.length, 0); assert.equal(closeCalls, 0);
  } finally {
    for (const client of [...clients].filter(client => client !== control)) {
      try { await close(client); } catch (error) { errors.push(error); }
    }
    if (control) {
      if (created && clients.size === 1) {
        try { await control.query(`DROP SCHEMA ${quoted} CASCADE`); }
        catch (error) { errors.push(error); }
      }
      try {
        assert.equal((await control.query('SELECT count(*) AS n FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].n, '0');
        const survivors = await control.query(`SELECT pid FROM pg_stat_activity WHERE application_name LIKE $1 AND pid<>pg_backend_pid()`, [`${application}%`]);
        assert.deepEqual(survivors.rows, [], 'Every actual borrowed/service backend must close.');
      } catch (error) { errors.push(error); }
      try { await close(control); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Borrowed admission PostgreSQL cleanup failed.');
  }
  console.log(JSON.stringify({ version: 1, passed: true, boundaries: checked.length, checked,
    serverMajor: 18, generatedSchemaRemoved: schema, ownedBackendPids: [...backendPids],
    ownedBackendsClosed: true, coreCloseCalls: closeCalls, coreOwnsNoTransactionControls: true }));
}

run().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error('Borrowed admission PostgreSQL regression failed.', JSON.stringify({
    name: error instanceof Error ? error.name : 'Error',
    code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(code) ? code : null,
    message: error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]') : 'Unknown failure',
  })); process.exitCode = 1;
});
