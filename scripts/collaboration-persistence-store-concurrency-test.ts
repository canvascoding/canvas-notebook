import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Pool } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import type {
  CollaborationPersistenceIdentity,
  CollaborationPersistenceResult,
} from '../app/lib/collaboration/persistence';
import { mergeCollaborationPersistenceUpdates } from '../app/lib/collaboration/persistence-merge';

const SCHEMA_PREFIX = 'canvas_persistence_store_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const BARRIER_TIMEOUT_MS = 4_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type PersistenceModule = {
  persistCollaborationYDoc: (
    documentId: string,
    expectedLifecycleGeneration: number,
    doc: Y.Doc,
    expectedIdentity?: CollaborationPersistenceIdentity,
  ) => Promise<CollaborationPersistenceResult>;
};

type ConnectionHooks = {
  beforeConnect?: () => Promise<void>;
  connected?: (backendPid: number) => void;
  beforeRowLock?: (backendPid: number) => void;
  afterRowLock?: (backendPid: number) => Promise<void>;
};

type StoredRow = {
  yjs_state: Uint8Array;
  state_vector: Uint8Array;
  document_sequence: number | string;
};

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
};

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('PostgreSQL concurrency test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error(
      'PostgreSQL concurrency test only accepts the managed loopback database at port 55433/canvas_notebook.',
    );
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) {
    throw new Error('Refusing SQL for a schema outside the generated persistence-test namespace.');
  }
}

function schemaIdentifier(schema: string): string {
  assertGeneratedSchema(schema);
  return `"${schema}"`;
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
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
  };
  const localRequire = (name: string) => Object.prototype.hasOwnProperty.call(mocks, name)
    ? mocks[name]
    : runtimeRequire(name);
  new Function('require', 'module', 'exports', source)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports as PersistenceModule;
}

function createConnectionAdapter(
  pool: Pool,
  hookContext: AsyncLocalStorage<ConnectionHooks>,
): () => Promise<SqlConnection> {
  return async () => {
    const hooks = hookContext.getStore() ?? {};
    await hooks.beforeConnect?.();
    const client = await pool.connect();
    let backendPid: number;
    try {
      backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      hooks.connected?.(backendPid);
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('Could not identify the test backend.'));
      throw error;
    }
    let closed = false;
    const query = async (sql: string, params: unknown[] = []) => {
      const lockQuery = normalizedSql(sql)
        === 'SELECT * FROM COLLABORATION_YJS_STATES WHERE DOCUMENT_ID = $1 FOR UPDATE';
      if (lockQuery) hooks.beforeRowLock?.(backendPid);
      const result = await client.query(sql, params);
      if (lockQuery) await hooks.afterRowLock?.(backendPid);
      return result;
    };
    return {
      get: async (sql, params = []) => (await query(sql, params)).rows[0],
      all: async (sql, params = []) => (await query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
      close: (error) => {
        assert.equal(closed, false, 'a production persistence connection must only be released once');
        closed = true;
        client.release(error);
      },
    };
  };
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(source));
  return result;
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

function mapFromUpdate(update: Uint8Array): Record<string, unknown> {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return doc.getMap('content').toJSON();
  } finally {
    doc.destroy();
  }
}

function poolConfig(databaseUrl: URL, applicationName: string, searchPath?: string) {
  if (searchPath) assertGeneratedSchema(searchPath);
  const options = [
    searchPath ? `-c search_path=${searchPath}` : '',
    `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
  ].filter(Boolean).join(' ');
  return {
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 2_000,
    allowExitOnIdle: true,
    options,
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
    throw new Error('PostgreSQL concurrency test refused a server outside the managed PG18 Notebook profile.');
  }
}

function sanitizeError(error: unknown): string {
  const candidate = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
  const name = typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(candidate.name)
    ? candidate.name
    : 'Error';
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,24}$/u.test(candidate.code)
    ? ` [${candidate.code}]`
    : '';
  const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown test failure.';
  const redacted = message
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
  return `${name}${code}: ${redacted}`;
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const tableSql = `${schemaSql}.collaboration_yjs_states`;
  const gates = new Set<Gate>();
  const operations = new Set<Promise<unknown>>();
  const ownedDocs: Y.Doc[] = [];
  const own = <T extends Y.Doc>(doc: T): T => {
    ownedDocs.push(doc);
    return doc;
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };

  const controlPool = new Pool({
    ...poolConfig(databaseUrl, 'canvas-persistence-store-concurrency-control'),
    max: 2,
  });
  const poolErrors: Error[] = [];
  controlPool.on('error', (error) => { poolErrors.push(error); });
  let persistencePool: Pool | undefined;
  let schemaCreated = false;
  let persistencePoolDrained = false;
  const cleanupErrors: unknown[] = [];

  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(
      `CREATE TABLE ${tableSql} (LIKE public.collaboration_yjs_states INCLUDING ALL)`,
    );

    persistencePool = new Pool({
      ...poolConfig(databaseUrl, 'canvas-persistence-store-concurrency', schema),
      max: 8,
    });
    persistencePool.on('error', (error) => { poolErrors.push(error); });
    const searchPath = await persistencePool.query<{ search_path: string }>('SHOW search_path');
    assert.equal(searchPath.rows[0]?.search_path, schema,
      'production persistence connections must resolve only the generated schema');

    const hookContext = new AsyncLocalStorage<ConnectionHooks>();
    const persistence = await loadPersistence(createConnectionAdapter(persistencePool, hookContext));
    const identity: CollaborationPersistenceIdentity = {
      workspaceId: 'workspace',
      organizationId: 'organization',
      path: 'note.md',
      representation: 'plain_text',
      schemaVersion: 1,
    };
    const persist = (
      hooks: ConnectionHooks,
      documentId: string,
      doc: Y.Doc,
    ) => hookContext.run(hooks, () => persistence.persistCollaborationYDoc(documentId, 1, doc, identity));
    const seed = async (documentId: string, doc: Y.Doc) => {
      await controlPool.query(
        `INSERT INTO ${tableSql} (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded, status
        ) VALUES ($1,$2,$3,$4,$5,1,1,$6,$7,0,$8,$8,0,NULL,NULL,'lf',0,0,'active')`,
        [documentId, identity.workspaceId, identity.organizationId, identity.path, identity.representation,
          Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), Date.now()],
      );
    };
    const readRow = async (documentId: string): Promise<StoredRow> => {
      const result = await controlPool.query<StoredRow>(
        `SELECT yjs_state, state_vector, document_sequence FROM ${tableSql} WHERE document_id=$1`,
        [documentId],
      );
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const blockedPair = async (documentId: string, first: Y.Doc, second: Y.Doc) => {
      const firstLocked = deferred(gates);
      const releaseFirst = deferred(gates);
      const secondStarted = deferred(gates);
      let firstPid = 0;
      let secondPid = 0;
      const firstOperation = track(persist({
        connected: (pid) => { firstPid = pid; },
        afterRowLock: async () => {
          firstLocked.resolve();
          await releaseFirst.promise;
        },
      }, documentId, first));
      await within(Promise.race([
        firstLocked.promise,
        firstOperation.then(() => { throw new Error('First persistence completed before holding its row lock.'); }),
      ]), BARRIER_TIMEOUT_MS, 'Timed out waiting for the first PostgreSQL row lock.');

      const secondOperation = track(persist({
        connected: (pid) => { secondPid = pid; },
        beforeRowLock: () => { secondStarted.resolve(); },
      }, documentId, second));
      await within(Promise.race([
        secondStarted.promise,
        secondOperation.then(() => { throw new Error('Second persistence completed before submitting its row lock.'); }),
      ]), BARRIER_TIMEOUT_MS, 'Timed out waiting for the second PostgreSQL lock query.');
      assert.notEqual(firstPid, secondPid, 'contending stores must use distinct PostgreSQL backend connections');

      const waiting = await eventually(async () => {
        const result = await controlPool.query<{
          blocking_pids: number[];
          wait_event_type: string | null;
        }>(`SELECT pg_blocking_pids($1::int) AS blocking_pids, wait_event_type
            FROM pg_stat_activity WHERE pid=$1`, [secondPid]);
        const activity = result.rows[0];
        return activity?.blocking_pids.includes(firstPid) ? activity : null;
      }, 'PostgreSQL never reported the second persistence as blocked by the first row lock.');
      assert.equal(waiting.wait_event_type, 'Lock');

      releaseFirst.resolve();
      const results = await within(
        Promise.all([firstOperation, secondOperation]),
        STATEMENT_TIMEOUT_MS,
        'Timed out waiting for the row-lock contenders to commit.',
      );
      return { first: results[0], second: results[1], firstPid, secondPid };
    };

    const divergentBase = own(new Y.Doc());
    divergentBase.getMap('content').set('base', true);
    await seed('divergent-locks', divergentBase);
    const divergentLeft = own(cloneDoc(divergentBase));
    const divergentRight = own(cloneDoc(divergentBase));
    divergentLeft.getMap('content').set('left', true);
    divergentRight.getMap('content').set('right', true);
    const divergent = await blockedPair('divergent-locks', divergentLeft, divergentRight);
    assert.equal(divergent.first.persistenceDisposition, 'advanced');
    assert.equal(divergent.first.documentSequence, 1);
    assert.equal(divergent.second.persistenceDisposition, 'merged');
    assert.equal(divergent.second.incomingNeedsReconcile, true);
    assert.equal(divergent.second.documentSequence, 2);
    const divergentRow = await readRow('divergent-locks');
    assert.equal(Number(divergentRow.document_sequence), 2);
    assert.deepEqual(mapFromUpdate(divergentRow.yjs_state), { base: true, left: true, right: true });

    const deletionBase = own(new Y.Doc());
    deletionBase.getText('content').insert(0, 'ABC');
    await seed('deletion-locks', deletionBase);
    const deleteA = own(cloneDoc(deletionBase));
    const deleteB = own(cloneDoc(deletionBase));
    deleteA.getText('content').delete(0, 1);
    deleteB.getText('content').delete(1, 1);
    assert.deepEqual(Y.encodeStateVector(deleteA), Y.encodeStateVector(deleteB),
      'deletion lock fixture must have equal vectors and distinct delete sets');
    const deleted = await blockedPair('deletion-locks', deleteA, deleteB);
    assert.equal(deleted.first.persistenceDisposition, 'advanced');
    assert.equal(deleted.second.persistenceDisposition, 'merged');
    assert.equal(deleted.second.documentSequence, 2);
    const deletionRow = await readRow('deletion-locks');
    assert.equal(Number(deletionRow.document_sequence), 2);
    assert.equal(textFromUpdate(deletionRow.yjs_state), 'C', 'row-lock serialization must not lose either deletion');

    const runExactSnapshotOrdering = async (order: 'exact-first' | 'ancestor-first') => {
      const documentId = `exact-snapshot-${order}`;
      const base = own(new Y.Doc());
      base.getText('content').insert(0, 'base');
      await seed(documentId, base);
      const ancestor = own(cloneDoc(base));
      ancestor.getText('content').insert(4, '-ancestor');
      const exact = own(cloneDoc(ancestor));
      exact.getText('content').insert(13, '-exact');
      const delayedEntered = deferred(gates);
      const releaseDelayed = deferred(gates);
      const delayedDoc = order === 'exact-first' ? ancestor : exact;
      const immediateDoc = order === 'exact-first' ? exact : ancestor;
      const delayedOperation = track(persist({
        beforeConnect: async () => {
          delayedEntered.resolve();
          await releaseDelayed.promise;
        },
      }, documentId, delayedDoc));
      await within(delayedEntered.promise, BARRIER_TIMEOUT_MS,
        'Timed out before the delayed snapshot requested a PostgreSQL connection.');
      if (order === 'exact-first') ancestor.getText('content').insert(13, '-late');
      const immediate = await persist({}, documentId, immediateDoc);
      releaseDelayed.resolve();
      const delayed = await within(delayedOperation, STATEMENT_TIMEOUT_MS,
        'Timed out waiting for the delayed snapshot persistence.');
      const stored = await readRow(documentId);
      assert.equal(textFromUpdate(stored.yjs_state), 'base-ancestor-exact',
        'the exact new snapshot wins in either storage ordering without late mutable-document bytes');
      if (order === 'exact-first') {
        assert.equal(immediate.persistenceDisposition, 'advanced');
        assert.equal(delayed.persistenceDisposition, 'unchanged');
        assert.equal(delayed.incomingNeedsReconcile, true);
        assert.equal(delayed.documentSequence, 1, 'a delayed ancestor cannot bump the exact committed snapshot');
        assert.equal(Number(stored.document_sequence), 1);
      } else {
        assert.equal(immediate.persistenceDisposition, 'advanced');
        assert.equal(delayed.persistenceDisposition, 'advanced');
        assert.equal(delayed.incomingNeedsReconcile, false);
        assert.equal(Number(stored.document_sequence), 2);
      }
    };
    // Storage-order characterization only: this does not invoke or claim to test
    // the proposal/candidate orchestrator that may supply an exact new snapshot.
    await runExactSnapshotOrdering('exact-first');
    await runExactSnapshotOrdering('ancestor-first');

    assert.equal(poolErrors.length, 0, 'the dedicated PostgreSQL pools must not emit background connection errors');
    console.log(
      'PostgreSQL persistence store concurrency: distinct blocked backends, divergent union, deletion union, '
      + 'pre-connect immutable capture and exact-snapshot storage ordering passed in an isolated generated schema. '
      + 'The exact-snapshot cases are storage-only and do not exercise the candidate orchestrator.',
    );
  } finally {
    for (const gate of [...gates]) gate.resolve();
    const pending = [...operations];
    if (pending.length > 0) {
      try {
        await within(Promise.allSettled(pending), CLEANUP_TIMEOUT_MS,
          'Timed out releasing pending persistence operations during cleanup.');
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const doc of ownedDocs) doc.destroy();
    if (persistencePool) {
      try {
        await within(persistencePool.end(), CLEANUP_TIMEOUT_MS,
          'Timed out draining the isolated persistence connection pool.');
        persistencePoolDrained = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      persistencePoolDrained = true;
    }
    if (schemaCreated && persistencePoolDrained) {
      try {
        assertGeneratedSchema(schema);
        await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS,
        'Timed out closing the isolated persistence control pool.');
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Isolated PostgreSQL persistence test cleanup failed.');
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = guardedDatabaseUrl();
  if (!databaseUrl) {
    console.log('collaboration-persistence-store-concurrency-test: skipped (managed PostgreSQL profile is not enabled)');
    return;
  }
  await run(databaseUrl);
}

void main().catch((error: unknown) => {
  console.error(`collaboration-persistence-store-concurrency-test failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
