import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import * as Y from 'yjs';

import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';
import { createCollaborationRoomOwnerRuntime } from '../app/lib/collaboration/room-owner-runtime';
import {
  assertCollaborationRoomOwnerFence,
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

const SCHEMA_PREFIX = 'canvas_idle_release_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type OwnerRuntime = ReturnType<typeof createCollaborationRoomOwnerRuntime>;
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
    throw new Error('Idle-release PostgreSQL test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error('Idle-release PostgreSQL test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) throw new Error('Refusing SQL outside the generated idle-release namespace.');
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
    throw new Error('Idle-release PostgreSQL test refused a server outside managed PG18.');
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

function ownerLost(error: unknown): boolean {
  assert.ok(error instanceof CollaborationRoomOwnerError);
  assert.ok(error.code === 'ROOM_OWNER_LOST' || error.code === 'ROOM_OWNER_UNAVAILABLE');
  return true;
}

function releaseUnproven(error: unknown): boolean {
  assert.ok(error instanceof CollaborationRoomReleaseError);
  assert.equal(error.code, 'ROOM_RELEASE_UNPROVEN');
  return true;
}

function scope(documentId: string): CollaborationRoomOwnerScope {
  return {
    documentId,
    workspaceId: 'workspace-idle-release',
    organizationId: 'organization-idle-release',
    path: `${documentId}.md`,
    representation: 'plain_text',
    lifecycleGeneration: 1,
    schemaVersion: 1,
  };
}

function snapshot(document: Y.Doc, releaseId: string = randomUUID()): CollaborationRoomReleaseSnapshot {
  return Object.freeze({
    releaseId,
    yjsState: Y.encodeStateAsUpdate(document),
    stateVector: Y.encodeStateVector(document),
  });
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const looseClients = new Set<Client>();
  const runtimes = new Set<OwnerRuntime>();
  const documents = new Set<Y.Doc>();
  const cleanupErrors: unknown[] = [];
  const backgroundErrors: Error[] = [];
  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-idle-release-control'), max: 4 });
  controlPool.on('error', (error) => { backgroundErrors.push(error); });
  let schemaCreated = false;

  const clientConfig = (label: string) => ({
    ...poolConfig(databaseUrl, `canvas-idle-release-${label}`, schema),
  });
  const createConnectedClient = async (label: string): Promise<Client> => {
    const client = new Client(clientConfig(label));
    looseClients.add(client);
    await client.connect();
    return client;
  };
  const ownDocument = (document: Y.Doc) => {
    documents.add(document);
    return document;
  };
  const createRuntime = (input: {
    label: string;
    transformOwner?: (client: Client) => Pick<Client, 'query' | 'on' | 'end'>;
    recoverRelease?: (input: {
      fence: CollaborationRoomOwnerFence;
      snapshot: CollaborationRoomReleaseSnapshot;
    }) => Promise<CollaborationRoomReleaseReceipt>;
  }) => {
    const runtime = createCollaborationRoomOwnerRuntime({
      heartbeatMs: 60_000,
      createSession: async (onInvalidated) => {
        const client = await createConnectedClient(`owner-${input.label}`);
        const session = await createCollaborationRoomOwnerSession(input.transformOwner?.(client) ?? client, onInvalidated);
        looseClients.delete(client);
        return session;
      },
      recoverRelease: input.recoverRelease,
      onLost: () => undefined,
    });
    runtimes.add(runtime);
    return runtime;
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
    const seed = async (identity: CollaborationRoomOwnerScope) => {
      await controlPool.query(
        `INSERT INTO ${stateTable} (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$10,0,NULL,NULL,'lf',0,0,'active')`,
        [identity.documentId, identity.workspaceId, identity.organizationId, identity.path,
          identity.representation, identity.lifecycleGeneration, identity.schemaVersion,
          emptyUpdate, emptyVector, Date.now()],
      );
    };
    const readState = async (documentId: string): Promise<StateRow> => {
      const result = await controlPool.query<StateRow>(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const persist = async (fence: CollaborationRoomOwnerFence, document: Y.Doc) => {
      const client = await createConnectedClient(`persist-${fence.scope.documentId}`);
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
          document_sequence=document_sequence+1 WHERE document_id=$1`, [fence.scope.documentId,
        Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document))]);
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
        looseClients.delete(client);
      }
    };
    const realRecovery = async (fence: CollaborationRoomOwnerFence, releaseSnapshot: CollaborationRoomReleaseSnapshot) => (
      recoverCollaborationRoomRelease({
        createClient: async () => {
          const client = await createConnectedClient(`recover-${fence.scope.documentId}`);
          looseClients.delete(client);
          return client;
        },
        fence,
        snapshot: releaseSnapshot,
      })
    );
    const receiptCount = async (releaseId: string) => Number((await controlPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`,
      [releaseId],
    )).rows[0]!.count);

    const happyScope = scope('idle-happy');
    const lostScope = scope('idle-lost-commit');
    const rejectedScope = scope('idle-rejected-commit');
    for (const identity of [happyScope, lostScope, rejectedScope]) await seed(identity);

    // Normal idle unload: durable snapshot, immutable receipt, destroy+finish, then a fresh runtime reads and reclaims.
    const happyRuntime = createRuntime({
      label: 'happy',
      recoverRelease: ({ fence, snapshot: value }) => realRecovery(fence, value),
    });
    const happyDocument = ownDocument(new Y.Doc({ guid: happyScope.documentId }));
    happyDocument.getText('content').insert(0, 'durable-idle-content');
    const happyFence = await happyRuntime.claim(happyDocument, happyScope);
    await persist(happyFence, happyDocument);
    const activity = happyRuntime.admitActivity(happyScope.documentId);
    assert.equal(happyRuntime.tryBeginIdleTerminalDrain(happyDocument), undefined,
      'normal unload defers instead of waiting on its own active lease');
    activity.release();
    const happyDrain = happyRuntime.tryBeginIdleTerminalDrain(happyDocument);
    assert.ok(happyDrain);
    assert.equal(happyRuntime.tryBeginIdleTerminalDrain(happyDocument), undefined,
      'an already draining room cannot begin a second idle terminal drain');
    await happyDrain.idle;
    const happySnapshot = snapshot(happyDocument);
    await happyDrain.releaseDurably(happySnapshot);
    const happyRow = await readState(happyScope.documentId);
    assert.equal(Number(happyRow.document_sequence), 1);
    assert.equal(happyRow.room_owner_token, null);
    assert.equal(Buffer.from(happyRow.yjs_state).equals(Buffer.from(happySnapshot.yjsState)), true);
    assert.equal(Buffer.from(happyRow.state_vector).equals(Buffer.from(happySnapshot.stateVector)), true);
    const happyReceipt = await controlPool.query<{
      release_id: string;
      document_id: string;
      workspace_id: string;
      organization_id: string | null;
      path: string;
      representation: string;
      lifecycle_generation: string;
      schema_version: string;
      owner_epoch: string;
      owner_token: string;
      document_sequence: string;
    }>(`SELECT release_id,document_id,workspace_id,organization_id,path,representation,
        lifecycle_generation,schema_version,owner_epoch,owner_token,document_sequence
        FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`, [happySnapshot.releaseId]);
    assert.deepEqual(happyReceipt.rows[0], {
      release_id: happySnapshot.releaseId,
      document_id: happyScope.documentId,
      workspace_id: happyScope.workspaceId,
      organization_id: happyScope.organizationId,
      path: happyScope.path,
      representation: happyScope.representation,
      lifecycle_generation: '1',
      schema_version: '1',
      owner_epoch: String(happyFence.epoch),
      owner_token: happyFence.token,
      document_sequence: '1',
    });
    assert.equal((await controlPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${schemaSql}.collaboration_admission_requests`,
    )).rows[0]?.count, '0', 'ordinary idle release needs no admission request');
    happyDocument.destroy();
    happyDrain.finish();

    const replacementRuntime = createRuntime({ label: 'happy-replacement' });
    const replacementDocument = ownDocument(new Y.Doc({ guid: `${happyScope.documentId}-replacement` }));
    Y.applyUpdate(replacementDocument, happyRow.yjs_state);
    assert.equal(replacementDocument.getText('content').toString(), 'durable-idle-content');
    const replacementFence = await replacementRuntime.claim(replacementDocument, happyScope);
    assert.equal(replacementFence.epoch, happyFence.epoch + 1);
    await replacementRuntime.release(replacementDocument);
    replacementDocument.destroy();
    const receiptAfterReplacement = await controlPool.query<typeof happyReceipt.rows[number]>(
      `SELECT release_id,document_id,workspace_id,organization_id,path,representation,
       lifecycle_generation,schema_version,owner_epoch,owner_token,document_sequence
       FROM ${schemaSql}.collaboration_room_release_receipts WHERE release_id=$1`, [happySnapshot.releaseId],
    );
    assert.deepEqual(receiptAfterReplacement.rows[0], happyReceipt.rows[0],
      'later owner epochs cannot rewrite the immutable predecessor release receipt');

    // A committed release with a lost reply retries only the exact read-only proof after a transient recovery failure.
    let dropLostCommitReply = false;
    let lostBackendEnded = false;
    let lostCommitAttempts = 0;
    let lostRecoveryCalls = 0;
    const lostRuntime = createRuntime({
      label: 'lost',
      transformOwner: (client) => ({
        query: async (sql: string, values?: unknown[]) => {
          if (dropLostCommitReply && normalizedSql(sql) === 'COMMIT') {
            lostCommitAttempts += 1;
            await client.query(sql, values);
            dropLostCommitReply = false;
            throw new Error('Injected lost successful idle-release COMMIT reply.');
          }
          return client.query(sql, values);
        },
        on: client.on.bind(client),
        end: async () => {
          await client.end();
          lostBackendEnded = true;
        },
      } as unknown as Pick<Client, 'query' | 'on' | 'end'>),
      recoverRelease: async ({ fence, snapshot: value }) => {
        lostRecoveryCalls += 1;
        assert.equal(lostBackendEnded, true, 'recovery starts only after the uncertain owner backend ended');
        if (lostRecoveryCalls === 1) throw new Error('Injected temporary receipt-read failure.');
        return realRecovery(fence, value);
      },
    });
    const lostDocument = ownDocument(new Y.Doc({ guid: lostScope.documentId }));
    lostDocument.getText('content').insert(0, 'lost-commit-content');
    const lostFence = await lostRuntime.claim(lostDocument, lostScope);
    await persist(lostFence, lostDocument);
    const lostDrain = lostRuntime.tryBeginIdleTerminalDrain(lostDocument);
    assert.ok(lostDrain);
    await lostDrain.idle;
    const lostSnapshot = snapshot(lostDocument);
    dropLostCommitReply = true;
    await assert.rejects(lostDrain.releaseDurably(lostSnapshot), /temporary receipt-read failure/u);
    assert.equal(lostBackendEnded, true);
    assert.equal(await receiptCount(lostSnapshot.releaseId), 1,
      'PostgreSQL committed the release before its reply was lost');
    const changedDocument = new Y.Doc();
    changedDocument.getText('content').insert(0, 'mutated-retry');
    try {
      await assert.rejects(lostDrain.releaseDurably({
        ...snapshot(changedDocument, lostSnapshot.releaseId),
      }), (error: unknown) => error instanceof CollaborationRoomOwnerError
        && error.code === 'ROOM_OWNER_SCOPE_CHANGED');
      await assert.rejects(lostDrain.releaseDurably({ ...lostSnapshot, releaseId: randomUUID() }),
        (error: unknown) => error instanceof CollaborationRoomOwnerError
          && error.code === 'ROOM_OWNER_SCOPE_CHANGED');
    } finally {
      changedDocument.destroy();
    }
    assert.equal(lostRecoveryCalls, 1, 'mutated retries never inspect durable state');
    await lostDrain.releaseDurably(lostSnapshot);
    assert.equal(lostRecoveryCalls, 2);
    assert.equal(lostCommitAttempts, 1, 'exact retry never issues a second SQL release');
    lostDocument.destroy();
    lostDrain.finish();

    // A rejected COMMIT has no receipt: repeated exact recovery fails and the live document remains quarantined.
    let rejectCommit = false;
    let rejectedCommitAttempts = 0;
    let rejectedRecoveryCalls = 0;
    const rejectedRuntime = createRuntime({
      label: 'rejected',
      transformOwner: (client) => ({
        query: async (sql: string, values?: unknown[]) => {
          if (rejectCommit && normalizedSql(sql) === 'COMMIT') {
            rejectedCommitAttempts += 1;
            rejectCommit = false;
            throw new Error('Injected rejected idle-release COMMIT.');
          }
          return client.query(sql, values);
        },
        on: client.on.bind(client),
        end: client.end.bind(client),
      } as unknown as Pick<Client, 'query' | 'on' | 'end'>),
      recoverRelease: async ({ fence, snapshot: value }) => {
        rejectedRecoveryCalls += 1;
        return realRecovery(fence, value);
      },
    });
    const rejectedDocument = ownDocument(new Y.Doc({ guid: rejectedScope.documentId }));
    rejectedDocument.getText('content').insert(0, 'rejected-commit-content');
    const rejectedFence = await rejectedRuntime.claim(rejectedDocument, rejectedScope);
    await persist(rejectedFence, rejectedDocument);
    const rejectedDrain = rejectedRuntime.tryBeginIdleTerminalDrain(rejectedDocument);
    assert.ok(rejectedDrain);
    await rejectedDrain.idle;
    const rejectedSnapshot = snapshot(rejectedDocument);
    rejectCommit = true;
    await assert.rejects(rejectedDrain.releaseDurably(rejectedSnapshot), releaseUnproven);
    await assert.rejects(rejectedDrain.releaseDurably(rejectedSnapshot), releaseUnproven);
    assert.equal(rejectedCommitAttempts, 1, 'recovery retry never reissues the rejected SQL release');
    assert.equal(rejectedRecoveryCalls, 2);
    assert.equal(await receiptCount(rejectedSnapshot.releaseId), 0);
    const rejectedRow = await readState(rejectedScope.documentId);
    assert.equal(rejectedRow.room_owner_token, rejectedFence.token,
      'a rejected COMMIT rolls back token clear and retains the claimed epoch');
    assert.equal(rejectedDocument.isDestroyed, false, 'unproven live content remains locally retained');
    assert.equal(rejectedRuntime.canUnload(rejectedDocument), false);
    await assert.rejects(rejectedRuntime.claim(ownDocument(new Y.Doc()), scope('no-auto-reclaim')), ownerLost,
      'owner-session loss never starts a replacement claim automatically');

    assert.equal(backgroundErrors.length, 0, 'idle-release test pools must not emit background errors');
    console.log(
      'Collaboration idle release PostgreSQL: normal idle receipt+reclaim, committed lost-reply recovery retry, '
      + 'snapshot-bound retry rejection, and rejected-COMMIT quarantine passed in one isolated generated schema.',
    );
  } finally {
    for (const runtime of runtimes) {
      try {
        await within(runtime.dispose(), CLEANUP_TIMEOUT_MS, 'Timed out disposing an idle-release runtime.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const document of documents) if (!document.isDestroyed) document.destroy();
    for (const client of [...looseClients]) {
      try {
        await within(client.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing an idle-release client.');
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
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining the idle-release control pool.');
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Idle-release PostgreSQL cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration idle-release PostgreSQL test skipped: guarded managed database environment is not configured.');
} else {
  run(databaseUrl).catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}
