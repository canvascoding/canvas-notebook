import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { lockIdentity } from '@/app/lib/collaboration/room-owner';
import { getCollaborationRoomConnectionCount } from '@/app/lib/collaboration/runtime-state';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';

type GuardLease = { active: boolean; verify: () => Promise<boolean> };
const shared = globalThis as typeof globalThis & {
  __canvasWorkspaceFileLifecycleGuardV1?: AsyncLocalStorage<ReadonlyMap<string, GuardLease>>;
};
const context = shared.__canvasWorkspaceFileLifecycleGuardV1 ??= new AsyncLocalStorage<ReadonlyMap<string, GuardLease>>();

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
  workspaceId: string, inputPaths: readonly string[]): Promise<void> {
  const paths = capturePaths(workspaceId, inputPaths);
  const lease = context.getStore()?.get(workspaceId);
  if (!lease || !await lease.verify()) {
    const acquired = await database.get('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [collaborationAdmissionLockKey(workspaceId)]) as { locked?: boolean } | undefined;
    if (acquired?.locked !== true) throw new WorkspaceFileLifecycleBusyError();
  }
  for (const path of paths) {
    const reservation = await database.get(`SELECT s.request_id FROM collaboration_admission_scopes s
      JOIN collaboration_admission_requests r ON r.request_id = s.request_id
      WHERE s.workspace_id = $1 AND r.status NOT IN ('committed', 'cancelled')
        AND (s.path = $2 OR $2 = '' OR left(s.path, length($2) + 1) = $2 || '/'
          OR (s.kind = 'subtree' AND (s.path = '' OR left($2, length(s.path) + 1) = s.path || '/')))
      LIMIT 1`, [workspaceId, path]);
    if (reservation) throw new WorkspaceFileLifecycleBusyError();
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
    const inheritedLease = context.getStore()?.get(input.workspaceId);
    const alreadyHeld = inheritedLease?.active === true && await inheritedLease.verify();
    const database = await openConnection();
    let acquired = false;
    let closed = false;
    const key = collaborationAdmissionLockKey(input.workspaceId);
    const unsigned = BigInt.asUintN(64, BigInt(key));
    const lease: GuardLease = alreadyHeld ? inheritedLease! : {
      active: true,
      verify: async () => {
        if (!lease.active || closed) return false;
        try {
          const held = await database.get(`SELECT EXISTS (SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock' AND pid = pg_backend_pid()
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 1) AS held`,
          [Number(unsigned >> BigInt(32)), Number(unsigned & BigInt('0xffffffff'))]) as { held?: boolean } | undefined;
          if (held?.held === true) return true;
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
      const held = new Map(context.getStore());
      held.set(input.workspaceId, lease);
      return await context.run(held, async () => {
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
        return operation();
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
