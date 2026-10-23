import 'server-only';

import type { SqlConnection } from '../db';

type BorrowedIdentity = Readonly<{
  backend: number; start: string; database: string; schema: string; searchPath: string; transaction: string;
}>;
async function identity(database: SqlConnection, assign: boolean, error: () => Error): Promise<BorrowedIdentity> {
  const row = await database.get(`SELECT pg_catalog.pg_backend_pid() AS backend,
    extract(epoch FROM a.backend_start)::text AS start,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database,
    pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::text AS schema,
    pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication,
    CASE WHEN pg_catalog.current_setting('transaction_isolation')='read committed'
      AND pg_catalog.current_setting('transaction_read_only')='off'
      THEN ${assign ? 'pg_catalog.pg_current_xact_id()' : 'pg_catalog.pg_current_xact_id_if_assigned()'}::text
      ELSE NULL END AS transaction
    FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(row.backend) || Number(row.backend) < 1
    || typeof row.start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.start)
    || typeof row.database !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(row.database)
    || typeof row.schema !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(row.schema)
    || typeof row.search_path !== 'string' || !row.search_path || row.search_path.length > 4096
    || typeof row.transaction !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.transaction)
    || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin') throw error();
  return Object.freeze({ backend: Number(row.backend), start: row.start, database: row.database,
    schema: row.schema, searchPath: row.search_path, transaction: row.transaction });
}

// One mechanical overlap fence across borrowers. It supplies no current
// principal, owner, claim or COMMIT authority. Failure belongs to each caller.
type BorrowedFrame = { error: () => Error; failure?: Error };
const connections = new WeakMap<SqlConnection, BorrowedFrame>();

/** Caller owns explicit RC/RW B, all domain authority/fences, timeouts,
 * mandatory rollback on ANY failure and confirmed COMMIT/recovery. This only
 * observes actual backend/start/database/schema/search_path/XID at entry and
 * return boundaries; it does not police arbitrary SQL between those checks. */
export async function withBorrowedWriteTransaction<T>(database: SqlConnection,
  operation: () => Promise<T>, error: () => Error): Promise<T> {
  if (!database || typeof database !== 'object' || !['get', 'all', 'run'].every(key => typeof Reflect.get(database, key) === 'function')) throw error();
  const sibling = connections.get(database);
  if (sibling) {
    sibling.failure ??= sibling.error();
    throw error();
  }
  const frame: BorrowedFrame = { error };
  connections.set(database, frame);
  const assertFrame = () => { if (frame.failure !== undefined) throw frame.failure; };
  try {
    const pinned = await identity(database, true, error); assertFrame();
    const check = async () => {
      const current = await identity(database, false, error); assertFrame();
      if (JSON.stringify(current) !== JSON.stringify(pinned)) throw error();
    };
    await check(); assertFrame(); // Reject autocommit before any domain SQL.
    const result = await operation(); assertFrame();
    await check(); assertFrame();
    return result;
  } finally { if (connections.get(database) === frame) connections.delete(database); }
}
