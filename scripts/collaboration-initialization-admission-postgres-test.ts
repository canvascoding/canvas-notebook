import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client, Pool } from 'pg';
import ts from 'typescript';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import * as compactionContractRuntime from '../app/lib/collaboration/compaction-contract';
import * as handoffRuntime from '../app/lib/collaboration/room-admission-handoff';
import * as roomAdmissionRuntime from '../app/lib/collaboration/room-admission';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import * as admissionContractRuntime from '../app/lib/collaboration/room-admission-contract';
import {
  collaborationAdmissionActionDigest,
  CollaborationAdmissionError,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
  type CollaborationAdmissionScope,
} from '../app/lib/collaboration/room-admission-contract';
import * as roomOwnerRuntime from '../app/lib/collaboration/room-owner';
import {
  ensureCollaborationDocument,
  updateCollaborationDocumentCheckpoint,
} from '../app/lib/files/collaboration-repository/document-repository';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const SCHEMA_PREFIX = 'canvas_initialization_admission_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type PersistenceState = {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  representation: 'plain_text';
  lifecycleGeneration: number;
  schemaVersion: number;
  yjsState: Uint8Array;
  stateVector: Uint8Array;
  documentSequence: number;
  checkpointSequence: number;
  persistedAt: number;
  checkpointedAt: number | null;
  status: 'active' | 'archived';
};
type PersistenceModule = {
  CollaborationStateInactiveError: new (...args: never[]) => Error;
  ensureCollaborationState(input: StateInput): Promise<PersistenceState>;
  loadCollaborationState(documentId: string): Promise<PersistenceState | null>;
  loadCollaborationStateIncludingArchived(documentId: string): Promise<PersistenceState | null>;
};
type StateInput = {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  representation: 'plain_text';
  initialContent: string;
};
type QueryHooks = {
  connections?: number;
  backendPids?: number[];
  beforeQuery?: (sql: string, ordinal: number, backendPid: number) => Promise<void>;
  afterQuery?: (sql: string, ordinal: number, backendPid: number) => Promise<void>;
  commitFault?: { ordinal: number; position: 'before' | 'after'; remaining: number };
  closeFault?: { ordinal: number; remaining: number };
  writes?: number;
};
type Gate = { promise: Promise<void>; resolve: () => void };

function deferred(): Gate {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
}

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try { parsed = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('Initialization-admission PostgreSQL test refused a malformed DATABASE_URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433' || databaseName !== 'canvas_notebook') {
    throw new Error('Initialization-admission test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) throw new Error('Refusing SQL outside the generated initialization namespace.');
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

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
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

async function verifyManagedPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{ database_name: string; server_version_num: string;
    state_table: boolean; document_table: boolean }>(`SELECT current_database() AS database_name,
      current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS state_table,
      to_regclass('public.collaboration_documents') IS NOT NULL AS document_table`);
  const row = result.rows[0];
  if (!row || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18 || !row.state_table || !row.document_table) {
    throw new Error('Initialization-admission test refused a server outside managed PG18.');
  }
}

function createConnectionAdapter(pool: Pool, hookContext: AsyncLocalStorage<QueryHooks>) {
  return async (): Promise<SqlConnection> => {
    const client = await pool.connect();
    const backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid')).rows[0]!.pid;
    const hooks = hookContext.getStore();
    const ordinal = hooks ? (hooks.connections = (hooks.connections ?? 0) + 1) : 0;
    if (hooks) (hooks.backendPids ??= []).push(backendPid);
    let closed = false;
    const query = async (sql: string, params: unknown[] = []) => {
      const normalized = normalizedSql(sql);
      await hooks?.beforeQuery?.(normalized, ordinal, backendPid);
      if (normalized === 'COMMIT' && hooks?.commitFault?.ordinal === ordinal
        && hooks.commitFault.position === 'before' && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining -= 1;
        throw new Error('Injected rejected initialization COMMIT.');
      }
      if (/^(?:INSERT|UPDATE|DELETE) /u.test(normalized) && hooks) hooks.writes = (hooks.writes ?? 0) + 1;
      const result = await client.query(sql, params);
      await hooks?.afterQuery?.(normalized, ordinal, backendPid);
      if (normalized === 'COMMIT' && hooks?.commitFault?.ordinal === ordinal
        && hooks.commitFault.position === 'after' && hooks.commitFault.remaining > 0) {
        hooks.commitFault.remaining -= 1;
        throw new Error('Injected lost initialization COMMIT reply.');
      }
      return result;
    };
    return {
      get: async (sql, params = []) => (await query(sql, params)).rows[0],
      all: async (sql, params = []) => (await query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
      close: async (error) => {
        assert.equal(closed, false, 'initialization SQL connection closed twice');
        closed = true;
        client.release(error);
        if (hooks?.closeFault?.ordinal === ordinal && hooks.closeFault.remaining > 0) {
          hooks.closeFault.remaining -= 1;
          throw new Error('Injected initialization connection discard failure.');
        }
      },
    };
  };
}

async function loadPersistence(openDb: () => Promise<SqlConnection>): Promise<PersistenceModule> {
  const filename = path.resolve('app/lib/collaboration/persistence.ts');
  const runtimeRequire = createRequire(filename);
  const compile = async (relative: string, mocks: Record<string, unknown>) => {
    const moduleFilename = path.resolve(relative);
    const source = ts.transpileModule(await readFile(moduleFilename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const compiledModule = { exports: {} as Record<string, unknown> };
    new Function('require', 'module', 'exports', source)((name: string) =>
      Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : createRequire(moduleFilename)(name),
    compiledModule, compiledModule.exports);
    return compiledModule.exports;
  };
  const merge = await compile('app/lib/collaboration/persistence-merge.ts', { './server-runtime': { Y } });
  const transaction = await compile('app/lib/collaboration/lifecycle-transaction.ts', { 'server-only': {} });
  const createTextDocument = (content: string) => {
    const document = new Y.Doc();
    document.getText('content').insert(0, content);
    return document;
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
      analyzeMarkdownRichMode: () => ({ mode: 'normalizable', prefix: '', normalizedBody: 'normalized' }),
    },
    './types': { isRichTextCollaborationRepresentation: (value: string) => value !== 'plain_text' },
    './markdown-state': {
      createPlainTextYDoc: createTextDocument, createRichMarkdownYDoc: createTextDocument,
      convertRichMarkdownYDoc: (document: Y.Doc) => document,
      richMarkdownFromYDoc: (document: Y.Doc) => document.getText('content').toString(),
      validateRichMarkdownYDoc: (document: Y.Doc) => ({ valid: true, markdown: document.getText('content').toString() }),
    },
    './runtime-state': {
      getCollaborationRoomConnectionCount: () => 0,
      withCollaborationRoomLifecycleLock: async (_documentId: string, operation: () => Promise<unknown>) => operation(),
    },
    './server-runtime': { Y },
    './persistence-merge': merge,
    './room-owner': roomOwnerRuntime,
    './lifecycle-transaction': transaction,
    './room-admission-handoff': handoffRuntime,
    './compaction-contract': compactionContractRuntime,
    './room-admission-contract': admissionContractRuntime,
    './room-admission': roomAdmissionRuntime,
  };
  const source = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', source)((name: string) =>
    Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : runtimeRequire(name),
  compiledModule, compiledModule.exports);
  return compiledModule.exports as PersistenceModule;
}

function workspace(workspaceId: string, organizationId = `organization-${workspaceId}`): WorkspaceContext {
  return { workspaceId, workspaceType: 'organization', organizationId, customerId: null, projectId: null,
    rootPath: `/test-only/${workspaceId}`, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: false, canRunAgent: false } };
}

function stateInput(documentId: string, workspaceId: string, filePath: string,
  organizationId = `organization-${workspaceId}`): StateInput {
  return { documentId, workspaceId, organizationId, path: filePath,
    representation: 'plain_text', initialContent: `content:${documentId}` };
}

function admissionDocument(input: StateInput, status: 'active' | 'archived' = 'active'): CollaborationAdmissionDocument {
  return { documentId: input.documentId, workspaceId: input.workspaceId, organizationId: input.organizationId,
    path: input.path, representation: input.representation, lifecycleGeneration: 1, schemaVersion: 1, status };
}

function admissionRequest(scopes: readonly CollaborationAdmissionScope[],
  expectedDocuments: readonly CollaborationAdmissionDocument[] = []): CollaborationAdmissionRequest {
  const actionPayloadText = JSON.stringify({ version: 1, purpose: 'initialization-admission-test' });
  return { requestId: randomUUID(), actorId: 'actor-initialization', action: 'copy_replace', actionPayloadText,
    actionDigest: collaborationAdmissionActionDigest('copy_replace', actionPayloadText), scopes, expectedDocuments };
}

function admissionConflict(error: unknown): boolean {
  assert.ok(error instanceof CollaborationAdmissionError);
  assert.equal(error.code, 'ADMISSION_CONFLICT');
  return true;
}

async function waitForBlocked(pool: Pool, backendPid: number, label: string): Promise<void> {
  await within((async () => {
    for (;;) {
      const result = await pool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [backendPid]);
      if (result.rows[0]?.blocked) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  })(), OPERATION_TIMEOUT_MS, `${label} did not block on the admission guard`);
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const documentTable = `${schemaSql}.collaboration_documents`;
  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-initialization-admission-control'), max: 5 });
  const poolErrors: Error[] = [];
  controlPool.on('error', (error) => { poolErrors.push(error); });
  let runtimePool: Pool | undefined;
  let runtimePoolDrained = false;
  let schemaCreated = false;
  const cleanupErrors: unknown[] = [];
  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(`CREATE TABLE ${stateTable} (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    await controlPool.query(`CREATE TABLE ${documentTable} (LIKE public.collaboration_documents INCLUDING ALL)`);
    const migration = new Client({ ...poolConfig(databaseUrl, 'canvas-initialization-admission-migration', schema) });
    await migration.connect();
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        await migration.query(COLLABORATION_ROOM_OWNER_UP_SQL);
        await migration.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
        for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migration.query(statement);
      }
    } finally { await migration.end(); }

    runtimePool = new Pool({ ...poolConfig(databaseUrl, 'canvas-initialization-admission-runtime', schema), max: 16 });
    runtimePool.on('error', (error) => { poolErrors.push(error); });
    const hookContext = new AsyncLocalStorage<QueryHooks>();
    const openConnection = createConnectionAdapter(runtimePool, hookContext);
    const persistence = await loadPersistence(openConnection);
    const admission = createCollaborationAdmissionService({ openConnection });
    const withTransaction = async <T>(operation: (database: SqlConnection) => Promise<T>): Promise<T> => {
      const database = await openConnection();
      try {
        await database.run('BEGIN');
        const value = await operation(database);
        await database.run('COMMIT');
        return value;
      } catch (error) {
        await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined);
        throw error;
      } finally { await database.close(); }
    };
    const ensureDocument = (input: StateInput, nowMs = Date.now()) => withTransaction((database) =>
      ensureCollaborationDocument(database, { id: input.documentId, lineageId: `lineage-${input.documentId}`,
        workspace: workspace(input.workspaceId, input.organizationId ?? undefined), path: input.path, provider: 'yjs',
        snapshotRevisionId: `revision-${input.documentId}`, nowMs }));
    const readStateRow = async (documentId: string) => (await controlPool.query<Record<string, unknown>>(
      `SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId])).rows[0];
    const readDocumentRows = async (workspaceId: string, filePath: string) => (await controlPool.query<Record<string, unknown>>(
      `SELECT * FROM ${documentTable} WHERE workspace_id=$1 AND path=$2 ORDER BY created_at`,
      [workspaceId, filePath])).rows;

    // Initializers commit first: reservation waits on the same workspace guard and captures the exact durable state.
    const first = stateInput('initialization-first', 'workspace-first', 'notes/first.md');
    await ensureDocument(first, 100);
    const stateInsertEntered = deferred();
    const releaseStateInsert = deferred();
    const stateHooks: QueryHooks = { beforeQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_YJS_STATES')) return;
      stateInsertEntered.resolve();
      await releaseStateInsert.promise;
    } };
    const firstStatePromise = hookContext.run(stateHooks, () => persistence.ensureCollaborationState(first));
    const firstStateHandled = firstStatePromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    try {
      await within(stateInsertEntered.promise, OPERATION_TIMEOUT_MS, 'state initializer did not reach INSERT');
    } catch (error) {
      releaseStateInsert.resolve();
      await firstStateHandled;
      throw error;
    }
    const firstRequest = admissionRequest([{ workspaceId: first.workspaceId,
      organizationId: first.organizationId, path: first.path, kind: 'exact' }], [admissionDocument(first)]);
    const reserveHooks: QueryHooks = {};
    const reservePromise = hookContext.run(reserveHooks, () => admission.reserve(firstRequest));
    const reserveHandled = reservePromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    let firstRaceError: unknown;
    try {
      await within((async () => {
        while (!reserveHooks.backendPids?.[0]) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      })(), OPERATION_TIMEOUT_MS, 'reservation connection did not open');
      await waitForBlocked(controlPool, reserveHooks.backendPids![0]!, 'reservation behind state initializer');
    } catch (error) { firstRaceError = error; }
    finally { releaseStateInsert.resolve(); }
    const firstStateResult = await firstStateHandled;
    if (firstStateResult.error) throw firstStateResult.error;
    const firstReservationResult = await reserveHandled;
    if (firstReservationResult.error) throw firstReservationResult.error;
    if (firstRaceError) throw firstRaceError;
    assert.equal(firstReservationResult.value?.targets.length, 1);
    assert.equal(firstReservationResult.value?.targets[0]?.document.documentId, first.documentId);
    assert.equal((await readDocumentRows(first.workspaceId, first.path)).length, 1);

    // Reservation commits first: both missing metadata and missing Yjs state wait, then fail without partial rows.
    const blocked = stateInput('initialization-blocked', 'workspace-blocked', 'notes/blocked.md');
    const blockedRequest = admissionRequest([{ workspaceId: blocked.workspaceId,
      organizationId: blocked.organizationId, path: blocked.path, kind: 'exact' }]);
    const reserveInserted = deferred();
    const releaseReserve = deferred();
    const blockedReserveHooks: QueryHooks = { afterQuery: async (sql) => {
      if (!sql.startsWith('INSERT INTO COLLABORATION_ADMISSION_SCOPES')) return;
      reserveInserted.resolve();
      await releaseReserve.promise;
    } };
    const blockedReservePromise = hookContext.run(blockedReserveHooks, () => admission.reserve(blockedRequest));
    const blockedReserveHandled = blockedReservePromise.then((value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }));
    try {
      await within(reserveInserted.promise, OPERATION_TIMEOUT_MS, 'reservation did not reach its controlled INSERT');
    } catch (error) {
      releaseReserve.resolve();
      await blockedReserveHandled;
      throw error;
    }
    const blockedDocumentHooks: QueryHooks = {};
    const blockedStateHooks: QueryHooks = {};
    const blockedDocumentPromise = hookContext.run(blockedDocumentHooks, () => ensureDocument(blocked));
    const blockedStatePromise = hookContext.run(blockedStateHooks, () => persistence.ensureCollaborationState(blocked));
    const blockedDocumentHandled = blockedDocumentPromise.then(() => ({ error: undefined as unknown }),
      (error: unknown) => ({ error }));
    const blockedStateHandled = blockedStatePromise.then(() => ({ error: undefined as unknown }),
      (error: unknown) => ({ error }));
    let blockedRaceError: unknown;
    try {
      await within((async () => {
        while (!blockedDocumentHooks.backendPids?.[0] || !blockedStateHooks.backendPids?.[1]) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      })(), OPERATION_TIMEOUT_MS, 'initializer connections did not open');
      await Promise.all([
        waitForBlocked(controlPool, blockedDocumentHooks.backendPids![0]!, 'metadata initializer'),
        waitForBlocked(controlPool, blockedStateHooks.backendPids![1]!, 'state initializer'),
      ]);
    } catch (error) { blockedRaceError = error; }
    finally { releaseReserve.resolve(); }
    const blockedReservation = await blockedReserveHandled;
    if (blockedReservation.error) throw blockedReservation.error;
    admissionConflict((await blockedDocumentHandled).error);
    admissionConflict((await blockedStateHandled).error);
    if (blockedRaceError) throw blockedRaceError;
    assert.equal((await readDocumentRows(blocked.workspaceId, blocked.path)).length, 0);
    assert.equal(await readStateRow(blocked.documentId), undefined);

    // Cancelling the exact reservation restores liveness for the same immutable initializer inputs.
    await admission.cancel(blockedRequest, blockedReservation.value!.revision);
    const unblockedDocument = await ensureDocument(blocked, 200);
    const unblockedState = await persistence.ensureCollaborationState(blocked);
    assert.equal(unblockedDocument.id, blocked.documentId);
    assert.equal(unblockedState.documentId, blocked.documentId);

    // Existing identities remain usable during a later reservation; state reads do not rewrite durable bytes or clocks.
    const existingRequest = admissionRequest([{ workspaceId: blocked.workspaceId,
      organizationId: blocked.organizationId, path: blocked.path, kind: 'exact' }], [admissionDocument(blocked)]);
    await admission.reserve(existingRequest);
    const stateBeforeExistingRead = await readStateRow(blocked.documentId);
    const existingState = await persistence.ensureCollaborationState({ ...blocked, initialContent: 'must-not-win' });
    const stateAfterExistingRead = await readStateRow(blocked.documentId);
    assert.equal(existingState.documentSequence, 0);
    assert.deepEqual(stateAfterExistingRead, stateBeforeExistingRead,
      'existing-state ensure is a read and performs no post-commit rewrite');
    const existingDocument = await ensureDocument(blocked, 300);
    assert.equal(existingDocument.id, blocked.documentId);
    const checkpoint = await withTransaction((database) => updateCollaborationDocumentCheckpoint(database, {
      workspaceId: blocked.workspaceId, path: blocked.path, documentId: blocked.documentId,
      stateVersion: 1, revisionId: 'checkpoint-existing', nowMs: 301,
    }));
    assert.equal(checkpoint?.stateVersion, 1);
    assert.equal(checkpoint?.snapshotRevisionId, 'checkpoint-existing');

    // SQL path matching is literal: %, _, and sibling prefixes cannot widen an exact or subtree reservation.
    const literal = stateInput('initialization-literal', 'workspace-literal', 'folder/%_literal.md');
    const literalRequest = admissionRequest([{ workspaceId: literal.workspaceId,
      organizationId: literal.organizationId, path: literal.path, kind: 'exact' }]);
    await admission.reserve(literalRequest);
    await assert.rejects(ensureDocument(literal), admissionConflict);
    await assert.rejects(persistence.ensureCollaborationState(literal), admissionConflict);
    const literalSibling = stateInput('initialization-literal-sibling', literal.workspaceId, 'folder/XXliteral.md');
    await ensureDocument(literalSibling);
    await persistence.ensureCollaborationState(literalSibling);

    const prefix = stateInput('initialization-prefix', 'workspace-prefix', 'a/blocked.md');
    const prefixRequest = admissionRequest([{ workspaceId: prefix.workspaceId,
      organizationId: prefix.organizationId, path: 'a', kind: 'subtree' }]);
    await admission.reserve(prefixRequest);
    await assert.rejects(persistence.ensureCollaborationState(prefix), admissionConflict);
    const prefixSibling = stateInput('initialization-prefix-sibling', prefix.workspaceId, 'ab/allowed.md');
    await persistence.ensureCollaborationState(prefixSibling);
    const rootBlocked = stateInput('initialization-root', 'workspace-root', 'deep/path/note.md');
    const rootRequest = admissionRequest([{ workspaceId: rootBlocked.workspaceId,
      organizationId: rootBlocked.organizationId, path: '', kind: 'subtree' }]);
    await admission.reserve(rootRequest);
    await assert.rejects(ensureDocument(rootBlocked), admissionConflict);
    await assert.rejects(persistence.ensureCollaborationState(rootBlocked), admissionConflict);

    // Archived and mismatched durable identities cannot be revived or replaced by initialization.
    const archived = stateInput('initialization-archived', 'workspace-archived', 'archive.md');
    await ensureDocument(archived, 400);
    await persistence.ensureCollaborationState(archived);
    await controlPool.query(`UPDATE ${documentTable} SET status='archived' WHERE id=$1`, [archived.documentId]);
    await controlPool.query(`UPDATE ${stateTable} SET status='archived' WHERE document_id=$1`, [archived.documentId]);
    const archivedRequest = admissionRequest([{ workspaceId: archived.workspaceId,
      organizationId: archived.organizationId, path: archived.path, kind: 'exact' }],
    [admissionDocument(archived, 'archived')]);
    const archivedReservation = await admission.reserve(archivedRequest);
    await assert.rejects(ensureDocument(archived), admissionConflict);
    await assert.rejects(persistence.ensureCollaborationState(archived),
      (error: unknown) => error instanceof persistence.CollaborationStateInactiveError);
    assert.equal((await readDocumentRows(archived.workspaceId, archived.path)).length, 1);
    await admission.cancel(archivedRequest, archivedReservation.revision);
    await assert.rejects(ensureDocument(archived),
      (error: unknown) => (error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_SCOPE_CHANGED')
        || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'));
    const archivedReplacement = { ...archived, documentId: 'initialization-archived-replacement' };
    assert.equal((await ensureDocument(archivedReplacement, 401)).id, archivedReplacement.documentId,
      'a genuinely new file identity may reuse the old path after delete admission is complete');

    const mismatched = stateInput('initialization-mismatch', 'workspace-mismatch', 'mismatch.md');
    await ensureDocument(mismatched, 500);
    await persistence.ensureCollaborationState(mismatched);
    const mismatchDocumentBefore = (await readDocumentRows(mismatched.workspaceId, mismatched.path))[0];
    await assert.rejects(ensureDocument({ ...mismatched, organizationId: 'wrong-organization' }),
      (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_SCOPE_CHANGED');
    await assert.rejects(withTransaction((database) => ensureCollaborationDocument(database, {
      id: mismatched.documentId, lineageId: 'wrong-lineage', workspace: workspace(mismatched.workspaceId,
        mismatched.organizationId ?? undefined), path: mismatched.path, provider: 'yjs', nowMs: 501,
    })), (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_SCOPE_CHANGED');
    await assert.rejects(persistence.ensureCollaborationState({ ...mismatched, path: 'other.md' }),
      /identity, lifecycle, or representation/u);
    assert.equal((await readDocumentRows(mismatched.workspaceId, mismatched.path)).length, 1);
    assert.deepEqual((await readDocumentRows(mismatched.workspaceId, mismatched.path))[0], mismatchDocumentBefore,
      'organization and lineage mismatches leave the active metadata row byte-for-byte unchanged');

    // An active metadata hit archived after its SELECT cannot fall through to a replacement INSERT.
    const archiveRace = stateInput('initialization-metadata-archive-race', 'workspace-metadata-race', 'archive-race.md');
    await ensureDocument(archiveRace, 600);
    let archivedAfterRead = false;
    const archiveRaceHooks: QueryHooks = { afterQuery: async (sql) => {
      if (archivedAfterRead || !sql.startsWith('SELECT * FROM COLLABORATION_DOCUMENTS')) return;
      archivedAfterRead = true;
      await controlPool.query(`UPDATE ${documentTable} SET status='archived',updated_at=601 WHERE id=$1`,
        [archiveRace.documentId]);
    } };
    await assert.rejects(hookContext.run(archiveRaceHooks, () => ensureDocument(archiveRace, 602)),
      (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_SCOPE_CHANGED');
    const archiveRaceRows = await readDocumentRows(archiveRace.workspaceId, archiveRace.path);
    assert.equal(archiveRaceRows.length, 1);
    assert.equal(archiveRaceRows[0]?.id, archiveRace.documentId);
    assert.equal(archiveRaceRows[0]?.status, 'archived');

    // A foreign lineage inserted after a missing read wins canonically; DO NOTHING fallback never adopts or rewrites it.
    const fallbackRace = stateInput('initialization-metadata-fallback-race', 'workspace-fallback-race', 'fallback.md');
    const foreignId = 'initialization-metadata-foreign-winner';
    let foreignInserted = false;
    const fallbackRaceHooks: QueryHooks = { afterQuery: async (sql) => {
      if (foreignInserted || !sql.startsWith('SELECT * FROM COLLABORATION_DOCUMENTS')) return;
      foreignInserted = true;
      await controlPool.query(`INSERT INTO ${documentTable} (
        id,organization_id,customer_id,project_id,workspace_id,workspace_type,path,lineage_id,provider,
        state_version,snapshot_revision_id,status,created_at,updated_at
      ) VALUES ($1,$2,NULL,NULL,$3,'organization',$4,'foreign-lineage','yjs',0,NULL,'active',700,700)`,
      [foreignId, fallbackRace.organizationId, fallbackRace.workspaceId, fallbackRace.path]);
    } };
    await assert.rejects(hookContext.run(fallbackRaceHooks, () => ensureDocument(fallbackRace, 701)),
      (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_SCOPE_CHANGED');
    const fallbackRaceRows = await readDocumentRows(fallbackRace.workspaceId, fallbackRace.path);
    assert.equal(fallbackRaceRows.length, 1);
    assert.equal(fallbackRaceRows[0]?.id, foreignId);
    assert.equal(fallbackRaceRows[0]?.lineage_id, 'foreign-lineage');
    assert.equal(Number(fallbackRaceRows[0]?.updated_at), 700);

    // Rejected COMMIT has no row and the same input remains live on an exact retry.
    const rejected = stateInput('initialization-rejected-commit', 'workspace-rejected', 'rejected.md');
    const rejectedHooks: QueryHooks = { commitFault: { ordinal: 2, position: 'before', remaining: 1 } };
    await assert.rejects(hookContext.run(rejectedHooks, () => persistence.ensureCollaborationState(rejected)),
      /Injected rejected initialization COMMIT/u);
    assert.equal(await readStateRow(rejected.documentId), undefined);
    const rejectedRetry = await persistence.ensureCollaborationState(rejected);
    assert.equal(rejectedRetry.documentId, rejected.documentId);

    // Lost COMMIT is recovered by a fresh read after discard, without issuing a second state write.
    const lost = stateInput('initialization-lost-commit', 'workspace-lost', 'lost.md');
    const lostHooks: QueryHooks = { commitFault: { ordinal: 2, position: 'after', remaining: 1 } };
    const lostState = await hookContext.run(lostHooks, () => persistence.ensureCollaborationState(lost));
    assert.equal(lostState.documentId, lost.documentId);
    assert.equal(lostHooks.connections, 3);
    assert.equal(lostHooks.writes, 1, 'lost COMMIT recovery performs one INSERT and a read-only proof');

    // A failed discard suppresses recovery; a later ordinary ensure only reads the already committed canonical row.
    const discard = stateInput('initialization-discard-failure', 'workspace-discard', 'discard.md');
    const discardHooks: QueryHooks = {
      commitFault: { ordinal: 2, position: 'after', remaining: 1 }, closeFault: { ordinal: 2, remaining: 1 },
    };
    await assert.rejects(hookContext.run(discardHooks, () => persistence.ensureCollaborationState(discard)), AggregateError);
    assert.equal(discardHooks.connections, 2, 'failed discard opens no recovery connection');
    const committedDiscardRow = await readStateRow(discard.documentId);
    assert.ok(committedDiscardRow);
    const retryReadHooks: QueryHooks = {};
    const discardRetry = await hookContext.run(retryReadHooks, () => persistence.ensureCollaborationState(discard));
    assert.equal(discardRetry.documentId, discard.documentId);
    assert.equal(retryReadHooks.connections, 1);
    assert.equal(retryReadHooks.writes ?? 0, 0, 'post-commit retry is read-only and never rewrites the state');

    assert.equal(poolErrors.length, 0, 'initialization-admission pools must not emit background errors');
    console.log('Collaboration initialization admission PostgreSQL: 13 bounded boundaries passed—both race orders, '
      + 'exact reservation capture, cancellation liveness, existing checkpoint/state availability, literal and subtree '
      + 'scope matching, archived/mismatched identity fences, active-hit/archive and missing-hit/foreign-lineage metadata '
      + 'races, and rejected/lost/discard-failed COMMIT handling—in one isolated generated schema.');
  } finally {
    if (runtimePool) {
      try {
        await within(runtimePool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining initialization runtime pool.');
        runtimePoolDrained = true;
      } catch (error) { cleanupErrors.push(error); }
    }
    if (schemaCreated && (!runtimePool || runtimePoolDrained)) {
      try { await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining initialization control pool.'); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Initialization-admission cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration initialization-admission PostgreSQL test skipped: guarded managed database is not configured.');
} else {
  run(databaseUrl).catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
}
