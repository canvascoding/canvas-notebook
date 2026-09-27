import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import {
  CollaborationAdmissionError,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
  type CollaborationAdmissionScope,
} from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import {
  createCollaborationAdmissionQuiescenceService,
  type CollaborationAdmissionQuiescenceProof,
} from '../app/lib/collaboration/room-admission-quiescence';
import type { CollaborationAdmissionDrainTicket } from '../app/lib/collaboration/room-admission-drain';
import {
  assertCollaborationRoomOwnerFence,
  CollaborationRoomOwnerError,
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerFence,
} from '../app/lib/collaboration/room-owner';
import type { CollaborationRoomReleaseSnapshot } from '../app/lib/collaboration/room-owner-release';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';

const SCHEMA_PREFIX = 'canvas_admission_quiescence_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type OwnerSession = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;
type AdmissionService = ReturnType<typeof createCollaborationAdmissionService>;
type QuiescenceService = ReturnType<typeof createCollaborationAdmissionQuiescenceService>;

type StateRow = {
  document_id: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  representation: string;
  lifecycle_generation: number | string;
  schema_version: number | string;
  status: string;
  yjs_state: Uint8Array;
  state_vector: Uint8Array;
  document_sequence: number | string;
  room_owner_epoch: number | string;
  room_owner_token: string | null;
  room_owner_backend_pid: number | null;
  room_owner_backend_start: string | null;
};

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('Admission-quiescence PostgreSQL test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error('Admission-quiescence PostgreSQL test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) {
    throw new Error('Refusing SQL outside the generated admission-quiescence test namespace.');
  }
}

function schemaIdentifier(schema: string): string {
  assertGeneratedSchema(schema);
  return `"${schema}"`;
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
}

function poolConfig(databaseUrl: URL, applicationName: string, searchPath?: string) {
  if (searchPath) assertGeneratedSchema(searchPath);
  return {
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 2_000,
    allowExitOnIdle: true,
    options: [
      searchPath ? `-c search_path=${searchPath}` : '',
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
    ].filter(Boolean).join(' '),
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function verifyManagedPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{
    database_name: string;
    server_version_num: string;
    source_table_exists: boolean;
  }>(`SELECT current_database() AS database_name,
      current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS source_table_exists`);
  const row = result.rows[0];
  if (!row || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18
    || row.source_table_exists !== true) {
    throw new Error('Admission-quiescence PostgreSQL test refused a server outside managed PG18.');
  }
}

function sanitizeError(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; name?: unknown }
    : {};
  const name = typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(candidate.name)
    ? candidate.name
    : 'Error';
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(candidate.code)
    ? ` [${candidate.code}]`
    : '';
  const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown test failure.';
  return `${name}${code}: ${message}`
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
}

function admissionError(...codes: CollaborationAdmissionError['code'][]) {
  return (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.ok(codes.includes(error.code), `expected ${codes.join(' or ')}, received ${error.code}`);
    return true;
  };
}

function ownerBusy(error: unknown): boolean {
  assert.ok(error instanceof CollaborationRoomOwnerError);
  assert.equal(error.code, 'ROOM_OWNER_BUSY');
  return true;
}

function scope(path: string): CollaborationAdmissionScope {
  return { workspaceId: 'workspace-quiescence', organizationId: 'organization-quiescence', path, kind: 'exact' };
}

function document(documentId: string): CollaborationAdmissionDocument {
  return {
    documentId,
    workspaceId: 'workspace-quiescence',
    organizationId: 'organization-quiescence',
    path: `${documentId}.md`,
    representation: 'plain_text',
    lifecycleGeneration: 1,
    schemaVersion: 1,
    status: 'active',
  };
}

function request(expected: CollaborationAdmissionDocument, label: string): CollaborationAdmissionRequest {
  return {
    requestId: randomUUID(),
    actorId: 'actor-quiescence',
    action: 'move',
    actionDigest: createHash('sha256').update(`quiescence-${label}`).digest('hex'),
    scopes: [scope(expected.path)],
    expectedDocuments: [expected],
  };
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const looseClients = new Set<Client>();
  const ownerSessions = new Set<OwnerSession>();
  const cleanupErrors: unknown[] = [];
  const backgroundErrors: Error[] = [];
  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-admission-quiescence-control'), max: 4 });
  controlPool.on('error', (error) => { backgroundErrors.push(error); });
  let schemaCreated = false;

  const clientConfig = (label: string) => ({
    ...poolConfig(databaseUrl, `canvas-admission-quiescence-${label}`, schema),
  });
  const createConnectedClient = async (label: string): Promise<Client> => {
    const client = new Client(clientConfig(label));
    looseClients.add(client);
    await client.connect();
    return client;
  };
  const openConnection = (label: string) => async (): Promise<SqlConnection> => {
    const client = await createConnectedClient(label);
    let closed = false;
    return {
      get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await client.query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
      close: async () => {
        assert.equal(closed, false, 'an admission-quiescence connection must close exactly once');
        closed = true;
        await client.end();
        looseClients.delete(client);
      },
    };
  };
  const createAdmission = (label: string): AdmissionService => (
    createCollaborationAdmissionService({ openConnection: openConnection(`admission-${label}`) })
  );
  const createQuiescence = (
    label: string,
    factory: () => Promise<SqlConnection> = openConnection(`quiescence-${label}`),
  ): QuiescenceService => createCollaborationAdmissionQuiescenceService({ openConnection: factory });
  const createOwner = async (label: string) => {
    const client = await createConnectedClient(`owner-${label}`);
    const session = await createCollaborationRoomOwnerSession(client);
    ownerSessions.add(session);
    looseClients.delete(client);
    return { client, session };
  };

  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(`CREATE TABLE ${stateTable} (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    const migrationClient = await createConnectedClient('migration');
    assert.equal((await migrationClient.query<{ search_path: string }>('SHOW search_path')).rows[0]?.search_path, schema);
    await migrationClient.query(COLLABORATION_ROOM_OWNER_UP_SQL);
    await migrationClient.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migrationClient.query(statement);
    // Recreate the exact legacy upgrade boundary in this isolated namespace:
    // the old target table exists but neither additive quiescence column does.
    await migrationClient.query(`ALTER TABLE collaboration_admission_targets
      DROP COLUMN quiescence_kind, DROP COLUMN quiescence_text`);
    for (let pass = 0; pass < 2; pass++) {
      await migrationClient.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migrationClient.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migrationClient.query(statement);
    }
    const upgradedColumns = await migrationClient.query<{ column_name: string }>(`SELECT column_name
      FROM information_schema.columns WHERE table_schema=$1 AND table_name='collaboration_admission_targets'
        AND column_name IN ('quiescence_kind','quiescence_text') ORDER BY column_name`, [schema]);
    assert.deepEqual(upgradedColumns.rows.map((row) => row.column_name), ['quiescence_kind', 'quiescence_text'],
      'two idempotent migration passes restore both columns on the legacy table');
    await migrationClient.end();
    looseClients.delete(migrationClient);

    const encode = (content: string) => {
      const doc = new Y.Doc();
      try {
        doc.getText('content').insert(0, content);
        return {
          yjsState: Buffer.from(Y.encodeStateAsUpdate(doc)),
          stateVector: Buffer.from(Y.encodeStateVector(doc)),
        };
      } finally { doc.destroy(); }
    };
    const seed = async (expected: CollaborationAdmissionDocument, content = expected.documentId) => {
      const state = encode(content);
      await controlPool.query(
        `INSERT INTO ${stateTable} (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$10,0,NULL,NULL,'lf',0,0,'active')`,
        [expected.documentId, expected.workspaceId, expected.organizationId, expected.path,
          expected.representation, expected.lifecycleGeneration, expected.schemaVersion,
          state.yjsState, state.stateVector, Date.now()],
      );
    };
    const storeSnapshot = async (
      fence: CollaborationRoomOwnerFence,
      content: string,
      admission?: CollaborationAdmissionDrainTicket,
    ): Promise<CollaborationRoomReleaseSnapshot> => {
      const client = await createConnectedClient(`store-${fence.scope.documentId}`);
      const state = encode(content);
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const row = (await client.query<StateRow>(
          'SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE', [fence.scope.documentId],
        )).rows[0];
        assert.ok(row);
        await assertCollaborationRoomOwnerFence({
          get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
        }, row, fence);
        await client.query(`UPDATE collaboration_yjs_states SET yjs_state=$2, state_vector=$3,
          document_sequence=document_sequence+1 WHERE document_id=$1`,
        [fence.scope.documentId, state.yjsState, state.stateVector]);
        await client.query('COMMIT');
        transactionOpen = false;
        return Object.freeze({ releaseId: admission?.releaseId ?? randomUUID(), ...(admission ? { admission } : {}),
          yjsState: new Uint8Array(state.yjsState), stateVector: new Uint8Array(state.stateVector) });
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
        looseClients.delete(client);
      }
    };
    const readTarget = async (input: CollaborationAdmissionRequest) => {
      const result = await controlPool.query<{
        status: string;
        active: boolean;
        release_id: string | null;
        quiescence_kind: string | null;
        quiescence_text: string | null;
      }>(`SELECT status,active,release_id,quiescence_kind,quiescence_text
        FROM ${schemaSql}.collaboration_admission_targets WHERE request_id=$1 AND document_id=$2`,
      [input.requestId, input.expectedDocuments[0]!.documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const readOwnerTuple = async (documentId: string) => {
      const result = await controlPool.query<{
        room_owner_epoch: string;
        room_owner_token: string | null;
        room_owner_backend_pid: number | null;
        room_owner_backend_start: string | null;
      }>(`SELECT room_owner_epoch::text,room_owner_token,room_owner_backend_pid,room_owner_backend_start
        FROM ${stateTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const receiptCount = async (releaseId: string) => Number((await controlPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`,
      [releaseId],
    )).rows[0]!.count);

    const admission = createAdmission('main');
    const quiescence = createQuiescence('main');

    // Epoch zero is proven only from the exact reserved bytes under the room guard.
    const vacantDoc = document('quiescence-vacant');
    await seed(vacantDoc, 'vacant');
    const vacantRequest = request(vacantDoc, 'vacant');
    const vacantReservation = await admission.reserve(vacantRequest);
    const vacantProof = await quiescence.prove(vacantRequest, vacantDoc.documentId);
    assert.equal(Object.isFrozen(vacantProof), true);
    assert.equal(vacantProof.kind, 'vacant');
    assert.equal(vacantProof.releaseId, null);
    assert.deepEqual(await quiescence.prove(vacantRequest, vacantDoc.documentId), vacantProof,
      'an exact vacancy proof is idempotent');
    assert.deepEqual(await readTarget(vacantRequest), {
      status: 'released', active: true, release_id: null,
      quiescence_kind: 'vacant', quiescence_text: vacantProof.proofText,
    });
    await assert.rejects(admission.cancel(vacantRequest, vacantReservation.revision),
      admissionError('ADMISSION_STATE_CHANGED'),
      'a proven vacancy is no longer an unstarted cancellable reservation');
    const blockedOwner = await createOwner('blocked-after-vacancy');
    await assert.rejects(blockedOwner.session.acquire({ ...vacantDoc }), ownerBusy,
      'the retained reservation still blocks claims after the short proof guard is released');

    // Raw deletion bytes can drift without changing a Yjs state vector and must invalidate vacancy.
    const driftDoc = document('quiescence-vector-equal-drift');
    const live = new Y.Doc();
    live.getText('content').insert(0, 'delete-me');
    const beforeDelete = Buffer.from(Y.encodeStateAsUpdate(live));
    const sameVector = Buffer.from(Y.encodeStateVector(live));
    live.getText('content').delete(0, live.getText('content').length);
    const afterDelete = Buffer.from(Y.encodeStateAsUpdate(live));
    assert.deepEqual(Buffer.from(Y.encodeStateVector(live)), sameVector);
    assert.notDeepEqual(afterDelete, beforeDelete);
    live.destroy();
    await seed(driftDoc, 'placeholder');
    await controlPool.query(`UPDATE ${stateTable} SET yjs_state=$2,state_vector=$3 WHERE document_id=$1`,
      [driftDoc.documentId, beforeDelete, sameVector]);
    const driftRequest = request(driftDoc, 'vector-equal-drift');
    await admission.reserve(driftRequest);
    await controlPool.query(`UPDATE ${stateTable} SET yjs_state=$2 WHERE document_id=$1`,
      [driftDoc.documentId, afterDelete]);
    await assert.rejects(quiescence.prove(driftRequest, driftDoc.documentId),
      admissionError('ADMISSION_SCOPE_CHANGED'));

    // An active advisory owner prevents proof without waiting under row locks.
    const busyDoc = document('quiescence-guard-busy');
    await seed(busyDoc);
    const busyOwner = await createOwner('guard-busy');
    const busyFence = await busyOwner.session.acquire({ ...busyDoc });
    const busyRequest = request(busyDoc, 'guard-busy');
    await admission.reserve(busyRequest);
    await assert.rejects(within(quiescence.prove(busyRequest, busyDoc.documentId), OPERATION_TIMEOUT_MS,
      'quiescence proof waited instead of using the room try-lock'),
    admissionError('ADMISSION_CONFLICT'));
    await busyOwner.session.release(busyFence);

    // A lost owner tuple and a snapshot-less release both remain unproven.
    const staleDoc = document('quiescence-stale-owner');
    await seed(staleDoc);
    const staleOwner = await createOwner('stale-owner');
    await staleOwner.session.acquire({ ...staleDoc });
    const staleRequest = request(staleDoc, 'stale-owner');
    await admission.reserve(staleRequest);
    await staleOwner.session.close();
    const staleTuple = await readOwnerTuple(staleDoc.documentId);
    await assert.rejects(quiescence.prove(staleRequest, staleDoc.documentId),
      admissionError('ADMISSION_RECOVERY_REQUIRED'));
    assert.deepEqual(await readOwnerTuple(staleDoc.documentId), staleTuple,
      'a failed stale-owner proof never clears or rewrites the recovery tuple');

    const noReceiptDoc = document('quiescence-no-receipt');
    await seed(noReceiptDoc);
    const noReceiptOwner = await createOwner('no-receipt');
    const noReceiptFence = await noReceiptOwner.session.acquire({ ...noReceiptDoc });
    const noReceiptRequest = request(noReceiptDoc, 'no-receipt');
    await admission.reserve(noReceiptRequest);
    await noReceiptOwner.session.release(noReceiptFence);
    await assert.rejects(quiescence.prove(noReceiptRequest, noReceiptDoc.documentId),
      admissionError('ADMISSION_RECOVERY_REQUIRED'));

    // A complete normal receipt may precede or follow reservation.
    const releaseBeforeDoc = document('quiescence-release-before-reserve');
    await seed(releaseBeforeDoc);
    const releaseBeforeOwner = await createOwner('release-before');
    const releaseBeforeFence = await releaseBeforeOwner.session.acquire({ ...releaseBeforeDoc });
    const releaseBeforeSnapshot = await storeSnapshot(releaseBeforeFence, 'release-before-final');
    await releaseBeforeOwner.session.release(releaseBeforeFence, releaseBeforeSnapshot);
    const releaseBeforeRequest = request(releaseBeforeDoc, 'release-before');
    await admission.reserve(releaseBeforeRequest);
    const releaseBeforeProof = await quiescence.prove(releaseBeforeRequest, releaseBeforeDoc.documentId);
    assert.equal(releaseBeforeProof.kind, 'normal_release');
    assert.equal(releaseBeforeProof.releaseId, releaseBeforeSnapshot.releaseId);

    const reserveBeforeDoc = document('quiescence-reserve-before-release');
    await seed(reserveBeforeDoc);
    const reserveBeforeOwner = await createOwner('reserve-before');
    const reserveBeforeFence = await reserveBeforeOwner.session.acquire({ ...reserveBeforeDoc });
    const reserveBeforeRequest = request(reserveBeforeDoc, 'reserve-before');
    await admission.reserve(reserveBeforeRequest);
    const reserveBeforeSnapshot = await storeSnapshot(reserveBeforeFence, 'reserve-before-final');
    await reserveBeforeOwner.session.release(reserveBeforeFence, reserveBeforeSnapshot);
    const reserveBeforeProof = await quiescence.prove(reserveBeforeRequest, reserveBeforeDoc.documentId);
    assert.equal(reserveBeforeProof.kind, 'normal_release');
    assert.equal(reserveBeforeProof.releaseId, reserveBeforeSnapshot.releaseId);
    assert.equal(await receiptCount(reserveBeforeSnapshot.releaseId), 1);
    await assert.rejects(controlPool.query(
      `DELETE FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`,
      [reserveBeforeSnapshot.releaseId],
    ), (error: unknown) => {
      assert.equal((error as { code?: string }).code, '23503');
      return true;
    });

    // A normal receipt can settle a target whose owner drain started, but it is no longer polled as local owner work.
    const startedNormalDoc = document('quiescence-started-normal');
    await seed(startedNormalDoc);
    const startedNormalOwner = await createOwner('started-normal');
    const startedNormalFence = await startedNormalOwner.session.acquire({ ...startedNormalDoc });
    const startedNormalRequest = request(startedNormalDoc, 'started-normal');
    await admission.reserve(startedNormalRequest);
    const abandonedTicket = await admission.startDrain(startedNormalRequest, startedNormalDoc.documentId);
    const startedNormalSnapshot = await storeSnapshot(startedNormalFence, 'started-normal-final');
    await startedNormalOwner.session.release(startedNormalFence, startedNormalSnapshot);
    const startedNormalProof = await quiescence.prove(startedNormalRequest, startedNormalDoc.documentId);
    assert.equal(startedNormalProof.kind, 'normal_release');
    assert.notEqual(startedNormalProof.releaseId, abandonedTicket.releaseId);
    assert.deepEqual(await quiescence.prove(startedNormalRequest, startedNormalDoc.documentId), startedNormalProof,
      'an already materialized normal-release proof is exactly idempotent');
    await assert.rejects(admission.readDrain(abandonedTicket), admissionError('ADMISSION_STATE_CHANGED'),
      'the abandoned owner-drain ticket cannot be read as normal-release local-finish authority');
    await assert.rejects(admission.startDrain(startedNormalRequest, startedNormalDoc.documentId),
      admissionError('ADMISSION_STATE_CHANGED'),
      'a proven normal release cannot be converted back into an owner drain');
    assert.deepEqual(await admission.pendingDrains([startedNormalFence]), [],
      'a normal release proof is not owner-drain local-finish authority');

    // DA02 owner release retains its deterministic ticket for bounded local finish after proof text is added.
    const ownerDrainDoc = document('quiescence-owner-drain');
    await seed(ownerDrainDoc);
    const ownerDrainOwner = await createOwner('owner-drain');
    const ownerDrainFence = await ownerDrainOwner.session.acquire({ ...ownerDrainDoc });
    const ownerDrainRequest = request(ownerDrainDoc, 'owner-drain');
    await admission.reserve(ownerDrainRequest);
    const ownerDrainTicket = await admission.startDrain(ownerDrainRequest, ownerDrainDoc.documentId);
    const ownerDrainSnapshot = await storeSnapshot(ownerDrainFence, 'owner-drain-final', ownerDrainTicket);
    await ownerDrainOwner.session.release(ownerDrainFence, ownerDrainSnapshot);
    const ownerDrainProof = await quiescence.prove(ownerDrainRequest, ownerDrainDoc.documentId);
    assert.equal(ownerDrainProof.kind, 'owner_drain');
    assert.equal(ownerDrainProof.releaseId, ownerDrainTicket.releaseId);
    assert.deepEqual(await admission.pendingDrains([ownerDrainFence]), [ownerDrainTicket],
      'owner-drain proof retains the exact released ticket for unfinished local destruction');

    // Exact epoch, scope and bytes are all part of proof validation.
    const wrongEpochDoc = document('quiescence-wrong-epoch');
    await seed(wrongEpochDoc);
    const wrongEpochOwner = await createOwner('wrong-epoch');
    const wrongEpochFence = await wrongEpochOwner.session.acquire({ ...wrongEpochDoc });
    const wrongEpochSnapshot = await storeSnapshot(wrongEpochFence, 'wrong-epoch-final');
    await wrongEpochOwner.session.release(wrongEpochFence, wrongEpochSnapshot);
    const wrongEpochRequest = request(wrongEpochDoc, 'wrong-epoch');
    await admission.reserve(wrongEpochRequest);
    await controlPool.query(`UPDATE ${stateTable} SET room_owner_epoch=room_owner_epoch+1 WHERE document_id=$1`,
      [wrongEpochDoc.documentId]);
    await assert.rejects(quiescence.prove(wrongEpochRequest, wrongEpochDoc.documentId),
      admissionError('ADMISSION_SCOPE_CHANGED'));

    const wrongScopeDoc = document('quiescence-wrong-scope');
    await seed(wrongScopeDoc);
    const wrongScopeRequest = request(wrongScopeDoc, 'wrong-scope');
    await admission.reserve(wrongScopeRequest);
    await controlPool.query(`UPDATE ${stateTable} SET path=path || '.moved' WHERE document_id=$1`,
      [wrongScopeDoc.documentId]);
    await assert.rejects(quiescence.prove(wrongScopeRequest, wrongScopeDoc.documentId),
      admissionError('ADMISSION_SCOPE_CHANGED'));

    const wrongBytesDoc = document('quiescence-wrong-bytes');
    await seed(wrongBytesDoc);
    const wrongBytesOwner = await createOwner('wrong-bytes');
    const wrongBytesFence = await wrongBytesOwner.session.acquire({ ...wrongBytesDoc });
    const wrongBytesSnapshot = await storeSnapshot(wrongBytesFence, 'wrong-bytes-final');
    await wrongBytesOwner.session.release(wrongBytesFence, wrongBytesSnapshot);
    const wrongBytesRequest = request(wrongBytesDoc, 'wrong-bytes');
    await admission.reserve(wrongBytesRequest);
    const changedBytes = encode('coherent-but-not-receipted');
    await controlPool.query(`UPDATE ${stateTable} SET yjs_state=$2,state_vector=$3 WHERE document_id=$1`,
      [wrongBytesDoc.documentId, changedBytes.yjsState, changedBytes.stateVector]);
    await assert.rejects(quiescence.prove(wrongBytesRequest, wrongBytesDoc.documentId),
      admissionError('ADMISSION_SCOPE_CHANGED'));

    // Stored proof text is canonical evidence, not mutable retry metadata.
    const tamperedProofDoc = document('quiescence-tampered-proof');
    await seed(tamperedProofDoc);
    const tamperedProofRequest = request(tamperedProofDoc, 'tampered-proof');
    await admission.reserve(tamperedProofRequest);
    await quiescence.prove(tamperedProofRequest, tamperedProofDoc.documentId);
    await controlPool.query(`UPDATE ${schemaSql}.collaboration_admission_targets
      SET quiescence_text=quiescence_text || 'tampered' WHERE request_id=$1 AND document_id=$2`,
    [tamperedProofRequest.requestId, tamperedProofDoc.documentId]);
    await assert.rejects(quiescence.prove(tamperedProofRequest, tamperedProofDoc.documentId),
      admissionError('ADMISSION_STATE_CHANGED'),
      'retry refuses a stored proof whose canonical text was modified');

    // A lost successful COMMIT is recovered only after closing the uncertain backend and matching exact proof text.
    const lostCommitDoc = document('quiescence-lost-commit');
    await seed(lostCommitDoc);
    const lostCommitRequest = request(lostCommitDoc, 'lost-commit');
    await admission.reserve(lostCommitRequest);
    let lostCommitOpens = 0;
    let lostCommitClosed = false;
    const lostCommitFactory = async (): Promise<SqlConnection> => {
      lostCommitOpens += 1;
      if (lostCommitOpens > 1) {
        assert.equal(lostCommitClosed, true, 'proof recovery must wait for the uncertain backend to close');
        return openConnection('lost-commit-recovery')();
      }
      const database = await openConnection('lost-commit-primary')();
      return {
        ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost quiescence COMMIT reply.');
          return result;
        },
        close: async (error) => {
          await database.close(error);
          lostCommitClosed = true;
        },
      };
    };
    const lostCommitProof = await createQuiescence('lost-commit', lostCommitFactory)
      .prove(lostCommitRequest, lostCommitDoc.documentId);
    assert.equal(lostCommitProof.kind, 'vacant');
    assert.ok(lostCommitOpens >= 2);
    assert.deepEqual(await quiescence.prove(lostCommitRequest, lostCommitDoc.documentId), lostCommitProof);

    // If discarding a lost-COMMIT backend itself fails, no recovery connection may guess success.
    const closeFailureDoc = document('quiescence-close-failure');
    await seed(closeFailureDoc);
    const closeFailureRequest = request(closeFailureDoc, 'close-failure');
    await admission.reserve(closeFailureRequest);
    let closeFailureOpens = 0;
    const closeFailureFactory = async (): Promise<SqlConnection> => {
      closeFailureOpens += 1;
      const database = await openConnection('close-failure-primary')();
      return {
        ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost COMMIT before discard failure.');
          return result;
        },
        close: async (error) => {
          if (error) throw new Error('Injected quiescence backend discard failure.');
          await database.close();
        },
      };
    };
    await assert.rejects(createQuiescence('close-failure', closeFailureFactory)
      .prove(closeFailureRequest, closeFailureDoc.documentId),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      return true;
    });
    assert.equal(closeFailureOpens, 1, 'failed discard prevents opening a recovery connection');
    const committedAfterCloseFailure = await readTarget(closeFailureRequest);
    assert.equal(committedAfterCloseFailure.active, true, 'the reservation remains active after discard failure');
    assert.equal(committedAfterCloseFailure.status, 'released');
    assert.equal(committedAfterCloseFailure.quiescence_kind, 'vacant');
    assert.equal(typeof committedAfterCloseFailure.quiescence_text, 'string');
    const closeFailureRetry = await quiescence.prove(closeFailureRequest, closeFailureDoc.documentId);
    assert.equal(closeFailureRetry.proofText, committedAfterCloseFailure.quiescence_text,
      'a later fresh exact retry can read the already committed proof without replaying mutation');

    // A rejected COMMIT never invents success; the exact same attempt can safely retry afterward.
    const rejectedCommitDoc = document('quiescence-rejected-commit');
    await seed(rejectedCommitDoc);
    const rejectedCommitRequest = request(rejectedCommitDoc, 'rejected-commit');
    await admission.reserve(rejectedCommitRequest);
    let rejectedCommitOpens = 0;
    let rejectedCommitClosed = false;
    const rejectedCommitFactory = async (): Promise<SqlConnection> => {
      rejectedCommitOpens += 1;
      if (rejectedCommitOpens > 1) {
        assert.equal(rejectedCommitClosed, true, 'absence recovery must wait for the rejected backend to close');
        return openConnection('rejected-commit-recovery')();
      }
      const database = await openConnection('rejected-commit-primary')();
      return {
        ...database,
        run: async (sql, params = []) => {
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected rejected quiescence COMMIT.');
          return database.run(sql, params);
        },
        close: async (error) => {
          await database.close(error);
          rejectedCommitClosed = true;
        },
      };
    };
    await assert.rejects(createQuiescence('rejected-commit', rejectedCommitFactory)
      .prove(rejectedCommitRequest, rejectedCommitDoc.documentId),
    admissionError('ADMISSION_RECOVERY_REQUIRED'));
    assert.deepEqual(await readTarget(rejectedCommitRequest), {
      status: 'reserved', active: true, release_id: null, quiescence_kind: null, quiescence_text: null,
    });
    const retriedProof = await quiescence.prove(rejectedCommitRequest, rejectedCommitDoc.documentId);
    assert.equal(retriedProof.kind, 'vacant');

    assert.equal(backgroundErrors.length, 0, 'admission-quiescence pools must not emit background errors');
    const proofs: CollaborationAdmissionQuiescenceProof[] = [
      vacantProof, releaseBeforeProof, reserveBeforeProof, startedNormalProof,
      ownerDrainProof, lostCommitProof, closeFailureRetry, retriedProof,
    ];
    assert.ok(proofs.every((proof) => JSON.parse(proof.proofText).version === 1));
    console.log(
      'Collaboration admission quiescence PostgreSQL: 18 bounded boundaries passed—legacy additive migration, exact vacancy '
      + 'and raw-byte drift, '
      + 'owner try-lock contention, stale/no-receipt rejection, both normal-release orderings, started-normal and owner-drain '
      + 'classification, exact epoch/scope/byte rejection, claim blocking, receipt FK pinning, lost-COMMIT proof recovery, '
      + 'canonical proof retry fencing, failed-discard recovery suppression, and rejected-COMMIT same-attempt retry—in one '
      + 'isolated generated schema.',
    );
  } finally {
    for (const session of ownerSessions) {
      try {
        await within(session.close(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission-quiescence owner session.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const client of [...looseClients]) {
      try {
        await within(client.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission-quiescence client.');
        looseClients.delete(client);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (schemaCreated && looseClients.size === 0) {
      try {
        await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining the admission-quiescence control pool.');
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Admission-quiescence cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration admission-quiescence PostgreSQL test skipped: guarded managed database environment is not configured.');
} else {
  run(databaseUrl).catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
