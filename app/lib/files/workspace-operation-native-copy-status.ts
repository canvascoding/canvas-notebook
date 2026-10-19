import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { assertDirectMcpWorkspaceCopyPrincipalCaptured, type DirectMcpWorkspaceCopyPrincipal } from '../mcp/server/document-read-principal';
import { withWorkspaceCopyMcpOnConnection } from '../workspaces/copy-principal';
import { assertWorkspaceOperationCopyOriginCurrent, decodeWorkspaceOperationCopyOrigin,
  type WorkspaceOperationCopyMcpOrigin, type WorkspaceOperationCopyOrigin } from './workspace-operation-copy-origin';
import { serializeWorkspaceOperationRequest, type WorkspaceOperationRequest,
  type WorkspaceOperationStatus, type WorkspaceOperationPhase } from './workspace-operation-journal';
import { readCompletedMcpNativeCopyHistoryOnConnection } from './workspace-operation-native-copy-phase-read';
import { readNativeCopyReceiptStorageIdentityOnConnection,
  type NativeCopyReceiptStorageIdentity } from '../collaboration/native-copy-historical-receipt';
import { readExcalidrawCopyReceiptStorageIdentityOnConnection } from '../excalidraw-collaboration/copy-history';
import type { ExcalidrawCopyReceiptStorageIdentity } from '../excalidraw-collaboration/copy-contract';

type StatusCode = 'NATIVE_COPY_STATUS_REQUIRED' | 'NATIVE_COPY_STATUS_INVALID' | 'NATIVE_COPY_STATUS_CHANGED'
  | 'NATIVE_COPY_STATUS_TOO_LARGE' | 'NATIVE_COPY_STATUS_UNCONFIRMED';
export class NativeCopyStatusError extends Error {
  readonly status: 409 | 413 | 503;
  constructor(readonly code: StatusCode, options?: ErrorOptions) {
    super(code, options); this.name = 'NativeCopyStatusError';
    this.status = code === 'NATIVE_COPY_STATUS_TOO_LARGE' ? 413 : code === 'NATIVE_COPY_STATUS_UNCONFIRMED' ? 503 : 409;
  }
}
/** A missing journal does not prove that no private pre-B0 Stage exists. */
export class NativeCopyStatusNotFoundError extends Error {
  readonly code = 'NATIVE_COPY_STATUS_NOT_FOUND';
  readonly status = 404;
  constructor() { super('NATIVE_COPY_STATUS_NOT_FOUND'); this.name = 'NativeCopyStatusNotFoundError'; }
}
export type McpWorkspaceNativeCopyOperationStatus = Readonly<{
  operationId: string; planId: string; revision: number;
  journal: Readonly<{ status: WorkspaceOperationStatus; phase: WorkspaceOperationPhase;
    expectedStepCount: number; recordedStepCount: number; appliedStepCount: number; intentStepCount: number;
    createdAt: number; updatedAt: number; errorCode: string | null }>;
  completion: Readonly<{ status: 'confirmed'; historical: true; copiedPaths: readonly string[] }>
    | Readonly<{ status: 'not_confirmed' }>;
}>;
type Input = Readonly<{ origin: WorkspaceOperationCopyMcpOrigin; mcpPrincipal: DirectMcpWorkspaceCopyPrincipal; operationId: string }>;
type Row = Record<string, unknown>;
type Identity = Readonly<{ backend: number; start: string; databaseOid: number; schema: string; schemaOid: number; searchPath: string }>;
type Witness = Readonly<{ identity: Identity; isolation: string; readOnly: string; xid: string | null; virtual: string }>;
type Header = Readonly<{ operationId: string; planId: string; requestHash: string; requestJson: string;
  original: WorkspaceOperationCopyMcpOrigin; copiedPaths: readonly string[]; revision: number;
  status: WorkspaceOperationStatus; phase: WorkspaceOperationPhase; expected: number; createdAt: number; updatedAt: number; errorCode: string | null }>;
type Frame = { database: SqlConnection; active: boolean; phase: 'idle' | 'authorization' | 'history'; checking: boolean;
  failure?: Error; identity?: Identity; relations?: string; original?: WorkspaceOperationCopyMcpOrigin; history?: Witness };
const context = new AsyncLocalStorage<Frame>(), frames = new WeakMap<SqlConnection, Frame>();
const MAX_REQUEST_BYTES = 65536, MAX_HEADER_BYTES = 16384, MAX_STEPS = 10000;
const statuses: readonly WorkspaceOperationStatus[] = ['prepared', 'running', 'completed', 'failed', 'recovery_required'];
const phases: readonly WorkspaceOperationPhase[] = ['prepared', 'path', 'link', 'completed'];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function fail(code: StatusCode = 'NATIVE_COPY_STATUS_CHANGED'): never { throw new NativeCopyStatusError(code); }
function unconfirmed(cause: unknown): NativeCopyStatusError { return new NativeCopyStatusError('NATIVE_COPY_STATUS_UNCONFIRMED', { cause }); }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}
function oid(value: unknown): number {
  if (typeof value === 'string' && /^[1-9][0-9]{0,9}$/u.test(value)) value = Number(value);
  if (!integer(value, 1, 4294967295)) fail(); return value;
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function record(value: unknown, keys: readonly string[], code: StatusCode = 'NATIVE_COPY_STATUS_CHANGED'): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) fail(code);
  return value as Row;
}
function captureInput(value: Input): Input {
  const input = record(value, ['origin', 'mcpPrincipal', 'operationId'], 'NATIVE_COPY_STATUS_INVALID');
  let origin: WorkspaceOperationCopyOrigin;
  try { origin = decodeWorkspaceOperationCopyOrigin(input.origin); } catch { return fail('NATIVE_COPY_STATUS_INVALID'); }
  if (origin.version !== 2 || typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u.test(input.operationId)) {
    fail('NATIVE_COPY_STATUS_INVALID');
  }
  const principal = input.mcpPrincipal as DirectMcpWorkspaceCopyPrincipal;
  assertDirectMcpWorkspaceCopyPrincipalCaptured(principal,
    { sourceWorkspaceId: origin.sourceScope.workspaceId, destinationWorkspaceId: origin.destinationScope.workspaceId });
  return Object.freeze({ origin, mcpPrincipal: principal, operationId: input.operationId });
}
async function witness(database: SqlConnection): Promise<Witness> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,a.backend_start::text AS start,a.datid::text AS database_oid,
    pg_catalog.current_schema() AS schema,pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS schema_oid,
    CASE WHEN pg_catalog.octet_length(pg_catalog.current_setting('search_path'))<=16384 THEN pg_catalog.current_setting('search_path') END AS search_path,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication,pg_catalog.pg_current_xact_id_if_assigned()::text AS xid,
    (SELECT virtualtransaction FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND locktype='virtualxid' AND mode='ExclusiveLock' AND granted) AS virtual
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Row | undefined;
  if (!row || !integer(row.backend, 1, 2147483647) || typeof row.start !== 'string' || row.start.length < 1 || row.start.length > 128
    || typeof row.schema !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(row.schema) || row.schema.startsWith('pg_')
    || typeof row.search_path !== 'string' || !row.search_path || Buffer.byteLength(row.search_path) > 16384 || row.replication !== 'origin'
    || !['read committed', 'repeatable read'].includes(String(row.isolation)) || !['on', 'off'].includes(String(row.read_only))
    || row.xid !== null && (typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid))
    || typeof row.virtual !== 'string' || !/^[0-9]+\/[0-9]+$/u.test(row.virtual)) fail();
  return Object.freeze({ identity: Object.freeze({ backend: row.backend, start: row.start, databaseOid: oid(row.database_oid),
    schema: row.schema, schemaOid: oid(row.schema_oid), searchPath: row.search_path }),
  isolation: row.isolation as string, readOnly: row.read_only as string, xid: row.xid as string | null, virtual: row.virtual });
}
async function relations(frame: Frame): Promise<string> {
  const identity = frame.identity; if (!identity) fail();
  const names = ['workspace_file_operations', 'workspace_file_operation_steps'];
  const rows = await frame.database.all(`SELECT names.name,c.oid::bigint AS relation_oid,n.oid::bigint AS schema_oid,
    n.nspname AS schema_name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass(names.name)::oid::bigint AS resolved_oid,pg_catalog.current_schema() AS current_schema
    FROM pg_catalog.unnest($2::text[]) WITH ORDINALITY AS names(name,ordinal) LEFT JOIN pg_catalog.pg_class c
      ON c.oid=pg_catalog.to_regclass(pg_catalog.format('%I.%I',$1::text,names.name))
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace ORDER BY names.ordinal`, [identity.schema, names]) as Row[];
  if (rows.length !== 2 || rows.some((row, index) => row.name !== names[index] || row.schema_name !== identity.schema
    || oid(row.schema_oid) !== identity.schemaOid || row.current_schema !== identity.schema || row.relkind !== 'r' || row.relpersistence !== 'p'
    || row.relrowsecurity !== false || row.relforcerowsecurity !== false || oid(row.relation_oid) !== oid(row.resolved_oid))) fail();
  return JSON.stringify(rows);
}
async function assertIdentity(frame: Frame): Promise<Witness> {
  if (!frame.active || frames.get(frame.database) !== frame || context.getStore() !== frame) fail('NATIVE_COPY_STATUS_REQUIRED');
  if (frame.failure) throw frame.failure;
  const actual = await witness(frame.database);
  if (!frame.identity || !equal(actual.identity, frame.identity) || frame.relations !== await relations(frame)) fail();
  return actual;
}
/** A fixed read frame only. It supplies no Owner, mutation, lease or resume capability. */
export async function assertNativeCopyStatusSessionOnConnection(database: SqlConnection, origin: WorkspaceOperationCopyOrigin): Promise<void> {
  const frame = context.getStore();
  if (!frame?.active) fail('NATIVE_COPY_STATUS_REQUIRED');
  try {
    if (frame.database !== database || frames.get(database) !== frame || frame.phase !== 'history' || !frame.history || !frame.original) {
      fail('NATIVE_COPY_STATUS_REQUIRED');
    }
    if (frame.failure) throw frame.failure;
    if (frame.checking || !equal(decodeWorkspaceOperationCopyOrigin(origin), frame.original)) fail();
    frame.checking = true;
    const actual = await assertIdentity(frame);
    if (actual.isolation !== 'repeatable read' || actual.readOnly !== 'on' || actual.xid !== null || !equal(actual, frame.history)) fail();
  } catch (error) { frame.failure ??= error instanceof Error ? error : unconfirmed(error); throw frame.failure; }
  finally { frame.checking = false; }
}
function boundedJson(value: unknown, count: unknown, maximum: number): unknown {
  if (typeof count === 'string' && /^[0-9]{1,16}$/u.test(count)) count = Number(count);
  if (!integer(count, 1) || count > maximum) fail('NATIVE_COPY_STATUS_TOO_LARGE');
  if (typeof value !== 'string' || Buffer.byteLength(value) !== count) fail();
  try { return JSON.parse(value) as unknown; } catch { return fail(); }
}
async function readHeader(frame: Frame, operationId: string): Promise<Header> {
  if (!frame.identity) fail();
  const row = await frame.database.get(`SELECT pg_catalog.octet_length(header::text) AS header_bytes,
    CASE WHEN pg_catalog.octet_length(header::text)<=16384 THEN header::text END AS header_json,
    pg_catalog.octet_length(request_json) AS request_bytes,
    CASE WHEN pg_catalog.octet_length(request_json)<=65536 THEN request_json END AS request_json FROM (
      SELECT request_json,pg_catalog.jsonb_build_object('operation_id',operation_id,'plan_id',plan_id,'request_hash',request_hash,
        'actor_type',actor_type,'actor_id',actor_id,'source_workspace_id',source_workspace_id,'destination_workspace_id',destination_workspace_id,
        'expected_step_count',expected_step_count,'status',status,'phase',phase,'revision',revision,
        'error_code',error_code,'created_at',created_at,'updated_at',updated_at) AS header
      FROM ${quote(frame.identity.schema)}.workspace_file_operations WHERE operation_id=$1 LIMIT 1) selected`, [operationId]) as Row | undefined;
  if (!row) throw new NativeCopyStatusNotFoundError();
  const h = record(boundedJson(row.header_json, row.header_bytes, MAX_HEADER_BYTES), ['operation_id', 'plan_id', 'request_hash', 'actor_type', 'actor_id',
    'source_workspace_id', 'destination_workspace_id', 'expected_step_count', 'status', 'phase', 'revision', 'error_code', 'created_at', 'updated_at']);
  const request = boundedJson(row.request_json, row.request_bytes, MAX_REQUEST_BYTES) as WorkspaceOperationRequest;
  let serialized: ReturnType<typeof serializeWorkspaceOperationRequest>;
  try { serialized = serializeWorkspaceOperationRequest(request); } catch { return fail(); }
  if (request.kind !== 'copy' || !request.origin || request.origin.version !== 2) throw new NativeCopyStatusNotFoundError();
  const original = decodeWorkspaceOperationCopyOrigin(request.origin); if (original.version !== 2) throw new NativeCopyStatusNotFoundError();
  if (h.operation_id !== operationId || !hash(h.plan_id) || !hash(h.request_hash) || serialized.requestJson !== row.request_json
    || serialized.requestHash !== h.request_hash || h.actor_type !== original.actor.type || h.actor_id !== original.actor.userId
    || h.source_workspace_id !== original.sourceScope.workspaceId || h.destination_workspace_id !== original.destinationScope.workspaceId
    || !integer(h.expected_step_count, 1, MAX_STEPS) || !statuses.includes(h.status as WorkspaceOperationStatus)
    || !phases.includes(h.phase as WorkspaceOperationPhase) || !integer(h.revision, 1) || !integer(h.created_at) || !integer(h.updated_at, h.created_at)
    || h.error_code !== null && (typeof h.error_code !== 'string' || h.error_code.length < 1 || h.error_code.length > 128
      || /[\u0000-\u001f\u007f]/u.test(h.error_code) || Buffer.from(h.error_code).toString('utf8') !== h.error_code)) fail();
  return Object.freeze({ operationId, planId: h.plan_id, requestHash: h.request_hash, requestJson: serialized.requestJson, original,
    copiedPaths: Object.freeze(request.selections.map(selection => selection.destinationPath)), revision: h.revision,
    status: h.status as WorkspaceOperationStatus, phase: h.phase as WorkspaceOperationPhase, expected: h.expected_step_count,
    createdAt: h.created_at, updatedAt: h.updated_at, errorCode: h.error_code as string | null });
}
function sameOriginal(actual: Header, original: Header): void {
  if (actual.operationId !== original.operationId || actual.planId !== original.planId || actual.requestHash !== original.requestHash
    || actual.requestJson !== original.requestJson || !equal(actual.original, original.original)) fail();
}
async function readSnapshot(frame: Frame, header: Header, storage: NativeCopyReceiptStorageIdentity,
  sceneStorage: ExcalidrawCopyReceiptStorageIdentity): Promise<McpWorkspaceNativeCopyOperationStatus> {
  await assertNativeCopyStatusSessionOnConnection(frame.database, header.original);
  const now = await readHeader(frame, header.operationId); sameOriginal(now, header);
  const steps = await frame.database.get(`SELECT count(*)::integer AS total,
    count(*) FILTER (WHERE status='applied')::integer AS applied,count(*) FILTER (WHERE status='intent')::integer AS intent,
    count(*) FILTER (WHERE status NOT IN ('intent','applied') OR phase NOT IN ('path','link'))::integer AS invalid
    FROM (SELECT status,phase FROM ${quote(frame.identity!.schema)}.workspace_file_operation_steps WHERE operation_id=$1 LIMIT $2) selected`,
  [header.operationId, MAX_STEPS + 1]) as Row | undefined;
  if (!steps || !integer(steps.total, 0, MAX_STEPS)) fail('NATIVE_COPY_STATUS_TOO_LARGE');
  if (steps.total > now.expected || !integer(steps.applied) || !integer(steps.intent) || steps.invalid !== 0
    || steps.applied + steps.intent !== steps.total) fail();
  const complete = await readCompletedMcpNativeCopyHistoryOnConnection(frame.database,
    { operationId: header.operationId, origin: header.original, requestHash: header.requestHash, planId: header.planId, storage, sceneStorage });
  if (complete && (now.status !== 'completed' || complete.operation.revision !== now.revision
    || complete.operation.requestJson !== now.requestJson || complete.operation.planId !== now.planId)) fail();
  await assertNativeCopyStatusSessionOnConnection(frame.database, header.original);
  return Object.freeze({ operationId: header.operationId, planId: header.planId, revision: now.revision,
    journal: Object.freeze({ status: now.status, phase: now.phase, expectedStepCount: now.expected, recordedStepCount: steps.total,
      appliedStepCount: steps.applied, intentStepCount: steps.intent, createdAt: now.createdAt, updatedAt: now.updatedAt, errorCode: now.errorCode }),
    completion: complete ? Object.freeze({ status: 'confirmed' as const, historical: true as const, copiedPaths: now.copiedPaths })
      : Object.freeze({ status: 'not_confirmed' as const }) });
}
async function transaction<T>(frame: Frame, kind: 'authorization' | 'history', operation: () => Promise<T>): Promise<T> {
  if (!frame.active || frame.phase !== 'idle') fail('NATIVE_COPY_STATUS_REQUIRED');
  frame.phase = kind;
  let began = false, attempted = false;
  try {
    await frame.database.run(kind === 'history' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
    await frame.database.run("SET LOCAL statement_timeout='5s'"); await frame.database.run("SET LOCAL transaction_timeout='5s'");
    if (kind === 'history') {
      if (!frame.original) fail('NATIVE_COPY_STATUS_REQUIRED');
      frame.history = await assertIdentity(frame);
      await assertNativeCopyStatusSessionOnConnection(frame.database, frame.original);
    }
    const value = await operation();
    if (frame.failure) throw frame.failure;
    if (kind === 'history') await assertNativeCopyStatusSessionOnConnection(frame.database, frame.original!);
    else {
      const actual = await assertIdentity(frame);
      if (actual.isolation !== 'read committed' || actual.readOnly !== 'off' || actual.xid === null) fail();
    }
    attempted = true; await frame.database.run('COMMIT'); began = false; return value;
  } catch (error) {
    if (attempted) throw unconfirmed(error);
    if (began) try { await frame.database.run('ROLLBACK'); } catch (rollback) { throw unconfirmed(new AggregateError([error, rollback], 'Copy status rollback was not confirmed.')); }
    throw error;
  } finally { frame.history = undefined; frame.phase = 'idle'; }
}

/** Fixed current-MCP status observation only. No Stage, file, view, lease,
 * publication or recovery access. Results escape only after C2 and close. */
export async function readMcpWorkspaceNativeCopyOperationStatus(supplied: Input): Promise<McpWorkspaceNativeCopyOperationStatus> {
  const inherited = context.getStore();
  if (inherited?.active) { inherited.failure ??= new NativeCopyStatusError('NATIVE_COPY_STATUS_REQUIRED'); throw inherited.failure; }
  const input = captureInput(supplied);
  // openDb uses the existing monitored runtime-pool checkout. Its current
  // implementation creates no schema, migration, backfill or domain rows.
  let database: SqlConnection;
  try { database = await openDb(); } catch (error) { throw unconfirmed(error); }
  const frame: Frame = { database, active: true, phase: 'idle', checking: false };
  frames.set(database, frame);
  let result: McpWorkspaceNativeCopyOperationStatus | undefined, failed = false, failure: unknown;
  try {
    result = await context.run(frame, async () => {
      const initial = await transaction(frame, 'authorization', () => withWorkspaceCopyMcpOnConnection(database, input.mcpPrincipal, input.origin, async access => {
        const current = await witness(database);
        if (current.isolation !== 'read committed' || current.readOnly !== 'off' || current.xid === null) fail();
        frame.identity = current.identity; frame.relations = await relations(frame);
        const header = await readHeader(frame, input.operationId);
        try { assertWorkspaceOperationCopyOriginCurrent(header.original, access.originalOrigin); } catch { throw new NativeCopyStatusNotFoundError(); }
        frame.original = header.original;
        const storage = await readNativeCopyReceiptStorageIdentityOnConnection(database, current.identity.schema);
        const sceneStorage = await readExcalidrawCopyReceiptStorageIdentityOnConnection(database, current.identity.schema);
        return { header, storage, sceneStorage };
      }));
      const snapshot = await transaction(frame, 'history', () => readSnapshot(frame, initial.header, initial.storage, initial.sceneStorage));
      await transaction(frame, 'authorization', () => withWorkspaceCopyMcpOnConnection(database, input.mcpPrincipal, initial.header.original, async () => {
        const actual = await assertIdentity(frame);
        if (actual.isolation !== 'read committed' || actual.readOnly !== 'off' || actual.xid === null) fail();
        sameOriginal(await readHeader(frame, input.operationId), initial.header);
      }));
      return snapshot;
    });
  } catch (error) { failed = true; failure = error; }
  finally {
    frame.active = false; frames.delete(database);
    try { await database.close(failed ? failure instanceof Error ? failure : unconfirmed(failure) : undefined); }
    catch (close) { failure = unconfirmed(new AggregateError(failed ? [failure, close] : [close], 'Copy status connection disposal was not confirmed.')); failed = true; }
  }
  if (failed) throw failure;
  if (!result) throw unconfirmed(new Error('Copy status result is absent.'));
  return result;
}
