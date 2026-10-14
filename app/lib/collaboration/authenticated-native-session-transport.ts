import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { NextRequest } from 'next/server';
import type { SqlConnection } from '../db';
import { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection,
  type WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import type { WorkspaceContext } from '../workspaces/types';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { withAuthenticatedExistingNativeCollaborationSessionOnConnection,
  type ExistingNativeCollaborationSession, type ExistingNativeSessionIdentity,
  type ExistingNativeSessionRequestAccess } from './native-session-state-reader';

/** Inactive server-private transport provenance, never a ticket or write grant. */
declare const transportBrand: unique symbol;
export type AuthenticatedNativeSessionTransport = Readonly<{ [transportBrand]: never }>;
type Permission = 'canRead' | 'canWrite';
type OriginalRequest = Readonly<{ url: string; method: string; headers: readonly (readonly [string, string])[] }>;
type Realm = Readonly<{ schema: string; schemaOid: number; searchPath: string; databaseOid: number }>;
type Backend = Readonly<{ pid: number; start: string; xid: string }>;
type Scope = Readonly<{ userId: string; sessionId: string; workspaceId: string; workspaceType: string;
  organizationId: string | null; projectId: string | null; customerId: string | null; ownerUserId: string | null;
  rootPath: string; rootRelativePath: string; legacy: false; status: 'active' }>;
type Binding = Readonly<{ realm: Realm; backend: Backend; scope: Scope }>;
type RecordState = { original?: OriginalRequest; workspaceId: string; maxPermission: Permission; origin?: Binding;
  failure: unknown; disposed: boolean; inFlight?: Promise<unknown>; disposal?: Promise<void>; phase?: Phase };
type Phase = { record: RecordState; connection: SqlConnection; active: boolean; callbackActive: boolean;
  binding?: Binding; checks: Set<Promise<void>> };
const transports = new WeakMap<AuthenticatedNativeSessionTransport, RecordState>();
const connections = new WeakMap<SqlConnection, Phase>();
const callbackContext = new AsyncLocalStorage<Phase>();
const scopeKeys = ['userId', 'sessionId', 'workspaceId', 'workspaceType', 'organizationId', 'projectId',
  'customerId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status'] as const;
const identityKeys = ['documentId', 'lineageId', 'workspaceId', 'organizationId', 'path',
  'lifecycleGeneration', 'representation', 'schemaVersion'] as const;

export class AuthenticatedNativeSessionTransportError extends Error {
  constructor(readonly code: 'NATIVE_TRANSPORT_INVALID' | 'NATIVE_TRANSPORT_REQUIRED' | 'NATIVE_TRANSPORT_TOO_LARGE'
    | 'NATIVE_TRANSPORT_SCOPE_CHANGED' | 'NATIVE_TRANSPORT_ACCESS_DENIED' | 'NATIVE_TRANSPORT_REENTRANT'
    | 'NATIVE_TRANSPORT_DETACHED' | 'NATIVE_TRANSPORT_DISPOSED') {
    super(code); this.name = 'AuthenticatedNativeSessionTransportError';
  }
}
function fail(code: AuthenticatedNativeSessionTransportError['code']): never {
  throw new AuthenticatedNativeSessionTransportError(code);
}
function poison(record: RecordState, error: unknown): unknown {
  record.failure ??= error ?? new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_INVALID');
  return record.failure;
}
function active(phase: Phase, callback = false): void {
  const error = phase.record.failure ?? (phase.record.disposed
    ? new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_DISPOSED')
    : !phase.active || phase.record.phase !== phase || connections.get(phase.connection) !== phase || callback && !phase.callbackActive
      ? new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_REQUIRED') : undefined);
  if (error !== undefined) {
    poison(phase.record, error);
    // A retained facade must also invalidate a genuine successor that catches
    // its failure, including another transport or another Connection object.
    for (const current of [connections.get(phase.connection), callbackContext.getStore()]) {
      if (current?.active && current !== phase) poison(current.record, error);
    }
    throw phase.record.failure;
  }
}
function data(value: unknown, required: readonly string[], allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail('NATIVE_TRANSPORT_INVALID');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('NATIVE_TRANSPORT_INVALID');
  }
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function positive(value: unknown): number {
  if (!(typeof value === 'number' || typeof value === 'string' && /^[1-9][0-9]*$/u.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  return Number(value);
}
function captureRequest(request: NextRequest): OriginalRequest {
  if (!(request instanceof NextRequest)) fail('NATIVE_TRANSPORT_INVALID');
  const url = request.url, method = request.method;
  if (Buffer.byteLength(url, 'utf8') > 8192) fail('NATIVE_TRANSPORT_TOO_LARGE');
  const headers: (readonly [string, string])[] = [];
  let bytes = 0;
  for (const [name, value] of request.headers) {
    bytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 4;
    if (headers.length >= 128 || bytes > 65536) fail('NATIVE_TRANSPORT_TOO_LARGE');
    headers.push(Object.freeze([name, value] as const));
  }
  return Object.freeze({ url, method, headers: Object.freeze(headers) });
}
function freshRequest(original: OriginalRequest): NextRequest {
  return new NextRequest(original.url, { method: original.method, headers: new Headers(original.headers.map(pair => [...pair])) });
}
function capturePhaseInput(input: { permission: Permission; path: string; expectedIdentity?: ExistingNativeSessionIdentity }) {
  data(input, ['permission', 'path'], ['permission', 'path', 'expectedIdentity']);
  if (!['canRead', 'canWrite'].includes(input.permission) || !isCanonicalAdmissionPath(input.path)
    || !/\.(?:md|markdown|txt)$/iu.test(input.path)) fail('NATIVE_TRANSPORT_INVALID');
  let expectedIdentity: ExistingNativeSessionIdentity | undefined;
  if (input.expectedIdentity !== undefined) {
    data(input.expectedIdentity, identityKeys, identityKeys);
    expectedIdentity = Object.freeze({ ...input.expectedIdentity });
  }
  return Object.freeze({ permission: input.permission, path: input.path,
    ...(expectedIdentity ? { expectedIdentity } : {}) });
}
function captureScope(access: WorkspaceRequestPrincipalAccess, workspaceId: string): Scope {
  const workspace = access.workspace;
  if (!validId(access.userId) || !validId(access.sessionId) || workspace.workspaceId !== workspaceId
    || workspace.actor?.userId !== access.userId || workspace.legacy || workspace.status !== 'active'
    || !workspace.permissions.canRead || typeof workspace.rootPath !== 'string' || !workspace.rootPath || workspace.rootPath.length > 8192
    || typeof workspace.rootRelativePath !== 'string' || workspace.rootRelativePath.length > 4096) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  return Object.freeze({ userId: access.userId, sessionId: access.sessionId, workspaceId,
    workspaceType: workspace.workspaceType, organizationId: workspace.organizationId ?? null,
    projectId: workspace.projectId ?? null, customerId: workspace.customerId ?? null, ownerUserId: workspace.ownerUserId ?? null,
    rootPath: workspace.rootPath, rootRelativePath: workspace.rootRelativePath, legacy: false, status: 'active' });
}
async function readBinding(phase: Phase, scope: Scope): Promise<Binding> {
  active(phase);
  const row = await phase.connection.get(`SELECT current_schema() AS schema,
    to_regnamespace(current_schema())::oid::bigint AS schema_oid,current_setting('search_path') AS search_path,
    (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid,
    pg_backend_pid() AS backend,extract(epoch FROM a.backend_start)::text AS backend_start,
    pg_current_xact_id()::text AS xid,w.id AS workspace_id,w.type AS workspace_type,w.organization_id,
    w.project_id,w.customer_id,w.owner_user_id,w.root_relative_path,w.status AS workspace_status
    FROM pg_stat_activity a JOIN canvas_workspaces w ON w.id=$1 WHERE a.pid=pg_backend_pid()`,
  [scope.workspaceId]) as Record<string, unknown> | undefined;
  active(phase);
  if (!row || typeof row.schema !== 'string' || !row.schema || row.schema.length > 63
    || typeof row.search_path !== 'string' || !row.search_path || row.search_path.length > 4096
    || typeof row.backend_start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.backend_start)
    || typeof row.xid !== 'string' || !/^[0-9]{1,32}$/u.test(row.xid)) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  const realm = Object.freeze({ schema: row.schema, schemaOid: positive(row.schema_oid), searchPath: row.search_path,
    databaseOid: positive(row.database_oid) });
  const backend = Object.freeze({ pid: positive(row.backend), start: row.backend_start, xid: row.xid });
  // This is an identity observation under the genuine principal's held row
  // locks, never an independent ACL resolver. Keep customer/root scope too.
  // One statement binds the row to this actual backend/XID/namespace, including
  // the final read after all capabilities close. No intervening second query.
  if (row.workspace_id !== scope.workspaceId || row.workspace_type !== scope.workspaceType
    || (row.organization_id ?? null) !== scope.organizationId || (row.project_id ?? null) !== scope.projectId
    || (row.customer_id ?? null) !== scope.customerId || (row.owner_user_id ?? null) !== scope.ownerUserId
    || row.root_relative_path !== scope.rootRelativePath || row.workspace_status !== scope.status) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  const binding = Object.freeze({ realm, backend, scope });
  if (phase.binding && (Object.keys(backend).some(key => Reflect.get(backend, key) !== Reflect.get(phase.binding!.backend, key))
    || !sameRealm(realm, phase.binding.realm))) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  const origin = phase.record.origin;
  if (origin && (!sameRealm(realm, origin.realm) || scopeKeys.some(key => scope[key] !== origin.scope[key]))) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  return binding;
}
function sameRealm(a: Realm, b: Realm): boolean {
  return a.schema === b.schema && a.schemaOid === b.schemaOid && a.searchPath === b.searchPath && a.databaseOid === b.databaseOid;
}
async function verify(phase: Phase, access: WorkspaceRequestPrincipalAccess): Promise<void> {
  active(phase);
  await access.assertCurrent();
  const scope = captureScope(access, phase.record.workspaceId), binding = await readBinding(phase, scope);
  await access.assertCurrent();
  active(phase);
  phase.binding ??= binding;
}
function reserve(connection: SqlConnection, record: RecordState): Phase {
  const held = connections.get(connection);
  if (held || record.inFlight) {
    const error = new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_REENTRANT');
    if (held) poison(held.record, error);
    throw poison(record, error);
  }
  if (!connection || typeof connection !== 'object' || !['get', 'all', 'run'].every(key => typeof Reflect.get(connection, key) === 'function')) {
    throw poison(record, new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_INVALID'));
  }
  const phase: Phase = { record, connection, active: true, callbackActive: false, checks: new Set() };
  connections.set(connection, phase); record.phase = phase;
  return phase;
}
function run<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
  const pending = (async () => {
    try {
      const result = await operation();
      active(phase);
      if (!phase.binding) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
      // Native and principal capabilities have already closed. Retain only
      // identity checking through the factory completion window on caller B.
      await readBinding(phase, phase.binding.scope);
      active(phase); return result;
    } catch (error) { throw poison(phase.record, error); }
    finally {
      phase.callbackActive = false; phase.active = false;
      if (connections.get(phase.connection) === phase) connections.delete(phase.connection);
      if (phase.record.phase === phase) phase.record.phase = undefined;
      if (phase.record.disposed) phase.record.original = undefined;
    }
  })();
  phase.record.inFlight = pending;
  void pending.then(() => { if (phase.record.inFlight === pending) phase.record.inFlight = undefined; },
    () => { if (phase.record.inFlight === pending) phase.record.inFlight = undefined; });
  return pending;
}

/** Genuine standalone enrollment. Caller owns RC/RW B, all TX completion and
 * mandatory rollback on failure. No reader, consumer, seed or grant is nested. */
export function captureAuthenticatedNativeSessionTransportOnConnection(connection: SqlConnection, request: NextRequest,
  options: { workspaceId: string; maxPermission: Permission }): Promise<AuthenticatedNativeSessionTransport> {
  let record: RecordState;
  try {
    data(options, ['workspaceId', 'maxPermission'], ['workspaceId', 'maxPermission']);
    if (!validId(options.workspaceId) || !['canRead', 'canWrite'].includes(options.maxPermission)) fail('NATIVE_TRANSPORT_INVALID');
    record = { original: captureRequest(request), workspaceId: options.workspaceId, maxPermission: options.maxPermission,
      failure: undefined, disposed: false };
    const phase = reserve(connection, record);
    return run(phase, () => withWorkspaceRequestPrincipal(freshRequest(record.original!),
      { workspaceId: record.workspaceId, permission: record.maxPermission }, principal =>
        withWorkspaceRequestPrincipalOnConnection(connection, principal, async access => {
          await verify(phase, access); record.origin = phase.binding;
          return Object.freeze({}) as AuthenticatedNativeSessionTransport;
        }))).then(capability => { transports.set(capability, record); return capability; });
  } catch (error) {
    const held = connections.get(connection); if (held) poison(held.record, error);
    return Promise.reject(error ?? new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_INVALID'));
  }
}
function callbackAccess(phase: Phase, access: ExistingNativeSessionRequestAccess): ExistingNativeSessionRequestAccess {
  const assertBound = () => {
    active(phase, true);
    if (phase.checks.size) throw poison(phase.record, new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_REENTRANT'));
  };
  const assertCurrent = (): Promise<void> => {
    try { assertBound(); } catch (error) { return Promise.reject(poison(phase.record, error)); }
    const pending = verify(phase, access).catch(error => { throw poison(phase.record, error); });
    phase.checks.add(pending);
    void pending.then(() => phase.checks.delete(pending), () => phase.checks.delete(pending));
    return pending;
  };
  return Object.freeze({ get workspace(): WorkspaceContext { assertBound(); return access.workspace; },
    get userId() { assertBound(); return access.userId; }, get sessionId() { assertBound(); return access.sessionId; },
    get assertCurrent() { assertBound(); return assertCurrent; } });
}

/** Fresh original-header authentication per phase, directly into the reader's
 * ONLY genuine B phase. canRead entry rights are diagnosis, never a write grant.
 * A write phase always requests genuine canWrite and its final authorization.
 * Native/facade lifetime ends at callback return; successful return waits for
 * all Reader/Principal/factory finals, but proves no COMMIT or publication. */
export function withAuthenticatedNativeSessionTransportOnConnection<T>(connection: SqlConnection,
  transport: AuthenticatedNativeSessionTransport,
  input: { permission: Permission; path: string; expectedIdentity?: ExistingNativeSessionIdentity },
  consume: (native: ExistingNativeCollaborationSession, access: ExistingNativeSessionRequestAccess) => Promise<T>): Promise<T> {
  const record = transports.get(transport);
  try {
    if (!record) fail('NATIVE_TRANSPORT_REQUIRED');
    if (record.failure !== undefined) throw record.failure;
    if (record.disposed || !record.original) fail('NATIVE_TRANSPORT_DISPOSED');
    const captured = capturePhaseInput(input);
    if (typeof consume !== 'function') fail('NATIVE_TRANSPORT_INVALID');
    if (captured.permission === 'canWrite' && record.maxPermission !== 'canWrite') fail('NATIVE_TRANSPORT_ACCESS_DENIED');
    const phase = reserve(connection, record), original = record.original;
    return run(phase, () => withWorkspaceRequestPrincipal(freshRequest(original),
      { permission: captured.permission, workspaceId: record.workspaceId }, principal =>
        withAuthenticatedExistingNativeCollaborationSessionOnConnection(connection, principal,
          { path: captured.path, ...(captured.expectedIdentity ? { expectedIdentity: captured.expectedIdentity } : {}) },
          async (native, access) => {
            await verify(phase, access);
            phase.callbackActive = true;
            let result: T | undefined;
            try { result = await callbackContext.run(phase, () => consume(native, callbackAccess(phase, access))); }
            catch (error) { poison(record, error); }
            finally { phase.callbackActive = false; }
            if (phase.checks.size) {
              poison(record, new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_DETACHED'));
              await Promise.allSettled([...phase.checks]);
            }
            active(phase);
            await verify(phase, access);
            return result as T;
          })));
  } catch (error) {
    if (record) poison(record, error);
    const held = connections.get(connection); if (held) poison(held.record, error);
    return Promise.reject(record?.failure ?? error ?? new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_INVALID'));
  }
}

/** Invalidates immediately, clears original credentials and awaits the entire
 * in-flight factory, including final authorization. Never closes caller B.
 * Awaiting disposal from its own callback is rejected rather than self-waiting. */
export function disposeAuthenticatedNativeSessionTransport(transport: AuthenticatedNativeSessionTransport): Promise<void> {
  const record = transports.get(transport);
  if (!record) {
    const error = new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_REQUIRED'), current = callbackContext.getStore();
    if (current?.active) poison(current.record, error);
    return Promise.reject(error);
  }
  record.disposed = true; record.original = undefined;
  if (record.inFlight) poison(record, new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_DISPOSED'));
  if (callbackContext.getStore()?.record === record && record.inFlight) {
    return Promise.reject(new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_REENTRANT'));
  }
  record.disposal ??= (async () => { if (record.inFlight) await Promise.allSettled([record.inFlight]); })();
  return record.disposal;
}
