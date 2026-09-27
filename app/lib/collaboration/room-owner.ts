import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { SqlConnection } from '@/app/lib/db';
import type { TextCollaborationRepresentation } from './types';
import {
  captureCollaborationRoomReleaseSnapshot,
  recordCollaborationRoomRelease,
  type CollaborationRoomReleaseSnapshot,
} from './room-owner-release';

export type CollaborationRoomOwnerScope = Readonly<{
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  representation: TextCollaborationRepresentation;
  lifecycleGeneration: number;
  schemaVersion: number;
}>;

export type CollaborationRoomOwnerFence = Readonly<{
  scope: CollaborationRoomOwnerScope;
  epoch: number;
  token: string;
  backendPid: number;
  backendStart: string;
}>;

export type CollaborationRoomOwnerRow = {
  document_id: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  representation: string;
  lifecycle_generation: number | string;
  schema_version: number | string;
  status: string;
  room_owner_epoch: number | string;
  room_owner_token: string | null;
  room_owner_backend_pid: number | null;
  room_owner_backend_start: string | null;
};

type OwnerErrorCode = 'ROOM_OWNER_BUSY' | 'ROOM_OWNER_LOST' | 'ROOM_OWNER_SCOPE_CHANGED' | 'ROOM_OWNER_UNAVAILABLE';

export class CollaborationRoomOwnerError extends Error {
  constructor(readonly code: OwnerErrorCode) {
    super(code === 'ROOM_OWNER_BUSY' ? 'The document is owned by another collaboration room.'
      : code === 'ROOM_OWNER_SCOPE_CHANGED' ? 'The collaboration document identity changed.'
        : 'The collaboration room ownership is no longer available.');
    this.name = 'CollaborationRoomOwnerError';
  }
}

const MAX_ROOMS = 256;
const MAX_QUEUED_COMMANDS = 256;
const COMMAND_TIMEOUT_MS = 5_000;

export function lockIdentity(documentId: string) {
  const hex = createHash('sha256').update(`canvas.collaboration.room-owner.v1\0${documentId}`).digest('hex').slice(0, 16);
  return { key: BigInt.asIntN(64, BigInt(`0x${hex}`)).toString(),
    high: Number.parseInt(hex.slice(0, 8), 16), low: Number.parseInt(hex.slice(8), 16) };
}

function matchesScope(row: CollaborationRoomOwnerRow, scope: CollaborationRoomOwnerScope): boolean {
  return row.status === 'active' && row.document_id === scope.documentId
    && row.workspace_id === scope.workspaceId && row.organization_id === scope.organizationId
    && row.path === scope.path && row.representation === scope.representation
    && Number(row.lifecycle_generation) === scope.lifecycleGeneration && Number(row.schema_version) === scope.schemaVersion;
}

const HOLDER_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ExclusiveLock'
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.classid::bigint = $1 AND l.objid::bigint = $2 AND l.objsubid = 1
    AND l.pid = $3 AND extract(epoch FROM a.backend_start)::text = $4
) AS held`;

/** The caller must hold this state row FOR UPDATE through its write and COMMIT. */
export async function assertCollaborationRoomOwnerFence(
  database: Pick<SqlConnection, 'get'>,
  row: CollaborationRoomOwnerRow,
  fence?: CollaborationRoomOwnerFence,
): Promise<void> {
  const epoch = Number(row.room_owner_epoch);
  if (epoch === 0 && !fence) return;
  if (!fence || !Number.isSafeInteger(epoch) || epoch < 1 || epoch !== fence.epoch
    || row.room_owner_token !== fence.token || row.room_owner_backend_pid !== fence.backendPid
    || row.room_owner_backend_start !== fence.backendStart || !matchesScope(row, fence.scope)) {
    throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
  }
  const lock = lockIdentity(fence.scope.documentId);
  const holder = await database.get(HOLDER_SQL, [lock.high, lock.low, fence.backendPid, fence.backendStart]) as { held: boolean } | undefined;
  if (holder?.held !== true) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
}

/**
 * Takes ownership of ONE already-connected, dedicated pg Client, never a pool
 * checkout. All rooms share this session. No runtime caller is enabled yet.
 * Session loss invalidates every handle; there is no automatic reconnect/replay.
 */
export async function createCollaborationRoomOwnerSession(
  client: Pick<Client, 'query' | 'on' | 'end'>,
  onInvalidated: () => void = () => undefined,
) {
  let active = true;
  let closePromise: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const rooms = new Map<string, CollaborationRoomOwnerFence>();
  const lockKeys = new Set<string>();
  const invalidate = () => {
    if (!active) return;
    active = false;
    rooms.clear();
    lockKeys.clear();
    try { onInvalidated(); }
    catch { console.error('[Collaboration] Room owner invalidation handler failed.'); }
  };
  const close = () => {
    invalidate();
    closePromise ??= Promise.resolve().then(() => client.end());
    return closePromise;
  };
  client.on('error', () => { void close().catch(() => undefined); });
  client.on('end', invalidate);
  const query = async (sql: string, values?: unknown[]) => {
    if (!active) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        client.query(sql, values),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE')), COMMAND_TIMEOUT_MS);
        }),
      ]);
      if (!active) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
      return result;
    } catch {
      // An advisory-lock/COMMIT acknowledgement may have been lost. Never
      // reuse this session or attempt a compensating unlock on an uncertain key.
      void close().catch(() => undefined);
      throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE');
    } finally { if (timeout) clearTimeout(timeout); }
  };
  const enqueue = <T>(command: () => Promise<T>): Promise<T> => {
    if (!active) return Promise.reject(new CollaborationRoomOwnerError('ROOM_OWNER_LOST'));
    if (queued >= MAX_QUEUED_COMMANDS) return Promise.reject(new CollaborationRoomOwnerError('ROOM_OWNER_BUSY'));
    queued += 1;
    const result = tail.then(() => {
      if (!active) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
      return command();
    });
    tail = result.catch((error) => {
      // Runtime exceptions outside query() must not strand an open transaction.
      if (!(error instanceof CollaborationRoomOwnerError)) void close().catch(() => undefined);
    }).finally(() => { queued -= 1; });
    return result;
  };
  const identity = (await query(`SELECT pid, extract(epoch FROM backend_start)::text AS started
    FROM pg_stat_activity WHERE pid = pg_backend_pid()`)).rows[0] as { pid: number; started: string } | undefined;
  if (!identity || !Number.isSafeInteger(identity.pid) || !identity.started) {
    await close();
    throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE');
  }
  const assertActive = (fence: CollaborationRoomOwnerFence) => {
    if (!active || rooms.get(fence.scope.documentId) !== fence) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
  };
  const acquire = (input: CollaborationRoomOwnerScope): Promise<CollaborationRoomOwnerFence> => {
    // Copy before queuing: caller mutation must not change the claimed identity.
    const scope = Object.freeze({ ...input });
    if (!scope.documentId || !scope.workspaceId || !scope.path
      || !Number.isSafeInteger(scope.lifecycleGeneration) || scope.lifecycleGeneration < 1
      || !Number.isSafeInteger(scope.schemaVersion) || scope.schemaVersion < 1) {
      return Promise.reject(new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED'));
    }
    return enqueue(async () => {
      const lock = lockIdentity(scope.documentId);
      // Also reject a same-session hash collision: PG session locks reenter.
      if (lockKeys.size >= MAX_ROOMS || rooms.has(scope.documentId) || lockKeys.has(lock.key)) {
        throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
      }
      const acquired = (await query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [lock.key])).rows[0];
      if (acquired?.locked !== true) throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
      await query('BEGIN');
      const row = (await query('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE', [scope.documentId])).rows[0] as CollaborationRoomOwnerRow | undefined;
      const oldEpoch = Number(row?.room_owner_epoch);
      if (!row || !matchesScope(row, scope) || !Number.isSafeInteger(oldEpoch) || oldEpoch < 0 || oldEpoch >= Number.MAX_SAFE_INTEGER) {
        await query('ROLLBACK');
        const unlocked = (await query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [lock.key])).rows[0];
        if (unlocked?.unlocked !== true) { await close(); throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE'); }
        throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
      }
      const fence = Object.freeze({ scope, epoch: oldEpoch + 1, token: randomUUID(), backendPid: identity.pid, backendStart: identity.started });
      await query(`UPDATE collaboration_yjs_states SET room_owner_epoch = $2, room_owner_token = $3,
        room_owner_backend_pid = $4, room_owner_backend_start = $5 WHERE document_id = $1`,
      [scope.documentId, fence.epoch, fence.token, fence.backendPid, fence.backendStart]);
      await query('COMMIT');
      rooms.set(scope.documentId, fence);
      lockKeys.add(lock.key);
      return fence;
    });
  };
  const release = (fence: CollaborationRoomOwnerFence, input?: CollaborationRoomReleaseSnapshot): Promise<void> => {
    try { assertActive(fence); } catch (error) { return Promise.reject(error); }
    // Reserve capacity before revoking the local handle. A busy caller can
    // retry this exact handle; it must never leave an unreachable held lock.
    if (queued >= MAX_QUEUED_COMMANDS) return Promise.reject(new CollaborationRoomOwnerError('ROOM_OWNER_BUSY'));
    // Capture before entering the queue. Buffer.slice() would retain aliases.
    let snapshot: CollaborationRoomReleaseSnapshot | undefined;
    try { snapshot = input && captureCollaborationRoomReleaseSnapshot(input); }
    catch (error) { return Promise.reject(error); }
    // Stop new local mutations immediately, before waiting for a SQL writer.
    rooms.delete(fence.scope.documentId);
    return enqueue(async () => {
      try {
        const lock = lockIdentity(fence.scope.documentId);
        await query('BEGIN');
        const row = (await query('SELECT * FROM collaboration_yjs_states WHERE document_id = $1 FOR UPDATE', [fence.scope.documentId])).rows[0] as CollaborationRoomOwnerRow | undefined;
        if (snapshot) {
          // Legacy/abandon release never creates a durability receipt.
          await recordCollaborationRoomRelease({
            query: async (sql, values) => (await query(sql, values)).rows,
            row, fence, snapshot,
          });
        }
        // Identity may have changed during rename/archive. Releasing our exact
        // token is allowed then; never clear a replacement owner's token.
        if (row && Number(row.room_owner_epoch) === fence.epoch && row.room_owner_token === fence.token
          && row.room_owner_backend_pid === fence.backendPid && row.room_owner_backend_start === fence.backendStart) {
          await query(`UPDATE collaboration_yjs_states SET room_owner_token = NULL,
            room_owner_backend_pid = NULL, room_owner_backend_start = NULL WHERE document_id = $1`, [fence.scope.documentId]);
        }
        await query('COMMIT');
        const unlocked = (await query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [lock.key])).rows[0];
        if (unlocked?.unlocked !== true) { await close(); throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE'); }
        lockKeys.delete(lock.key);
      } catch (error) {
        // Include COMMIT and unlock uncertainty, not just receipt validation:
        // fresh recovery may start only after this backend's locks are gone.
        if (snapshot) {
          try { await close(); }
          catch (closeError) { throw new AggregateError([error, closeError], 'Durable room release could not close its owner session.'); }
        }
        throw error;
      }
    });
  };
  return { acquire, release, assertActive, close, probe: () => enqueue(async () => { await query('SELECT 1'); }) };
}
