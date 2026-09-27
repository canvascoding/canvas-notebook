import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client, Pool } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import { lockFileCollaborationPaths } from '../app/lib/files/collaboration-repository';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import {
  collaborationAdmissionActionDigest,
  CollaborationAdmissionError,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';
import * as compactionContractModule from '../app/lib/collaboration/compaction-contract';
import { createCollaborationAdmissionQuiescenceService } from '../app/lib/collaboration/room-admission-quiescence';
import * as handoffRuntime from '../app/lib/collaboration/room-admission-handoff';
import {
  assertCollaborationRoomOwnerFence,
  createCollaborationRoomOwnerSession,
  type CollaborationRoomOwnerFence,
} from '../app/lib/collaboration/room-owner';
import type { CollaborationRoomReleaseSnapshot } from '../app/lib/collaboration/room-owner-release';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';

const SCHEMA_PREFIX = 'canvas_admission_compact_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type OwnerSession = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;
type PersistenceError = Error & { code?: string };
type PersistenceModule = {
  CollaborationRepresentationMigrationError: new (...args: never[]) => PersistenceError;
  compactCollaborationState(input: {
    documentId: string;
    expectedLifecycleGeneration: number;
  }): Promise<unknown>;
  compactCollaborationStateInAdmissionHandoff(database: SqlConnection, input: {
    documentId: string;
    expectedLifecycleGeneration: number;
  }): Promise<{ state: { documentId: string; lifecycleGeneration: number; documentSequence: number }; backupId: string }>;
  prepareCollaborationCompactionAdmission(
    database: SqlConnection,
    input: CollaborationAdmissionRequest,
  ): Promise<void>;
};
type CompactionModule = {
  createCollaborationCompactionHandoffService(options: {
    openConnection: () => Promise<SqlConnection>;
    withMutationLocks: <T>(workspaceIds: readonly string[], operation: () => Promise<T>) => Promise<T>;
  }): {
    execute(input: CollaborationAdmissionRequest, authorization: {
      authorize: (request: CollaborationAdmissionRequest) => Promise<void>;
    }): Promise<{
      result: Readonly<Record<string, string>>;
      targets: readonly unknown[];
    }>;
  };
};
type ConnectionHooks = {
  connections?: number;
  commitFault?: { position: 'before' | 'after'; remaining: number };
  onOpen?: (ordinal: number) => Promise<void>;
  onClose?: (error: Error | undefined, ordinal: number) => void;
  beforeQuery?: (normalizedSql: string) => Promise<void>;
  afterQuery?: (normalizedSql: string) => Promise<void>;
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
  checkpoint_sequence: number | string;
  room_owner_epoch: number | string;
  room_owner_token: string | null;
  room_owner_backend_pid: number | null;
  room_owner_backend_start: string | null;
  status: string;
};
type BackupRow = {
  backup_id: string;
  lifecycle_generation: number | string;
  document_sequence: number | string;
  yjs_state: Uint8Array;
  state_vector: Uint8Array;
  reason: string;
};
type Gate = { promise: Promise<void>; resolve: () => void };

function deferred(): Gate {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try { parsed = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('Admission-compaction PostgreSQL test refused a malformed DATABASE_URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433' || databaseName !== 'canvas_notebook') {
    throw new Error('Admission-compaction PostgreSQL test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) throw new Error('Refusing SQL outside the generated admission-compaction namespace.');
}

function schemaIdentifier(schema: string): string {
  assertGeneratedSchema(schema);
  return `"${schema}"`;
}

function poolConfig(databaseUrl: URL, applicationName: string, searchPath?: string) {
  if (searchPath) assertGeneratedSchema(searchPath);
  return {
    connectionString: databaseUrl.toString(), application_name: applicationName,
    connectionTimeoutMillis: 3_000, idleTimeoutMillis: 2_000, allowExitOnIdle: true,
    options: [searchPath ? `-c search_path=${searchPath}` : '',
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`, `-c lock_timeout=${LOCK_TIMEOUT_MS}`]
      .filter(Boolean).join(' '),
  };
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

async function verifyManagedPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{
    database_name: string;
    server_version_num: string;
    state_table: boolean;
    backup_table: boolean;
    operation_table: boolean;
  }>(`SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS state_table,
      to_regclass('public.collaboration_yjs_state_backups') IS NOT NULL AS backup_table,
      to_regclass('public.collaboration_agent_operations') IS NOT NULL AS operation_table`);
  const row = result.rows[0];
  if (!row || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18
    || !row.state_table || !row.backup_table || !row.operation_table) {
    throw new Error('Admission-compaction test refused a server outside managed PG18.');
  }
}

function sanitizeError(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
  const name = typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(candidate.name)
    ? candidate.name : 'Error';
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(candidate.code)
    ? ` [${candidate.code}]` : '';
  const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown test failure.';
  return `${name}${code}: ${message}`.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
}

function createDocument(content: string): Y.Doc {
  const document = new Y.Doc({ gc: true });
  document.getText('content').insert(0, content);
  return document;
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, Y.encodeStateAsUpdate(source));
  return document;
}

function textFromUpdate(update: Uint8Array): string {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, update);
    return document.getText('content').toString();
  } finally { document.destroy(); }
}

function admissionError(...codes: CollaborationAdmissionError['code'][]) {
  return (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.ok(codes.includes(error.code), `expected ${codes.join(' or ')}, received ${error.code}`);
    return true;
  };
}

function persistenceError(module: PersistenceModule, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof module.CollaborationRepresentationMigrationError);
    assert.equal(error.code, code);
    return true;
  };
}

function expectedDocument(documentId: string, lifecycleGeneration = 1): CollaborationAdmissionDocument {
  return { documentId, workspaceId: 'workspace-compaction', organizationId: 'organization-compaction',
    path: `${documentId}.md`, representation: 'plain_text', lifecycleGeneration, schemaVersion: 1, status: 'active' };
}

function compactionRequest(document: CollaborationAdmissionDocument): CollaborationAdmissionRequest {
  const actionPayloadText = JSON.stringify({ version: 1, documentId: document.documentId,
    expectedLifecycleGeneration: document.lifecycleGeneration });
  return { requestId: randomUUID(), actorId: 'actor-compaction', action: 'compact', actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
    scopes: [{ workspaceId: document.workspaceId, organizationId: document.organizationId,
      path: document.path, kind: 'exact' }], expectedDocuments: [document] };
}

function createConnectionAdapter(pool: Pool, hookContext: AsyncLocalStorage<ConnectionHooks>) {
  return async (): Promise<SqlConnection> => {
    const client = await pool.connect();
    const hooks = hookContext.getStore();
    let ordinal = 0;
    if (hooks) {
      hooks.connections = (hooks.connections ?? 0) + 1;
      ordinal = hooks.connections;
      try { await hooks.onOpen?.(ordinal); }
      catch (error) {
        client.release(error instanceof Error ? error : new Error('Admission-compaction open hook failed.'));
        throw error;
      }
    }
    let closed = false;
    const query = async (sql: string, params: unknown[] = []) => {
      const normalized = normalizedSql(sql);
      await hooks?.beforeQuery?.(normalized);
      if (normalized === 'COMMIT' && hooks?.commitFault?.position === 'before'
        && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining -= 1;
        throw new Error('Injected rejected admission-compaction COMMIT.');
      }
      const result = await client.query(sql, params);
      await hooks?.afterQuery?.(normalized);
      if (normalized === 'COMMIT' && hooks?.commitFault?.position === 'after'
        && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining -= 1;
        throw new Error('Injected lost admission-compaction COMMIT reply.');
      }
      return result;
    };
    return {
      get: async (sql, params = []) => (await query(sql, params)).rows[0],
      all: async (sql, params = []) => (await query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
      close: async (error) => {
        assert.equal(closed, false, 'admission-compaction SQL connection closed twice');
        closed = true;
        hooks?.onClose?.(error, ordinal);
        client.release(error);
      },
    };
  };
}

async function loadProductionModules(openDb: () => Promise<SqlConnection>):
Promise<{ persistence: PersistenceModule; compaction: CompactionModule }> {
  const persistenceFilename = path.resolve('app/lib/collaboration/persistence.ts');
  const runtimeRequire = createRequire(persistenceFilename);
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
  const createTextDocument = (content: string) => createDocument(content);
  // Plain-text codec injection keeps this harness on transactional admission
  // mechanics. It makes no real rich-Markdown codec or filesystem projection claim.
  const markdownState = {
    createPlainTextYDoc: createTextDocument,
    createRichMarkdownYDoc: createTextDocument,
    richMarkdownFromYDoc: (document: Y.Doc) => document.getText('content').toString(),
    validateRichMarkdownYDoc: (document: Y.Doc) => ({ valid: true, markdown: document.getText('content').toString() }),
    convertRichMarkdownYDoc: (document: Y.Doc) => cloneDocument(document),
  };
  const persistenceMocks: Record<string, unknown> = {
    'server-only': {},
    '@/app/lib/db': { openDb },
    '@/app/lib/files/workspace-mutation-lock': {
      withWorkspaceMutationLock: async (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
    },
    '@/app/lib/files/collaboration-repository': {
      archivePersistedCollaborationStatePathScopes() {},
      lockFileCollaborationPaths,
      movePersistedCollaborationStatePathScope() {},
      reactivatePersistedCollaborationStatePathScope() {},
      withFileCollaborationTransaction: async (operation: (value: unknown) => Promise<unknown>) => operation({}),
    },
    '@/app/lib/markdown/obsidian-metadata': {
      composeCanvasMarkdownDocument: (prefix: string, body: string) => `${prefix}${body}`,
    },
    '@/app/lib/markdown/rich-markdown-codec': {
      analyzeMarkdownRichMode: () => ({ mode: 'normalizable', prefix: '', normalizedBody: 'normalized' }),
    },
    './types': { isRichTextCollaborationRepresentation: (value: string) => value !== 'plain_text' },
    './markdown-state': markdownState,
    './runtime-state': {
      getCollaborationRoomConnectionCount: () => 0,
      withCollaborationRoomLifecycleLock: async (_documentId: string, operation: () => Promise<unknown>) => operation(),
    },
    './server-runtime': { Y },
    './persistence-merge': mergeModule.exports,
    './room-owner': await import('../app/lib/collaboration/room-owner'),
    './room-admission-handoff': handoffRuntime,
    './compaction-contract': compactionContractModule,
    './lifecycle-transaction': transactionModule.exports,
  };
  const persistenceSource = ts.transpileModule(await readFile(persistenceFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const persistenceCompiledModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', persistenceSource)((name: string) =>
    Object.prototype.hasOwnProperty.call(persistenceMocks, name) ? persistenceMocks[name] : runtimeRequire(name),
  persistenceCompiledModule, persistenceCompiledModule.exports);

  const compactionFilename = path.resolve('app/lib/collaboration/compaction-handoff.ts');
  const compactionSource = ts.transpileModule(await readFile(compactionFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const compactionMocks: Record<string, unknown> = {
    'server-only': {},
    './compaction-contract': compactionContractModule,
    './room-admission-handoff': handoffRuntime,
    './persistence': persistenceCompiledModule.exports,
  };
  const compactionCompiledModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', compactionSource)((name: string) =>
    Object.prototype.hasOwnProperty.call(compactionMocks, name)
      ? compactionMocks[name] : createRequire(compactionFilename)(name),
  compactionCompiledModule, compactionCompiledModule.exports);
  return { persistence: persistenceCompiledModule.exports as PersistenceModule,
    compaction: compactionCompiledModule.exports as CompactionModule };
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const backupTable = `${schemaSql}.collaboration_yjs_state_backups`;
  const operationTable = `${schemaSql}.collaboration_agent_operations`;
  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-admission-compaction-control'), max: 4 });
  const poolErrors: Error[] = [];
  controlPool.on('error', (error) => { poolErrors.push(error); });
  let runtimePool: Pool | undefined;
  let runtimePoolDrained = false;
  let schemaCreated = false;
  const ownerSessions = new Set<OwnerSession>();
  const cleanupErrors: unknown[] = [];
  const documents = new Set<Y.Doc>();

  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(`CREATE TABLE ${stateTable} (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    await controlPool.query(`CREATE TABLE ${backupTable} (LIKE public.collaboration_yjs_state_backups INCLUDING ALL)`);
    await controlPool.query(`CREATE TABLE ${operationTable} (LIKE public.collaboration_agent_operations INCLUDING ALL)`);
    const migrationClient = new Client({ ...poolConfig(databaseUrl, 'canvas-admission-compaction-migration', schema) });
    await migrationClient.connect();
    try {
      assert.equal((await migrationClient.query<{ search_path: string }>('SHOW search_path')).rows[0]?.search_path, schema);
      for (let pass = 0; pass < 2; pass += 1) {
        await migrationClient.query(COLLABORATION_ROOM_OWNER_UP_SQL);
        await migrationClient.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
        for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migrationClient.query(statement);
      }
    } finally { await migrationClient.end(); }

    runtimePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-admission-compaction-runtime', schema), max: 10 });
    runtimePool.on('error', (error) => { poolErrors.push(error); });
    assert.equal((await runtimePool.query<{ search_path: string }>('SHOW search_path')).rows[0]?.search_path, schema);
    const hookContext = new AsyncLocalStorage<ConnectionHooks>();
    const openConnection = createConnectionAdapter(runtimePool, hookContext);
    const { persistence, compaction } = await loadProductionModules(openConnection);
    const admission = createCollaborationAdmissionService({ openConnection });
    const quiescence = createCollaborationAdmissionQuiescenceService({ openConnection });
    const compactionService = compaction.createCollaborationCompactionHandoffService({
      openConnection,
      withMutationLocks: async (workspaceIds, operation) => {
        assert.deepEqual(workspaceIds, ['workspace-compaction']);
        return operation();
      },
    });
    const createOwner = async (label: string) => {
      const client = new Client({ ...poolConfig(databaseUrl, `canvas-admission-compaction-owner-${label}`, schema) });
      await client.connect();
      const session = await createCollaborationRoomOwnerSession(client);
      ownerSessions.add(session);
      return session;
    };
    const ownDocument = (content: string) => {
      const document = createDocument(content);
      documents.add(document);
      return document;
    };
    const seed = async (expected: CollaborationAdmissionDocument, content: string, ownerEpoch = 0) => {
      const document = ownDocument(content);
      const now = 1_700_000_000_000;
      await controlPool.query(`INSERT INTO ${stateTable} (
        document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,
        canonical_hash,serialized_hash,newline_style,has_bom,degraded,status,
        room_owner_epoch,room_owner_token,room_owner_backend_pid,room_owner_backend_start
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$10,0,$11,$11,'lf',0,0,'active',$12,NULL,NULL,NULL)`,
      [expected.documentId, expected.workspaceId, expected.organizationId, expected.path, expected.representation,
        expected.lifecycleGeneration, expected.schemaVersion, Buffer.from(Y.encodeStateAsUpdate(document)),
        Buffer.from(Y.encodeStateVector(document)), now, createHash('sha256').update(content).digest('hex'), ownerEpoch]);
    };
    const readState = async (documentId: string) => {
      const result = await controlPool.query<StateRow>(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0]!;
    };
    const readBackups = async (documentId: string) => (await controlPool.query<BackupRow>(
      `SELECT * FROM ${backupTable} WHERE document_id=$1 ORDER BY created_at`, [documentId],
    )).rows;
    const saveAndRelease = async (session: OwnerSession, fence: CollaborationRoomOwnerFence, content: string) => {
      const document = ownDocument(content);
      const yjsState = Buffer.from(Y.encodeStateAsUpdate(document));
      const stateVector = Buffer.from(Y.encodeStateVector(document));
      const database = await openConnection();
      try {
        await database.run('BEGIN');
        const row = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE',
          [fence.scope.documentId]) as StateRow | undefined;
        assert.ok(row);
        await assertCollaborationRoomOwnerFence(database, row, fence);
        await database.run(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,
          document_sequence=document_sequence+1,checkpoint_sequence=document_sequence+1,
          checkpointed_at=$4,persisted_at=$4,canonical_hash=$5 WHERE document_id=$1`,
        [fence.scope.documentId, yjsState, stateVector, Date.now(), createHash('sha256').update(content).digest('hex')]);
        await database.run('COMMIT');
      } catch (error) {
        await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined);
        throw error;
      } finally { await database.close(); }
      const snapshot: CollaborationRoomReleaseSnapshot = Object.freeze({ releaseId: randomUUID(),
        yjsState: new Uint8Array(yjsState), stateVector: new Uint8Array(stateVector) });
      await session.release(fence, snapshot);
      return snapshot;
    };
    const reserveAndProve = async (input: CollaborationAdmissionRequest) => {
      await admission.reserve(input);
      return quiescence.prove(input, input.expectedDocuments[0]!.documentId);
    };
    const insertPendingOperation = async (expected: CollaborationAdmissionDocument) => {
      const state = await readState(expected.documentId);
      const now = Date.now();
      await controlPool.query(`INSERT INTO ${operationTable} (
        operation_id,document_id,document_path,document_representation,workspace_id,organization_id,
        document_lifecycle_generation,schema_version,initiated_by_user_id,actor_id,idempotency_key,run_generation,
        payload_hash,operation_type,requested_mode,atomicity,status,base_state_vector,base_document_sequence,
        action_keys_json,created_at,updated_at
      ) VALUES ($1,$2,$3,'plain_text',$4,$5,$6,1,'user','agent',$7,1,
        'payload','apply','review','all_or_nothing','preparing',$8,$9,'{}',$10,$10)`,
      [`operation-${expected.documentId}`, expected.documentId, expected.path, expected.workspaceId,
        expected.organizationId, expected.lifecycleGeneration, `key-${expected.documentId}`,
        Buffer.from(state.state_vector), Number(state.document_sequence), now]);
    };

    // The real production core is inaccessible without the exact WeakMap-bound handoff transaction.
    const raw = await openConnection();
    const delegated: SqlConnection = {
      get: raw.get.bind(raw), all: raw.all.bind(raw), run: raw.run.bind(raw), close: raw.close.bind(raw),
    };
    await assert.rejects(persistence.compactCollaborationStateInAdmissionHandoff(raw,
      { documentId: 'outside-handoff', expectedLifecycleGeneration: 1 }), admissionError('ADMISSION_RECOVERY_REQUIRED'));
    await assert.rejects(persistence.compactCollaborationStateInAdmissionHandoff(delegated,
      { documentId: 'outside-handoff', expectedLifecycleGeneration: 1 }), admissionError('ADMISSION_RECOVERY_REQUIRED'));
    await raw.close(new Error('Discarding direct authority probes.'));

    // Floating persistence promises cannot outlive the exact mutation lease, before or after its single-use claim.
    const floatingHandoff = handoffRuntime.createCollaborationAdmissionHandoffService({
      openConnection,
      withMutationLocks: async (_workspaceIds, operation) => operation(),
    });
    const runFloatingCase = async (label: string, blockedQuery: 'state' | 'backup') => {
      const target = expectedDocument(`admission-compaction-floating-${label}`);
      await seed(target, `floating ${label} content`);
      const input = compactionRequest(target);
      await reserveAndProve(input);
      const gateEntered = deferred();
      const releaseGate = deferred();
      const mutateReturned = deferred();
      let floatingStarted = false;
      let mutationReturnedFlag = false;
      let stateUpdatesAfterReturn = 0;
      let detachedError: unknown;
      let detachedHandled: Promise<void> | undefined;
      const hooks: ConnectionHooks = {
        beforeQuery: async (sql) => {
          if (floatingStarted && mutationReturnedFlag && sql.startsWith('UPDATE COLLABORATION_YJS_STATES')) {
            stateUpdatesAfterReturn += 1;
          }
        },
        afterQuery: async (sql) => {
          const matches = blockedQuery === 'state'
            ? sql === 'SELECT * FROM COLLABORATION_YJS_STATES WHERE DOCUMENT_ID = $1 FOR UPDATE'
            : sql.startsWith('INSERT INTO COLLABORATION_YJS_STATE_BACKUPS');
          if (!floatingStarted || !matches) return;
          gateEntered.resolve();
          await releaseGate.promise;
        },
      };
      const execution = hookContext.run(hooks, () => floatingHandoff.execute(input, {
        authorize: async () => undefined,
        prepare: (database) => persistence.prepareCollaborationCompactionAdmission(database, input),
        mutate: async (database) => {
          floatingStarted = true;
          const detached = persistence.compactCollaborationStateInAdmissionHandoff(database,
            { documentId: target.documentId, expectedLifecycleGeneration: target.lifecycleGeneration });
          detachedHandled = detached.then(
            () => { assert.fail('floating compaction unexpectedly completed'); },
            (error: unknown) => { detachedError = error; },
          );
          await gateEntered.promise;
          mutationReturnedFlag = true;
          mutateReturned.resolve();
          return {};
        },
      }));
      const executionHandled = execution.then(
        () => ({ error: undefined as unknown }),
        (error: unknown) => ({ error }),
      );
      await within(Promise.all([gateEntered.promise, mutateReturned.promise]), OPERATION_TIMEOUT_MS,
        `floating ${label} compaction did not reach its controlled query`);
      try {
        const executionResult = await within(executionHandled, OPERATION_TIMEOUT_MS,
          `floating ${label} handoff did not reject`);
        admissionError('ADMISSION_RECOVERY_REQUIRED')(executionResult.error);
      } finally { releaseGate.resolve(); }
      assert.ok(detachedHandled);
      await within(detachedHandled, OPERATION_TIMEOUT_MS, `floating ${label} promise did not settle`);
      assert.ok(detachedError instanceof Error, `floating ${label} promise must reject`);
      assert.equal(stateUpdatesAfterReturn, 0, 'revoked floating compaction cannot reach the state UPDATE');
      assert.equal(Number((await readState(target.documentId)).lifecycle_generation), 1);
      assert.equal((await readBackups(target.documentId)).length, 0);
    };
    await runFloatingCase('preclaim', 'state');
    await runFloatingCase('postclaim', 'backup');

    // Authority cannot transfer to a delegated wrapper, cannot be claimed twice, and expires after mutate returns.
    const transferDocument = expectedDocument('admission-compaction-authority-transfer');
    await seed(transferDocument, 'authority transfer content');
    const transferRequest = compactionRequest(transferDocument);
    await reserveAndProve(transferRequest);
    let escapedDatabase: SqlConnection | undefined;
    await assert.rejects(floatingHandoff.execute(transferRequest, {
      authorize: async () => undefined,
      prepare: (database) => persistence.prepareCollaborationCompactionAdmission(database, transferRequest),
      mutate: async (database) => {
        escapedDatabase = database;
        const wrapper: SqlConnection = {
          get: database.get.bind(database), all: database.all.bind(database),
          run: database.run.bind(database), close: database.close.bind(database),
        };
        await assert.rejects(persistence.compactCollaborationStateInAdmissionHandoff(wrapper,
          { documentId: transferDocument.documentId, expectedLifecycleGeneration: 1 }),
        admissionError('ADMISSION_RECOVERY_REQUIRED'));
        await persistence.compactCollaborationStateInAdmissionHandoff(database,
          { documentId: transferDocument.documentId, expectedLifecycleGeneration: 1 });
        const current = await database.get('SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE',
          [transferDocument.documentId]) as Record<string, unknown>;
        handoffRuntime.claimCollaborationAdmissionMutation(database, 'compact', current);
        return {};
      },
    }), admissionError('ADMISSION_SCOPE_CHANGED'));
    assert.ok(escapedDatabase);
    await assert.rejects(persistence.compactCollaborationStateInAdmissionHandoff(escapedDatabase,
      { documentId: transferDocument.documentId, expectedLifecycleGeneration: 1 }),
    admissionError('ADMISSION_RECOVERY_REQUIRED'));
    assert.equal(Number((await readState(transferDocument.documentId)).lifecycle_generation), 1);
    assert.equal((await readBackups(transferDocument.documentId)).length, 0);

    // Same-vector deletion-only drift inside raw mutate fails the authority's complete-byte snapshot comparison.
    const deletionDocument = expectedDocument('admission-compaction-deletion-drift');
    await seed(deletionDocument, 'delete-me');
    const deletionRequest = compactionRequest(deletionDocument);
    await reserveAndProve(deletionRequest);
    const deletionBefore = await readState(deletionDocument.documentId);
    const deletionYDoc = ownDocument('');
    Y.applyUpdate(deletionYDoc, deletionBefore.yjs_state);
    deletionYDoc.getText('content').delete(0, 1);
    const deletionUpdate = Buffer.from(Y.encodeStateAsUpdate(deletionYDoc));
    const deletionVector = Buffer.from(Y.encodeStateVector(deletionYDoc));
    assert.equal(deletionVector.equals(Buffer.from(deletionBefore.state_vector)), true,
      'deletion-only drift keeps the state vector unchanged');
    assert.equal(deletionUpdate.equals(Buffer.from(deletionBefore.yjs_state)), false,
      'deletion-only drift changes the full update bytes');
    await assert.rejects(floatingHandoff.execute(deletionRequest, {
      authorize: async () => undefined,
      prepare: (database) => persistence.prepareCollaborationCompactionAdmission(database, deletionRequest),
      mutate: async (database) => {
        await database.run('UPDATE collaboration_yjs_states SET yjs_state=$2 WHERE document_id=$1',
          [deletionDocument.documentId, deletionUpdate]);
        await persistence.compactCollaborationStateInAdmissionHandoff(database,
          { documentId: deletionDocument.documentId, expectedLifecycleGeneration: 1 });
        return {};
      },
    }), admissionError('ADMISSION_STATE_CHANGED'));
    const deletionAfter = await readState(deletionDocument.documentId);
    assert.deepEqual(Buffer.from(deletionAfter.yjs_state), Buffer.from(deletionBefore.yjs_state));
    assert.deepEqual(Buffer.from(deletionAfter.state_vector), Buffer.from(deletionBefore.state_vector));
    assert.equal((await readBackups(deletionDocument.documentId)).length, 0);

    // Owner-era normal-release proof compacts real Yjs state and preserves the exact predecessor backup.
    const happyDocument = expectedDocument('admission-compaction-happy');
    await seed(happyDocument, 'pre-owner content');
    const happyOwner = await createOwner('happy');
    const happyFence = await happyOwner.acquire({ ...happyDocument });
    const happySnapshot = await saveAndRelease(happyOwner, happyFence, 'durable compacted text');
    const happyRequest = compactionRequest(happyDocument);
    const happyProof = await reserveAndProve(happyRequest);
    assert.equal(happyProof.kind, 'normal_release');
    const executionInput = JSON.parse(JSON.stringify(happyRequest)) as CollaborationAdmissionRequest;
    let happyAuthorizations = 0;
    const happyExecution = compactionService.execute(executionInput, {
      authorize: async () => { happyAuthorizations += 1; },
    });
    (executionInput as { actionPayloadText?: string }).actionPayloadText = '{}';
    const happyOutcome = await within(happyExecution, OPERATION_TIMEOUT_MS, 'admission compaction did not complete');
    assert.equal(happyAuthorizations, 2, 'authorization repeats after transaction-bound path and operation locks');
    assert.equal(happyOutcome.result.documentId, happyDocument.documentId);
    assert.equal(happyOutcome.result.lifecycleGeneration, '2');
    assert.equal(happyOutcome.result.documentSequence, '2');
    assert.match(happyOutcome.result.backupId!, /^[0-9a-f-]{36}$/u);
    const happyState = await readState(happyDocument.documentId);
    assert.equal(Number(happyState.lifecycle_generation), 2);
    assert.equal(Number(happyState.document_sequence), 2);
    assert.equal(Number(happyState.checkpoint_sequence), 2);
    assert.equal(Number(happyState.room_owner_epoch), happyFence.epoch);
    assert.equal(textFromUpdate(happyState.yjs_state), 'durable compacted text');
    const happyBackups = await readBackups(happyDocument.documentId);
    assert.equal(happyBackups.length, 1);
    assert.equal(happyBackups[0]?.backup_id, happyOutcome.result.backupId);
    assert.equal(happyBackups[0]?.reason, 'compaction');
    assert.equal(Number(happyBackups[0]?.lifecycle_generation), 1);
    assert.equal(Number(happyBackups[0]?.document_sequence), 1);
    assert.deepEqual(Buffer.from(happyBackups[0]!.yjs_state), Buffer.from(happySnapshot.yjsState));
    assert.deepEqual(Buffer.from(happyBackups[0]!.state_vector), Buffer.from(happySnapshot.stateVector));
    const retryOutcome = await compactionService.execute(happyRequest, {
      authorize: async () => { happyAuthorizations += 1; },
    });
    assert.deepEqual(retryOutcome, happyOutcome);
    assert.equal(happyAuthorizations, 3, 'completed retry authorizes once and bypasses mutation preparation');
    assert.equal((await readBackups(happyDocument.documentId)).length, 1);

    // The legacy public compactor and quiescence proof both reject unproven owner-era state.
    const legacyDocument = expectedDocument('admission-compaction-legacy-owner');
    await seed(legacyDocument, 'legacy owner bytes', 1);
    await assert.rejects(persistence.compactCollaborationState({ documentId: legacyDocument.documentId,
      expectedLifecycleGeneration: 1 }), persistenceError(persistence, 'room_active'));
    const legacyRequest = compactionRequest(legacyDocument);
    await admission.reserve(legacyRequest);
    await assert.rejects(quiescence.prove(legacyRequest, legacyDocument.documentId),
      admissionError('ADMISSION_RECOVERY_REQUIRED'));
    assert.equal((await readBackups(legacyDocument.documentId)).length, 0);

    // Pending operations reject before state mutation; a terminal transition permits the exact retry.
    const pendingDocument = expectedDocument('admission-compaction-pending');
    await seed(pendingDocument, 'pending operation content');
    const pendingRequest = compactionRequest(pendingDocument);
    await reserveAndProve(pendingRequest);
    await insertPendingOperation(pendingDocument);
    await assert.rejects(compactionService.execute(pendingRequest, { authorize: async () => undefined }),
      persistenceError(persistence, 'agent_operation_pending'));
    assert.equal(Number((await readState(pendingDocument.documentId)).lifecycle_generation), 1);
    assert.equal((await readBackups(pendingDocument.documentId)).length, 0);
    await controlPool.query(`UPDATE ${operationTable} SET status='cancelled' WHERE document_id=$1`,
      [pendingDocument.documentId]);
    const pendingRetry = await compactionService.execute(pendingRequest, { authorize: async () => undefined });
    assert.equal(pendingRetry.result.lifecycleGeneration, '2');
    assert.equal((await readBackups(pendingDocument.documentId)).length, 1);

    // A rejected COMMIT rolls the backup and state rewrite back; the same request can then succeed exactly once.
    const rejectedDocument = expectedDocument('admission-compaction-rejected-commit');
    await seed(rejectedDocument, 'rejected commit content');
    const rejectedRequest = compactionRequest(rejectedDocument);
    await reserveAndProve(rejectedRequest);
    const rejectedHooks: ConnectionHooks = { commitFault: { position: 'before', remaining: 1 } };
    await assert.rejects(hookContext.run(rejectedHooks, () => compactionService.execute(rejectedRequest,
      { authorize: async () => undefined })), admissionError('ADMISSION_RECOVERY_REQUIRED'));
    assert.equal(rejectedHooks.connections, 3);
    assert.equal(Number((await readState(rejectedDocument.documentId)).lifecycle_generation), 1);
    assert.equal((await readBackups(rejectedDocument.documentId)).length, 0);
    const rejectedRetry = await compactionService.execute(rejectedRequest, { authorize: async () => undefined });
    assert.equal(rejectedRetry.result.lifecycleGeneration, '2');
    assert.equal((await readBackups(rejectedDocument.documentId)).length, 1);

    // A committed-but-lost response recovers the immutable outcome after the old backend ends and a new owner claims.
    const lostDocument = expectedDocument('admission-compaction-lost-commit');
    await seed(lostDocument, 'lost commit before owner');
    const lostOwner = await createOwner('lost-old');
    const lostFence = await lostOwner.acquire({ ...lostDocument });
    await saveAndRelease(lostOwner, lostFence, 'lost commit durable content');
    const lostRequest = compactionRequest(lostDocument);
    await reserveAndProve(lostRequest);
    let mutationBackendClosed = false;
    let replacementFence: CollaborationRoomOwnerFence | undefined;
    const lostHooks: ConnectionHooks = {
      commitFault: { position: 'after', remaining: 1 },
      onClose: (error, ordinal) => { if (ordinal === 2 && error) mutationBackendClosed = true; },
      onOpen: async (ordinal) => {
        if (ordinal !== 3) return;
        assert.equal(mutationBackendClosed, true, 'recovery starts only after the uncertain backend is discarded');
        const replacement = await createOwner('lost-replacement');
        replacementFence = await replacement.acquire({ ...lostDocument, lifecycleGeneration: 2 });
      },
    };
    const lostOutcome = await hookContext.run(lostHooks, () => compactionService.execute(lostRequest,
      { authorize: async () => undefined }));
    assert.equal(lostHooks.connections, 3);
    assert.equal(lostOutcome.result.lifecycleGeneration, '2');
    assert.ok(replacementFence);
    assert.ok(replacementFence.epoch > lostFence.epoch);
    assert.equal(textFromUpdate((await readState(lostDocument.documentId)).yjs_state), 'lost commit durable content');
    assert.equal((await readBackups(lostDocument.documentId)).length, 1);

    assert.equal(poolErrors.length, 0, 'admission-compaction pools must not emit background errors');
    console.log('Collaboration admission compaction PostgreSQL: 12 bounded boundaries passed—exact handoff authority, '
      + 'delegation/escape/double-claim rejection, pre- and post-claim floating-promise revocation, deletion-only drift, '
      + 'real owner-era backup/compaction, '
      + 'immutable capture and completed retry, legacy owner fencing, '
      + 'pending-operation rollback/retry, rejected-COMMIT rollback, and lost-COMMIT recovery after replacement claim—'
      + 'in one isolated generated schema.');
  } finally {
    for (const session of ownerSessions) {
      try { await within(session.close(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission-compaction owner session.'); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const document of documents) document.destroy();
    if (runtimePool) {
      try {
        await within(runtimePool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining admission-compaction runtime pool.');
        runtimePoolDrained = true;
      } catch (error) { cleanupErrors.push(error); }
    }
    if (schemaCreated && (!runtimePool || runtimePoolDrained)) {
      try { await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining admission-compaction control pool.'); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Admission-compaction cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration admission-compaction PostgreSQL test skipped: guarded managed database environment is not configured.');
} else {
  run(databaseUrl).catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
}
