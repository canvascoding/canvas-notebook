import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Pool, types } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import type {
  CollaborationPersistenceIdentity,
  CollaborationPersistenceResult,
  PersistedCollaborationState,
  SafeMarkdownNormalizationCheckpoint,
} from '../app/lib/collaboration/persistence';

const SCHEMA_PREFIX = 'canvas_lifecycle_snapshot_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const BARRIER_TIMEOUT_MS = 4_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type LifecycleError = Error & { code?: string };

type PersistenceModule = {
  CollaborationRepresentationMigrationError: new (...args: never[]) => LifecycleError;
  CollaborationStateStaleError: new (...args: never[]) => Error;
  compactCollaborationState(input: {
    documentId: string;
    expectedLifecycleGeneration: number;
  }): Promise<PersistedCollaborationState>;
  changeCollaborationRepresentation(input: {
    documentId: string;
    expectedLifecycleGeneration: number;
    representation: 'plain_text' | 'tiptap_xml';
    schemaVersion: number;
  }): Promise<PersistedCollaborationState>;
  changeCollaborationRepresentationWithSafeMarkdownNormalization(input: {
    documentId: string;
    expectedLifecycleGeneration: number;
    schemaVersion: number;
    representation?: 'tiptap_xml';
    checkpoint: SafeMarkdownNormalizationCheckpoint;
  }): Promise<{ canonicalContent: string; checkpointRequired: boolean; state: PersistedCollaborationState }>;
  markCollaborationCheckpoint(input: {
    documentId: string;
    workspaceId: string;
    path: string;
    lifecycleGeneration: number;
    schemaVersion: number;
    sequence: number;
    canonicalContent: string;
    serializedContent: string;
    degraded?: boolean;
  }): Promise<PersistedCollaborationState | null>;
  persistCollaborationYDoc(
    documentId: string,
    expectedLifecycleGeneration: number,
    doc: Y.Doc,
    expectedIdentity?: CollaborationPersistenceIdentity,
  ): Promise<CollaborationPersistenceResult>;
};

type ConnectionHooks = {
  beforeBegin?: (backendPid: number) => Promise<void>;
  beforeStateLock?: (backendPid: number) => void;
  afterStateLock?: (backendPid: number) => Promise<void>;
  afterCommit?: (backendPid: number) => Promise<void>;
  commitFault?: { position: 'before' | 'after'; remaining: number };
  rollbackFault?: { remaining: number };
  onClose?: (input: { backendPid: number; error: Error | undefined }) => void;
};

type StateRow = {
  document_id: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  representation: string;
  lifecycle_generation: number | string;
  schema_version: number | string;
  yjs_state: Uint8Array;
  state_vector: Uint8Array;
  document_sequence: number | string;
  persisted_at: number | string;
  checkpointed_at: number | string | null;
  checkpoint_sequence: number | string;
  canonical_hash: string | null;
  serialized_hash: string | null;
  newline_style: string;
  has_bom: boolean | number;
  degraded: boolean | number;
  status: string;
  room_owner_epoch: number | string;
  room_owner_token: string | null;
  room_owner_backend_pid: number | null;
  room_owner_backend_start: string | null;
};

type Gate = { promise: Promise<void>; resolve: () => void };

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('Lifecycle snapshot concurrency test refused a malformed DATABASE_URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433'
    || databaseName !== 'canvas_notebook') {
    throw new Error('Lifecycle snapshot concurrency test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) {
    throw new Error('Refusing SQL outside the generated lifecycle-snapshot test namespace.');
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
    const value = await probe();
    if (value !== null) return value;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(message);
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
    state_table: boolean;
    backup_table: boolean;
    operation_table: boolean;
  }>(`SELECT current_database() AS database_name,
      current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS state_table,
      to_regclass('public.collaboration_yjs_state_backups') IS NOT NULL AS backup_table,
      to_regclass('public.collaboration_agent_operations') IS NOT NULL AS operation_table`);
  const row = result.rows[0];
  if (!row || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18
    || !row.state_table || !row.backup_table || !row.operation_table) {
    throw new Error('Lifecycle snapshot concurrency test refused a server outside the managed PG18 Notebook profile.');
  }
}

function sanitizeError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown } : {};
  const name = typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(value.name) ? value.name : 'Error';
  const code = typeof value.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(value.code) ? ` [${value.code}]` : '';
  const message = typeof value.message === 'string' ? value.message : 'Unknown test failure.';
  return `${name}${code}: ${message}`
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
}

function createPlainTextDocument(content: string): Y.Doc {
  const doc = new Y.Doc({ gc: true });
  doc.getText('content').insert(0, content);
  return doc;
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
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

function createConnectionAdapter(
  pool: Pool,
  hookContext: AsyncLocalStorage<ConnectionHooks>,
): () => Promise<SqlConnection> {
  return async () => {
    const client = await pool.connect();
    const hooks = hookContext.getStore() ?? {};
    let backendPid: number;
    try {
      backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('Could not identify lifecycle test backend.'));
      throw error;
    }
    let closed = false;
    const query = async (sql: string, params: unknown[] = []) => {
      const normalized = normalizedSql(sql);
      if (normalized === 'BEGIN') await hooks.beforeBegin?.(backendPid);
      if (normalized === 'COMMIT' && hooks.commitFault?.position === 'before'
        && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining--;
        throw new Error('synthetic lifecycle COMMIT rejection');
      }
      if (normalized === 'ROLLBACK' && hooks.rollbackFault && hooks.rollbackFault.remaining > 0) {
        hooks.rollbackFault.remaining--;
        throw new Error('synthetic lifecycle ROLLBACK failure');
      }
      const stateLock = normalized === 'SELECT * FROM COLLABORATION_YJS_STATES WHERE DOCUMENT_ID = $1 FOR UPDATE';
      if (stateLock) hooks.beforeStateLock?.(backendPid);
      const result = await client.query(sql, params);
      if (stateLock) await hooks.afterStateLock?.(backendPid);
      if (normalized === 'COMMIT') await hooks.afterCommit?.(backendPid);
      if (normalized === 'COMMIT' && hooks.commitFault?.position === 'after'
        && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining--;
        throw new Error('synthetic lost lifecycle COMMIT reply');
      }
      return result;
    };
    return {
      get: async (sql, params = []) => (await query(sql, params)).rows[0],
      all: async (sql, params = []) => (await query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
      close: (error) => {
        assert.equal(closed, false, 'a production lifecycle connection must only be released once');
        closed = true;
        hooks.onClose?.({ backendPid, error });
        client.release(error);
      },
    };
  };
}

async function loadPersistence(openDb: () => Promise<SqlConnection>): Promise<PersistenceModule> {
  const filename = path.resolve('app/lib/collaboration/persistence.ts');
  const runtimeRequire = createRequire(filename);
  const ownerFilename = path.resolve('app/lib/collaboration/room-owner.ts');
  const ownerSource = ts.transpileModule(await readFile(ownerFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const ownerModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', ownerSource)((name: string) => {
    if (name === 'server-only') return {};
    return createRequire(ownerFilename)(name);
  }, ownerModule, ownerModule.exports);
  const mergeFilename = path.resolve('app/lib/collaboration/persistence-merge.ts');
  const mergeSource = ts.transpileModule(await readFile(mergeFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const mergeModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', mergeSource)((name: string) => {
    if (name === './server-runtime') return { Y };
    return createRequire(mergeFilename)(name);
  }, mergeModule, mergeModule.exports);
  const transactionFilename = path.resolve('app/lib/collaboration/lifecycle-transaction.ts');
  const transactionSource = ts.transpileModule(await readFile(transactionFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const transactionModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', transactionSource)((name: string) => {
    if (name === 'server-only') return {};
    return createRequire(transactionFilename)(name);
  }, transactionModule, transactionModule.exports);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const createTextDoc = (content: string) => createPlainTextDocument(content);
  // The codec injection keeps this regression focused on row-lock/snapshot
  // behavior. Existing projection-lifecycle tests cover the real rich codec;
  // no assertion below claims to validate rich serialization.
  const markdownState = {
    createPlainTextYDoc: createTextDoc,
    createRichMarkdownYDoc: createTextDoc,
    richMarkdownFromYDoc: (doc: Y.Doc) => doc.getText('content').toString(),
    validateRichMarkdownYDoc: (doc: Y.Doc) => ({ valid: true, markdown: doc.getText('content').toString() }),
    convertRichMarkdownYDoc: (doc: Y.Doc) => cloneDocument(doc),
  };
  const mocks: Record<string, unknown> = {
    'server-only': {},
    '@/app/lib/db': { openDb },
    '@/app/lib/files/workspace-mutation-lock': {
      withWorkspaceMutationLock: async (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
    },
    '@/app/lib/files/collaboration-repository': {
      archivePersistedCollaborationStatePathScopes() {}, lockFileCollaborationPaths() {},
      movePersistedCollaborationStatePathScope() {}, reactivatePersistedCollaborationStatePathScope() {},
      withFileCollaborationTransaction: async (operation: (value: unknown) => Promise<unknown>) => operation({}),
    },
    '@/app/lib/markdown/obsidian-metadata': {
      composeCanvasMarkdownDocument: (prefix: string, body: string) => `${prefix}${body}`,
    },
    '@/app/lib/markdown/rich-markdown-codec': {
      analyzeMarkdownRichMode: () => ({ mode: 'normalizable', prefix: '', normalizedBody: 'normalized checkpoint' }),
    },
    './types': { isRichTextCollaborationRepresentation: (value: string) => value !== 'plain_text' },
    './markdown-state': markdownState,
    './runtime-state': {
      getCollaborationRoomConnectionCount: () => 0,
      withCollaborationRoomLifecycleLock: async (_documentId: string, operation: () => Promise<unknown>) => operation(),
    },
    './server-runtime': { Y },
    './persistence-merge': mergeModule.exports,
    './room-owner': ownerModule.exports,
    './lifecycle-transaction': transactionModule.exports,
  };
  const compiledModule = { exports: {} as Record<string, unknown> };
  const localRequire = (name: string) => Object.prototype.hasOwnProperty.call(mocks, name)
    ? mocks[name]
    : runtimeRequire(name);
  new Function('require', 'module', 'exports', source)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports as PersistenceModule;
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const backupTable = `${schemaSql}.collaboration_yjs_state_backups`;
  const operationTable = `${schemaSql}.collaboration_agent_operations`;
  const gates = new Set<Gate>();
  const operations = new Set<Promise<unknown>>();
  const documents: Y.Doc[] = [];
  const own = <T extends Y.Doc>(document: T): T => { documents.push(document); return document; };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => undefined);
    return operation;
  };

  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-lifecycle-snapshot-control'), max: 3 });
  const poolErrors: Error[] = [];
  controlPool.on('error', (error) => { poolErrors.push(error); });
  let lifecyclePool: Pool | undefined;
  let schemaCreated = false;
  let lifecyclePoolDrained = false;
  const cleanupErrors: unknown[] = [];

  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(`CREATE TABLE ${stateTable} (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    await controlPool.query(`CREATE TABLE ${backupTable} (LIKE public.collaboration_yjs_state_backups INCLUDING ALL)`);
    await controlPool.query(`CREATE TABLE ${operationTable} (LIKE public.collaboration_agent_operations INCLUDING ALL)`);

    lifecyclePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-lifecycle-snapshot-runtime', schema), max: 10 });
    lifecyclePool.on('error', (error) => { poolErrors.push(error); });
    const searchPath = await lifecyclePool.query<{ search_path: string }>('SHOW search_path');
    assert.equal(searchPath.rows[0]?.search_path, schema);
    const hookContext = new AsyncLocalStorage<ConnectionHooks>();
    const persistence = await loadPersistence(createConnectionAdapter(lifecyclePool, hookContext));
    const identity: CollaborationPersistenceIdentity = {
      workspaceId: 'workspace', organizationId: 'organization', path: 'note.md',
      representation: 'plain_text', schemaVersion: 1,
    };
    const runWithHooks = <T>(hooks: ConnectionHooks, operation: () => Promise<T>) => hookContext.run(hooks, operation);
    const persist = (documentId: string, document: Y.Doc, hooks: ConnectionHooks = {}) => runWithHooks(
      hooks,
      () => persistence.persistCollaborationYDoc(documentId, 1, document, identity),
    );
    const seed = async (documentId: string, document: Y.Doc, input: {
      ownerEpoch?: number;
      ownerClaimed?: boolean;
      agentOperation?: boolean;
    } = {}) => {
      const now = 1_700_000_000_000;
      await controlPool.query(
        `INSERT INTO ${stateTable} (
          document_id, workspace_id, organization_id, path, representation,
          lifecycle_generation, schema_version, yjs_state, state_vector,
          document_sequence, persisted_at, checkpointed_at, checkpoint_sequence,
          canonical_hash, serialized_hash, newline_style, has_bom, degraded, status,
          room_owner_epoch, room_owner_token, room_owner_backend_pid, room_owner_backend_start
        ) VALUES ($1,$2,$3,$4,'plain_text',1,1,$5,$6,0,$7,$7,0,
          'canonical-0','serialized-0','lf',0,0,'active',$8,$9,$10,$11)`,
        [documentId, identity.workspaceId, identity.organizationId, identity.path,
          Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document)), now,
          input.ownerEpoch ?? 0, input.ownerClaimed ? 'owner-token' : null,
          input.ownerClaimed ? 12345 : null, input.ownerClaimed ? '1700000000.000000' : null],
      );
      if (input.agentOperation) {
        await controlPool.query(
          `INSERT INTO ${operationTable} (
            operation_id, document_id, document_path, document_representation,
            workspace_id, organization_id, document_lifecycle_generation, schema_version,
            initiated_by_user_id, actor_id, idempotency_key, run_generation,
            payload_hash, operation_type, requested_mode, atomicity, status,
            base_state_vector, base_document_sequence, action_keys_json, created_at, updated_at
          ) VALUES ($1,$2,$3,'plain_text',$4,$5,1,1,'user','agent',$6,1,
            'payload','apply','review','all_or_nothing','preparing',$7,0,'{}',$8,$8)`,
          [`operation-${documentId}`, documentId, identity.path, identity.workspaceId, identity.organizationId,
            `key-${documentId}`, Buffer.from(Y.encodeStateVector(document)), now],
        );
      }
    };
    const readState = async (documentId: string): Promise<StateRow> => {
      const result = await controlPool.query<StateRow>(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const backupCount = async (documentId: string) => Number((await controlPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${backupTable} WHERE document_id=$1`, [documentId],
    )).rows[0]!.count);
    const readOnlyBackup = async (documentId: string) => {
      const result = await controlPool.query<{
        lifecycle_generation: number;
        schema_version: number;
        representation: string;
        yjs_state: Uint8Array;
        state_vector: Uint8Array;
        document_sequence: number;
      }>(`SELECT lifecycle_generation, schema_version, representation, yjs_state, state_vector, document_sequence
          FROM ${backupTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const operationState = async (documentId: string) => (await controlPool.query<{
      status: string; cas_version: number; error_code: string | null;
    }>(`SELECT status, cas_version, error_code FROM ${operationTable} WHERE document_id=$1`, [documentId])).rows[0];
    const expectLifecycleError = async (operation: Promise<unknown>, code: string, label: string) => {
      await assert.rejects(within(operation, STATEMENT_TIMEOUT_MS, `Timed out: ${label}`),
        (error) => error instanceof persistence.CollaborationRepresentationMigrationError && error.code === code);
    };
    const staleAtBegin = async (input: {
      documentId: string;
      lifecycle: () => Promise<unknown>;
      mutate: () => Promise<void>;
      expectedRow: () => Promise<void>;
      expectedAgent?: boolean;
      callbackCount?: () => number;
    }) => {
      const beforeBegin = deferred(gates);
      const releaseBegin = deferred(gates);
      const lifecycle = track(runWithHooks({ beforeBegin: async () => {
        beforeBegin.resolve();
        await releaseBegin.promise;
      } }, input.lifecycle));
      await within(Promise.race([
        beforeBegin.promise,
        lifecycle.then(() => { throw new Error('Lifecycle mutation completed before its transaction gate.'); }),
      ]), BARRIER_TIMEOUT_MS, `Timed out before ${input.documentId} lifecycle BEGIN.`);
      await input.mutate();
      releaseBegin.resolve();
      await expectLifecycleError(lifecycle, 'state_changed', `${input.documentId} stale snapshot`);
      await input.expectedRow();
      assert.equal(await backupCount(input.documentId), 0, 'stale lifecycle input cannot create a committed backup');
      if (input.expectedAgent) {
        assert.deepEqual(await operationState(input.documentId), {
          status: 'preparing', cas_version: 0, error_code: null,
        }, 'transactional expiry must roll back with the stale snapshot');
      }
      assert.equal(input.callbackCount?.() ?? 0, 0,
        'stale lifecycle input cannot invoke external checkpoint callbacks');
    };

    const deletionBase = own(createPlainTextDocument('ABC'));
    await seed('stale-deletion', deletionBase);
    const deletion = own(cloneDocument(deletionBase));
    deletion.getText('content').delete(0, 1);
    assert.deepEqual(Y.encodeStateVector(deletion), Y.encodeStateVector(deletionBase),
      'deletion-only fixture must preserve the state vector while changing the delete set');
    await staleAtBegin({
      documentId: 'stale-deletion',
      lifecycle: () => persistence.compactCollaborationState({
        documentId: 'stale-deletion', expectedLifecycleGeneration: 1,
      }),
      mutate: async () => {
        const stored = await persist('stale-deletion', deletion);
        assert.equal(stored.persistenceDisposition, 'advanced');
      },
      expectedRow: async () => {
        const row = await readState('stale-deletion');
        assert.equal(textFromUpdate(row.yjs_state), 'BC');
        assert.equal(Number(row.document_sequence), 1);
        assert.deepEqual(Buffer.from(row.state_vector), Buffer.from(Y.encodeStateVector(deletion)));
      },
    });
    console.log('PASS compaction rejects a deletion-only same-vector store and preserves newer bytes');

    const byteOnlyBase = own(createPlainTextDocument('XYZ'));
    await seed('stale-byte-only', byteOnlyBase);
    const byteOnlyDeletion = own(cloneDocument(byteOnlyBase));
    byteOnlyDeletion.getText('content').delete(1, 1);
    assert.deepEqual(Y.encodeStateVector(byteOnlyDeletion), Y.encodeStateVector(byteOnlyBase));
    await staleAtBegin({
      documentId: 'stale-byte-only',
      lifecycle: () => persistence.compactCollaborationState({
        documentId: 'stale-byte-only', expectedLifecycleGeneration: 1,
      }),
      mutate: async () => {
        await controlPool.query(
          `UPDATE ${stateTable} SET yjs_state=$1 WHERE document_id='stale-byte-only'`,
          [Buffer.from(Y.encodeStateAsUpdate(byteOnlyDeletion))],
        );
      },
      expectedRow: async () => {
        const row = await readState('stale-byte-only');
        assert.equal(textFromUpdate(row.yjs_state), 'XZ');
        assert.equal(Number(row.document_sequence), 0);
        assert.deepEqual(Buffer.from(row.state_vector), Buffer.from(Y.encodeStateVector(byteOnlyBase)));
      },
    });
    console.log('PASS byte-equal snapshot guard detects deletion-only yjs_state drift with every metadata field unchanged');

    const checkpointDoc = own(createPlainTextDocument('checkpoint'));
    await seed('stale-checkpoint', checkpointDoc, { agentOperation: true });
    let checkpointCallbacks = 0;
    const checkpoint: SafeMarkdownNormalizationCheckpoint = {
      materialize: async ({ state }) => {
        checkpointCallbacks++;
        return state;
      },
    };
    await staleAtBegin({
      documentId: 'stale-checkpoint',
      lifecycle: () => persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
        documentId: 'stale-checkpoint', expectedLifecycleGeneration: 1, schemaVersion: 2,
        representation: 'tiptap_xml', checkpoint,
      }),
      mutate: async () => {
        const marked = await persistence.markCollaborationCheckpoint({
          documentId: 'stale-checkpoint', workspaceId: identity.workspaceId, path: identity.path,
          lifecycleGeneration: 1, schemaVersion: 1, sequence: 0,
          canonicalContent: 'checkpoint', serializedContent: '\uFEFFcheckpoint\r\n', degraded: true,
        });
        assert(marked);
        assert.equal(marked.degraded, true);
      },
      expectedRow: async () => {
        const row = await readState('stale-checkpoint');
        assert.equal(Boolean(row.degraded), true);
        assert.equal(Number(row.checkpoint_sequence), 0);
        assert.notEqual(row.canonical_hash, 'canonical-0');
        assert.notEqual(row.serialized_hash, 'serialized-0');
      },
      expectedAgent: true,
      callbackCount: () => checkpointCallbacks,
    });
    console.log('PASS representation migration rejects newer checkpoint/health metadata before callbacks or expiry commit');

    const alternateVectorDoc = own(createPlainTextDocument('alternate-vector'));
    type SnapshotMutationCase = {
      label: string;
      setClause: string;
      value: unknown;
      read: (row: StateRow) => unknown;
      expected: unknown;
    };
    const metadataCases: SnapshotMutationCase[] = [
      { label: 'workspace', setClause: 'workspace_id=$2', value: 'workspace-new', read: (row) => row.workspace_id, expected: 'workspace-new' },
      { label: 'organization', setClause: 'organization_id=$2', value: 'organization-new', read: (row) => row.organization_id, expected: 'organization-new' },
      { label: 'path', setClause: 'path=$2', value: 'renamed.md', read: (row) => row.path, expected: 'renamed.md' },
      { label: 'representation', setClause: 'representation=$2', value: 'tiptap_xml', read: (row) => row.representation, expected: 'tiptap_xml' },
      { label: 'generation', setClause: 'lifecycle_generation=$2', value: 2, read: (row) => Number(row.lifecycle_generation), expected: 2 },
      { label: 'schema', setClause: 'schema_version=$2', value: 3, read: (row) => Number(row.schema_version), expected: 3 },
      { label: 'document-sequence', setClause: 'document_sequence=$2', value: 7, read: (row) => Number(row.document_sequence), expected: 7 },
      { label: 'persisted-at', setClause: 'persisted_at=$2', value: 1_700_000_000_999, read: (row) => Number(row.persisted_at), expected: 1_700_000_000_999 },
      { label: 'checkpointed-at', setClause: 'checkpointed_at=$2', value: null, read: (row) => row.checkpointed_at, expected: null },
      { label: 'checkpoint-sequence', setClause: 'checkpoint_sequence=$2', value: 1, read: (row) => Number(row.checkpoint_sequence), expected: 1 },
      { label: 'canonical-hash', setClause: 'canonical_hash=$2', value: 'canonical-new', read: (row) => row.canonical_hash, expected: 'canonical-new' },
      { label: 'serialized-hash', setClause: 'serialized_hash=$2', value: 'serialized-new', read: (row) => row.serialized_hash, expected: 'serialized-new' },
      { label: 'newline-style', setClause: 'newline_style=$2', value: 'crlf', read: (row) => row.newline_style, expected: 'crlf' },
      { label: 'bom', setClause: 'has_bom=$2', value: 1, read: (row) => Number(row.has_bom), expected: 1 },
      { label: 'health', setClause: 'degraded=$2', value: 1, read: (row) => Number(row.degraded), expected: 1 },
      { label: 'status', setClause: 'status=$2', value: 'archived', read: (row) => row.status, expected: 'archived' },
      { label: 'state-vector', setClause: 'state_vector=$2', value: Buffer.from(Y.encodeStateVector(alternateVectorDoc)),
        read: (row) => Buffer.from(row.state_vector), expected: Buffer.from(Y.encodeStateVector(alternateVectorDoc)) },
    ];
    for (const testCase of metadataCases) {
      const documentId = `stale-metadata-${testCase.label}`;
      const document = own(createPlainTextDocument(`metadata-${testCase.label}`));
      await seed(documentId, document);
      await staleAtBegin({
        documentId,
        lifecycle: () => persistence.compactCollaborationState({
          documentId, expectedLifecycleGeneration: 1,
        }),
        mutate: async () => {
          await controlPool.query(
            `UPDATE ${stateTable} SET ${testCase.setClause} WHERE document_id=$1`,
            [documentId, testCase.value],
          );
        },
        expectedRow: async () => {
          const row = await readState(documentId);
          assert.deepEqual(testCase.read(row), testCase.expected, `${testCase.label} mutation must remain authoritative`);
        },
      });
    }
    console.log('PASS each identity, lifecycle, checkpoint, encoding, health, status, and state-vector field is snapshot-fenced');

    const ownerActive = own(createPlainTextDocument('owned-active'));
    await seed('owned-active', ownerActive, { ownerEpoch: 1, ownerClaimed: true });
    await expectLifecycleError(persistence.compactCollaborationState({
      documentId: 'owned-active', expectedLifecycleGeneration: 1,
    }), 'room_active', 'active owner refusal');
    assert.equal(await backupCount('owned-active'), 0);

    const ownerReleased = own(createPlainTextDocument('owned-released'));
    await seed('owned-released', ownerReleased, { ownerEpoch: 2, agentOperation: true });
    await expectLifecycleError(persistence.changeCollaborationRepresentation({
      documentId: 'owned-released', expectedLifecycleGeneration: 1,
      representation: 'tiptap_xml', schemaVersion: 2,
    }), 'room_active', 'released owner refusal');
    assert.equal(await backupCount('owned-released'), 0);
    assert.deepEqual(await operationState('owned-released'), {
      status: 'preparing', cas_version: 0, error_code: null,
    });

    const ownerCorruptLegacy = own(createPlainTextDocument('owned-corrupt-legacy'));
    await seed('owned-corrupt-legacy', ownerCorruptLegacy);
    await controlPool.query(
      `UPDATE ${stateTable} SET room_owner_token='orphan-token' WHERE document_id='owned-corrupt-legacy'`,
    );
    await expectLifecycleError(persistence.compactCollaborationState({
      documentId: 'owned-corrupt-legacy', expectedLifecycleGeneration: 1,
    }), 'room_active', 'corrupt epoch-zero owner refusal');
    assert.equal(await backupCount('owned-corrupt-legacy'), 0);
    console.log('PASS active, released, and corrupt epoch-zero owner metadata fail closed without committed expiry or backup');

    const compactHappy = own(createPlainTextDocument('compact-happy'));
    const compactPredecessorUpdate = Buffer.from(Y.encodeStateAsUpdate(compactHappy));
    const compactPredecessorVector = Buffer.from(Y.encodeStateVector(compactHappy));
    await seed('compact-happy', compactHappy);
    const compacted = await persistence.compactCollaborationState({
      documentId: 'compact-happy', expectedLifecycleGeneration: 1,
    });
    assert.equal(compacted.lifecycleGeneration, 2);
    assert.equal(compacted.documentSequence, 1);
    assert.equal(textFromUpdate(compacted.yjsState), 'compact-happy');
    assert.equal(await backupCount('compact-happy'), 1);
    const compactBackup = await readOnlyBackup('compact-happy');
    assert.deepEqual({
      generation: Number(compactBackup.lifecycle_generation), schema: Number(compactBackup.schema_version),
      representation: compactBackup.representation, sequence: Number(compactBackup.document_sequence),
    }, { generation: 1, schema: 1, representation: 'plain_text', sequence: 0 });
    assert.deepEqual(Buffer.from(compactBackup.yjs_state), compactPredecessorUpdate);
    assert.deepEqual(Buffer.from(compactBackup.state_vector), compactPredecessorVector);

    const representationHappy = own(createPlainTextDocument('representation-happy'));
    const representationPredecessorUpdate = Buffer.from(Y.encodeStateAsUpdate(representationHappy));
    const representationPredecessorVector = Buffer.from(Y.encodeStateVector(representationHappy));
    await seed('representation-happy', representationHappy);
    const represented = await persistence.changeCollaborationRepresentation({
      documentId: 'representation-happy', expectedLifecycleGeneration: 1,
      representation: 'tiptap_xml', schemaVersion: 2,
    });
    assert.equal(represented.lifecycleGeneration, 2);
    assert.equal(represented.documentSequence, 1);
    assert.equal(represented.representation, 'tiptap_xml');
    assert.equal(represented.schemaVersion, 2);
    assert.equal(textFromUpdate(represented.yjsState), 'representation-happy');
    assert.equal(await backupCount('representation-happy'), 1);
    const representationBackup = await readOnlyBackup('representation-happy');
    assert.deepEqual({
      generation: Number(representationBackup.lifecycle_generation), schema: Number(representationBackup.schema_version),
      representation: representationBackup.representation, sequence: Number(representationBackup.document_sequence),
    }, { generation: 1, schema: 1, representation: 'plain_text', sequence: 0 });
    assert.deepEqual(Buffer.from(representationBackup.yjs_state), representationPredecessorUpdate);
    assert.deepEqual(Buffer.from(representationBackup.state_vector), representationPredecessorVector);
    console.log('PASS unchanged compaction and representation snapshots commit one backup and advance lifecycle');

    const visibleBeforeMaterialize = own(createPlainTextDocument('materialize-visible'));
    await seed('materialize-visible', visibleBeforeMaterialize, { agentOperation: true });
    let visibleMaterializations = 0;
    const visibleMigration = await persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
      documentId: 'materialize-visible', expectedLifecycleGeneration: 1,
      representation: 'tiptap_xml', schemaVersion: 2,
      checkpoint: {
        materialize: async ({ state }) => {
          visibleMaterializations++;
          const committedRow = await readState('materialize-visible');
          assert.equal(committedRow.representation, 'tiptap_xml');
          assert.equal(Number(committedRow.lifecycle_generation), 2);
          assert.equal(Number(committedRow.document_sequence), 1);
          assert.equal(Number(committedRow.checkpoint_sequence), 0);
          assert.equal(Number(committedRow.checkpointed_at), 1_700_000_000_000);
          assert.equal(committedRow.canonical_hash, 'canonical-0');
          assert.equal(committedRow.serialized_hash, 'serialized-0');
          assert.equal(state.lifecycleGeneration, 2);
          assert.equal(state.documentSequence, 1);
          assert.equal(state.checkpointSequence, 0);
          const checkpointed = await persistence.markCollaborationCheckpoint({
            documentId: state.documentId, workspaceId: state.workspaceId, path: state.path,
            lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion,
            sequence: state.documentSequence, canonicalContent: 'normalized checkpoint',
            serializedContent: 'normalized checkpoint',
          });
          assert(checkpointed);
          return checkpointed;
        },
      },
    });
    assert.equal(visibleMaterializations, 1);
    assert.equal(visibleMigration.state.checkpointSequence, visibleMigration.state.documentSequence);
    assert.deepEqual(await operationState('materialize-visible'), {
      status: 'expired', cas_version: 1, error_code: 'lifecycle_representation_changed',
    });
    console.log('PASS normalization commits SQL and preserves the predecessor checkpoint tuple before materialization');

    const failedMaterializeDoc = own(createPlainTextDocument('materialize-failure'));
    await seed('materialize-failure', failedMaterializeDoc, { agentOperation: true });
    let failedMaterializations = 0;
    await expectLifecycleError(
      persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
        documentId: 'materialize-failure', expectedLifecycleGeneration: 1,
        representation: 'tiptap_xml', schemaVersion: 2,
        checkpoint: {
          materialize: async () => {
            failedMaterializations++;
            throw new Error('synthetic materialization failure');
          },
        },
      }),
      'checkpoint_failed',
      'post-commit materialization failure',
    );
    assert.equal(failedMaterializations, 1);
    const failedMaterializeRow = await readState('materialize-failure');
    assert.equal(failedMaterializeRow.representation, 'tiptap_xml');
    assert.equal(Number(failedMaterializeRow.lifecycle_generation), 2);
    assert.equal(Number(failedMaterializeRow.document_sequence), 1);
    assert.equal(Number(failedMaterializeRow.checkpoint_sequence), 0);
    assert.equal(Number(failedMaterializeRow.checkpointed_at), 1_700_000_000_000);
    assert.equal(failedMaterializeRow.canonical_hash, 'canonical-0');
    assert.equal(failedMaterializeRow.serialized_hash, 'serialized-0');
    assert.equal(await backupCount('materialize-failure'), 1);
    assert.deepEqual(await operationState('materialize-failure'), {
      status: 'expired', cas_version: 1, error_code: 'lifecycle_representation_changed',
    });
    console.log('PASS failed materialization leaves the committed rich lifecycle durably pending');

    const lostCommitDoc = own(createPlainTextDocument('lost-commit'));
    await seed('lost-commit', lostCommitDoc);
    const lostCommitCloses: Array<Error | undefined> = [];
    let recoveredMaterializations = 0;
    const recoveredMigration = await runWithHooks({
      commitFault: { position: 'after', remaining: 1 },
      onClose: ({ error }) => { lostCommitCloses.push(error); },
    }, () => persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
      documentId: 'lost-commit', expectedLifecycleGeneration: 1,
      representation: 'tiptap_xml', schemaVersion: 2,
      checkpoint: {
        materialize: async ({ state }) => {
          recoveredMaterializations++;
          const committedRow = await readState('lost-commit');
          assert.equal(Number(committedRow.lifecycle_generation), state.lifecycleGeneration);
          assert.equal(Number(committedRow.document_sequence), state.documentSequence);
          const checkpointed = await persistence.markCollaborationCheckpoint({
            documentId: state.documentId, workspaceId: state.workspaceId, path: state.path,
            lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion,
            sequence: state.documentSequence, canonicalContent: 'normalized checkpoint',
            serializedContent: 'normalized checkpoint',
          });
          assert(checkpointed);
          return checkpointed;
        },
      },
    }));
    assert.equal(recoveredMaterializations, 1);
    assert.equal(recoveredMigration.state.lifecycleGeneration, 2);
    assert.equal(recoveredMigration.state.checkpointSequence, 1);
    assert(lostCommitCloses.some((error) => error instanceof Error),
      'a lost COMMIT reply must discard its writer connection with an error');
    console.log('PASS a lost successful COMMIT is proven by its exact backup receipt before materialization');

    const rejectedCommitDoc = own(createPlainTextDocument('rejected-commit'));
    await seed('rejected-commit', rejectedCommitDoc);
    const rejectedCommitCloses: Array<Error | undefined> = [];
    await expectLifecycleError(runWithHooks({
      commitFault: { position: 'before', remaining: 1 },
      onClose: ({ error }) => { rejectedCommitCloses.push(error); },
    }, () => persistence.compactCollaborationState({
      documentId: 'rejected-commit', expectedLifecycleGeneration: 1,
    })), 'state_changed', 'rejected COMMIT cannot produce a durable receipt');
    const rejectedCommitRow = await readState('rejected-commit');
    assert.equal(Number(rejectedCommitRow.lifecycle_generation), 1);
    assert.equal(Number(rejectedCommitRow.document_sequence), 0);
    assert.equal(await backupCount('rejected-commit'), 0);
    assert(rejectedCommitCloses.some((error) => error instanceof Error),
      'an unconfirmed rejected COMMIT must discard its writer connection');
    console.log('PASS a pre-COMMIT failure has no receipt and cannot be inferred as committed');

    const rollbackFailureDoc = own(createPlainTextDocument('rollback-failure'));
    await seed('rollback-failure', rollbackFailureDoc);
    const rollbackBeforeBegin = deferred(gates);
    const releaseRollbackBegin = deferred(gates);
    const rollbackCloses: Array<Error | undefined> = [];
    const rollbackFailure = track(runWithHooks({
      beforeBegin: async () => {
        rollbackBeforeBegin.resolve();
        await releaseRollbackBegin.promise;
      },
      rollbackFault: { remaining: 1 },
      onClose: ({ error }) => { rollbackCloses.push(error); },
    }, () => persistence.compactCollaborationState({
      documentId: 'rollback-failure', expectedLifecycleGeneration: 1,
    })));
    await within(rollbackBeforeBegin.promise, BARRIER_TIMEOUT_MS, 'Rollback-failure lifecycle did not reach BEGIN.');
    await controlPool.query(
      `UPDATE ${stateTable} SET persisted_at=$2 WHERE document_id=$1`,
      ['rollback-failure', 1_700_000_000_777],
    );
    releaseRollbackBegin.resolve();
    await assert.rejects(
      within(rollbackFailure, STATEMENT_TIMEOUT_MS, 'Rollback-failure lifecycle did not settle.'),
      (error) => error instanceof AggregateError,
    );
    const rollbackFailureRow = await readState('rollback-failure');
    assert.equal(Number(rollbackFailureRow.lifecycle_generation), 1);
    assert.equal(Number(rollbackFailureRow.persisted_at), 1_700_000_000_777);
    assert.equal(await backupCount('rollback-failure'), 0);
    assert(rollbackCloses.some((error) => error instanceof Error),
      'a failed ROLLBACK must discard its unresolved connection');
    console.log('PASS a failed ROLLBACK discards the connection without committing lifecycle effects');

    const supersededRecoveryDoc = own(createPlainTextDocument('superseded-recovery'));
    await seed('superseded-recovery', supersededRecoveryDoc);
    let supersededMaterializations = 0;
    let committedTransitions = 0;
    await expectLifecycleError(runWithHooks({
      commitFault: { position: 'after', remaining: 1 },
      afterCommit: async () => {
        if (committedTransitions++ !== 0) return;
        await controlPool.query(
          `UPDATE ${stateTable}
           SET lifecycle_generation=lifecycle_generation + 1,
               document_sequence=document_sequence + 1
           WHERE document_id='superseded-recovery'`,
        );
      },
    }, () => persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
      documentId: 'superseded-recovery', expectedLifecycleGeneration: 1,
      representation: 'tiptap_xml', schemaVersion: 2,
      checkpoint: {
        materialize: async ({ state }) => {
          supersededMaterializations++;
          return state;
        },
      },
    })), 'state_changed', 'superseded commit recovery');
    assert.equal(supersededMaterializations, 0,
      'a superseded recovered lifecycle must not auto-replay materialization');
    const supersededRecoveryRow = await readState('superseded-recovery');
    assert.equal(supersededRecoveryRow.representation, 'tiptap_xml');
    assert.equal(Number(supersededRecoveryRow.lifecycle_generation), 3);
    assert.equal(Number(supersededRecoveryRow.document_sequence), 2);
    assert.equal(Number(supersededRecoveryRow.checkpoint_sequence), 0);
    assert.equal(await backupCount('superseded-recovery'), 1);
    const pendingProjection = await controlPool.query<{ document_id: string }>(
      `SELECT document_id FROM ${stateTable}
       WHERE document_id='superseded-recovery' AND status='active'
         AND checkpoint_sequence < document_sequence`,
    );
    assert.deepEqual(pendingProjection.rows, [{ document_id: 'superseded-recovery' }]);
    console.log('PASS superseded commit recovery skips materialization and remains discoverably pending');

    const corruptHigherDoc = own(createPlainTextDocument('corrupt-higher-row'));
    const corruptHigherUpdate = Buffer.from(Y.encodeStateAsUpdate(corruptHigherDoc));
    const corruptHigherVector = Buffer.from(Y.encodeStateVector(corruptHigherDoc));
    const corruptRecoveryBase = own(createPlainTextDocument('corrupt-recovery'));
    await seed('corrupt-recovery', corruptRecoveryBase);
    let corruptRecoveryCommits = 0;
    let corruptRecoveryMaterializations = 0;
    await expectLifecycleError(runWithHooks({
      commitFault: { position: 'after', remaining: 1 },
      afterCommit: async () => {
        if (corruptRecoveryCommits++ !== 0) return;
        await controlPool.query(
          `UPDATE ${stateTable}
           SET yjs_state=$2, state_vector=$3, document_sequence=document_sequence + 1
           WHERE document_id=$1`,
          ['corrupt-recovery', corruptHigherUpdate, corruptHigherVector],
        );
      },
    }, () => persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
      documentId: 'corrupt-recovery', expectedLifecycleGeneration: 1,
      representation: 'tiptap_xml', schemaVersion: 2,
      checkpoint: {
        materialize: async ({ state }) => {
          corruptRecoveryMaterializations++;
          return state;
        },
      },
    })), 'state_changed', 'non-containing higher-sequence recovery');
    assert.equal(corruptRecoveryMaterializations, 0,
      'a non-containing higher-sequence recovery row must be rejected before materialization');
    const corruptRecoveryRow = await readState('corrupt-recovery');
    assert.equal(Number(corruptRecoveryRow.lifecycle_generation), 2);
    assert.equal(Number(corruptRecoveryRow.document_sequence), 2);
    assert.deepEqual(Buffer.from(corruptRecoveryRow.yjs_state), corruptHigherUpdate);
    assert.deepEqual(Buffer.from(corruptRecoveryRow.state_vector), corruptHigherVector);
    console.log('PASS a non-containing higher-sequence recovery row is rejected before materialization');

    const validHigherBase = own(createPlainTextDocument('valid-higher-recovery'));
    await seed('valid-higher-recovery', validHigherBase);
    let validHigherCommits = 0;
    let validHigherMaterializations = 0;
    const validHigherMigration = await runWithHooks({
      commitFault: { position: 'after', remaining: 1 },
      afterCommit: async () => {
        if (validHigherCommits++ !== 0) return;
        const committed = await readState('valid-higher-recovery');
        const newer = own(new Y.Doc());
        Y.applyUpdate(newer, committed.yjs_state);
        const text = newer.getText('content');
        text.insert(text.length, '-newer');
        await controlPool.query(
          `UPDATE ${stateTable}
           SET yjs_state=$2, state_vector=$3, document_sequence=document_sequence + 1
           WHERE document_id=$1`,
          ['valid-higher-recovery', Buffer.from(Y.encodeStateAsUpdate(newer)), Buffer.from(Y.encodeStateVector(newer))],
        );
      },
    }, () => persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
      documentId: 'valid-higher-recovery', expectedLifecycleGeneration: 1,
      representation: 'tiptap_xml', schemaVersion: 2,
      checkpoint: {
        materialize: async ({ state }) => {
          validHigherMaterializations++;
          assert.equal(state.documentSequence, 2);
          assert.equal(textFromUpdate(state.yjsState), 'normalized checkpoint-newer');
          const checkpointed = await persistence.markCollaborationCheckpoint({
            documentId: state.documentId, workspaceId: state.workspaceId, path: state.path,
            lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion,
            sequence: state.documentSequence, canonicalContent: 'normalized checkpoint-newer',
            serializedContent: 'normalized checkpoint-newer',
          });
          assert(checkpointed);
          return checkpointed;
        },
      },
    }));
    assert.equal(validHigherMaterializations, 1);
    assert.equal(validHigherMigration.state.documentSequence, 2);
    assert.equal(validHigherMigration.state.checkpointSequence, 2);
    assert.equal(textFromUpdate(validHigherMigration.state.yjsState), 'normalized checkpoint-newer');
    console.log('PASS a causally containing higher-sequence recovery row reaches materialization as the fresh state');

    for (const corruption of ['bytes', 'vector'] as const) {
      const documentId = `corrupt-materializer-${corruption}`;
      const base = own(createPlainTextDocument(documentId));
      const unrelated = own(createPlainTextDocument(`unrelated-${corruption}`));
      await seed(documentId, base);
      let callbackCount = 0;
      await expectLifecycleError(
        persistence.changeCollaborationRepresentationWithSafeMarkdownNormalization({
          documentId, expectedLifecycleGeneration: 1,
          representation: 'tiptap_xml', schemaVersion: 2,
          checkpoint: {
            materialize: async ({ state }) => {
              callbackCount++;
              return {
                ...state,
                checkpointSequence: state.documentSequence,
                ...(corruption === 'bytes'
                  ? { yjsState: Y.encodeStateAsUpdate(unrelated) }
                  : { stateVector: Y.encodeStateVector(unrelated) }),
              };
            },
          },
        }),
        'checkpoint_failed',
        `same-sequence materializer ${corruption} corruption`,
      );
      assert.equal(callbackCount, 1);
      const row = await readState(documentId);
      assert.equal(Number(row.lifecycle_generation), 2);
      assert.equal(Number(row.document_sequence), 1);
      assert.equal(Number(row.checkpoint_sequence), 0);
    }
    console.log('PASS same-sequence materializer byte or vector corruption fails closed as checkpoint_failed');

    const reverseBase = own(createPlainTextDocument('reverse'));
    await seed('reverse-lock-order', reverseBase);
    const lifecycleLocked = deferred(gates);
    const releaseLifecycle = deferred(gates);
    let lifecyclePid = 0;
    const lifecycle = track(runWithHooks({
      afterStateLock: async (pid) => {
        lifecyclePid = pid;
        lifecycleLocked.resolve();
        await releaseLifecycle.promise;
      },
    }, () => persistence.compactCollaborationState({
      documentId: 'reverse-lock-order', expectedLifecycleGeneration: 1,
    })));
    await within(lifecycleLocked.promise, BARRIER_TIMEOUT_MS, 'Lifecycle transaction never acquired its state row lock.');
    const late = own(cloneDocument(reverseBase));
    late.getText('content').insert(late.getText('content').length, '-late');
    let persistPid = 0;
    const persistStarted = deferred(gates);
    const delayedPersist = track(persist('reverse-lock-order', late, {
      beforeStateLock: (pid) => { persistPid = pid; persistStarted.resolve(); },
    }));
    await within(persistStarted.promise, BARRIER_TIMEOUT_MS, 'Persist never submitted its contending row lock.');
    assert.notEqual(lifecyclePid, persistPid);
    const waiting = await eventually(async () => {
      const result = await controlPool.query<{ blocking_pids: number[]; wait_event_type: string | null }>(
        `SELECT pg_blocking_pids($1::int) AS blocking_pids, wait_event_type
         FROM pg_stat_activity WHERE pid=$1`, [persistPid],
      );
      const activity = result.rows[0];
      return activity?.blocking_pids.includes(lifecyclePid) ? activity : null;
    }, 'PostgreSQL never reported persist blocked by the lifecycle state lock.');
    assert.equal(waiting.wait_event_type, 'Lock');
    releaseLifecycle.resolve();
    const lifecycleResult = await within(lifecycle, STATEMENT_TIMEOUT_MS, 'Lifecycle lock holder did not commit.');
    assert.equal(lifecycleResult.lifecycleGeneration, 2);
    await assert.rejects(within(delayedPersist, STATEMENT_TIMEOUT_MS, 'Blocked persist did not settle.'),
      (error) => error instanceof persistence.CollaborationStateStaleError);
    const reverseRow = await readState('reverse-lock-order');
    assert.equal(Number(reverseRow.lifecycle_generation), 2);
    assert.equal(Number(reverseRow.document_sequence), 1);
    assert.equal(textFromUpdate(reverseRow.yjs_state), 'reverse');
    assert.equal(await backupCount('reverse-lock-order'), 1);
    console.log('PASS lifecycle row lock blocks persist; committed generation makes the delayed store reject stale');

    assert.equal(poolErrors.length, 0);
    console.log('PostgreSQL lifecycle snapshot concurrency passed in an isolated generated schema.');
  } finally {
    for (const gate of [...gates]) gate.resolve();
    if (operations.size > 0) {
      try {
        await within(Promise.allSettled([...operations]), CLEANUP_TIMEOUT_MS,
          'Timed out releasing lifecycle concurrency operations during cleanup.');
      } catch (error) { cleanupErrors.push(error); }
    }
    for (const document of documents) document.destroy();
    if (lifecyclePool) {
      try {
        await within(lifecyclePool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining lifecycle test pool.');
        lifecyclePoolDrained = true;
      } catch (error) { cleanupErrors.push(error); }
    } else lifecyclePoolDrained = true;
    if (schemaCreated && lifecyclePoolDrained) {
      try {
        assertGeneratedSchema(schema);
        await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`);
      } catch (error) { cleanupErrors.push(error); }
    }
    try {
      await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing lifecycle control pool.');
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Isolated PostgreSQL lifecycle snapshot test cleanup failed.');
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = guardedDatabaseUrl();
  if (!databaseUrl) {
    console.log('collaboration-lifecycle-snapshot-concurrency-test: skipped (managed PostgreSQL profile is not enabled)');
    return;
  }
  const previousInt8Parser = types.getTypeParser(types.builtins.INT8, 'text');
  types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));
  try {
    await run(databaseUrl);
  } finally {
    types.setTypeParser(types.builtins.INT8, previousInt8Parser);
  }
}

void main().catch((error: unknown) => {
  console.error(`collaboration-lifecycle-snapshot-concurrency-test failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
