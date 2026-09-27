import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import {
  CollaborationAdmissionError,
  captureCollaborationAdmissionRequest,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
  type CollaborationAdmissionScope,
} from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import {
  assertCollaborationRoomOwnerFence,
  CollaborationRoomOwnerError,
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';

const SCHEMA_PREFIX = 'canvas_admission_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 20_000;
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
  room_owner_epoch: number | string;
  room_owner_token: string | null;
  room_owner_backend_pid: number | null;
  room_owner_backend_start: string | null;
  document_sequence: number | string;
};

type CloseObservation = {
  closeCalls: number;
  closeErrors: number;
  closed: boolean;
};

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(gates: Set<Gate>): Gate {
  let settled = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const gate: Gate = {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      gates.delete(gate);
      resolvePromise();
    },
  };
  gates.add(gate);
  return gate;
}

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('Admission PostgreSQL test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error('Admission PostgreSQL test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) {
    throw new Error('Refusing SQL outside the generated admission test namespace.');
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

async function eventually<T>(probe: () => Promise<T | null>, message: string): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(message);
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
    throw new Error('Admission PostgreSQL test refused a server outside managed PG18.');
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

function scope(
  path: string,
  kind: CollaborationAdmissionScope['kind'] = 'exact',
  overrides: Partial<CollaborationAdmissionScope> = {},
): CollaborationAdmissionScope {
  return {
    workspaceId: 'workspace-main',
    organizationId: 'organization-main',
    path,
    kind,
    ...overrides,
  };
}

function document(
  documentId: string,
  path: string,
  overrides: Partial<CollaborationAdmissionDocument> = {},
): CollaborationAdmissionDocument {
  return {
    documentId,
    workspaceId: 'workspace-main',
    organizationId: 'organization-main',
    path,
    representation: 'plain_text',
    lifecycleGeneration: 1,
    schemaVersion: 1,
    status: 'active',
    ...overrides,
  };
}

function request(
  scopes: readonly CollaborationAdmissionScope[],
  expectedDocuments: readonly CollaborationAdmissionDocument[],
  overrides: Partial<CollaborationAdmissionRequest> = {},
): CollaborationAdmissionRequest {
  return {
    requestId: randomUUID(),
    actorId: 'actor-main',
    action: 'move',
    actionDigest: 'a'.repeat(64),
    scopes,
    expectedDocuments,
    ...overrides,
  };
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const gates = new Set<Gate>();
  const pendingOperations = new Set<Promise<unknown>>();
  const looseClients = new Set<Client>();
  const ownerSessions = new Set<OwnerSession>();
  const cleanupErrors: unknown[] = [];
  const backgroundErrors: Error[] = [];
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pendingOperations.add(operation);
    operation.then(
      () => pendingOperations.delete(operation),
      () => pendingOperations.delete(operation),
    );
    return operation;
  };
  const controlPool = new Pool({
    ...poolConfig(databaseUrl, 'canvas-admission-test-control'),
    max: 4,
  });
  controlPool.on('error', (error) => { backgroundErrors.push(error); });
  let schemaCreated = false;

  const clientConfig = (label: string) => ({
    ...poolConfig(databaseUrl, `canvas-admission-test-${label}`, schema),
  });
  const createConnectedClient = async (label: string): Promise<Client> => {
    const client = new Client(clientConfig(label));
    looseClients.add(client);
    await client.connect();
    return client;
  };
  const openConnection = (label: string, observe?: CloseObservation) => async (): Promise<SqlConnection> => {
    const client = await createConnectedClient(label);
    let closed = false;
    return {
      get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await client.query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
      close: async (error) => {
        assert.equal(closed, false, 'an admission connection must be closed exactly once');
        closed = true;
        if (observe) {
          observe.closeCalls += 1;
          observe.closeErrors += error ? 1 : 0;
        }
        await client.end();
        looseClients.delete(client);
        if (observe) observe.closed = true;
      },
    };
  };
  const createService = (label: string, factory = openConnection(label)): AdmissionService => (
    createCollaborationAdmissionService({ openConnection: factory })
  );
  const createOwner = async (label: string) => {
    const client = await createConnectedClient(`owner-${label}`);
    const session = await createCollaborationRoomOwnerSession(client);
    ownerSessions.add(session);
    looseClients.delete(client);
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return { session, pid };
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
    const registered = await controlPool.query<{ requests: string | null; scopes: string | null; targets: string | null }>(
      'SELECT to_regclass($1) AS requests, to_regclass($2) AS scopes, to_regclass($3) AS targets',
      [`${schema}.collaboration_admission_requests`, `${schema}.collaboration_admission_scopes`,
        `${schema}.collaboration_admission_targets`],
    );
    assert.equal(registered.rows[0]?.requests, `${schema}.collaboration_admission_requests`);
    assert.equal(registered.rows[0]?.scopes, `${schema}.collaboration_admission_scopes`);
    assert.equal(registered.rows[0]?.targets, `${schema}.collaboration_admission_targets`);

    const emptyDoc = new Y.Doc();
    const emptyUpdate = Buffer.from(Y.encodeStateAsUpdate(emptyDoc));
    const emptyVector = Buffer.from(Y.encodeStateVector(emptyDoc));
    emptyDoc.destroy();
    const seed = async (expected: CollaborationAdmissionDocument) => {
      await controlPool.query(
        `INSERT INTO ${stateTable} (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$10,0,NULL,NULL,'lf',0,0,$11)`,
        [expected.documentId, expected.workspaceId, expected.organizationId, expected.path,
          expected.representation, expected.lifecycleGeneration, expected.schemaVersion,
          emptyUpdate, emptyVector, Date.now(), expected.status],
      );
    };
    const readState = async (documentId: string): Promise<StateRow> => {
      const result = await controlPool.query<StateRow>(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const waitForBlock = async (waitingPid: number, blockingPid: number, message: string) => eventually(async () => {
      const result = await controlPool.query<{ blocking_pids: number[]; wait_event_type: string | null }>(
        `SELECT pg_blocking_pids($1::int) AS blocking_pids, wait_event_type
         FROM pg_stat_activity WHERE pid=$1`,
        [waitingPid],
      );
      const activity = result.rows[0];
      return activity?.blocking_pids.includes(blockingPid) ? activity : null;
    }, message);
    const fencedStore = async (fence: CollaborationRoomOwnerFence) => {
      const client = await createConnectedClient('final-store');
      const liveDocument = new Y.Doc();
      liveDocument.getText('content').insert(0, 'final-owner-state');
      const yjsState = Y.encodeStateAsUpdate(liveDocument);
      const stateVector = Y.encodeStateVector(liveDocument);
      const releaseId = randomUUID();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const row = (await client.query<StateRow>(
          'SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE',
          [fence.scope.documentId],
        )).rows[0];
        assert.ok(row);
        await assertCollaborationRoomOwnerFence({
          get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
        }, row, fence);
        await client.query(
          `UPDATE collaboration_yjs_states SET yjs_state=$2, state_vector=$3,
           document_sequence=document_sequence+1 WHERE document_id=$1`,
          [fence.scope.documentId, Buffer.from(yjsState), Buffer.from(stateVector)],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return Object.freeze({ releaseId, yjsState, stateVector });
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        liveDocument.destroy();
        await client.end();
        looseClients.delete(client);
      }
    };

    const ownerFirstDocument = document('owner-first', 'owner-first.md');
    const reservedClaimDocument = document('reserved-claim', 'reserved-claim.md');
    const staleDocument = document('stale-doc', 'stale.md');
    const immutableDocument = document('immutable-doc', 'immutable.md');
    const persistentDocument = document('persistent-doc', 'persistent.md');
    const phaseDocument = document('phase-doc', 'phase.md');
    const treeA = document('tree-a', 'tree/a.md');
    const treeB = document('tree-b', 'tree/deep/b.md');
    const archivedTree = document('tree-archived', 'tree/archived.md', { status: 'archived' });
    const rootA = document('root-a', 'root-a.md', {
      workspaceId: 'workspace-root', organizationId: 'organization-root',
    });
    const rootB = document('root-b', 'nested/root-b.md', {
      workspaceId: 'workspace-root', organizationId: 'organization-root',
    });
    const percentPath = document('percent-path', 'literal%/child.md', {
      workspaceId: 'workspace-pattern', organizationId: 'organization-pattern',
    });
    const underscorePath = document('underscore-path', 'literal_/child.md', {
      workspaceId: 'workspace-pattern', organizationId: 'organization-pattern',
    });
    const wildcardNeighbor = document('wildcard-neighbor', 'literalX/child.md', {
      workspaceId: 'workspace-pattern', organizationId: 'organization-pattern',
    });
    const segmentA = document('segment-a', 'a/child.md', {
      workspaceId: 'workspace-pattern', organizationId: 'organization-pattern',
    });
    const segmentAb = document('segment-ab', 'ab/child.md', {
      workspaceId: 'workspace-pattern', organizationId: 'organization-pattern',
    });
    for (const item of [ownerFirstDocument, reservedClaimDocument, staleDocument, immutableDocument,
      persistentDocument, phaseDocument, treeA, treeB, archivedTree, rootA, rootB, percentPath,
      underscorePath, wildcardNeighbor, segmentA, segmentAb]) await seed(item);

    const service = createService('main');
    const mainOwner = await createOwner('main');
    const ownerSession = mainOwner.session;

    // Claim first: hold its workspace guard+row transaction open and prove reserve waits behind that backend.
    const ownerScope: CollaborationRoomOwnerScope = { ...ownerFirstDocument };
    const claimCommitEntered = deferred(gates);
    const releaseClaimCommit = deferred(gates);
    const racingOwnerClient = await createConnectedClient('owner-claim-first');
    const racingOwnerPid = (await racingOwnerClient.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    )).rows[0]!.pid;
    let gateClaimCommit = true;
    const racingOwnerTransport = {
      query: async (sql: string, values?: unknown[]) => {
        if (gateClaimCommit && normalizedSql(sql) === 'COMMIT') {
          gateClaimCommit = false;
          claimCommitEntered.resolve();
          await releaseClaimCommit.promise;
        }
        return racingOwnerClient.query(sql, values);
      },
      on: racingOwnerClient.on.bind(racingOwnerClient),
      end: racingOwnerClient.end.bind(racingOwnerClient),
    } as Pick<Client, 'query' | 'on' | 'end'>;
    const racingOwner = await createCollaborationRoomOwnerSession(racingOwnerTransport);
    ownerSessions.add(racingOwner);
    looseClients.delete(racingOwnerClient);
    const ownerFencePromise = track(racingOwner.acquire(ownerScope));
    await within(claimCommitEntered.promise, OPERATION_TIMEOUT_MS, 'Claim-first owner did not reach its COMMIT gate.');
    const ownerRequest = request([scope(ownerFirstDocument.path)], [ownerFirstDocument]);
    let claimFirstReservePid = 0;
    const claimFirstFactory = async () => {
      const database = await openConnection('claim-first-reserve')();
      claimFirstReservePid = Number((await database.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
      return database;
    };
    const ownerReservationPromise = track(createService('claim-first-reserve', claimFirstFactory).reserve(ownerRequest));
    const observedClaimFirstReservePid = await eventually(async () => claimFirstReservePid > 0
      ? claimFirstReservePid : null, 'Claim-first reservation never opened its PostgreSQL backend.');
    const claimFirstBlocked = await waitForBlock(observedClaimFirstReservePid, racingOwnerPid,
      'Reservation did not wait for the claim-first workspace admission transaction.');
    assert.equal(claimFirstBlocked.wait_event_type, 'Lock');
    releaseClaimCommit.resolve();
    const ownerFence = await within(ownerFencePromise, OPERATION_TIMEOUT_MS, 'Claim-first owner did not commit.');
    const ownerReservation = await within(ownerReservationPromise, OPERATION_TIMEOUT_MS,
      'Owner-snapshot reservation timed out.');
    assert.equal(ownerReservation.status, 'reserved');
    assert.equal(ownerReservation.revision, 1);
    assert.equal(ownerReservation.targets.length, 1);
    assert.equal(ownerReservation.targets[0]?.ownerEpoch, ownerFence.epoch);
    assert.equal(ownerReservation.targets[0]?.ownerToken, ownerFence.token);
    assert.equal(ownerReservation.targets[0]?.ownerBackendPid, ownerFence.backendPid);
    assert.equal(ownerReservation.targets[0]?.ownerBackendStart, ownerFence.backendStart);
    racingOwner.assertActive(ownerFence);
    const finalSnapshot = await fencedStore(ownerFence);
    assert.equal(Number((await readState(ownerFirstDocument.documentId)).document_sequence), 1,
      'an admitted final fenced store remains possible while the reservation is active');
    await racingOwner.release(ownerFence, finalSnapshot);
    const releasedWhileReserved = await readState(ownerFirstDocument.documentId);
    assert.equal(Number(releasedWhileReserved.room_owner_epoch), ownerFence.epoch);
    assert.equal(releasedWhileReserved.room_owner_token, null,
      'owner release remains possible while the reservation is active');
    const releaseReceipt = await controlPool.query<{
      release_id: string;
      document_sequence: number | string;
      owner_token: string;
    }>(`SELECT release_id,document_sequence,owner_token
        FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`, [finalSnapshot.releaseId]);
    assert.deepEqual(releaseReceipt.rows[0], {
      release_id: finalSnapshot.releaseId,
      document_sequence: '1',
      owner_token: ownerFence.token,
    });
    const stillReservedTarget = await controlPool.query<{
      active: boolean;
      status: string;
      release_id: string | null;
    }>(`SELECT active,status,release_id FROM ${schemaSql}.collaboration_admission_targets
        WHERE request_id=$1 AND document_id=$2`, [ownerRequest.requestId, ownerFirstDocument.documentId]);
    assert.deepEqual(stillReservedTarget.rows[0], { active: true, status: 'reserved', release_id: null },
      'DA-01 owner release must not pretend that the later drain-target acknowledgement exists');
    await service.cancel(ownerRequest, ownerReservation.revision);

    // Reservation first: hold its transaction open and prove claim waits for the same workspace guard.
    const claimRequest = request([scope(reservedClaimDocument.path)], [reservedClaimDocument]);
    const reserveCommitEntered = deferred(gates);
    const releaseReserveCommit = deferred(gates);
    let reserveFirstPid = 0;
    const reserveFirstFactory = async () => {
      const database = await openConnection('reserve-first')();
      reserveFirstPid = Number((await database.get('SELECT pg_backend_pid() AS pid') as { pid: number }).pid);
      return {
        ...database,
        run: async (sql: string, params: unknown[] = []) => {
          if (normalizedSql(sql) === 'COMMIT') {
            reserveCommitEntered.resolve();
            await releaseReserveCommit.promise;
          }
          return database.run(sql, params);
        },
      };
    };
    const claimReservationPromise = track(createService('reserve-first', reserveFirstFactory).reserve(claimRequest));
    await within(reserveCommitEntered.promise, OPERATION_TIMEOUT_MS, 'Reserve-first transaction did not reach COMMIT.');
    const blockedClaimPromise = track(ownerSession.acquire({ ...reservedClaimDocument }));
    const reserveFirstBlocked = await waitForBlock(mainOwner.pid, reserveFirstPid,
      'Claim did not wait for the reserve-first workspace admission transaction.');
    assert.equal(reserveFirstBlocked.wait_event_type, 'Lock');
    releaseReserveCommit.resolve();
    const claimReservation = await within(claimReservationPromise, OPERATION_TIMEOUT_MS,
      'Reserve-first transaction did not commit.');
    await assert.rejects(blockedClaimPromise, ownerBusy);
    await ownerSession.probe();
    const claimRowBeforeCancel = await readState(reservedClaimDocument.documentId);
    assert.equal(Number(claimRowBeforeCancel.room_owner_epoch), 0,
      'a reservation-refused claim must not advance the owner epoch');
    const claimCancelled = await service.cancel(claimRequest, claimReservation.revision);
    assert.equal(claimCancelled.status, 'cancelled');
    assert.equal(claimCancelled.revision, claimReservation.revision + 1);
    const claimFence = await ownerSession.acquire({ ...reservedClaimDocument });
    assert.equal(claimFence.epoch, 1);
    await ownerSession.release(claimFence);

    // Empty destinations prove scope serialization independently from the active-target unique index.
    const overlapA = request([scope('empty-destination', 'subtree')], []);
    const overlapB = request([scope('empty-destination/child')], [], { actionDigest: 'b'.repeat(64) });
    const overlapResults = await Promise.allSettled([
      createService('overlap-a').reserve(overlapA),
      createService('overlap-b').reserve(overlapB),
    ]);
    const overlapSuccesses = overlapResults.filter((result) => result.status === 'fulfilled');
    const overlapFailures = overlapResults.filter((result) => result.status === 'rejected');
    assert.equal(overlapSuccesses.length, 1, 'exactly one overlapping empty-scope reservation must win');
    assert.equal(overlapFailures.length, 1, 'the other overlapping empty-scope reservation must fail');
    assert.ok(overlapFailures[0]?.status === 'rejected');
    admissionError('ADMISSION_CONFLICT')(overlapFailures[0].reason);
    const overlapWinnerRequest = overlapResults[0]?.status === 'fulfilled' ? overlapA : overlapB;
    const overlapWinner = overlapResults[0]?.status === 'fulfilled' ? overlapResults[0].value
      : overlapResults[1]?.status === 'fulfilled' ? overlapResults[1].value : undefined;
    assert.ok(overlapWinner);
    await service.cancel(overlapWinnerRequest, overlapWinner.revision);

    // Exact paths are segment-exact, not raw string prefixes; a subtree then conflicts with its child.
    const prefix = request([scope('prefix')], [], { actionDigest: 'c'.repeat(64) });
    const prefixChild = request([scope('prefix/child')], [], { actionDigest: 'd'.repeat(64) });
    const [prefixReservation, childReservation] = await Promise.all([
      service.reserve(prefix), service.reserve(prefixChild),
    ]);
    assert.equal(prefixReservation.status, 'reserved');
    assert.equal(childReservation.status, 'reserved');
    await service.cancel(prefix, prefixReservation.revision);
    await service.cancel(prefixChild, childReservation.revision);
    const subtree = request([scope('prefix', 'subtree')], [], { actionDigest: 'e'.repeat(64) });
    const subtreeReservation = await service.reserve(subtree);
    await assert.rejects(
      service.reserve(request([scope('prefix/absent')], [], { actionDigest: 'f'.repeat(64) })),
      admissionError('ADMISSION_CONFLICT'),
    );
    const disjoint = request([scope('prefix-other')], [], { actionDigest: '0'.repeat(64) });
    const disjointReservation = await service.reserve(disjoint);
    await service.cancel(disjoint, disjointReservation.revision);
    await service.cancel(subtree, subtreeReservation.revision);

    // SQL path matching treats root, wildcard characters, and segment prefixes literally.
    const rootRequest = request([scope('', 'subtree', {
      workspaceId: rootA.workspaceId,
      organizationId: rootA.organizationId,
    })], [rootB, rootA], { actionDigest: '5'.repeat(64) });
    const rootReservation = await service.reserve(rootRequest);
    assert.deepEqual(rootReservation.targets.map((target) => target.document.documentId),
      [rootA.documentId, rootB.documentId].sort());
    await service.cancel(rootRequest, rootReservation.revision);
    for (const [pathPrefix, expected, digest] of [
      ['literal%', percentPath, '6'.repeat(64)],
      ['literal_', underscorePath, '7'.repeat(64)],
      ['a', segmentA, '8'.repeat(64)],
    ] as const) {
      const literalRequest = request([scope(pathPrefix, 'subtree', {
        workspaceId: expected.workspaceId,
        organizationId: expected.organizationId,
      })], [expected], { actionDigest: digest });
      const literalReservation = await service.reserve(literalRequest);
      assert.deepEqual(literalReservation.targets.map((target) => target.document.documentId), [expected.documentId]);
      await service.cancel(literalRequest, literalReservation.revision);
    }
    assert.equal(wildcardNeighbor.path, 'literalX/child.md');
    assert.equal(segmentAb.path, 'ab/child.md');

    // A subtree captures every active document plus explicitly supplied archived members.
    const treeRequest = request([scope('tree', 'subtree')], [treeB, archivedTree, treeA]);
    const treeReservation = await service.reserve(treeRequest);
    assert.deepEqual(treeReservation.targets.map((target) => target.document.documentId),
      [treeA.documentId, treeB.documentId, archivedTree.documentId].sort());
    await service.cancel(treeRequest, treeReservation.revision);
    await assert.rejects(
      service.reserve(request([scope('tree', 'subtree')], [treeA, treeB,
        { ...archivedTree, lifecycleGeneration: 2 }], { actionDigest: '9'.repeat(64) })),
      admissionError('ADMISSION_SCOPE_CHANGED'),
    );
    await assert.rejects(
      service.reserve(request([scope('tree', 'subtree')], [treeA, archivedTree], { actionDigest: '1'.repeat(64) })),
      admissionError('ADMISSION_SCOPE_CHANGED'),
    );

    // Every exact identity component is compared with the state row.
    const staleCases: CollaborationAdmissionDocument[] = [
      { ...staleDocument, workspaceId: 'workspace-other' },
      { ...staleDocument, organizationId: 'organization-other' },
      { ...staleDocument, path: 'stale-other.md' },
      { ...staleDocument, representation: 'tiptap_xml' },
      { ...staleDocument, lifecycleGeneration: 2 },
      { ...staleDocument, schemaVersion: 2 },
      { ...staleDocument, status: 'archived' },
    ];
    for (const [index, stale] of staleCases.entries()) {
      const staleScope = scope(stale.path, 'exact', {
        workspaceId: stale.workspaceId,
        organizationId: stale.organizationId,
      });
      await assert.rejects(
        service.reserve(request([staleScope], [stale], { actionDigest: index.toString(16).repeat(64) })),
        admissionError('ADMISSION_SCOPE_CHANGED'),
      );
    }

    // Caller-owned arrays/objects are copied before openConnection can resolve.
    let releaseImmutableOpen!: () => void;
    const immutableOpenGate = new Promise<void>((resolve) => { releaseImmutableOpen = resolve; });
    const immutableBaseFactory = openConnection('immutable');
    const immutableFactory = async () => {
      await immutableOpenGate;
      return immutableBaseFactory();
    };
    const mutableScopes = [scope(immutableDocument.path)];
    const mutableDocuments = [{ ...immutableDocument }];
    const immutableRequest = request(mutableScopes, mutableDocuments);
    const capturedImmutable = captureCollaborationAdmissionRequest(immutableRequest);
    const immutablePromise = createService('immutable', immutableFactory).reserve(immutableRequest);
    (mutableScopes[0] as { path: string }).path = 'mutated-after-call.md';
    (mutableDocuments[0] as { path: string }).path = 'mutated-after-call.md';
    (immutableRequest as { actorId: string }).actorId = 'mutated-actor';
    releaseImmutableOpen();
    const immutableReservation = await immutablePromise;
    assert.equal(immutableReservation.requestDigest, capturedImmutable.requestDigest);
    assert.equal(immutableReservation.targets[0]?.document.path, immutableDocument.path);
    await service.cancel(capturedImmutable.request, immutableReservation.revision);

    // The same request is idempotent; changing any bound intent under its ID is rejected.
    const persistentRequest = request([scope(persistentDocument.path)], [persistentDocument]);
    const persistentReservation = await service.reserve(persistentRequest);
    const retryReservation = await service.reserve(persistentRequest);
    assert.deepEqual(retryReservation, persistentReservation);
    for (const changed of [
      { ...persistentRequest, actorId: 'actor-other' },
      { ...persistentRequest, actionDigest: '2'.repeat(64) },
      { ...persistentRequest, scopes: [scope(persistentDocument.path, 'subtree')] },
    ]) {
      await assert.rejects(service.reserve(changed), admissionError('ADMISSION_REQUEST_CHANGED'));
    }
    const restartedService = createService('restarted');
    assert.deepEqual(await restartedService.read(persistentRequest), persistentReservation,
      'a fresh service instance must read the stored reservation');
    await service.cancel(persistentRequest, persistentReservation.revision);

    // A rejected COMMIT leaves no durable request; recovery observes absence instead of guessing success.
    const rejectedCommitRequest = request([scope('rejected-commit-empty')], [], {
      actionDigest: 'b'.repeat(64),
    });
    let rejectedCommitOpens = 0;
    const rejectedCommitFactory = async (): Promise<SqlConnection> => {
      rejectedCommitOpens += 1;
      const database = await openConnection(`rejected-commit-${rejectedCommitOpens}`)();
      if (rejectedCommitOpens > 1) return database;
      return {
        ...database,
        run: async (sql, params = []) => {
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected rejected reserve COMMIT.');
          return database.run(sql, params);
        },
      };
    };
    await assert.rejects(
      createService('rejected-commit', rejectedCommitFactory).reserve(rejectedCommitRequest),
      admissionError('ADMISSION_RECOVERY_REQUIRED'),
    );
    assert.ok(rejectedCommitOpens >= 2);
    assert.equal(await service.read(rejectedCommitRequest), null);
    const retriedRejectedCommit = await service.reserve(rejectedCommitRequest);
    assert.equal(retriedRejectedCommit.status, 'reserved',
      'the identical request can proceed after absence is positively established');
    const retriedRejectedCancel = await service.cancel(rejectedCommitRequest, retriedRejectedCommit.revision);
    assert.equal(retriedRejectedCancel.status, 'cancelled');

    // Even a durably committed row is not recovered when discarding the uncertain backend itself fails.
    const discardFailureRequest = request([scope('discard-failure-empty')], [], {
      actionDigest: 'c'.repeat(64),
    });
    let discardFailureOpens = 0;
    const discardFailureFactory = async (): Promise<SqlConnection> => {
      discardFailureOpens += 1;
      const database = await openConnection('discard-failure')();
      return {
        ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost COMMIT reply before discard failure.');
          return result;
        },
        close: async (error) => {
          await database.close(error);
          if (error) throw new Error('Injected connection discard failure.');
        },
      };
    };
    await assert.rejects(
      createService('discard-failure', discardFailureFactory).reserve(discardFailureRequest),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        return true;
      },
    );
    assert.equal(discardFailureOpens, 1, 'failed discard must prevent a fresh recovery read');
    const discardFailureStored = await service.read(discardFailureRequest);
    assert.equal(discardFailureStored?.status, 'reserved');
    await service.cancel(discardFailureRequest, discardFailureStored!.revision);

    // Lost reserve COMMIT reply: discard the old backend before exact durable recovery.
    const lostReserveDocument = document('lost-reserve', 'lost-reserve.md');
    await seed(lostReserveDocument);
    const lostReserveRequest = request([scope(lostReserveDocument.path)], [lostReserveDocument], {
      actionDigest: '3'.repeat(64),
    });
    const lostReserveClose: CloseObservation = { closeCalls: 0, closeErrors: 0, closed: false };
    let lostReserveOpens = 0;
    const lostReserveNormal = openConnection('lost-reserve', lostReserveClose);
    const lostReserveFactory = async (): Promise<SqlConnection> => {
      lostReserveOpens += 1;
      if (lostReserveOpens > 1) {
        assert.equal(lostReserveClose.closed, true, 'recovery must start after the uncertain backend ended');
        return openConnection('lost-reserve-recovery')();
      }
      const database = await lostReserveNormal();
      return {
        ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost reserve COMMIT reply.');
          return result;
        },
      };
    };
    const lostReserveService = createService('lost-reserve', lostReserveFactory);
    const lostReserveResult = await lostReserveService.reserve(lostReserveRequest);
    assert.equal(lostReserveResult.status, 'reserved');
    assert.equal(lostReserveClose.closeCalls, 1);
    assert.equal(lostReserveClose.closeErrors, 1);
    assert.ok(lostReserveOpens >= 2, 'lost reserve acknowledgement must use a fresh proof connection');

    // Lost cancel COMMIT reply is recovered as the exact revision+1 cancelled row.
    const lostCancelClose: CloseObservation = { closeCalls: 0, closeErrors: 0, closed: false };
    let lostCancelOpens = 0;
    const lostCancelNormal = openConnection('lost-cancel', lostCancelClose);
    const lostCancelFactory = async (): Promise<SqlConnection> => {
      lostCancelOpens += 1;
      if (lostCancelOpens > 1) {
        assert.equal(lostCancelClose.closed, true, 'cancel recovery must start after the uncertain backend ended');
        return openConnection('lost-cancel-recovery')();
      }
      const database = await lostCancelNormal();
      return {
        ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost cancel COMMIT reply.');
          return result;
        },
      };
    };
    const lostCancelService = createService('lost-cancel', lostCancelFactory);
    const lostCancelResult = await lostCancelService.cancel(lostReserveRequest, lostReserveResult.revision);
    assert.equal(lostCancelResult.status, 'cancelled');
    assert.equal(lostCancelResult.revision, lostReserveResult.revision + 1);
    assert.equal(lostCancelClose.closeCalls, 1);
    assert.equal(lostCancelClose.closeErrors, 1);
    assert.ok(lostCancelOpens >= 2, 'lost cancel acknowledgement must use a fresh proof connection');
    assert.deepEqual(await service.cancel(lostReserveRequest, lostReserveResult.revision), lostCancelResult,
      'the original cancel retry remains idempotent after revision advanced');
    await assert.rejects(service.cancel(lostReserveRequest, lostCancelResult.revision),
      admissionError('ADMISSION_STATE_CHANGED'));

    // A target already entering its drain phase cannot be cancelled or silently deactivated.
    const phaseRequest = request([scope(phaseDocument.path)], [phaseDocument], { actionDigest: '4'.repeat(64) });
    const phaseReservation = await service.reserve(phaseRequest);
    await controlPool.query(
      `UPDATE ${schemaSql}.collaboration_admission_targets
       SET status='draining' WHERE request_id=$1 AND document_id=$2`,
      [phaseRequest.requestId, phaseDocument.documentId],
    );
    await assert.rejects(service.cancel(phaseRequest, phaseReservation.revision),
      admissionError('ADMISSION_STATE_CHANGED'));
    const phaseTarget = await controlPool.query<{ active: boolean; status: string }>(
      `SELECT active,status FROM ${schemaSql}.collaboration_admission_targets
       WHERE request_id=$1 AND document_id=$2`,
      [phaseRequest.requestId, phaseDocument.documentId],
    );
    assert.deepEqual(phaseTarget.rows[0], { active: true, status: 'draining' });

    assert.equal(backgroundErrors.length, 0, 'test pools must not emit background connection errors');
    console.log(
      'Collaboration admission PostgreSQL: owner snapshot, claim/reservation ordering, empty-scope overlap, '
      + 'exact/subtree boundaries, full identity drift, immutable capture, idempotence, service restart, '
      + 'target-phase cancel fencing, and committed-but-unacknowledged reserve/cancel recovery passed in '
      + 'an isolated generated schema. This is distinct-backend evidence, not a two-OS-process test.',
    );
  } finally {
    for (const gate of [...gates]) gate.resolve();
    if (pendingOperations.size > 0) {
      try {
        await within(Promise.allSettled([...pendingOperations]), CLEANUP_TIMEOUT_MS,
          'Timed out releasing pending admission operations during cleanup.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const session of ownerSessions) {
      try {
        await within(session.close(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission owner session.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const client of [...looseClients]) {
      try {
        await within(client.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission test client.');
        looseClients.delete(client);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (schemaCreated && looseClients.size === 0) {
      try {
        assertGeneratedSchema(schema);
        await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining the admission control pool.');
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Admission PostgreSQL cleanup failed.');
    }
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration admission PostgreSQL test skipped: guarded managed database environment is not configured.');
} else {
  run(databaseUrl).catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
