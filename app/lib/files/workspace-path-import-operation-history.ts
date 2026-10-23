import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '../db';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { withWorkspaceRequestPrincipalOnConnection, withWorkspaceRequestPrincipalOriginalOrigin, WorkspaceRequestPrincipalError,
  type WorkspaceRequestPrincipalAccess, type WorkspaceRequestHistoricalOrigin } from '../workspaces/request-principal';
import { withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { captureWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { workspaceOperationMcpBatchId } from './workspace-operation-mcp-authorization';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { readWorkspacePathImportPreparationRecordOnConnection } from './workspace-path-import-preparation-record';
import { readWorkspacePathImportOperationBatchOnConnection } from './workspace-operation-batch-store';
import type { WorkspacePathImportPreparationPlanV1 } from './workspace-path-import-preparation-plan';
import type { WorkspacePathImportPreparationPrincipal, WorkspacePathImportOperationPreparation } from './workspace-path-import-preparation-phase';

export type WorkspacePathImportOperationHistoryInput = Readonly<{
  principal: WorkspacePathImportPreparationPrincipal;
  operationId: string;
  expected?: Readonly<{ planId: string; request: WorkspacePathImportPreparationPlanV1['request'] }>;
}>;
type HistoryAccess = WorkspaceRequestPrincipalAccess | DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess;
type HistoryRealm = Readonly<{ schemaName: string; schemaOid: number; databaseOid: number; searchPath: string;
  backendPid: number; backendStart: string; transactionId: string }>;
const retryableRequestHistoryReads = new WeakSet<WorkspaceRequestPrincipalError>();

export class WorkspacePathImportOperationHistoryError extends Error {
  readonly status: 422 | 409 | 503;
  constructor(readonly code: 'PATH_IMPORT_HISTORY_INVALID' | 'PATH_IMPORT_HISTORY_CHANGED'
    | 'PATH_IMPORT_HISTORY_ORPHAN' | 'PATH_IMPORT_HISTORY_UNAVAILABLE', options?: ErrorOptions) {
    super(code, options); this.name = 'WorkspacePathImportOperationHistoryError';
    this.status = code === 'PATH_IMPORT_HISTORY_INVALID' ? 422 : code === 'PATH_IMPORT_HISTORY_UNAVAILABLE' ? 503 : 409;
  }
}

function workspacePathImportHistoryFields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length < required.length || keys.length > required.length + optional.length
    || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) {
    throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
  }
  const captured: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field && optional.includes(key)) continue;
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
    captured[key] = field.value;
  }
  return captured;
}

function captureWorkspacePathImportHistoryInput(input: WorkspacePathImportOperationHistoryInput): WorkspacePathImportOperationHistoryInput {
  const fields = workspacePathImportHistoryFields(input, ['principal', 'operationId'], ['expected']);
  const selected = workspacePathImportHistoryFields(fields.principal, ['kind', 'principal']);
  if (selected.kind !== 'request' && selected.kind !== 'move' && selected.kind !== 'delete'
    || !selected.principal || typeof selected.principal !== 'object' || types.isProxy(selected.principal)) {
    throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
  }
  return Object.freeze({ principal: Object.freeze({ kind: selected.kind, principal: selected.principal }) as WorkspacePathImportPreparationPrincipal,
    ...captureWorkspacePathImportHistoryQuestion(selected.kind, fields.operationId, fields.expected) });
}

function captureWorkspacePathImportHistoryQuestion(principalKind: WorkspacePathImportPreparationPrincipal['kind'], operationId: unknown,
  suppliedExpected: unknown): Pick<WorkspacePathImportOperationHistoryInput, 'operationId' | 'expected'> {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 512
    || Buffer.from(operationId).toString('utf8') !== operationId || /[\u0000-\u001f\u007f]/u.test(operationId)
    || principalKind !== 'request' && !/^[A-Za-z0-9_-]{16,128}$/u.test(operationId)) {
    throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
  }
  let expected: WorkspacePathImportOperationHistoryInput['expected'];
  if (suppliedExpected !== undefined) {
    const value = captureWorkspaceOperationNativePlanData(suppliedExpected,
      () => { throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID'); }, 16 * 1024 * 1024);
    const captured = workspacePathImportHistoryFields(value, ['planId', 'request']);
    const request = workspacePathImportHistoryFields(captured.request, ['kind', 'selections']), kind = request.kind;
    if (typeof captured.planId !== 'string' || !/^[a-f0-9]{64}$/u.test(captured.planId)
      || kind !== 'move' && kind !== 'rename' && kind !== 'delete'
      || !Array.isArray(request.selections) || request.selections.length < 1 || request.selections.length > 1000) {
      throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
    }
    const selections = request.selections.map(item => {
      const selection = workspacePathImportHistoryFields(item, kind === 'delete' ? ['sourcePath'] : ['sourcePath', 'destinationPath']);
      for (const key of kind === 'delete' ? ['sourcePath'] : ['sourcePath', 'destinationPath']) {
        const path = selection[key];
        if (typeof path !== 'string' || Buffer.from(path).toString('utf8') !== path || !isCanonicalAdmissionPath(path)
          || Buffer.byteLength(path) > 4096 || path.split('/').length > 33) {
          throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
        }
      }
      return Object.freeze({ sourcePath: selection.sourcePath as string,
        ...(kind === 'delete' ? {} : { destinationPath: selection.destinationPath as string }) });
    });
    if (principalKind === 'delete' && kind !== 'delete' || principalKind === 'move' && kind !== 'move') {
      throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
    }
    expected = Object.freeze({ planId: captured.planId, request: Object.freeze({ kind, selections: Object.freeze(selections) }) });
  }
  return Object.freeze({ operationId, ...(expected === undefined ? {} : { expected }) });
}

async function readWorkspacePathImportHistoryRealm(database: SqlConnection): Promise<HistoryRealm> {
  const row = await database.get(`SELECT pg_catalog.current_schema() AS schema_name,n.oid::bigint AS schema_oid,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.current_setting('search_path') AS search_path,pg_catalog.pg_backend_pid() AS backend_pid,
    a.backend_start::text AS backend_start,pg_catalog.pg_current_xact_id_if_assigned()::text AS xid,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_catalog.pg_backend_pid()
    WHERE n.nspname=pg_catalog.current_schema()`) as Record<string, unknown> | undefined;
  if (!row || typeof row.schema_name !== 'string' || !row.schema_name || Buffer.byteLength(row.schema_name) > 63
    || Buffer.from(row.schema_name).toString('utf8') !== row.schema_name || /[\u0000-\u001f\u007f]/u.test(row.schema_name)
    || ![row.schema_oid, row.database_oid].every(value => (typeof value === 'number' || typeof value === 'string'
      && /^[1-9][0-9]*$/u.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 4294967295)
    || typeof row.search_path !== 'string' || !row.search_path || Buffer.byteLength(row.search_path) > 16384
    || !Number.isSafeInteger(row.backend_pid) || Number(row.backend_pid) < 1 || typeof row.backend_start !== 'string'
    || !row.backend_start || row.backend_start.length > 128 || typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') {
    throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_CHANGED');
  }
  return Object.freeze({ schemaName: row.schema_name, schemaOid: Number(row.schema_oid), databaseOid: Number(row.database_oid),
    searchPath: row.search_path, backendPid: Number(row.backend_pid), backendStart: row.backend_start, transactionId: row.xid });
}

/** Fixed historical reader inside the actual current Principal phase. All
 * persisted IDs, SID-A, import receipts and P0 facts stay original facts. */
async function readWorkspacePathImportHistoryOnConnection(database: SqlConnection, input: WorkspacePathImportOperationHistoryInput,
  access: HistoryAccess): Promise<WorkspacePathImportOperationPreparation | null> {
  await access.assertCurrent();
  const scope = captureWorkspaceOperationJobScope(access.workspace), realm = await readWorkspacePathImportHistoryRealm(database);
  if (scope.legacy || !access.workspace.permissions.canRead || !access.workspace.permissions.canWrite || !access.workspace.permissions.canDelete
    || access.workspace.status !== undefined && access.workspace.status !== 'active') {
    throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_CHANGED');
  }
  const clientId = 'clientId' in access ? access.clientId : null;
  const batchId = input.principal.kind === 'request'
    ? createHash('sha256').update(JSON.stringify(['workspace-path-operation-id-v1', scope.workspaceId, access.userId, input.operationId])).digest('hex')
    : workspaceOperationMcpBatchId({ userId: access.userId, clientId: clientId as string, workspaceId: scope.workspaceId,
      tool: input.principal.kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source', operationId: input.operationId });
  const record = await readWorkspacePathImportPreparationRecordOnConnection(database, { schema: realm.schemaName, workspaceId: scope.workspaceId, batchId });
  let result: WorkspacePathImportOperationPreparation | null = null;
  if (record) {
    if (record.operationId !== input.operationId || record.batchId !== batchId || record.origin.userId !== access.userId
      || record.origin.clientId !== clientId || record.origin.kind !== (input.principal.kind === 'request' ? 'request' : 'direct-mcp')
      || !equal(record.origin.scope, scope) || record.origin.realm.schemaName !== realm.schemaName
      || record.origin.realm.schemaOid !== realm.schemaOid || record.origin.realm.databaseOid !== realm.databaseOid
      || input.principal.kind === 'delete' && record.origin.tool !== 'delete'
      || input.principal.kind === 'move' && record.origin.tool !== 'move'
      || input.expected && (input.expected.planId !== record.previewPlan.planId && input.expected.planId !== record.nativePlan.planId
        || !equal(input.expected.request, record.previewPlan.request))) {
      throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_CHANGED');
    }
    const batch = await readWorkspacePathImportOperationBatchOnConnection(database, { record, workspace: access.workspace });
    if (!batch) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_ORPHAN');
    result = Object.freeze({ record, batch });
  }
  await access.assertCurrent();
  if (!equal(await readWorkspacePathImportHistoryRealm(database), realm)) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_CHANGED');
  return result;
}

/** Return only a proven prepared-operation mapping. null means there is no
 * import record; it is NOT permission to fresh-plan. Callers must still resolve
 * ordinary existing batch/domain history before planning. A present malformed
 * record or missing/mismatched original header/P0 always throws. No filesystem,
 * current native rows, imports, Claim, lifecycle lease or mutation is used. */
export async function readWorkspacePathImportOperationHistory(supplied: WorkspacePathImportOperationHistoryInput
): Promise<WorkspacePathImportOperationPreparation | null> {
  const input = captureWorkspacePathImportHistoryInput(supplied);
  let database: SqlConnection;
  try { database = await openDb(); }
  catch (cause) { throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_UNAVAILABLE', { cause }); }
  let begun = false, commitAttempted = false, committed = false, rollbackConfirmed = false, failure: unknown;
  let result: Readonly<{ value: WorkspacePathImportOperationPreparation | null }> | undefined;
  try {
    await database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
    const value = input.principal.kind === 'request'
      ? await withWorkspaceRequestPrincipalOnConnection(database, input.principal.principal,
        access => readWorkspacePathImportHistoryOnConnection(database, input, access))
      : input.principal.kind === 'move'
        ? await withDirectMcpWorkspaceMovePrincipalOnConnection(database, input.principal.principal,
          access => readWorkspacePathImportHistoryOnConnection(database, input, access))
        : await withDirectMcpWorkspaceDeletePrincipalOnConnection(database, input.principal.principal,
          access => readWorkspacePathImportHistoryOnConnection(database, input, access));
    result = Object.freeze({ value }); commitAttempted = true; await database.run('COMMIT'); committed = true; begun = false;
  } catch (error) {
    failure = commitAttempted ? new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_UNAVAILABLE', { cause: error }) : error;
    if (begun && !commitAttempted) try { await database.run('ROLLBACK'); begun = false; rollbackConfirmed = true; }
    catch (rollback) { failure = new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_UNAVAILABLE', {
      cause: new AggregateError([failure, rollback], 'Historical import selection rollback is unconfirmed.') }); }
  }
  try { await database.close(new Error('Discarding dedicated original import history session.', { cause: failure })); }
  catch (close) { failure = new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_UNAVAILABLE', {
    cause: failure === undefined ? close : new AggregateError([failure, close], 'Historical import selection disposal is unconfirmed.') }); }
  if (failure !== undefined) {
    // The same failed Principal is never reused. This private evidence is
    // consumed only after its whole factory has unwound in the Web reader.
    if (input.principal.kind === 'request' && rollbackConfirmed && !commitAttempted
      && failure instanceof WorkspaceRequestPrincipalError && failure.code === 'PRINCIPAL_BUSY') {
      retryableRequestHistoryReads.add(failure);
    }
    throw failure;
  }
  if (!committed || !result) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_UNAVAILABLE');
  return result.value;
}

/** Only the fixed, side-effect-free history question can be retried. Every
 * attempt freshly authenticates the original request; no planning, admission,
 * import or mutation callback can enter this loop. */
export async function readRequestWorkspacePathImportOperationHistory(request: NextRequest,
  supplied: Readonly<{ workspaceId: string; operationId: string; expected?: WorkspacePathImportOperationHistoryInput['expected'] }>
): Promise<WorkspacePathImportOperationPreparation | null> {
  if (!(request instanceof NextRequest)) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const fields = workspacePathImportHistoryFields(supplied, ['workspaceId', 'operationId'], ['expected']);
  const workspaceId = fields.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256 || workspaceId !== workspaceId.trim()
    || /[\u0000-\u001f\u007f]/u.test(workspaceId)) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_INVALID');
  const question = captureWorkspacePathImportHistoryQuestion('request', fields.operationId, fields.expected);
  let origin: WorkspaceRequestHistoricalOrigin | undefined;
  const observe = (current: WorkspaceRequestHistoricalOrigin): void => {
    if (origin && !equal(origin, current)) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_CHANGED');
    origin ??= current;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await withWorkspaceRequestPrincipalOriginalOrigin(original, { permission: 'canWrite', workspaceId }, observe,
        principal => readWorkspacePathImportOperationHistory({ principal: { kind: 'request', principal }, ...question }));
    } catch (error) {
      if (!(error instanceof WorkspaceRequestPrincipalError) || !retryableRequestHistoryReads.delete(error)) throw error;
      if (!origin || attempt === 2) throw new WorkspacePathImportOperationHistoryError('PATH_IMPORT_HISTORY_UNAVAILABLE', { cause: error });
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
  }
}
