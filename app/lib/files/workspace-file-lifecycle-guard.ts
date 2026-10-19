import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { getWorkspaceFileLifecycleLeases, withWorkspaceFileLifecycleLeases,
  type WorkspaceFileLifecycleLease } from '@/app/lib/collaboration/file-lifecycle-admission-context';
import { lockIdentity } from '@/app/lib/collaboration/room-owner';
import { getCollaborationRoomConnectionCount } from '@/app/lib/collaboration/runtime-state';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceLinkSourceAuthorityObservation } from '@/app/lib/markdown/workspace-source-authority-stage';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';

type SourceIdentity = Readonly<{ backend: number; start: string; database: number; schema: number; searchPath: string }>;
type SourceCapture = {
  workspaceId: string; database: SqlConnection; lease: WorkspaceFileLifecycleLease;
  active: boolean; accepting: boolean; reading: boolean; identity?: SourceIdentity; scope?: string; failure?: Error;
  pending: Set<Promise<unknown>>;
};
const sourceOwners = new WeakMap<WorkspaceFileLifecycleLease, SourceCapture>();
// Multiple ordered workspace guards may coexist during a copy. Public lease
// ALS alone cannot grant this private, fixed observation capability.
const sourceContext = new AsyncLocalStorage<ReadonlyMap<WorkspaceFileLifecycleLease, SourceCapture>>();

export class WorkspaceFileLifecycleSourceError extends Error {
  readonly status: number;
  constructor(readonly code: 'FILE_LIFECYCLE_SOURCE_INVALID' | 'FILE_LIFECYCLE_SOURCE_DETACHED'
    | 'FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED', options?: ErrorOptions) {
    super(code, options); this.name = 'WorkspaceFileLifecycleSourceError';
    this.status = code === 'FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED' ? 503 : 409;
  }
}

function sourceFailure(captured: SourceCapture, error: unknown): Error {
  const failure = error instanceof Error ? error : new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
  // An uncertain transaction end remains visible even if an earlier concurrent
  // or detached call already invalidated the observation.
  if (!captured.failure || failure instanceof WorkspaceFileLifecycleSourceError
    && failure.code === 'FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED') captured.failure = failure;
  captured.lease.active = false;
  return captured.failure;
}

function currentSource(captured: SourceCapture): void {
  if (captured.failure) throw captured.failure;
  if (!captured.active || !captured.accepting || !captured.lease.active
    || sourceOwners.get(captured.lease) !== captured || sourceContext.getStore()?.get(captured.lease) !== captured
    || getWorkspaceFileLifecycleLeases()?.get(captured.workspaceId) !== captured.lease) {
    throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
  }
}

async function sourceIdentity(database: SqlConnection, assign: boolean, readOnly: boolean): Promise<{
  identity: SourceIdentity; transaction: string | null; virtual: string;
}> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication,
    ${assign ? 'pg_catalog.pg_current_xact_id()' : 'pg_catalog.pg_current_xact_id_if_assigned()'}::text AS transaction,
    (SELECT virtualtransaction FROM pg_catalog.pg_locks WHERE locktype='virtualxid'
      AND pid=pg_catalog.pg_backend_pid() AND granted LIMIT 1) AS virtual
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1 || typeof row.start !== 'string'
    || !/^[0-9]+\.[0-9]+$/u.test(row.start) || !Number.isSafeInteger(Number(row.database)) || Number(row.database) < 1
    || !Number.isSafeInteger(Number(row.schema)) || Number(row.schema) < 1 || typeof row.search_path !== 'string'
    || row.isolation !== 'read committed' || row.read_only !== (readOnly ? 'on' : 'off') || row.replication !== 'origin'
    || row.transaction !== null && (typeof row.transaction !== 'string' || !/^[0-9]{1,32}$/u.test(row.transaction))
    || typeof row.virtual !== 'string' || !/^[0-9]+\/[0-9]+$/u.test(row.virtual)) {
    throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
  }
  return { identity: Object.freeze({ backend: Number(row.backend), start: row.start, database: Number(row.database),
    schema: Number(row.schema), searchPath: row.search_path }), transaction: row.transaction as string | null, virtual: row.virtual };
}

const sameSourceIdentity = (left: SourceIdentity, right: SourceIdentity) =>
  Object.keys(left).every(key => Reflect.get(left, key) === Reflect.get(right, key));

async function sourceFence(captured: SourceCapture, phase?: string): Promise<void> {
  currentSource(captured);
  const now = await sourceIdentity(captured.database, false, phase !== undefined);
  currentSource(captured);
  if (!captured.identity || !sameSourceIdentity(captured.identity, now.identity)
    || phase === undefined && now.transaction !== null || phase !== undefined && now.virtual !== phase) {
    throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
  }
  const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(captured.workspaceId)));
  const rows = await captured.database.all(`SELECT mode FROM pg_catalog.pg_locks WHERE locktype='advisory' AND granted
    AND pid=pg_catalog.pg_backend_pid() AND database=$1::oid AND classid::bigint=$2 AND objid::bigint=$3 AND objsubid=1`,
  [now.identity.database, Number(key >> BigInt(32)), Number(key & BigInt('0xffffffff'))]) as Array<{ mode: string }>;
  if (!rows.some(row => row.mode === 'ExclusiveLock') || rows.some(row => !['ExclusiveLock', 'ShareLock'].includes(row.mode))
    || rows.some(row => row.mode === 'ShareLock') !== (phase !== undefined) || !await captured.lease.verify()) {
    throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
  }
  currentSource(captured);
}

async function sourceIdle(captured: SourceCapture): Promise<void> {
  currentSource(captured);
  // The first assigned XID must disappear in the next statement. This rejects
  // an already open transaction even when it had not yet assigned an XID.
  const first = await sourceIdentity(captured.database, true, false);
  currentSource(captured);
  captured.identity ??= first.identity; // First read pins the actual private B, not historical guard-entry metadata.
  if (first.transaction === null || !sameSourceIdentity(captured.identity, first.identity)) {
    throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
  }
  await sourceFence(captured);
}

async function collectLifecycleSource(captured: SourceCapture, workspace: WorkspaceContext): Promise<WorkspaceLinkSourceAuthorityObservation> {
  let transaction = false;
  try {
    currentSource(captured);
    if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') {
      throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
    }
    await sourceIdle(captured);
    await captured.database.run('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'); transaction = true;
    await captured.database.run("SET LOCAL statement_timeout='5s'");
    await captured.database.run("SET LOCAL lock_timeout='4s'");
    await captured.database.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(captured.workspaceId)]);
    const phase = await sourceIdentity(captured.database, false, true);
    await sourceFence(captured, phase.virtual);
    const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('@/app/lib/markdown/workspace-source-authority-stage');
    currentSource(captured);
    const observation = await readWorkspaceLinkSourceAuthorityOnConnection(captured.database, workspace);
    await sourceFence(captured, phase.virtual);
    // Incomplete facts grant no readiness, just as in the standalone stage.
    try { await captured.database.run(observation.stage.coverage.complete ? 'COMMIT' : 'ROLLBACK'); transaction = false; }
    catch (error) { throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED', { cause: error }); }
    await sourceIdle(captured);
    return observation;
  } catch (error) {
    let failure = error;
    if (transaction) try { await captured.database.run('ROLLBACK'); }
    catch (cleanup) {
      failure = new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED', {
        cause: new AggregateError([error, cleanup], 'Source observation and rollback failed.'),
      });
    }
    throw sourceFailure(captured, failure);
  }
}

/** Rejection-only bridge for an existing exclusive guard and a separate caller
 * transaction. Public lease-shaped ALS data cannot impersonate the private
 * source owner. This opens no read transaction and returns no authority. */
export async function assertWorkspaceFileLifecycleSourceLeaseCurrent(database: SqlConnection,
  workspaceId: string): Promise<void> {
  const lease = getWorkspaceFileLifecycleLeases()?.get(workspaceId);
  const captured = lease && sourceOwners.get(lease);
  if (!captured || captured.workspaceId !== workspaceId || captured.reading
    || sourceContext.getStore()?.get(lease!) !== captured) {
    throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
  }
  try {
    await sourceIdle(captured);
    const current = await sourceIdentity(database, true, false);
    if (!captured.identity || current.identity.database !== captured.identity.database
      || current.identity.schema !== captured.identity.schema
      || current.identity.backend === captured.identity.backend || current.transaction === null) {
      throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
    }
    await sourceFence(captured);
  } catch (error) { throw sourceFailure(captured, error); }
}

/** Fixed facts-only read. No principal, writer authority, raw B or free callback
 * is created. Current caller rights remain required by the existing flow.
 * Undefined permits standalone staging only outside every owned lease. */
export async function readWorkspaceFileLifecycleSourceAuthority(workspace: WorkspaceContext): Promise<WorkspaceLinkSourceAuthorityObservation | undefined> {
  const lease = getWorkspaceFileLifecycleLeases()?.get(workspace.workspaceId);
  const local = [...(sourceContext.getStore()?.values() ?? [])].find(owner => owner.workspaceId === workspace.workspaceId);
  if (!lease && !local) return undefined;
  if (local && (!local.active || !local.accepting)) {
    throw sourceFailure(local, new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_DETACHED'));
  }
  const captured = lease && sourceOwners.get(lease);
  if (!captured || captured !== local) {
    const error = new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
    throw local ? sourceFailure(local, error) : error;
  }
  try { currentSource(captured); }
  catch (error) { throw sourceFailure(captured, error); }
  if (captured.reading) throw sourceFailure(captured, new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID'));
  let selected: WorkspaceContext;
  try {
    selected = structuredClone(workspace);
    // Consistency of the caller's locator, never a current DB principal or ACL.
    const scope = JSON.stringify([selected.workspaceId, selected.workspaceType, selected.rootPath, selected.rootRelativePath ?? null,
      selected.organizationId ?? null, selected.customerId ?? null, selected.projectId ?? null, selected.ownerUserId ?? null,
      selected.legacy, selected.actor?.userId ?? null]);
    if (captured.scope !== undefined && captured.scope !== scope) throw new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID');
    captured.scope ??= scope;
  } catch (error) { throw sourceFailure(captured, new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_INVALID', { cause: error })); }
  captured.reading = true;
  const work = collectLifecycleSource(captured, selected).finally(() => { captured.reading = false; });
  captured.pending.add(work);
  void work.then(() => captured.pending.delete(work), () => captured.pending.delete(work));
  return work;
}

async function withLifecycleSourceOwner<T>(workspaceId: string, database: SqlConnection,
  lease: WorkspaceFileLifecycleLease, operation: () => Promise<T>): Promise<T> {
  const captured: SourceCapture = { workspaceId, database, lease, active: true, accepting: true, reading: false, pending: new Set() };
  sourceOwners.set(lease, captured);
  // A retained async context may legitimately acquire a new guard after its
  // old one closed. Replace only that workspace's stale private association.
  const owners = new Map([...(sourceContext.getStore() ?? [])].filter(([, owner]) => owner.workspaceId !== workspaceId));
  owners.set(lease, captured);
  try {
    return await sourceContext.run(owners, async () => {
      let value: T | undefined, failed = false, failure: unknown;
      try { value = await operation(); } catch (error) { failed = true; failure = error; }
      captured.accepting = false;
      if (captured.pending.size) {
        sourceFailure(captured, new WorkspaceFileLifecycleSourceError('FILE_LIFECYCLE_SOURCE_DETACHED'));
        await Promise.allSettled([...captured.pending]);
      }
      if (captured.failure) {
        if (failed && failure !== captured.failure) {
          const aggregate = new AggregateError([captured.failure, failure], 'Source observation and operation cleanup failed.');
          const operationStatus = failure && typeof failure === 'object' ? Object.getOwnPropertyDescriptor(failure, 'status')?.value : undefined;
          const sourceUnconfirmed = captured.failure instanceof WorkspaceFileLifecycleSourceError
            && captured.failure.code === 'FILE_LIFECYCLE_SOURCE_TRANSACTION_UNCONFIRMED';
          const priority = !sourceUnconfirmed && operationStatus === 503 ? failure : captured.failure;
          throw Object.assign(aggregate, {
            status: Object.getOwnPropertyDescriptor(priority, 'status')?.value ?? 409,
            code: Object.getOwnPropertyDescriptor(priority, 'code')?.value ?? 'FILE_LIFECYCLE_SOURCE_INVALID',
          });
        }
        throw captured.failure;
      }
      if (failed) throw failure;
      return value as T;
    });
  } finally { captured.accepting = false; captured.active = false; sourceOwners.delete(lease); }
}

export class WorkspaceFileLifecycleBusyError extends Error {
  readonly code = 'COLLABORATION_FILE_LIFECYCLE_BUSY';
  readonly status = 409;
  constructor() {
    super('Close this document in every editor and retry after its saved connection has finished. A document transition may still be running.');
    this.name = 'WorkspaceFileLifecycleBusyError';
  }
}

function capturePaths(workspaceId: string, paths: readonly string[]): string[] {
  if (!workspaceId || !paths.length || paths.some(path => !isCanonicalAdmissionPath(path, true))) {
    throw new Error('A canonical workspace file lifecycle scope is required.');
  }
  return [...new Set(paths)].sort();
}

/** Retain the admission guard through the caller's SQL transaction. */
export async function assertWorkspaceFileLifecycleSqlAvailable(database: SqlConnection,
  workspaceId: string, inputPaths: readonly string[], options: { admissionLock?: 'try' | 'wait' } = {}): Promise<void> {
  const paths = capturePaths(workspaceId, inputPaths);
  const admissionLock = options.admissionLock ?? 'try';
  if (admissionLock !== 'try' && admissionLock !== 'wait') throw new Error('Invalid workspace file lifecycle admission mode.');
  const lease = getWorkspaceFileLifecycleLeases()?.get(workspaceId);
  if (!lease || !await lease.verify()) {
    if (admissionLock === 'wait') {
      await database.run("SET LOCAL lock_timeout='4s'");
      await database.run("SET LOCAL statement_timeout='5s'");
    }
    let acquired: { locked?: boolean } | undefined;
    try {
      acquired = await database.get(admissionLock === 'wait'
        ? 'SELECT pg_advisory_xact_lock($1::bigint), true AS locked'
        : 'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
      [collaborationAdmissionLockKey(workspaceId)]) as { locked?: boolean } | undefined;
    } catch (error) {
      // Only this acquisition timeout is an ordinary availability denial.
      if (admissionLock === 'wait' && error instanceof Error && 'code' in error && error.code === '55P03') {
        throw Object.assign(new WorkspaceFileLifecycleBusyError(), { cause: error });
      }
      throw error;
    }
    if (acquired?.locked !== true) throw new WorkspaceFileLifecycleBusyError();
  }
  for (const path of paths) {
    const ownReservations: string[] = [];
    while (true) {
      const reservation = await database.get(`SELECT s.request_id FROM collaboration_admission_scopes s
        JOIN collaboration_admission_requests r ON r.request_id = s.request_id
        WHERE s.workspace_id = $1 AND r.status NOT IN ('committed', 'cancelled')
          AND (s.path = $2 OR $2 = '' OR left(s.path, length($2) + 1) = $2 || '/'
            OR (s.kind = 'subtree' AND (s.path = '' OR left($2, length(s.path) + 1) = s.path || '/')))
          AND NOT (s.request_id = ANY($3::text[])) LIMIT 1`,
      [workspaceId, path, ownReservations]) as { request_id: string } | undefined;
      if (!reservation) break;
      // Only the fixed genuine Copy phase can recognize its original durable
      // reservation on this actual B. No public request-id/skip flag is used.
      const { readNativeCopyOwnedReservationOnConnection } = await import('./workspace-operation-native-copy-phase');
      const original = await readNativeCopyOwnedReservationOnConnection(database, reservation.request_id, workspaceId);
      if (!original || original.requestId !== reservation.request_id || ownReservations.includes(reservation.request_id)
        || ownReservations.length >= 1000) throw new WorkspaceFileLifecycleBusyError();
      ownReservations.push(reservation.request_id);
      // Continue scanning: our own first match must not hide another request.
    }
    const rows = await database.all(`SELECT document_id, room_owner_token, room_owner_backend_pid, room_owner_backend_start
      FROM collaboration_yjs_states WHERE workspace_id = $1
        AND (path = $2 OR $2 = '' OR left(path, length($2) + 1) = $2 || '/')
      ORDER BY document_id FOR UPDATE`, [workspaceId, path]) as Array<{
        document_id: string; room_owner_token: string | null; room_owner_backend_pid: number | null; room_owner_backend_start: string | null;
      }>;
    for (const row of rows) {
      if (row.room_owner_token !== null || row.room_owner_backend_pid !== null || row.room_owner_backend_start !== null
        || getCollaborationRoomConnectionCount(row.document_id) > 0) throw new WorkspaceFileLifecycleBusyError();
      const key = lockIdentity(row.document_id);
      const holder = await database.get(`SELECT EXISTS (SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 1) AS held`, [key.high, key.low]) as { held?: boolean } | undefined;
      if (holder?.held !== false) throw new WorkspaceFileLifecycleBusyError();
    }
  }
}

/** File actions retain a dedicated session guard across physical work and existing metadata commits. */
export async function withWorkspaceFileLifecycleGuard<T>(input: { workspaceId: string; paths: readonly string[] },
  operation: () => Promise<T>, openConnection: () => Promise<SqlConnection> = openDb): Promise<T> {
  const paths = capturePaths(input.workspaceId, input.paths);
  return withWorkspaceMutationLock(input.workspaceId, async () => {
    const inheritedLease = getWorkspaceFileLifecycleLeases()?.get(input.workspaceId);
    const alreadyHeld = inheritedLease?.active === true && await inheritedLease.verify();
    const database = await openConnection();
    let acquired = false;
    let closed = false;
    const key = collaborationAdmissionLockKey(input.workspaceId);
    const unsigned = BigInt.asUintN(64, BigInt(key));
    const lease: WorkspaceFileLifecycleLease = alreadyHeld ? inheritedLease! : {
      active: true,
      verify: async () => {
        if (!lease.active || closed) return false;
        try {
          const held = await database.get(`SELECT EXISTS (SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock' AND pid = pg_backend_pid()
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 1) AS held`,
          [Number(unsigned >> BigInt(32)), Number(unsigned & BigInt('0xffffffff'))]) as { held?: boolean } | undefined;
          if (held?.held === true && lease.active && !closed) return true;
        } catch { /* A lost dedicated session cannot authorize a new SQL writer. */ }
        lease.active = false;
        return false;
      },
    };
    const discardConnection = async () => {
      if (closed) return;
      closed = true;
      await database.close(new Error('Discarding dedicated file lifecycle guard session.'));
    };
    try {
      await database.run("SET statement_timeout = '5s'");
      await database.run("SET lock_timeout = '4s'");
      if (!alreadyHeld) {
        const result = await database.get('SELECT pg_try_advisory_lock($1::bigint) AS locked',
          [collaborationAdmissionLockKey(input.workspaceId)]) as { locked?: boolean } | undefined;
        if (result?.locked !== true) throw new WorkspaceFileLifecycleBusyError();
        acquired = true;
      }
      const held = new Map(getWorkspaceFileLifecycleLeases());
      held.set(input.workspaceId, lease);
      return await withWorkspaceFileLifecycleLeases(held, async () => {
        await database.run('BEGIN');
        try {
          await assertWorkspaceFileLifecycleSqlAvailable(database, input.workspaceId, paths);
          await database.run('COMMIT');
        } catch (error) {
          try { await database.run('ROLLBACK'); } catch { /* Discard below. */ }
          throw error;
        }
        if (alreadyHeld) {
          // The outer session retains authority; release this short checkout
          // before existing metadata commits need another pool connection.
          await discardConnection();
          if (!lease.active) throw new WorkspaceFileLifecycleBusyError();
        }
        // The kernel fence also gates owner acquisition and new reservations.
        // A lost PG session during physical work therefore cannot admit either;
        // metadata reacquires its own transaction guard if this lease expires.
        if (!await lease.verify()) throw new WorkspaceFileLifecycleBusyError();
        return alreadyHeld ? operation() : withLifecycleSourceOwner(input.workspaceId, database, lease, operation);
      });
    } finally {
      // Always destroy this dedicated checkout. An uncertain unlock/rollback
      // cannot return a session advisory lock to the shared pool.
      if (acquired) {
        lease.active = false;
        try { await database.get('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [collaborationAdmissionLockKey(input.workspaceId)]); }
        catch { /* Always discard an uncertain session below. */ }
      }
      if (!alreadyHeld) lease.active = false;
      await discardConnection().catch(() => {
        // SQL/FS results are already determined. A checkout disposal error
        // cannot invalidate a confirmed result or replace its original error.
        console.warn('[File lifecycle] Could not dispose the dedicated guard checkout.');
      });
    }
  });
}

/** Canonical workspace order prevents opposite-direction copy actions from splitting the lock order. */
export function withWorkspaceFileLifecycleGuards<T>(scopes: readonly { workspaceId: string; paths: readonly string[] }[],
  operation: () => Promise<T>): Promise<T> {
  const merged = new Map<string, string[]>();
  for (const scope of scopes) if (scope.paths.length) {
    merged.set(scope.workspaceId, [...(merged.get(scope.workspaceId) ?? []), ...scope.paths]);
  }
  const ordered = [...merged.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const enter = (index: number): Promise<T> => index === ordered.length ? operation()
    : withWorkspaceFileLifecycleGuard({ workspaceId: ordered[index][0], paths: ordered[index][1] }, () => enter(index + 1));
  return enter(0);
}
