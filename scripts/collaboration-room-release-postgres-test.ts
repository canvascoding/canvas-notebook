import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import * as Y from 'yjs';

import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';
import {
  CollaborationRoomOwnerError,
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';
import {
  CollaborationRoomReleaseError,
  recoverCollaborationRoomRelease,
  type CollaborationRoomReleaseReceipt,
  type CollaborationRoomReleaseSnapshot,
} from '../app/lib/collaboration/room-owner-release';

const SCHEMA_PREFIX = 'canvas_room_release_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type OwnerSession = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;

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
    throw new Error('Room-release PostgreSQL test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error('Room-release PostgreSQL test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) {
    throw new Error('Refusing SQL outside the generated room-release test namespace.');
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
    const value = await probe();
    if (value !== null) return value;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(message);
}

function createDocument(content: string): Y.Doc {
  const document = new Y.Doc({ gc: true });
  document.getText('content').insert(0, content);
  return document;
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, Y.encodeStateAsUpdate(source));
  return document;
}

function textFromUpdate(update: Uint8Array): string {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, update);
    return document.getText('content').toString();
  } finally {
    document.destroy();
  }
}

function snapshot(document: Y.Doc, releaseId = randomUUID()): CollaborationRoomReleaseSnapshot {
  return Object.freeze({
    releaseId,
    yjsState: Y.encodeStateAsUpdate(document),
    stateVector: Y.encodeStateVector(document),
  });
}

function releaseError(error: unknown): boolean {
  assert.ok(error instanceof CollaborationRoomReleaseError);
  assert.equal(error.code, 'ROOM_RELEASE_UNPROVEN');
  return true;
}

function ownerUnavailable(error: unknown): boolean {
  assert.ok(error instanceof CollaborationRoomOwnerError);
  assert.ok(error.code === 'ROOM_OWNER_UNAVAILABLE' || error.code === 'ROOM_OWNER_LOST');
  return true;
}

function sanitizeError(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; name?: unknown }
    : {};
  const name = typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(candidate.name)
    ? candidate.name
    : 'Error';
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(candidate.code)
    ? ` [${candidate.code}]`
    : '';
  const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown test failure.';
  return `${name}${code}: ${message}`
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
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
    throw new Error('Room-release PostgreSQL test refused a server outside managed PG18.');
  }
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const receiptTable = `${schemaSql}.collaboration_room_release_receipts`;
  const sessions = new Set<OwnerSession>();
  const looseClients = new Set<Client>();
  const documents: Y.Doc[] = [];
  const cleanupErrors: unknown[] = [];
  const own = <T extends Y.Doc>(document: T): T => {
    documents.push(document);
    return document;
  };

  const controlPool = new Pool({
    ...poolConfig(databaseUrl, 'canvas-room-release-test-control'),
    max: 3,
  });
  const backgroundErrors: Error[] = [];
  controlPool.on('error', (error) => { backgroundErrors.push(error); });
  let schemaCreated = false;

  const clientConfig = (label: string) => ({
    ...poolConfig(databaseUrl, `canvas-room-release-test-${label}`, schema),
  });
  const createConnectedClient = async (label: string): Promise<Client> => {
    const client = new Client(clientConfig(label));
    looseClients.add(client);
    await client.connect();
    return client;
  };
  const createOwner = async (label: string, onInvalidated?: () => void) => {
    const client = await createConnectedClient(label);
    const session = await createCollaborationRoomOwnerSession(client, onInvalidated);
    sessions.add(session);
    looseClients.delete(client);
    return { client, session };
  };
  const createRecoveryClient = async (label: string) => {
    const client = await createConnectedClient(label);
    looseClients.delete(client);
    return client;
  };

  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(`CREATE TABLE ${stateTable} (LIKE public.collaboration_yjs_states INCLUDING ALL)`);

    const migrationClient = await createConnectedClient('migration');
    assert.equal((await migrationClient.query<{ search_path: string }>('SHOW search_path')).rows[0]?.search_path, schema);
    for (let migrationPass = 0; migrationPass < 2; migrationPass++) {
      await migrationClient.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migrationClient.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
    }
    await migrationClient.end();
    looseClients.delete(migrationClient);
    const receiptRegistration = await controlPool.query<{ receipt_table: string | null }>(
      'SELECT to_regclass($1) AS receipt_table',
      [`${schema}.collaboration_room_release_receipts`],
    );
    assert.equal(receiptRegistration.rows[0]?.receipt_table, `${schema}.collaboration_room_release_receipts`);

    const identity = {
      workspaceId: 'workspace',
      organizationId: 'organization',
      representation: 'plain_text' as const,
      lifecycleGeneration: 1,
      schemaVersion: 1,
    };
    const scope = (
      documentId: string,
      overrides: Partial<CollaborationRoomOwnerScope> = {},
    ): CollaborationRoomOwnerScope => ({
      documentId,
      workspaceId: identity.workspaceId,
      organizationId: identity.organizationId,
      path: `${documentId}.md`,
      representation: identity.representation,
      lifecycleGeneration: identity.lifecycleGeneration,
      schemaVersion: identity.schemaVersion,
      ...overrides,
    });
    const seed = async (documentId: string, document: Y.Doc) => {
      const now = 1_700_000_000_000;
      await controlPool.query(
        `INSERT INTO ${stateTable} (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
        ) VALUES ($1,$2,$3,$4,$5,1,1,$6,$7,0,$8,$8,0,NULL,NULL,'lf',0,0,'active')`,
        [documentId, identity.workspaceId, identity.organizationId, `${documentId}.md`, identity.representation,
          Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document)), now],
      );
    };
    const readState = async (documentId: string): Promise<StateRow> => {
      const result = await controlPool.query<StateRow>(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const readReceipts = async (documentId: string): Promise<CollaborationRoomReleaseReceipt[]> => (
      await controlPool.query<CollaborationRoomReleaseReceipt>(
        `SELECT * FROM ${receiptTable} WHERE document_id=$1 ORDER BY owner_epoch`,
        [documentId],
      )
    ).rows;
    const expectInvalidated = async (session: OwnerSession, fence: CollaborationRoomOwnerFence, count: () => number) => {
      await eventually(async () => count() === 1 ? true : null, 'Failed release did not invalidate its owner session.');
      assert.throws(() => session.assertActive(fence), ownerUnavailable);
      await assert.rejects(session.probe(), ownerUnavailable);
    };

    const happyBase = own(createDocument('ABC'));
    const happyLive = own(cloneDocument(happyBase));
    happyLive.getText('content').delete(1, 1);
    assert.deepEqual(Y.encodeStateVector(happyLive), Y.encodeStateVector(happyBase),
      'deletion-only live fixture must retain its state vector');
    const happyPersisted = own(cloneDocument(happyLive));
    happyPersisted.getText('content').insert(happyPersisted.getText('content').length, 'D');
    await seed('happy-superset-delete', happyPersisted);
    const happyOwner = await createOwner('happy');
    const happyFence = await happyOwner.session.acquire(scope('happy-superset-delete'));
    const happySnapshot = snapshot(happyLive);
    await happyOwner.session.release(happyFence, happySnapshot);
    const happyRow = await readState('happy-superset-delete');
    assert.equal(textFromUpdate(happyRow.yjs_state), 'ACD');
    assert.equal(happyRow.room_owner_token, null);
    assert.equal(happyRow.room_owner_backend_pid, null);
    assert.equal(happyRow.room_owner_backend_start, null);
    const happyReceipts = await readReceipts('happy-superset-delete');
    assert.equal(happyReceipts.length, 1);
    assert.equal(happyReceipts[0]?.release_id, happySnapshot.releaseId);
    assert.equal(Number(happyReceipts[0]?.owner_epoch), happyFence.epoch);
    assert.equal(Number(happyReceipts[0]?.document_sequence), 0);
    for (const hash of [happyReceipts[0]?.persisted_update_hash, happyReceipts[0]?.persisted_vector_hash,
      happyReceipts[0]?.live_update_hash, happyReceipts[0]?.live_vector_hash]) {
      assert.match(hash ?? '', /^[0-9a-f]{64}$/u);
    }
    console.log('PASS release receipt atomically clears the exact owner for persisted superset plus live deletion');

    const ordinaryDoc = own(createDocument('ordinary'));
    await seed('ordinary-release', ordinaryDoc);
    const ordinaryFence = await happyOwner.session.acquire(scope('ordinary-release'));
    await happyOwner.session.release(ordinaryFence);
    assert.equal((await readState('ordinary-release')).room_owner_token, null);
    assert.equal((await readReceipts('ordinary-release')).length, 0);
    console.log('PASS ordinary release remains explicitly unproven and creates no receipt');

    const invalidCases: Array<{
      documentId: string;
      persisted: Y.Doc;
      live: Y.Doc;
      vector?: Uint8Array;
      mutateRow?: () => Promise<void>;
    }> = [];
    const unsavedInsertBase = own(createDocument('insert-base'));
    const unsavedInsertLive = own(cloneDocument(unsavedInsertBase));
    unsavedInsertLive.getText('content').insert(unsavedInsertLive.getText('content').length, '-unsaved');
    invalidCases.push({ documentId: 'unsaved-insert', persisted: unsavedInsertBase, live: unsavedInsertLive });
    const unsavedDeleteBase = own(createDocument('DELETE'));
    const unsavedDeleteLive = own(cloneDocument(unsavedDeleteBase));
    unsavedDeleteLive.getText('content').delete(1, 2);
    invalidCases.push({ documentId: 'unsaved-delete', persisted: unsavedDeleteBase, live: unsavedDeleteLive });
    const wrongVectorDoc = own(createDocument('wrong-vector'));
    const unrelatedVectorDoc = own(createDocument('unrelated-vector'));
    invalidCases.push({
      documentId: 'wrong-vector', persisted: wrongVectorDoc, live: wrongVectorDoc,
      vector: Y.encodeStateVector(unrelatedVectorDoc),
    });
    const scopeDoc = own(createDocument('scope'));
    invalidCases.push({
      documentId: 'scope-drift', persisted: scopeDoc, live: scopeDoc,
      mutateRow: async () => {
        await controlPool.query(`UPDATE ${stateTable} SET path='renamed.md' WHERE document_id='scope-drift'`);
      },
    });

    for (const testCase of invalidCases) {
      await seed(testCase.documentId, testCase.persisted);
      let invalidations = 0;
      const owner = await createOwner(`invalid-${testCase.documentId}`, () => { invalidations++ });
      const fence = await owner.session.acquire(scope(testCase.documentId));
      await testCase.mutateRow?.();
      const captured = snapshot(testCase.live);
      const releaseSnapshot: CollaborationRoomReleaseSnapshot = testCase.vector
        ? Object.freeze({ ...captured, stateVector: new Uint8Array(testCase.vector) })
        : captured;
      await assert.rejects(
        owner.session.release(fence, releaseSnapshot),
        (error) => testCase.documentId === 'scope-drift' ? ownerUnavailable(error) : releaseError(error),
      );
      await expectInvalidated(owner.session, fence, () => invalidations);
      const row = await readState(testCase.documentId);
      assert.equal(row.room_owner_token, fence.token,
        `${testCase.documentId} must not clear the owner without a durable proof`);
      assert.equal((await readReceipts(testCase.documentId)).length, 0,
        `${testCase.documentId} must not create a false receipt`);
    }
    console.log('PASS unsaved insert/delete, wrong vector, and scope drift invalidate without false receipts');

    const lostAckBase = own(createDocument('lost-ack-base'));
    const lostAckLive = own(cloneDocument(lostAckBase));
    lostAckLive.getText('content').insert(lostAckLive.getText('content').length, '-live');
    const lostAckPersisted = own(cloneDocument(lostAckLive));
    lostAckPersisted.getText('content').insert(lostAckPersisted.getText('content').length, '-persisted');
    await seed('lost-ack', lostAckPersisted);
    const lostAckClient = await createConnectedClient('lost-ack');
    let lostAckCommits = 0;
    let reportLostAckEnd!: () => void;
    let allowLostAckEnd!: () => void;
    const lostAckEndStarted = new Promise<void>((resolve) => { reportLostAckEnd = resolve; });
    const lostAckEndAllowed = new Promise<void>((resolve) => { allowLostAckEnd = resolve; });
    let lostAckEndCompleted = false;
    const lostAckTransport = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await lostAckClient.query(sql, values);
        if (normalizedSql(sql) === 'COMMIT' && ++lostAckCommits === 2) {
          throw new Error('synthetic lost release COMMIT reply');
        }
        return result;
      },
      on: lostAckClient.on.bind(lostAckClient),
      end: async () => {
        reportLostAckEnd();
        await lostAckEndAllowed;
        await lostAckClient.end();
        lostAckEndCompleted = true;
      },
    } as unknown as Pick<Client, 'query' | 'on' | 'end'>;
    const lostAckSession = await createCollaborationRoomOwnerSession(lostAckTransport);
    sessions.add(lostAckSession);
    looseClients.delete(lostAckClient);
    const lostAckFence = await lostAckSession.acquire(scope('lost-ack'));
    const lostAckSnapshot = snapshot(lostAckLive);
    const lostAckRelease = lostAckSession.release(lostAckFence, lostAckSnapshot);
    let lostAckReleaseSettled = false;
    void lostAckRelease.finally(() => { lostAckReleaseSettled = true; }).catch(() => undefined);
    await within(lostAckEndStarted, 4_000, 'Lost-ack release did not begin ending its dedicated backend.');
    await Promise.resolve();
    assert.equal(lostAckReleaseSettled, false,
      'release must not reject until the old advisory-lock backend has ended');
    allowLostAckEnd();
    await assert.rejects(lostAckRelease, ownerUnavailable);
    assert.equal(lostAckEndCompleted, true,
      'release rejection must itself confirm the old backend ended before recovery starts');
    const recovered = await recoverCollaborationRoomRelease({
      createClient: () => createRecoveryClient('lost-ack-recovery'),
      fence: lostAckFence,
      snapshot: lostAckSnapshot,
    });
    assert.equal(recovered.release_id, lostAckSnapshot.releaseId);
    assert.equal(recovered.document_id, 'lost-ack');
    assert.equal(recovered.owner_epoch, lostAckFence.epoch);
    assert.equal((await readState('lost-ack')).room_owner_token, null);
    assert.equal((await readReceipts('lost-ack')).length, 1);
    console.log('PASS committed release with lost acknowledgement is recovered from exact durable receipt');

    const replacementOwner = await createOwner('lost-ack-replacement');
    const replacementFence = await replacementOwner.session.acquire(scope('lost-ack'));
    assert.equal(replacementFence.epoch, lostAckFence.epoch + 1);
    await assert.rejects(recoverCollaborationRoomRelease({
      createClient: () => createRecoveryClient('lost-ack-recovery-blocked'),
      fence: lostAckFence,
      snapshot: lostAckSnapshot,
    }), releaseError);
    await replacementOwner.session.release(replacementFence);
    console.log('PASS a new owner makes old release recovery fail without waiting or replaying');

    const rejectedCommitDoc = own(createDocument('rejected-commit'));
    await seed('rejected-commit', rejectedCommitDoc);
    const rejectedCommitClient = await createConnectedClient('rejected-commit');
    let rejectedCommits = 0;
    const rejectedCommitTransport = {
      query: async (sql: string, values?: unknown[]) => {
        if (normalizedSql(sql) === 'COMMIT' && ++rejectedCommits === 2) {
          throw new Error('synthetic rejected release COMMIT');
        }
        return rejectedCommitClient.query(sql, values);
      },
      on: rejectedCommitClient.on.bind(rejectedCommitClient),
      end: rejectedCommitClient.end.bind(rejectedCommitClient),
    } as unknown as Pick<Client, 'query' | 'on' | 'end'>;
    const rejectedCommitSession = await createCollaborationRoomOwnerSession(rejectedCommitTransport);
    sessions.add(rejectedCommitSession);
    looseClients.delete(rejectedCommitClient);
    const rejectedCommitFence = await rejectedCommitSession.acquire(scope('rejected-commit'));
    const rejectedCommitSnapshot = snapshot(rejectedCommitDoc);
    await assert.rejects(
      rejectedCommitSession.release(rejectedCommitFence, rejectedCommitSnapshot),
      ownerUnavailable,
    );
    await rejectedCommitSession.close();
    assert.equal((await readReceipts('rejected-commit')).length, 0);
    assert.equal((await readState('rejected-commit')).room_owner_token, rejectedCommitFence.token);
    await assert.rejects(recoverCollaborationRoomRelease({
      createClient: () => createRecoveryClient('rejected-commit-recovery'),
      fence: rejectedCommitFence,
      snapshot: rejectedCommitSnapshot,
    }), releaseError);
    console.log('PASS rejected release COMMIT has no receipt and cannot be recovered');

    assert.equal(backgroundErrors.length, 0, 'test pools must not emit background connection errors');
    console.log('Collaboration room release PostgreSQL passed in an isolated generated schema.');
  } finally {
    for (const session of sessions) {
      try {
        await within(session.close(), CLEANUP_TIMEOUT_MS, 'Timed out closing a room-release owner session.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const client of looseClients) {
      try {
        await within(client.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing a loose room-release client.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const document of documents) document.destroy();
    if (schemaCreated) {
      try {
        assertGeneratedSchema(schema);
        await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining the room-release control pool.');
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Room-release PostgreSQL cleanup failed.');
  }
}

async function main(): Promise<void> {
  const databaseUrl = guardedDatabaseUrl();
  if (!databaseUrl) {
    console.log('collaboration-room-release-postgres-test: skipped (managed PostgreSQL profile is not enabled)');
    return;
  }
  await run(databaseUrl);
}

void main().catch((error) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
