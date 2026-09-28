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
import {
  captureCollaborationAdmissionDrainTicket,
  type CollaborationAdmissionDrainTicket,
} from '../app/lib/collaboration/room-admission-drain';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import {
  assertCollaborationRoomOwnerFence,
  CollaborationRoomOwnerError,
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerFence,
} from '../app/lib/collaboration/room-owner';
import {
  CollaborationRoomReleaseError,
  recoverCollaborationRoomRelease,
  type CollaborationRoomReleaseSnapshot,
} from '../app/lib/collaboration/room-owner-release';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';

const SCHEMA_PREFIX = 'canvas_admission_drain_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type OwnerSession = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;
type AdmissionService = ReturnType<typeof createCollaborationAdmissionService>;

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
    throw new Error('Admission-drain PostgreSQL test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error('Admission-drain PostgreSQL test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) {
    throw new Error('Refusing SQL outside the generated admission-drain test namespace.');
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
    throw new Error('Admission-drain PostgreSQL test refused a server outside managed PG18.');
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

function unprovenRelease(error: unknown): boolean {
  if (error instanceof CollaborationRoomReleaseError) {
    assert.equal(error.code, 'ROOM_RELEASE_UNPROVEN');
  } else {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.equal(error.code, 'ADMISSION_STATE_CHANGED');
  }
  return true;
}

function ownerLost(error: unknown): boolean {
  assert.ok(error instanceof CollaborationRoomOwnerError);
  assert.ok(error.code === 'ROOM_OWNER_LOST' || error.code === 'ROOM_OWNER_UNAVAILABLE');
  return true;
}

function scope(path: string): CollaborationAdmissionScope {
  return { workspaceId: 'workspace-drain', organizationId: 'organization-drain', path, kind: 'exact' };
}

function document(documentId: string): CollaborationAdmissionDocument {
  return {
    documentId,
    workspaceId: 'workspace-drain',
    organizationId: 'organization-drain',
    path: `${documentId}.md`,
    representation: 'plain_text',
    lifecycleGeneration: 1,
    schemaVersion: 1,
    status: 'active',
  };
}

function request(expected: CollaborationAdmissionDocument, digestCharacter: string): CollaborationAdmissionRequest {
  return {
    requestId: randomUUID(),
    actorId: 'actor-drain',
    action: 'move',
    actionDigest: digestCharacter.repeat(64),
    scopes: [scope(expected.path)],
    expectedDocuments: [expected],
  };
}

function deterministicReleaseId(requestId: string, requestDigest: string, documentId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([
    'canvas.admission-drain-release.v1', requestId, requestDigest, documentId,
  ])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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
  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-admission-drain-control'), max: 4 });
  controlPool.on('error', (error) => { backgroundErrors.push(error); });
  let schemaCreated = false;

  const clientConfig = (label: string) => ({
    ...poolConfig(databaseUrl, `canvas-admission-drain-${label}`, schema),
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
        assert.equal(closed, false, 'an admission-drain connection must close exactly once');
        closed = true;
        await client.end();
        looseClients.delete(client);
      },
    };
  };
  const createService = (label: string, factory = openConnection(label)): AdmissionService => (
    createCollaborationAdmissionService({ openConnection: factory })
  );
  const createOwner = async (label: string, transform?: (client: Client) => Pick<Client, 'query' | 'on' | 'end'>) => {
    const client = await createConnectedClient(`owner-${label}`);
    const session = await createCollaborationRoomOwnerSession(transform?.(client) ?? client);
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
    for (let pass = 0; pass < 2; pass++) {
      await migrationClient.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migrationClient.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migrationClient.query(statement);
    }
    await migrationClient.end();
    looseClients.delete(migrationClient);

    const empty = new Y.Doc();
    const emptyUpdate = Buffer.from(Y.encodeStateAsUpdate(empty));
    const emptyVector = Buffer.from(Y.encodeStateVector(empty));
    empty.destroy();
    const seed = async (expected: CollaborationAdmissionDocument) => {
      await controlPool.query(
        `INSERT INTO ${stateTable} (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$10,0,NULL,NULL,'lf',0,0,'active')`,
        [expected.documentId, expected.workspaceId, expected.organizationId, expected.path,
          expected.representation, expected.lifecycleGeneration, expected.schemaVersion,
          emptyUpdate, emptyVector, Date.now()],
      );
    };
    const readState = async (documentId: string): Promise<StateRow> => {
      const result = await controlPool.query<StateRow>(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const storeSnapshot = async (
      fence: CollaborationRoomOwnerFence,
      ticket: CollaborationAdmissionDrainTicket,
      content: string,
    ): Promise<CollaborationRoomReleaseSnapshot> => {
      const client = await createConnectedClient(`store-${fence.scope.documentId}`);
      const live = new Y.Doc();
      live.getText('content').insert(0, content);
      const yjsState = Y.encodeStateAsUpdate(live);
      const stateVector = Y.encodeStateVector(live);
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
        [fence.scope.documentId, Buffer.from(yjsState), Buffer.from(stateVector)]);
        await client.query('COMMIT');
        transactionOpen = false;
        return Object.freeze({ releaseId: ticket.releaseId, admission: ticket, yjsState, stateVector });
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        live.destroy();
        await client.end();
        looseClients.delete(client);
      }
    };
    const receiptCount = async (releaseId: string) => Number((await controlPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`,
      [releaseId],
    )).rows[0]!.count);

    const documents = {
      happy: document('drain-happy'),
      multiA: document('drain-multi-a'),
      multiB: document('drain-multi-b'),
      lostStart: document('drain-lost-start'),
      lostRelease: document('drain-lost-release'),
      failedAck: document('drain-failed-ack'),
    };
    for (const expected of Object.values(documents)) await seed(expected);
    const service = createService('main');

    // Happy path: one immutable deterministic ticket binds owner, receipt and target acknowledgement atomically.
    const happyOwner = await createOwner('happy');
    const happyFence = await happyOwner.session.acquire({ ...documents.happy });
    const happyRequest = request(documents.happy, 'a');
    const happyReservation = await service.reserve(happyRequest);
    const happyTicket = await service.startDrain(happyRequest, documents.happy.documentId);
    assert.equal(Object.isFrozen(happyTicket), true);
    assert.equal(Object.isFrozen(happyTicket.fence), true);
    assert.equal(Object.isFrozen(happyTicket.fence.scope), true);
    assert.equal(happyTicket.releaseId,
      deterministicReleaseId(happyTicket.requestId, happyTicket.requestDigest, documents.happy.documentId));
    assert.deepEqual(await service.startDrain(happyRequest, documents.happy.documentId), happyTicket,
      'a duplicate start returns the same deterministic ticket');
    assert.deepEqual(await service.readDrain(happyTicket), { ticket: happyTicket, status: 'draining' });
    assert.deepEqual(await createService('polling-restart').pendingDrains([happyFence]), [happyTicket],
      'a fresh service instance discovers the authoritative pending drain');
    await assert.rejects(service.cancel(happyRequest, happyReservation.revision),
      admissionError('ADMISSION_STATE_CHANGED'));

    const wrongDigest = 'f'.repeat(64);
    const wrongDigestTicket = captureCollaborationAdmissionDrainTicket({
      ...happyTicket,
      requestDigest: wrongDigest,
      releaseId: deterministicReleaseId(happyTicket.requestId, wrongDigest, documents.happy.documentId),
    });
    await assert.rejects(service.readDrain(wrongDigestTicket), admissionError('ADMISSION_REQUEST_CHANGED'));
    const wrongRequestId = randomUUID();
    const wrongRequestTicket = captureCollaborationAdmissionDrainTicket({
      ...happyTicket,
      requestId: wrongRequestId,
      releaseId: deterministicReleaseId(wrongRequestId, happyTicket.requestDigest, documents.happy.documentId),
    });
    await assert.rejects(service.readDrain(wrongRequestTicket), admissionError('ADMISSION_REQUEST_CHANGED'));
    for (const wrongFence of [
      { ...happyTicket.fence, epoch: happyTicket.fence.epoch + 1 },
      { ...happyTicket.fence, token: randomUUID() },
    ]) {
      await assert.rejects(service.readDrain(captureCollaborationAdmissionDrainTicket({
        ...happyTicket, fence: wrongFence,
      })), admissionError('ADMISSION_SCOPE_CHANGED'));
    }
    const wrongOwnerAdmission = captureCollaborationAdmissionDrainTicket({
      ...happyTicket,
      fence: { ...happyTicket.fence, token: randomUUID() },
    });
    const prematureSnapshot = await storeSnapshot(happyFence, happyTicket, 'happy-final');
    await assert.rejects(happyOwner.session.release(happyFence, {
      ...prematureSnapshot, admission: wrongOwnerAdmission,
    }), (error: unknown) => {
      assert.ok(error instanceof CollaborationRoomOwnerError);
      assert.equal(error.code, 'ROOM_OWNER_SCOPE_CHANGED');
      return true;
    });
    happyOwner.session.assertActive(happyFence);
    await happyOwner.session.release(happyFence, prematureSnapshot);
    assert.equal(await receiptCount(happyTicket.releaseId), 1);
    const happyTarget = await controlPool.query<{ active: boolean; status: string; release_id: string | null }>(
      `SELECT active,status,release_id FROM ${schemaSql}.collaboration_admission_targets
       WHERE request_id=$1 AND document_id=$2`, [happyRequest.requestId, documents.happy.documentId],
    );
    assert.deepEqual(happyTarget.rows[0], { active: true, status: 'released', release_id: happyTicket.releaseId });
    assert.deepEqual(await service.readDrain(happyTicket), { ticket: happyTicket, status: 'released' });
    assert.deepEqual(await createService('released-polling-restart').pendingDrains([happyFence]), [happyTicket],
      'released targets remain discoverable until local unload completion is durably handled');
    const happyReceipt = await controlPool.query<{
      release_id: string;
      owner_epoch: string;
      owner_token: string;
      document_sequence: string;
    }>(`SELECT release_id,owner_epoch,owner_token,document_sequence
        FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`, [happyTicket.releaseId]);
    assert.deepEqual(happyReceipt.rows[0], {
      release_id: happyTicket.releaseId,
      owner_epoch: String(happyFence.epoch),
      owner_token: happyFence.token,
      document_sequence: '1',
    });
    await assert.rejects(
      controlPool.query(`DELETE FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`,
        [happyTicket.releaseId]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23503');
        return true;
      },
    );

    // One request can progress target-by-target without regressing its header or hiding released local work.
    const multiOwner = await createOwner('multi');
    const multiFenceA = await multiOwner.session.acquire({ ...documents.multiA });
    const multiFenceB = await multiOwner.session.acquire({ ...documents.multiB });
    const multiRequest: CollaborationAdmissionRequest = {
      requestId: randomUUID(),
      actorId: 'actor-drain',
      action: 'move',
      actionDigest: 'e'.repeat(64),
      scopes: [scope(documents.multiA.path), scope(documents.multiB.path)],
      expectedDocuments: [documents.multiA, documents.multiB],
    };
    const multiRevision = async () => {
      const result = await controlPool.query<{ status: string; revision: string }>(
        `SELECT status,revision FROM ${schemaSql}.collaboration_admission_requests WHERE request_id=$1`,
        [multiRequest.requestId],
      );
      assert.equal(result.rows[0]?.status, 'draining');
      return Number(result.rows[0]?.revision);
    };
    const multiReservation = await service.reserve(multiRequest);
    assert.equal(multiReservation.revision, 1);
    const multiTicketA = await service.startDrain(multiRequest, documents.multiA.documentId);
    assert.equal(await multiRevision(), 2);
    assert.deepEqual(await service.startDrain(multiRequest, documents.multiA.documentId), multiTicketA);
    assert.equal(await multiRevision(), 2, 'retrying started target A must not increment the header revision');
    assert.deepEqual(await service.pendingDrains([multiFenceA, multiFenceB]), [multiTicketA],
      'only target A is visible while B remains reserved');
    const multiSnapshotA = await storeSnapshot(multiFenceA, multiTicketA, 'multi-a-final');
    await multiOwner.session.release(multiFenceA, multiSnapshotA);
    assert.equal(await multiRevision(), 3);
    const multiTicketB = await service.startDrain(multiRequest, documents.multiB.documentId);
    assert.equal(await multiRevision(), 4);
    assert.deepEqual(await service.pendingDrains([multiFenceA, multiFenceB]), [multiTicketA, multiTicketB],
      'released A and draining B both remain visible to unfinished local objects');
    const multiSnapshotB = await storeSnapshot(multiFenceB, multiTicketB, 'multi-b-final');
    await multiOwner.session.release(multiFenceB, multiSnapshotB);
    assert.equal(await multiRevision(), 5);
    assert.deepEqual(await service.pendingDrains([multiFenceA, multiFenceB]), [multiTicketA, multiTicketB],
      'both released targets remain visible until their local finish steps complete');
    for (const ticket of [multiTicketA, multiTicketB]) {
      assert.equal(await receiptCount(ticket.releaseId), 1);
      await assert.rejects(
        controlPool.query(`DELETE FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`,
          [ticket.releaseId]),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, '23503');
          return true;
        },
      );
    }

    // Lost startDrain COMMIT reply: the old connection ends before a fresh exact-ticket read proves success.
    const lostStartOwner = await createOwner('lost-start');
    const lostStartFence = await lostStartOwner.session.acquire({ ...documents.lostStart });
    const lostStartRequest = request(documents.lostStart, 'b');
    await service.reserve(lostStartRequest);
    let lostStartOpens = 0;
    let lostStartClosed = false;
    const lostStartFactory = async (): Promise<SqlConnection> => {
      lostStartOpens += 1;
      if (lostStartOpens > 1) {
        assert.equal(lostStartClosed, true, 'startDrain recovery must wait for the uncertain backend to end');
        return openConnection('lost-start-recovery')();
      }
      const database = await openConnection('lost-start-primary')();
      return {
        ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost startDrain COMMIT reply.');
          return result;
        },
        close: async (error) => {
          await database.close(error);
          lostStartClosed = true;
        },
      };
    };
    const lostStartTicket = await createService('lost-start', lostStartFactory)
      .startDrain(lostStartRequest, documents.lostStart.documentId);
    assert.ok(lostStartOpens >= 2);
    assert.deepEqual(await service.readDrain(lostStartTicket), { ticket: lostStartTicket, status: 'draining' });
    const lostStartSnapshot = await storeSnapshot(lostStartFence, lostStartTicket, 'lost-start-final');
    await lostStartOwner.session.release(lostStartFence, lostStartSnapshot);

    // Lost release COMMIT reply: recovery runs only after owner backend end and proves receipt+target acknowledgement.
    let dropReleaseCommit = false;
    let lostReleaseEnded = false;
    const lostReleaseOwner = await createOwner('lost-release', (client) => ({
      query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (dropReleaseCommit && normalizedSql(sql) === 'COMMIT') {
          dropReleaseCommit = false;
          throw new Error('Injected lost admission release COMMIT reply.');
        }
        return result;
      },
      on: client.on.bind(client),
      end: async () => {
        await client.end();
        lostReleaseEnded = true;
      },
    } as unknown as Pick<Client, 'query' | 'on' | 'end'>));
    const lostReleaseFence = await lostReleaseOwner.session.acquire({ ...documents.lostRelease });
    const lostReleaseRequest = request(documents.lostRelease, 'c');
    await service.reserve(lostReleaseRequest);
    const lostReleaseTicket = await service.startDrain(lostReleaseRequest, documents.lostRelease.documentId);
    const lostReleaseSnapshot = await storeSnapshot(lostReleaseFence, lostReleaseTicket, 'lost-release-final');
    dropReleaseCommit = true;
    await assert.rejects(lostReleaseOwner.session.release(lostReleaseFence, lostReleaseSnapshot), ownerLost);
    assert.equal(lostReleaseEnded, true, 'release must end its uncertain owner backend before recovery');
    const recoveredReceipt = await recoverCollaborationRoomRelease({
      createClient: async () => {
        assert.equal(lostReleaseEnded, true);
        const client = await createConnectedClient('lost-release-recovery');
        looseClients.delete(client);
        return client;
      },
      fence: lostReleaseFence,
      snapshot: lostReleaseSnapshot,
    });
    assert.equal(recoveredReceipt.release_id, lostReleaseTicket.releaseId);
    assert.equal(recoveredReceipt.owner_token, lostReleaseFence.token);
    assert.deepEqual(await service.readDrain(lostReleaseTicket), {
      ticket: lostReleaseTicket, status: 'released',
    });

    // Ack SQL failure happens after receipt/token writes in the transaction; backend close rolls every one back.
    let injectAckFailure = false;
    const failedAckOwner = await createOwner('failed-ack', (client) => ({
      query: async (sql: string, values?: unknown[]) => {
        if (injectAckFailure
          && normalizedSql(sql).startsWith("UPDATE COLLABORATION_ADMISSION_TARGETS SET STATUS = 'RELEASED'")) {
          injectAckFailure = false;
          throw new Error('Injected target acknowledgement failure.');
        }
        return client.query(sql, values);
      },
      on: client.on.bind(client),
      end: client.end.bind(client),
    } as unknown as Pick<Client, 'query' | 'on' | 'end'>));
    const failedAckFence = await failedAckOwner.session.acquire({ ...documents.failedAck });
    const failedAckRequest = request(documents.failedAck, 'd');
    await service.reserve(failedAckRequest);
    const failedAckTicket = await service.startDrain(failedAckRequest, documents.failedAck.documentId);
    const failedAckSnapshot = await storeSnapshot(failedAckFence, failedAckTicket, 'failed-ack-final');
    injectAckFailure = true;
    await assert.rejects(failedAckOwner.session.release(failedAckFence, failedAckSnapshot), ownerLost);
    assert.throws(() => failedAckOwner.session.assertActive(failedAckFence), ownerLost,
      'a database-binding failure invalidates and closes the owner session');
    assert.equal(await receiptCount(failedAckTicket.releaseId), 0,
      'receipt insert rolls back when target acknowledgement fails');
    const failedAckState = await readState(documents.failedAck.documentId);
    assert.equal(failedAckState.room_owner_token, failedAckFence.token,
      'owner token clear rolls back with the failed target acknowledgement');
    const failedAckTarget = await controlPool.query<{ active: boolean; status: string; release_id: string | null }>(
      `SELECT active,status,release_id FROM ${schemaSql}.collaboration_admission_targets
       WHERE request_id=$1 AND document_id=$2`, [failedAckRequest.requestId, documents.failedAck.documentId],
    );
    assert.deepEqual(failedAckTarget.rows[0], { active: true, status: 'draining', release_id: null });
    const failedAckHeader = await controlPool.query<{ status: string; revision: string }>(
      `SELECT status,revision FROM ${schemaSql}.collaboration_admission_requests WHERE request_id=$1`,
      [failedAckRequest.requestId],
    );
    assert.deepEqual(failedAckHeader.rows[0], { status: 'draining', revision: '2' });
    assert.deepEqual(await createService('failed-ack-restart').pendingDrains([failedAckFence]), [failedAckTicket]);
    await assert.rejects(recoverCollaborationRoomRelease({
      createClient: async () => {
        const client = await createConnectedClient('failed-ack-recovery');
        looseClients.delete(client);
        return client;
      },
      fence: failedAckFence,
      snapshot: failedAckSnapshot,
    }), unprovenRelease);

    assert.equal(backgroundErrors.length, 0, 'admission-drain test pools must not emit background errors');
    console.log(
      'Collaboration admission drain PostgreSQL: 10 bounded boundaries passed—atomic receipt/target/token acknowledgement, '
      + 'deterministic retryable tickets, exact binding rejection, cancel fencing, lost start COMMIT recovery, lost release '
      + 'COMMIT recovery, acknowledgement rollback, restart polling, multi-target mixed-state progression, and receipt FK '
      + 'pinning—in one isolated generated schema.',
    );
  } finally {
    for (const session of ownerSessions) {
      try {
        await within(session.close(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission-drain owner session.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const client of [...looseClients]) {
      try {
        await within(client.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission-drain client.');
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
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining the admission-drain control pool.');
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Admission-drain cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration admission-drain PostgreSQL test skipped: guarded managed database environment is not configured.');
} else {
  run(databaseUrl).catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
