import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { NextRequest } from 'next/server';
import type { SqlConnection } from '../db';
import { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection,
  WorkspaceRequestPrincipalError, type WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import type { WorkspaceContext } from '../workspaces/types';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { assertCollaborationRoomOwnerFence, type CollaborationRoomOwnerFence, type CollaborationRoomOwnerRow } from './room-owner';
import { isCollaborationStateQuarantined } from './failure';
import { COLLABORATION_SCHEMA_VERSION } from './types';
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
const busyFailures = new WeakSet<object>();
const scopeKeys = ['userId', 'sessionId', 'workspaceId', 'workspaceType', 'organizationId', 'projectId',
  'customerId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status'] as const;
const identityKeys = ['documentId', 'lineageId', 'workspaceId', 'organizationId', 'path',
  'lifecycleGeneration', 'representation', 'schemaVersion'] as const;

export class AuthenticatedNativeSessionTransportError extends Error {
  constructor(readonly code: 'NATIVE_TRANSPORT_INVALID' | 'NATIVE_TRANSPORT_REQUIRED' | 'NATIVE_TRANSPORT_TOO_LARGE'
    | 'NATIVE_TRANSPORT_SCOPE_CHANGED' | 'NATIVE_TRANSPORT_ACCESS_DENIED' | 'NATIVE_TRANSPORT_REENTRANT'
    | 'NATIVE_TRANSPORT_DETACHED' | 'NATIVE_TRANSPORT_DISPOSED' | 'NATIVE_TRANSPORT_QUARANTINED') {
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
function run<T>(phase: Phase, operation: () => Promise<T>, beforeOwnerCallback?: () => boolean,
  finalOwnerObservation?: () => Promise<void>): Promise<T> {
  const pending = (async () => {
    try {
      const result = await operation();
      active(phase);
      if (!phase.binding) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
      // Native and principal capabilities have already closed. Retain only
      // identity checking through the factory completion window on caller B.
      await readBinding(phase, phase.binding.scope);
      await finalOwnerObservation?.();
      active(phase); return result;
    } catch (error) {
      // Only a genuine principal lock rejection before any owner callback can
      // be retried. The callback never ran, so this proves no accepted write.
      if (beforeOwnerCallback?.() && error instanceof WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_BUSY'
        && phase.record.failure === undefined && !phase.record.disposed) {
        const busy = new Error('The current peer authorization phase is busy.');
        busy.name = 'AuthenticatedNativeSessionTransportBusyError'; busyFailures.add(busy);
        throw busy;
      }
      throw poison(phase.record, error);
    }
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

/** Separate fixed-canRead quarantine diagnosis using the immutable ORIGINAL
 * request headers. Its diagnostic capability is never an editing capability. */
export function withAuthenticatedNativeSessionDiagnosisTransportOnConnection<T>(connection: SqlConnection,
  transport: AuthenticatedNativeSessionTransport,
  input: { path: string; expectedIdentity?: ExistingNativeSessionIdentity },
  consume: (diagnosis: import('./native-session-state-reader').ReadOnlyNativeSessionDiagnosis,
    access: ExistingNativeSessionRequestAccess) => Promise<T>): Promise<T> {
  const record = transports.get(transport);
  try {
    if (!record) fail('NATIVE_TRANSPORT_REQUIRED');
    if (record.failure !== undefined) throw record.failure;
    if (record.disposed || !record.original) fail('NATIVE_TRANSPORT_DISPOSED');
    data(input, ['path'], ['path', 'expectedIdentity']);
    const captured = capturePhaseInput({ permission: 'canRead', path: input.path,
      ...(input.expectedIdentity ? { expectedIdentity: input.expectedIdentity } : {}) });
    if (typeof consume !== 'function') fail('NATIVE_TRANSPORT_INVALID');
    const phase = reserve(connection, record), original = record.original;
    return run(phase, async () => {
      const { withAuthenticatedNativeSessionDiagnosisOnConnection } = await import('./native-session-state-reader');
      return withAuthenticatedNativeSessionDiagnosisOnConnection(connection, freshRequest(original),
        { workspaceId: record.workspaceId, path: captured.path,
          ...(captured.expectedIdentity ? { expectedIdentity: captured.expectedIdentity } : {}) }, async (diagnosis, access) => {
          await verify(phase, access);
          phase.callbackActive = true;
          let result: T | undefined;
          try { result = await callbackContext.run(phase, () => consume(diagnosis, callbackAccess(phase, access))); }
          catch (error) { poison(record, error); }
          finally { phase.callbackActive = false; }
          if (phase.checks.size) {
            poison(record, new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_DETACHED'));
            await Promise.allSettled([...phase.checks]);
          }
          active(phase); await verify(phase, access);
          return result as T;
        });
    });
  } catch (error) {
    if (record) poison(record, error);
    const held = connections.get(connection); if (held) poison(held.record, error);
    return Promise.reject(record?.failure ?? error ?? new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_INVALID'));
  }
}

/** The SQL mode selector grants no authority and holds no principal locks.
 * Exactly one selected reader then performs its fresh ORIGINAL fixed-canRead
 * phase and full raw validation. A mode race rejects without reader fallback. */
export function withAuthenticatedNativeSessionReadJoinTransportOnConnection<T>(connection: SqlConnection,
  transport: AuthenticatedNativeSessionTransport, input: { path: string },
  consume: (session: Readonly<{ snapshot: import('./native-session-state-reader').ExistingNativeSessionSnapshot }>,
    access: ExistingNativeSessionRequestAccess) => Promise<T>): Promise<T> {
  const record = transports.get(transport);
  try {
    if (!record) fail('NATIVE_TRANSPORT_REQUIRED');
    if (record.failure !== undefined) throw record.failure;
    if (record.disposed || !record.original) fail('NATIVE_TRANSPORT_DISPOSED');
    data(input, ['path'], ['path']);
    const captured = capturePhaseInput({ permission: 'canRead', path: input.path });
    if (typeof consume !== 'function') fail('NATIVE_TRANSPORT_INVALID');
    const phase = reserve(connection, record), original = record.original;
    return run(phase, async () => {
      // This observation ONLY chooses which independently validating reader to
      // enter. Its SQL row never becomes a snapshot, identity or permission.
      const rows = await connection.all(`SELECT s.lifecycle_generation,s.degraded,s.projection_error_code,
        s.projection_error_permanent,s.projection_error_generation FROM collaboration_yjs_states s
        WHERE s.workspace_id=$1 AND s.path=$2 AND s.status='active' LIMIT 2`, [record.workspaceId, captured.path]) as Array<Record<string, unknown>>;
      active(phase);
      if (rows.length !== 1) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
      const row = rows[0], generation = ownerCounter(row.lifecycle_generation, 1);
      const error = row.projection_error_code && ownerCounter(row.projection_error_generation, 1) === generation
        ? { code: String(row.projection_error_code), permanent: Number(row.projection_error_permanent) === 1 } : undefined;
      const quarantined = isCollaborationStateQuarantined({ degraded: Number(row.degraded) === 1, projectionError: error });
      const consumeRead = async (session: Readonly<{ snapshot: import('./native-session-state-reader').ExistingNativeSessionSnapshot }>,
        access: ExistingNativeSessionRequestAccess): Promise<T> => {
        await verify(phase, access);
        phase.callbackActive = true;
        let result: T | undefined;
        try { result = await callbackContext.run(phase, () => consume(session, callbackAccess(phase, access))); }
        catch (failure) { poison(record, failure); }
        finally { phase.callbackActive = false; }
        if (phase.checks.size) {
          poison(record, new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_DETACHED'));
          await Promise.allSettled([...phase.checks]);
        }
        active(phase); await verify(phase, access);
        return result as T;
      };
      const { withAuthenticatedNativeSessionDiagnosisOnConnection } = await import('./native-session-state-reader');
      return quarantined
        ? withAuthenticatedNativeSessionDiagnosisOnConnection(connection, freshRequest(original),
          { workspaceId: record.workspaceId, path: captured.path }, consumeRead)
        : withWorkspaceRequestPrincipal(freshRequest(original), { workspaceId: record.workspaceId, permission: 'canRead' }, principal =>
          withAuthenticatedExistingNativeCollaborationSessionOnConnection(connection, principal, { path: captured.path }, consumeRead));
    });
  } catch (error) {
    if (record) poison(record, error);
    const held = connections.get(connection); if (held) poison(held.record, error);
    return Promise.reject(record?.failure ?? error ?? new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_INVALID'));
  }
}

/** Only actual lock contention before entering an owner callback is transient. */
export function isAuthenticatedNativeSessionTransportBusy(error: unknown): boolean {
  return !!error && typeof error === 'object' && busyFailures.has(error);
}

export type AuthenticatedOwnedNativeSessionAccess = ExistingNativeSessionRequestAccess & Readonly<{
  identity: ExistingNativeSessionIdentity; quarantined: boolean; documentSequence: number;
}>;

function ownerCounter(value: unknown, minimum = 0): number {
  if (!(typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  return Number(value);
}

async function observeOwnedNativeSession(phase: Phase, identity: ExistingNativeSessionIdentity,
  fence: CollaborationRoomOwnerFence): Promise<{ quarantined: boolean; documentSequence: number }> {
  active(phase);
  const names = ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states'];
  const relations = await phase.connection.all('SELECT name,to_regclass(name)::oid = '
    + "to_regclass(quote_ident(current_schema())||'.'||quote_ident(name))::oid AS same_relation "
    + 'FROM unnest($1::text[]) names(name)', [names]) as Array<{ name: string; same_relation: boolean }>;
  active(phase);
  if (relations.length !== names.length || relations.some(row => !names.includes(row.name) || row.same_relation !== true)) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  const rows = await phase.connection.all('SELECT s.document_id,s.workspace_id,s.organization_id,s.path,s.representation,'
    + 's.lifecycle_generation,s.schema_version,s.status,s.document_sequence,s.checkpoint_sequence,s.persisted_at,s.checkpointed_at,'
    + 's.newline_style,s.has_bom,s.degraded,s.projection_error_code,'
    + 's.projection_error_permanent,s.projection_error_generation,s.projection_error_sequence,s.projection_error_phase,s.room_owner_epoch,s.room_owner_token,'
    + 's.room_owner_backend_pid,s.room_owner_backend_start,d.id,d.lineage_id,d.workspace_type,d.provider,'
    + 'd.workspace_id AS registry_workspace_id,d.organization_id AS registry_organization_id,d.path AS registry_path,'
    + 'd.status AS registry_status,d.state_version,d.yjs_state_lifecycle,l.workspace_id AS lineage_workspace_id,'
    + 'l.organization_id AS lineage_organization_id,l.workspace_type AS lineage_workspace_type,l.path AS lineage_path,l.status AS lineage_status '
    + 'FROM collaboration_documents d FULL JOIN collaboration_yjs_states s ON s.document_id=d.id '
    + 'LEFT JOIN file_collaboration_lineages l ON l.id=d.lineage_id '
    + "WHERE ((d.workspace_id=$1 AND d.path=$2) OR (s.workspace_id=$1 AND s.path=$2)) AND (d.status='active' OR s.status='active') LIMIT 2",
  [identity.workspaceId, identity.path]) as Array<CollaborationRoomOwnerRow & Record<string, unknown>>;
  active(phase);
  const row = rows[0], scope = phase.binding?.scope;
  if (rows.length !== 1 || !scope || identity.organizationId !== scope.organizationId
    || row.id !== identity.documentId || row.document_id !== identity.documentId
    || row.lineage_id !== identity.lineageId || row.workspace_id !== identity.workspaceId || row.organization_id !== identity.organizationId
    || row.path !== identity.path || row.representation !== identity.representation
    || ownerCounter(row.lifecycle_generation, 1) !== identity.lifecycleGeneration || ownerCounter(row.schema_version, 1) !== identity.schemaVersion
    || row.status !== 'active' || row.provider !== 'yjs' || row.registry_status !== 'active' || row.yjs_state_lifecycle !== 'initialized'
    || row.registry_workspace_id !== identity.workspaceId || row.registry_organization_id !== identity.organizationId || row.registry_path !== identity.path
    || row.workspace_type !== scope.workspaceType || row.lineage_workspace_type !== scope.workspaceType
    || row.lineage_workspace_id !== identity.workspaceId || row.lineage_organization_id !== identity.organizationId
    || row.lineage_path !== identity.path || row.lineage_status !== 'active'
    || ownerCounter(row.checkpoint_sequence) > ownerCounter(row.document_sequence)
    || !['lf', 'crlf'].includes(row.newline_style as never) || ![0, 1, '0', '1', false, true].includes(row.has_bom as never)
    || ![0, 1, '0', '1', false, true].includes(row.degraded as never)
    || ![0, 1, '0', '1'].includes(row.projection_error_permanent as never)) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  ownerCounter(row.state_version); ownerCounter(row.persisted_at);
  if (row.checkpointed_at !== null) ownerCounter(row.checkpointed_at);
  // Validate the ORIGINAL tuple before mapping. A dropped orphaned error must
  // never turn a corrupt/permanently quarantined native row into a writer.
  if (row.projection_error_code !== null) {
    if (!validId(row.projection_error_code) || ownerCounter(row.projection_error_sequence) > ownerCounter(row.document_sequence)
      || ownerCounter(row.projection_error_generation, 1) > identity.lifecycleGeneration
      || Number(row.projection_error_permanent) === 1 && ownerCounter(row.projection_error_generation, 1) !== identity.lifecycleGeneration
      || row.projection_error_phase !== null && (typeof row.projection_error_phase !== 'string'
        || row.projection_error_phase.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.projection_error_phase))) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  } else if (Number(row.projection_error_permanent) !== 0 || row.projection_error_sequence !== null
    || row.projection_error_generation !== null || row.projection_error_phase !== null) fail('NATIVE_TRANSPORT_SCOPE_CHANGED');
  await assertCollaborationRoomOwnerFence(phase.connection, row, fence);
  active(phase);
  const error = row.projection_error_code && Number(row.projection_error_generation) === identity.lifecycleGeneration
    ? { code: String(row.projection_error_code), permanent: Number(row.projection_error_permanent) === 1 } : undefined;
  return { quarantined: isCollaborationStateQuarantined({ degraded: Number(row.degraded) === 1, projectionError: error }),
    documentSequence: Number(row.document_sequence) };
}

/** Already-held owner observation, never new admission or a shared-reader bypass.
 * Caller owns a fresh RC/RW transaction and its completion/disposal. Each phase
 * authenticates the immutable original headers and validates the actual owner
 * SQL lock, Registry/Lineage/native identity, original realm and full workspace.
 * The callback facade expires before the outer principal/factory final checks. */
export function withAuthenticatedOwnedNativeSessionTransportOnConnection<T>(connection: SqlConnection,
  transport: AuthenticatedNativeSessionTransport,
  input: { permission: Permission; identity: ExistingNativeSessionIdentity; ownerFence: CollaborationRoomOwnerFence },
  consume: (access: AuthenticatedOwnedNativeSessionAccess) => Promise<T>): Promise<T> {
  const record = transports.get(transport);
  try {
    if (!record) fail('NATIVE_TRANSPORT_REQUIRED');
    if (record.failure !== undefined) throw record.failure;
    if (record.disposed || !record.original) fail('NATIVE_TRANSPORT_DISPOSED');
    data(input, ['permission', 'identity', 'ownerFence'], ['permission', 'identity', 'ownerFence']);
    const captured = capturePhaseInput({ permission: input.permission, path: input.identity.path, expectedIdentity: input.identity });
    const identity = captured.expectedIdentity!;
    if (!validId(identity.documentId) || !validId(identity.lineageId) || identity.workspaceId !== record.workspaceId
      || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(identity.representation)
      || !Number.isSafeInteger(identity.lifecycleGeneration) || identity.lifecycleGeneration < 1 || identity.schemaVersion !== COLLABORATION_SCHEMA_VERSION) fail('NATIVE_TRANSPORT_INVALID');
    data(input.ownerFence, ['scope', 'epoch', 'token', 'backendPid', 'backendStart'], ['scope', 'epoch', 'token', 'backendPid', 'backendStart']);
    data(input.ownerFence.scope, identityKeys.filter(key => key !== 'lineageId'), identityKeys.filter(key => key !== 'lineageId'));
    if (identityKeys.some(key => key !== 'lineageId' && Reflect.get(input.ownerFence.scope, key) !== identity[key])
      || !validId(input.ownerFence.token) || !Number.isSafeInteger(input.ownerFence.epoch) || input.ownerFence.epoch < 1
      || !Number.isSafeInteger(input.ownerFence.backendPid) || input.ownerFence.backendPid < 1 || !validId(input.ownerFence.backendStart)
      || typeof consume !== 'function') fail('NATIVE_TRANSPORT_INVALID');
    const fence = Object.freeze({ ...input.ownerFence, scope: Object.freeze({ ...input.ownerFence.scope }) });
    if (captured.permission === 'canWrite' && record.maxPermission !== 'canWrite') fail('NATIVE_TRANSPORT_ACCESS_DENIED');
    const phase = reserve(connection, record), original = record.original;
    let entered = false;
    return run(phase, () => withWorkspaceRequestPrincipal(freshRequest(original),
      { permission: captured.permission, workspaceId: record.workspaceId }, principal =>
        withWorkspaceRequestPrincipalOnConnection(connection, principal, async actual => {
          entered = true;
          await verify(phase, actual);
          let observed = await observeOwnedNativeSession(phase, identity, fence);
          if (captured.permission === 'canWrite' && observed.quarantined) fail('NATIVE_TRANSPORT_QUARANTINED');
          const access = callbackAccess(phase, { ...actual, assertCurrent: async () => {
            await actual.assertCurrent(); observed = await observeOwnedNativeSession(phase, identity, fence);
          } });
          const bound = Object.freeze({ get workspace() { return access.workspace; }, get userId() { return access.userId; },
            get sessionId() { return access.sessionId; }, get assertCurrent() { return access.assertCurrent; },
            get identity() { void access.workspace; return identity; },
            get quarantined() { void access.workspace; return observed.quarantined; },
            get documentSequence() { void access.workspace; return observed.documentSequence; } });
          phase.callbackActive = true;
          let result: T | undefined;
          try { result = await callbackContext.run(phase, () => consume(bound)); }
          catch (error) { poison(record, error); }
          finally { phase.callbackActive = false; }
          if (phase.checks.size) {
            poison(record, new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_DETACHED'));
            await Promise.allSettled([...phase.checks]);
          }
          active(phase); observed = await observeOwnedNativeSession(phase, identity, fence);
          if (captured.permission === 'canWrite' && observed.quarantined) fail('NATIVE_TRANSPORT_QUARANTINED');
          await verify(phase, actual);
          return result as T;
        })), () => !entered, async () => {
          const observed = await observeOwnedNativeSession(phase, identity, fence);
          if (captured.permission === 'canWrite' && observed.quarantined) fail('NATIVE_TRANSPORT_QUARANTINED');
        });
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
