import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { isCanonicalWorkspacePath } from '@/app/lib/workspaces/path-identity';
import type { PersistedCollaborationState } from './persistence';
import { collaborationAdmissionLockKey } from './room-admission-contract';
import { currentProjectionIdentityJoins } from './projection-identity';
import { CollaborationFileOperationProjectionPendingError } from './checkpoint-errors';

type Identity = Readonly<{ schema: string; searchPath: string; schemaOid: number; database: number; backend: number; start: string }>;
type PublicationScope = Pick<PersistedCollaborationState, 'documentId' | 'workspaceId' | 'organizationId' | 'path'
  | 'representation' | 'lifecycleGeneration' | 'schemaVersion'>;

export class CollaborationProjectionPublicationGuardError extends Error {
  readonly status: number;
  constructor(readonly code: 'COLLABORATION_PROJECTION_GUARD_UNAVAILABLE' | 'COLLABORATION_PROJECTION_SCOPE_CHANGED'
    | 'COLLABORATION_PROJECTION_GUARD_DETACHED', options?: ErrorOptions) {
    super('The collaboration file publication guard could not be confirmed.', options);
    this.name = 'CollaborationProjectionPublicationGuardError';
    this.status = code === 'COLLABORATION_PROJECTION_SCOPE_CHANGED' ? 409 : 503;
  }
}

const unavailable = (cause?: unknown) => new CollaborationProjectionPublicationGuardError('COLLABORATION_PROJECTION_GUARD_UNAVAILABLE',
  cause === undefined ? undefined : { cause });
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
function positive(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw unavailable();
  return result;
}
async function identity(database: SqlConnection): Promise<Identity> {
  const row = await database.get(`SELECT pg_catalog.current_schema() AS schema,pg_catalog.current_setting('search_path') AS "searchPath",
    n.oid::bigint AS "schemaOid",(SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database,
    pg_catalog.pg_backend_pid() AS backend,extract(epoch FROM a.backend_start)::text AS start
    FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_namespace n ON n.nspname=pg_catalog.current_schema()
    WHERE a.pid=pg_catalog.pg_backend_pid()`) as Record<string, unknown> | undefined;
  if (!row || typeof row.schema !== 'string' || !row.schema || row.schema.includes('\0')
    || typeof row.searchPath !== 'string' || !row.searchPath || typeof row.start !== 'string' || !row.start) throw unavailable();
  return Object.freeze({ schema: row.schema, searchPath: row.searchPath, schemaOid: positive(row.schemaOid), database: positive(row.database),
    backend: positive(row.backend), start: row.start });
}

/** Rejection only. The caller must retain the actual workspace kernel fence and
 * a verified admission session guard across this observation and publication.
 * The authenticated first-birth caller already owns its private EXCLUSIVE B;
 * it uses this predicate inside that phase, never a public ALS-shaped bypass.
 * A durable intent remains pending after owner/claim loss until its matching
 * immutable completion exists. Batch status and lease time do not release it. */
export async function assertNoPendingOriginalFileOperationProjection(database: Pick<SqlConnection, 'get'>,
  workspaceId: string, schema?: string): Promise<void> {
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.includes('\0')) throw unavailable();
  const prefix = schema === undefined ? '' : `${identifier(schema)}.`;
  const pending = await database.get(`SELECT
    EXISTS(SELECT 1 FROM ${prefix}workspace_file_operation_move_intents i WHERE i.workspace_id=$1
      AND NOT EXISTS(SELECT 1 FROM ${prefix}workspace_file_operation_move_receipts r
        WHERE r.batch_id=i.batch_id AND r.intent_digest=i.intent_digest)) AS move_pending,
    EXISTS(SELECT 1 FROM ${prefix}workspace_file_operation_delete_intents i WHERE i.workspace_id=$1
      AND NOT EXISTS(SELECT 1 FROM ${prefix}workspace_file_operation_delete_receipts r
        WHERE r.batch_id=i.batch_id AND r.intent_digest=i.intent_digest)) AS delete_pending`, [workspaceId]) as
      { move_pending?: unknown; delete_pending?: unknown } | undefined;
  if (!pending || typeof pending.move_pending !== 'boolean' || typeof pending.delete_pending !== 'boolean') throw unavailable();
  if (pending.move_pending || pending.delete_pending) throw new CollaborationFileOperationProjectionPendingError();
}

/** Retain BOTH the cross-process workspace kernel fence and a dedicated real
 * PG shared session lock through file I/O, checkpoint metadata and finalization.
 * Move/Delete hold EXCLUSIVE on this exact admission key through B1/FS/B2.
 * Try-lock never waits for an owner/drain while retaining the kernel fence.
 * No connection, lease, principal or mutation authority escapes this callback. */
export async function withCollaborationProjectionPublicationGuard<T>(state: PublicationScope,
  operation: (assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
  if (!state || typeof operation !== 'function' || typeof state.documentId !== 'string' || !state.documentId || state.documentId.includes('\0')
    || typeof state.workspaceId !== 'string' || !state.workspaceId || state.workspaceId.includes('\0')
    || !(state.organizationId === null || typeof state.organizationId === 'string' && !!state.organizationId && !state.organizationId.includes('\0'))
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(state.representation) || !isCanonicalWorkspacePath(state.path)
    || !Number.isSafeInteger(state.lifecycleGeneration) || state.lifecycleGeneration < 1
    || !Number.isSafeInteger(state.schemaVersion) || state.schemaVersion < 1) throw unavailable();
  const scope = Object.freeze({ documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId,
    path: state.path, representation: state.representation, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion });
  return withWorkspaceMutationLock(scope.workspaceId, async () => {
    const database = await openDb();
    let active = true, accepting = true, failure: unknown;
    const pending = new Set<Promise<void>>();
    let first: Identity;
    const key = collaborationAdmissionLockKey(scope.workspaceId), unsigned = BigInt.asUintN(64, BigInt(key));
    const verify = async () => {
      if (!active || !accepting) throw new CollaborationProjectionPublicationGuardError('COLLABORATION_PROJECTION_GUARD_DETACHED');
      const current = await identity(database);
      if (JSON.stringify(current) !== JSON.stringify(first)) throw unavailable();
      const lock = await database.get(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND granted
        AND mode='ShareLock' AND pid=pg_catalog.pg_backend_pid() AND database=$1::oid AND classid::bigint=$2 AND objid::bigint=$3
        AND objsubid=1) AS held`, [first.database, Number(unsigned >> BigInt(32)), Number(unsigned & BigInt('0xffffffff'))]) as { held?: unknown } | undefined;
      if (lock?.held !== true) throw unavailable();
      const currentScope = await database.get(`SELECT y.document_id FROM collaboration_yjs_states y ${currentProjectionIdentityJoins}
        WHERE y.document_id=$1 AND y.workspace_id=$2 AND y.organization_id IS NOT DISTINCT FROM $3 AND y.path=$4
          AND y.representation=$5 AND y.lifecycle_generation=$6 AND y.schema_version=$7 AND y.status='active'`,
      [scope.documentId, scope.workspaceId, scope.organizationId, scope.path, scope.representation, scope.lifecycleGeneration, scope.schemaVersion]) as
        { document_id?: unknown } | undefined;
      if (currentScope?.document_id !== scope.documentId) throw new CollaborationProjectionPublicationGuardError('COLLABORATION_PROJECTION_SCOPE_CHANGED');
      await assertNoPendingOriginalFileOperationProjection(database, scope.workspaceId, first.schema);
      if (!active || !accepting || JSON.stringify(await identity(database)) !== JSON.stringify(first)) throw unavailable();
    };
    const assertCurrent = (): Promise<void> => {
      if (!active || !accepting || failure) return Promise.reject(failure ?? new CollaborationProjectionPublicationGuardError('COLLABORATION_PROJECTION_GUARD_DETACHED'));
      const work = verify().catch(error => { failure ??= error; throw error; });
      pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
    };
    try {
      await database.run("SET statement_timeout='5s'"); await database.run("SET lock_timeout='4s'");
      first = await identity(database);
      const locked = await database.get('SELECT pg_catalog.pg_try_advisory_lock_shared($1::bigint) AS locked', [key]) as { locked?: unknown } | undefined;
      if (locked?.locked !== true) throw new CollaborationFileOperationProjectionPendingError();
      await assertCurrent();
      const result = await operation(assertCurrent);
      if (pending.size) throw new CollaborationProjectionPublicationGuardError('COLLABORATION_PROJECTION_GUARD_DETACHED');
      await assertCurrent();
      return result;
    } catch (error) { failure ??= error; throw error; }
    finally {
      accepting = false;
      const detached = pending.size > 0;
      if (detached) await Promise.allSettled([...pending]);
      active = false;
      try { await database.close(new Error('Discarding dedicated collaboration publication guard session.')); }
      catch (error) { throw unavailable(failure ? new AggregateError([failure, error]) : error); }
      if (detached && !failure) throw new CollaborationProjectionPublicationGuardError('COLLABORATION_PROJECTION_GUARD_DETACHED');
    }
  });
}
