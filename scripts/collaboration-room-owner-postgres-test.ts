import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import type {
  CollaborationPersistenceIdentity,
  CollaborationPersistenceResult,
} from '../app/lib/collaboration/persistence';
import { COLLABORATION_ROOM_OWNER_UP_SQL } from '../app/lib/db/collaboration-room-owner-migration';
import { mergeCollaborationPersistenceUpdates } from '../app/lib/collaboration/persistence-merge';
import {
  assertCollaborationRoomOwnerFence,
  CollaborationRoomOwnerError,
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';

const SCHEMA_PREFIX = 'canvas_room_owner_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const BARRIER_TIMEOUT_MS = 4_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
};

type OwnerSession = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;

type PersistenceModule = {
  persistCollaborationYDoc: (
    documentId: string,
    expectedLifecycleGeneration: number,
    doc: Y.Doc,
    expectedIdentity?: CollaborationPersistenceIdentity,
    ownerFence?: CollaborationRoomOwnerFence,
  ) => Promise<CollaborationPersistenceResult>;
};

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

type WriteHooks = {
  afterFence?: (backendPid: number) => Promise<void>;
};

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('Room-owner PostgreSQL test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error('Room-owner PostgreSQL test only accepts the managed loopback database at port 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) {
    throw new Error('Refusing SQL for a schema outside the generated room-owner test namespace.');
  }
}

function schemaIdentifier(schema: string): string {
  assertGeneratedSchema(schema);
  return `"${schema}"`;
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
}

async function loadPersistence(openDb: () => Promise<SqlConnection>): Promise<PersistenceModule> {
  const filename = path.resolve('app/lib/collaboration/persistence.ts');
  const runtimeRequire = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  const mocks: Record<string, unknown> = {
    'server-only': {},
    '@/app/lib/db': { openDb },
    '@/app/lib/files/workspace-mutation-lock': {},
    '@/app/lib/files/collaboration-repository': {},
    '@/app/lib/markdown/obsidian-metadata': {},
    '@/app/lib/markdown/rich-markdown-codec': {},
    './types': {},
    './markdown-state': {},
    './runtime-state': {},
    './server-runtime': { Y },
    './persistence-merge': { mergeCollaborationPersistenceUpdates },
    './room-owner': { assertCollaborationRoomOwnerFence },
  };
  const localRequire = (name: string) => Object.prototype.hasOwnProperty.call(mocks, name)
    ? mocks[name]
    : runtimeRequire(name);
  new Function('require', 'module', 'exports', source)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports as PersistenceModule;
}

function persistenceOpenDb(pool: Pool): () => Promise<SqlConnection> {
  return async () => {
    const client = await pool.connect();
    let closed = false;
    return {
      get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await client.query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
      close: (error) => {
        assert.equal(closed, false, 'a production persistence connection must only be released once');
        closed = true;
        client.release(error);
      },
    };
  };
}

function deferred(gates: Set<Gate>): Gate {
  let settled = false;
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => { complete = resolve; });
  const gate = {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      gates.delete(gate);
      complete();
    },
  };
  gates.add(gate);
  return gate;
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
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(message);
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

async function verifyManagedPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{
    database_name: string;
    server_version_num: string;
    source_table_exists: boolean;
  }>(`SELECT current_database() AS database_name,
      current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS source_table_exists`);
  const row = result.rows[0];
  if (!row
    || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18
    || row.source_table_exists !== true) {
    throw new Error('Room-owner PostgreSQL test refused a server outside the managed PG18 Notebook profile.');
  }
}

function ownerError(...codes: CollaborationRoomOwnerError['code'][]) {
  return (error: unknown) => {
    assert.ok(error instanceof CollaborationRoomOwnerError);
    assert.ok(codes.includes(error.code), `expected ${codes.join(' or ')}, received ${error.code}`);
    return true;
  };
}

function sqlConnection(client: Pick<PoolClient, 'query'>): Pick<SqlConnection, 'get'> {
  return {
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
  };
}

function textFromUpdate(update: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

function sanitizeError(error: unknown): string {
  const candidate = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
  const name = typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(candidate.name)
    ? candidate.name
    : 'Error';
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(candidate.code)
    ? ` [${candidate.code}]`
    : '';
  const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown test failure.';
  return `${name}${code}: ${message
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]')}`;
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const tableSql = `${schemaSql}.collaboration_yjs_states`;
  const gates = new Set<Gate>();
  const operations = new Set<Promise<unknown>>();
  const sessions = new Set<OwnerSession>();
  const looseClients = new Set<Client>();
  const cleanupErrors: unknown[] = [];
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };

  const controlPool = new Pool({
    ...poolConfig(databaseUrl, 'canvas-room-owner-test-control'),
    max: 3,
  });
  const backgroundErrors: Error[] = [];
  controlPool.on('error', (error) => { backgroundErrors.push(error); });
  let writerPool: Pool | undefined;
  let schemaCreated = false;
  let writerPoolDrained = false;

  const ownerClientConfig = (label: string) => ({
    ...poolConfig(databaseUrl, `canvas-room-owner-test-${label}`, schema),
  });
  const createOwner = async (label: string, onInvalidated?: () => void) => {
    const client = new Client(ownerClientConfig(label));
    looseClients.add(client);
    await client.connect();
    const identity = (await client.query<{ pid: number; started: string }>(
      `SELECT pg_backend_pid() AS pid, extract(epoch FROM backend_start)::text AS started
       FROM pg_stat_activity WHERE pid=pg_backend_pid()`,
    )).rows[0]!;
    const session = await createCollaborationRoomOwnerSession(client, onInvalidated);
    sessions.add(session);
    looseClients.delete(client);
    return { client, session, backendPid: identity.pid, backendStart: identity.started };
  };

  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(`CREATE TABLE ${tableSql} (LIKE public.collaboration_yjs_states INCLUDING ALL)`);

    const migrationClient = new Client(ownerClientConfig('migration'));
    looseClients.add(migrationClient);
    await migrationClient.connect();
    const migrationSearchPath = await migrationClient.query<{ search_path: string }>('SHOW search_path');
    assert.equal(migrationSearchPath.rows[0]?.search_path, schema);
    await migrationClient.query(COLLABORATION_ROOM_OWNER_UP_SQL);
    await migrationClient.end();
    looseClients.delete(migrationClient);
    const ownerColumns = await controlPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='collaboration_yjs_states'
         AND column_name IN ('room_owner_epoch','room_owner_token','room_owner_backend_pid','room_owner_backend_start')`,
      [schema],
    );
    assert.equal(ownerColumns.rows[0]?.count, '4');

    writerPool = new Pool({
      ...poolConfig(databaseUrl, 'canvas-room-owner-test-writer', schema),
      max: 6,
    });
    writerPool.on('error', (error) => { backgroundErrors.push(error); });
    const writerSearchPath = await writerPool.query<{ search_path: string }>('SHOW search_path');
    assert.equal(writerSearchPath.rows[0]?.search_path, schema);
    const persistence = await loadPersistence(persistenceOpenDb(writerPool));

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
    const documentIds = [
      'contention', 'unrelated', 'production-persist', 'claim-wait', 'release-wait', 'scope-mismatch',
      'lost-owner', 'lost-owner-secondary', 'loss-during-write', 'lost-commit',
    ];
    const initialDoc = new Y.Doc();
    initialDoc.getText('content').insert(0, 'base');
    const initialState = Y.encodeStateAsUpdate(initialDoc);
    const initialVector = Y.encodeStateVector(initialDoc);
    try {
      for (const documentId of documentIds) {
        await controlPool.query(
          `INSERT INTO ${tableSql} (
            document_id, workspace_id, organization_id, path, representation,
            lifecycle_generation, schema_version, yjs_state, state_vector,
            document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
            canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
          ) VALUES ($1,$2,$3,$4,$5,1,1,$6,$7,0,$8,$8,0,NULL,NULL,'lf',0,0,'active')`,
          [documentId, identity.workspaceId, identity.organizationId, `${documentId}.md`, identity.representation,
            Buffer.from(initialState), Buffer.from(initialVector), Date.now()],
        );
      }
    } finally {
      initialDoc.destroy();
    }
    const readRow = async (documentId: string): Promise<StateRow> => {
      const result = await controlPool.query<StateRow>(`SELECT * FROM ${tableSql} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const sequence = async (documentId: string) => Number((await readRow(documentId)).document_sequence);
    const fencedWrite = async (
      documentId: string,
      fence?: CollaborationRoomOwnerFence,
      hooks: WriteHooks = {},
    ): Promise<number> => {
      assert.ok(writerPool);
      const client = await writerPool.connect();
      let transactionOpen = false;
      try {
        const backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await client.query('BEGIN');
        transactionOpen = true;
        const locked = (await client.query<StateRow>(
          'SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE',
          [documentId],
        )).rows[0];
        assert.ok(locked);
        await assertCollaborationRoomOwnerFence(sqlConnection(client), locked, fence);
        await hooks.afterFence?.(backendPid);
        const updated = await client.query<{ document_sequence: number | string }>(
          `UPDATE collaboration_yjs_states SET document_sequence=document_sequence+1
           WHERE document_id=$1 RETURNING document_sequence`,
          [documentId],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return Number(updated.rows[0]!.document_sequence);
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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

    const ownerA = await createOwner('owner-a');
    const ownerB = await createOwner('owner-b');
    assert.notEqual(ownerA.backendPid, ownerB.backendPid, 'room owners must use distinct PostgreSQL sessions');
    assert.notEqual(ownerA.backendStart, '', 'backend start is part of every owner identity');
    const contentionFence = await ownerA.session.acquire(scope('contention'));
    assert.equal(contentionFence.backendPid, ownerA.backendPid);
    assert.equal(contentionFence.backendStart, ownerA.backendStart);
    assert.equal(contentionFence.epoch, 1);
    assert.equal(Object.isFrozen(contentionFence), true);
    assert.equal(Object.isFrozen(contentionFence.scope), true);
    ownerA.session.assertActive(contentionFence);
    await assert.rejects(ownerA.session.acquire(scope('contention')), ownerError('ROOM_OWNER_BUSY'));
    await assert.rejects(ownerB.session.acquire(scope('contention')), ownerError('ROOM_OWNER_BUSY'));

    const unrelatedFence = await ownerA.session.acquire(scope('unrelated'));
    assert.equal(unrelatedFence.backendPid, contentionFence.backendPid,
      'one dedicated PostgreSQL owner session can safely own unrelated documents');
    await ownerA.session.release(unrelatedFence);

    const contentionSequence = await sequence('contention');
    await assert.rejects(fencedWrite('contention'), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('contention'), contentionSequence, 'a missing proof cannot mutate an already claimed row');
    const wrongStart = Object.freeze({ ...contentionFence, backendStart: '0' });
    await assert.rejects(fencedWrite('contention', wrongStart), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('contention'), contentionSequence,
      'a reused PID with the wrong backend start cannot mutate the sequence');
    assert.equal(await fencedWrite('contention', contentionFence), contentionSequence + 1);
    await ownerA.session.release(contentionFence);
    assert.throws(() => ownerA.session.assertActive(contentionFence), ownerError('ROOM_OWNER_LOST'));
    await assert.rejects(fencedWrite('contention'), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('contention'), contentionSequence + 1,
      'release retains epoch history so legacy/no-token writes remain fenced');

    const replacementFence = await ownerB.session.acquire(scope('contention'));
    assert.equal(replacementFence.epoch, contentionFence.epoch + 1);
    await assert.rejects(fencedWrite('contention', contentionFence), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('contention'), contentionSequence + 1,
      'a former proof cannot mutate after release and reacquisition');
    assert.equal(await fencedWrite('contention', replacementFence), contentionSequence + 2);
    await ownerB.session.release(replacementFence);

    for (const changedScope of [
      scope('scope-mismatch', { workspaceId: 'another-workspace' }),
      scope('scope-mismatch', { lifecycleGeneration: 2 }),
    ]) {
      await assert.rejects(ownerA.session.acquire(changedScope), ownerError('ROOM_OWNER_SCOPE_CHANGED'));
      const unchanged = await readRow('scope-mismatch');
      assert.equal(Number(unchanged.room_owner_epoch), 0);
      assert.equal(Number(unchanged.document_sequence), 0);
    }

    const persistenceScope = scope('production-persist');
    const persistenceIdentity: CollaborationPersistenceIdentity = {
      workspaceId: persistenceScope.workspaceId,
      organizationId: persistenceScope.organizationId,
      path: persistenceScope.path,
      representation: persistenceScope.representation,
      schemaVersion: persistenceScope.schemaVersion,
    };
    const persistenceFence = await ownerA.session.acquire(persistenceScope);
    const ownedDocument = new Y.Doc();
    Y.applyUpdate(ownedDocument, initialState);
    ownedDocument.getText('content').insert(4, '-owned');
    try {
      await assert.rejects(
        persistence.persistCollaborationYDoc(
          persistenceScope.documentId,
          persistenceScope.lifecycleGeneration,
          ownedDocument,
          persistenceIdentity,
        ),
        ownerError('ROOM_OWNER_LOST'),
      );
      assert.equal(await sequence(persistenceScope.documentId), 0,
        'production persistence cannot mutate a claimed row without its owner fence');
      const firstPersist = await persistence.persistCollaborationYDoc(
        persistenceScope.documentId,
        persistenceScope.lifecycleGeneration,
        ownedDocument,
        persistenceIdentity,
        persistenceFence,
      );
      assert.equal(firstPersist.persistenceDisposition, 'advanced');
      assert.equal(firstPersist.documentSequence, 1);
      assert.equal(textFromUpdate(firstPersist.yjsState), 'base-owned');

      await ownerA.session.release(persistenceFence);
      const transferredFence = await ownerB.session.acquire(persistenceScope);
      assert.equal(transferredFence.epoch, persistenceFence.epoch + 1);
      ownedDocument.getText('content').insert(10, '-transferred');
      await assert.rejects(
        persistence.persistCollaborationYDoc(
          persistenceScope.documentId,
          persistenceScope.lifecycleGeneration,
          ownedDocument,
          persistenceIdentity,
          persistenceFence,
        ),
        ownerError('ROOM_OWNER_LOST'),
      );
      assert.equal(await sequence(persistenceScope.documentId), 1,
        'production persistence cannot advance with the former owner proof after transfer');
      const transferredPersist = await persistence.persistCollaborationYDoc(
        persistenceScope.documentId,
        persistenceScope.lifecycleGeneration,
        ownedDocument,
        persistenceIdentity,
        transferredFence,
      );
      assert.equal(transferredPersist.persistenceDisposition, 'advanced');
      assert.equal(transferredPersist.documentSequence, 2);
      assert.equal(textFromUpdate(transferredPersist.yjsState), 'base-owned-transferred');
      const persistedRow = await readRow(persistenceScope.documentId);
      assert.equal(Number(persistedRow.document_sequence), 2);
      assert.equal(textFromUpdate(persistedRow.yjs_state), 'base-owned-transferred');
      await ownerB.session.release(transferredFence);
    } finally {
      ownedDocument.destroy();
    }

    const claimWriteHolding = deferred(gates);
    const releaseClaimWrite = deferred(gates);
    let claimWriterPid = 0;
    const claimWrite = track(fencedWrite('claim-wait', undefined, {
      afterFence: async (pid) => {
        claimWriterPid = pid;
        claimWriteHolding.resolve();
        await releaseClaimWrite.promise;
      },
    }));
    await within(claimWriteHolding.promise, BARRIER_TIMEOUT_MS, 'Timed out holding the claim target row.');
    const waitingClaim = track(ownerA.session.acquire(scope('claim-wait')));
    const claimBlocked = await waitForBlock(ownerA.backendPid, claimWriterPid,
      'Owner claim did not wait for the active state-row write transaction.');
    assert.equal(claimBlocked.wait_event_type, 'Lock');
    releaseClaimWrite.resolve();
    assert.equal(await within(claimWrite, STATEMENT_TIMEOUT_MS, 'Claim prerequisite write did not commit.'), 1);
    const claimFence = await within(waitingClaim, STATEMENT_TIMEOUT_MS, 'Owner claim did not resume after the row lock released.');
    assert.equal(claimFence.epoch, 1);
    await ownerA.session.release(claimFence);

    const releaseFence = await ownerA.session.acquire(scope('release-wait'));
    const fencedWriteHolding = deferred(gates);
    const releaseFencedWrite = deferred(gates);
    let fencedWriterPid = 0;
    const activeWrite = track(fencedWrite('release-wait', releaseFence, {
      afterFence: async (pid) => {
        fencedWriterPid = pid;
        fencedWriteHolding.resolve();
        await releaseFencedWrite.promise;
      },
    }));
    await within(fencedWriteHolding.promise, BARRIER_TIMEOUT_MS, 'Timed out holding the actively fenced row write.');
    const waitingRelease = track(ownerA.session.release(releaseFence));
    assert.throws(() => ownerA.session.assertActive(releaseFence), ownerError('ROOM_OWNER_LOST'),
      'release invalidates the local proof before waiting on PostgreSQL');
    const releaseBlocked = await waitForBlock(ownerA.backendPid, fencedWriterPid,
      'Owner release did not wait for the active fenced write transaction.');
    assert.equal(releaseBlocked.wait_event_type, 'Lock');
    releaseFencedWrite.resolve();
    assert.equal(await within(activeWrite, STATEMENT_TIMEOUT_MS, 'Active fenced write did not commit.'), 1);
    await within(waitingRelease, STATEMENT_TIMEOUT_MS, 'Owner release did not resume after the fenced write committed.');
    await assert.rejects(fencedWrite('release-wait'), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('release-wait'), 1,
      'a rejected no-token write after release cannot change the exact committed sequence');

    let invalidations = 0;
    const invalidated = deferred(gates);
    const doomed = await createOwner('doomed', () => {
      invalidations += 1;
      invalidated.resolve();
    });
    const doomedFence = await doomed.session.acquire(scope('lost-owner'));
    const doomedSecondaryFence = await doomed.session.acquire(scope('lost-owner-secondary'));
    const lossDuringWriteFence = await doomed.session.acquire(scope('loss-during-write'));
    const replacement = await createOwner('loss-replacement');
    assert.notEqual(replacement.backendPid, doomedFence.backendPid,
      'owner loss must terminate only the original dedicated backend');
    const ownerLossWriteHolding = deferred(gates);
    const releaseOwnerLossWrite = deferred(gates);
    let ownerLossWriterPid = 0;
    const alreadyAuthorizedWrite = track(fencedWrite('loss-during-write', lossDuringWriteFence, {
      afterFence: async (pid) => {
        ownerLossWriterPid = pid;
        ownerLossWriteHolding.resolve();
        await releaseOwnerLossWrite.promise;
      },
    }));
    await within(ownerLossWriteHolding.promise, BARRIER_TIMEOUT_MS,
      'Timed out holding the already-authorized owner-loss write.');
    const terminated = await controlPool.query<{ terminated: boolean }>(
      'SELECT pg_terminate_backend($1::int) AS terminated',
      [doomedFence.backendPid],
    );
    assert.equal(terminated.rows[0]?.terminated, true);
    await assert.rejects(doomed.session.probe(), ownerError('ROOM_OWNER_UNAVAILABLE', 'ROOM_OWNER_LOST'));
    await within(invalidated.promise, BARRIER_TIMEOUT_MS, 'Lost owner session did not invalidate its handles.');
    assert.equal(invalidations, 1);
    assert.throws(() => doomed.session.assertActive(doomedFence), ownerError('ROOM_OWNER_LOST'),
      'lost owner proof is rejected synchronously before any replacement exists');
    assert.throws(() => doomed.session.assertActive(doomedSecondaryFence), ownerError('ROOM_OWNER_LOST'),
      'one backend loss invalidates a second document handle from the same owner session');
    assert.throws(() => doomed.session.assertActive(lossDuringWriteFence), ownerError('ROOM_OWNER_LOST'),
      'backend loss invalidates the handle whose write was already authorized');

    const waitingLossReplacement = track(replacement.session.acquire(scope('loss-during-write')));
    const lossReplacementBlocked = await waitForBlock(replacement.backendPid, ownerLossWriterPid,
      'Replacement owner did not wait for the already-authorized state-row write.');
    assert.equal(lossReplacementBlocked.wait_event_type, 'Lock');
    releaseOwnerLossWrite.resolve();
    assert.equal(await within(alreadyAuthorizedWrite, STATEMENT_TIMEOUT_MS,
      'Already-authorized owner-loss write did not commit.'), 1);
    const lossReplacementFence = await within(waitingLossReplacement, STATEMENT_TIMEOUT_MS,
      'Replacement owner did not claim after the authorized write committed.');
    assert.equal(lossReplacementFence.epoch, lossDuringWriteFence.epoch + 1);
    await assert.rejects(fencedWrite('loss-during-write', lossDuringWriteFence), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('loss-during-write'), 1,
      'the former proof cannot mutate after the replacement claim');
    assert.equal(await fencedWrite('loss-during-write', lossReplacementFence), 2);
    await replacement.session.release(lossReplacementFence);

    await assert.rejects(fencedWrite('lost-owner', doomedFence), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('lost-owner'), 0,
      'the database helper verifies the live advisory lock before allowing a write');
    await doomed.session.close();
    await doomed.session.close();

    const successorFence = await replacement.session.acquire(scope('lost-owner'));
    assert.equal(successorFence.epoch, doomedFence.epoch + 1);
    assert.notEqual(successorFence.token, doomedFence.token);
    assert.notEqual(successorFence.backendStart, doomedFence.backendStart,
      'replacement evidence must have a distinct backend incarnation');
    const reusedPidProof = Object.freeze({ ...successorFence, backendStart: doomedFence.backendStart });
    await assert.rejects(fencedWrite('lost-owner', reusedPidProof), ownerError('ROOM_OWNER_LOST'));
    assert.equal(await sequence('lost-owner'), 0,
      'backend-start mismatch rejects a proof even if a PID were reused');
    assert.equal(await fencedWrite('lost-owner', successorFence), 1);
    await replacement.session.release(successorFence);

    let uncertainInvalidations = 0;
    const uncertainClient = new Client(ownerClientConfig('lost-commit'));
    looseClients.add(uncertainClient);
    await uncertainClient.connect();
    let dropCommitReply = true;
    const uncertainTransport = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await uncertainClient.query(sql, values);
        if (dropCommitReply && normalizedSql(sql) === 'COMMIT') {
          dropCommitReply = false;
          throw new Error('Injected lost COMMIT reply after PostgreSQL committed.');
        }
        return result;
      },
      on: uncertainClient.on.bind(uncertainClient),
      end: uncertainClient.end.bind(uncertainClient),
    } as unknown as Pick<Client, 'query' | 'on' | 'end'>;
    const uncertainSession = await createCollaborationRoomOwnerSession(uncertainTransport, () => {
      uncertainInvalidations += 1;
    });
    sessions.add(uncertainSession);
    looseClients.delete(uncertainClient);
    await assert.rejects(uncertainSession.acquire(scope('lost-commit')), ownerError('ROOM_OWNER_UNAVAILABLE'));
    assert.equal(uncertainInvalidations, 1, 'an unconfirmed owner COMMIT invalidates the entire dedicated session');
    const uncertainRow = await readRow('lost-commit');
    assert.equal(Number(uncertainRow.room_owner_epoch), 1,
      'the fixture proves PostgreSQL committed even though no fence was acknowledged');
    assert.ok(uncertainRow.room_owner_token);
    await uncertainSession.close();
    const recovered = await createOwner('lost-commit-recovery');
    const recoveredFence = await recovered.session.acquire(scope('lost-commit'));
    assert.equal(recoveredFence.epoch, 2);
    await recovered.session.release(recoveredFence);

    assert.equal(backgroundErrors.length, 0, 'dedicated test pools must not emit background connection errors');
    console.log(
      'Collaboration room owner PostgreSQL: distinct-session contention, multi-document ownership, epochs, '
      + 'scope/lifecycle fences, live-lock proof, claim/release row ordering, backend loss/start identity, '
      + 'owner loss during an already-authorized write, production persistence transfer fences, and an actual '
      + 'committed-but-unacknowledged claim passed in an isolated generated schema. '
      + 'This is backend-session evidence, not a two-OS-process test.',
    );
  } finally {
    for (const gate of [...gates]) gate.resolve();
    const pending = [...operations];
    if (pending.length > 0) {
      try {
        await within(Promise.allSettled(pending), CLEANUP_TIMEOUT_MS,
          'Timed out releasing pending room-owner operations during cleanup.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const session of sessions) {
      try {
        await within(session.close(), CLEANUP_TIMEOUT_MS, 'Timed out closing a room-owner session.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const client of looseClients) {
      try {
        await within(client.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing an unattached owner client.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (writerPool) {
      try {
        await within(writerPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining the room-owner writer pool.');
        writerPoolDrained = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      writerPoolDrained = true;
    }
    if (schemaCreated && writerPoolDrained) {
      try {
        assertGeneratedSchema(schema);
        await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing the room-owner control pool.');
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Isolated room-owner PostgreSQL test cleanup failed.');
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = guardedDatabaseUrl();
  if (!databaseUrl) {
    console.log('collaboration-room-owner-postgres-test: skipped (managed PostgreSQL profile is not enabled)');
    return;
  }
  await run(databaseUrl);
}

void main().catch((error: unknown) => {
  console.error(`collaboration-room-owner-postgres-test failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
