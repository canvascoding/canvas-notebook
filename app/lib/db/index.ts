import { createHash } from 'node:crypto';
import {
  createPostgresDrizzle,
  createPostgresPool,
} from './postgres';
import {
  assertRuntimeDatabaseProviderSupported,
  getDatabaseProvider,
} from './provider';
import {
  coerceDatabaseUnavailableError,
  DatabaseUnavailableError,
} from './errors';

export type SqlConnection = {
  get: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  /** Optional server-prepared execution; results are read fresh on this connection. */
  getPrepared?: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  run: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]>;
  /** A supplied error discards the connection instead of returning it to the pool. */
  close: (error?: Error) => void | Promise<void>;
};

function createPostgresDatabase() {
  const pool = createPostgresPool();
  return {
    client: pool,
    db: createPostgresDrizzle(pool) as AppDatabase,
  };
}

type AppDatabase = ReturnType<typeof createPostgresDrizzle>;

type RuntimeDatabase =
  | (ReturnType<typeof createPostgresDatabase> & { initializationError: null })
  | { client: null; db: AppDatabase; initializationError: DatabaseUnavailableError };

function createUnavailableDatabase(error: DatabaseUnavailableError): AppDatabase {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toStringTag) return 'DatabaseUnavailable';
      if (property === 'toJSON') {
        return () => ({
          unavailable: true,
          code: error.code,
          provider: error.context.provider,
        });
      }
      throw error;
    },
    set() {
      throw error;
    },
  }) as AppDatabase;
}

function createRuntimeDatabase(): RuntimeDatabase {
  const provider = getDatabaseProvider();
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    const error = new DatabaseUnavailableError(
      'database_initialization_failed',
      'Database connections are disabled during the production build; configure PostgreSQL before starting the runtime.',
      { provider },
    );
    return { client: null, db: createUnavailableDatabase(error), initializationError: error };
  }
  try {
    assertRuntimeDatabaseProviderSupported(provider);
    const database = createPostgresDatabase();
    return { ...database, initializationError: null };
  } catch (error) {
    const unavailableError = coerceDatabaseUnavailableError(error, {
      provider,
    });
    if (!unavailableError) {
      throw error;
    }

    console.error('[Database] Runtime database unavailable:', unavailableError.message);
    return {
      client: null,
      db: createUnavailableDatabase(unavailableError),
      initializationError: unavailableError,
    };
  }
}

let runtimeDatabase: RuntimeDatabase | undefined;
function getRuntimeDatabase(): RuntimeDatabase {
  runtimeDatabase ??= createRuntimeDatabase();
  return runtimeDatabase;
}

/**
 * Exposes only query capability from the already-initialized runtime pool.
 * PostgreSQL-only persistence helpers can share the app pool without creating
 * their own connection pool or gaining permission to close the runtime pool.
 */
export function getPostgresRuntimeQueryable(): ReturnType<typeof createPostgresPool> | null {
  const database = getRuntimeDatabase();
  return getDatabaseProvider() === 'postgres' && database.client
    ? database.client as ReturnType<typeof createPostgresPool>
    : null;
}

export const db: AppDatabase = new Proxy(Object.create(null), {
  get(_target, property) {
    return Reflect.get(getRuntimeDatabase().db, property);
  },
  set(_target, property, value) {
    return Reflect.set(getRuntimeDatabase().db, property, value);
  },
}) as AppDatabase;
export { getDatabaseProvider };

export function getDatabaseInitializationError(): DatabaseUnavailableError | null {
  return getRuntimeDatabase().initializationError;
}

export function assertDatabaseAvailable(): void {
  const database = getRuntimeDatabase();
  if (database.initializationError) {
    throw database.initializationError;
  }
}

export async function ensureDatabaseReady(): Promise<void> {
  assertDatabaseAvailable();
}

async function openPostgresDb(): Promise<SqlConnection> {
  await ensureDatabaseReady();
  const pool = getPostgresRuntimeQueryable();
  if (!pool) {
    throw new Error('Postgres runtime pool is not initialized.');
  }
  const runPostgresOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const unavailableError = coerceDatabaseUnavailableError(error, { provider: 'postgres' });
      if (unavailableError) {
        throw unavailableError;
      }
      throw error;
    }
  };
  let connectionError: DatabaseUnavailableError | undefined;
  let closed = false;
  let closeFailure: unknown;
  let inFlight = 0;
  const onClientError = (error: Error) => {
    if (connectionError) return;
    // Client errors can arrive between queries. Never throw from this event or
    // mistake an unusable connection for successful transaction completion.
    try {
      connectionError = coerceDatabaseUnavailableError(error, { provider: 'postgres' }) ??
        new DatabaseUnavailableError('postgres_unavailable', 'The PostgreSQL connection is unavailable.', { provider: 'postgres' }, error);
    } catch {
      connectionError = new DatabaseUnavailableError('postgres_unavailable', 'The PostgreSQL connection is unavailable.', { provider: 'postgres' }, error);
    }
  };
  const client = await runPostgresOperation(() => new Promise<import('pg').PoolClient>((resolve, reject) => {
    // Install synchronously in pg's callback, before promise continuations or
    // another backend message can run after pg removes its idle listener.
    pool.connect((error, acquired) => {
      if (error || !acquired) { reject(error ?? new Error('PostgreSQL client acquisition failed.')); return; }
      acquired.on('error', onClientError);
      resolve(acquired);
    });
  }));
  const assertAvailable = () => {
    if (connectionError) throw connectionError;
    if (closed) throw new Error('The PostgreSQL connection is closed.');
  };
  const query = (sql: string, params?: unknown[], prepared = false) => runPostgresOperation(async () => {
    assertAvailable();
    inFlight++;
    try {
      const result = await (prepared
        ? client.query({ name: `canvas_sql_${createHash('sha256').update(sql).digest('base64url')}`, text: sql, values: params })
        : client.query(sql, params));
      assertAvailable();
      return result;
    } catch (error) {
      assertAvailable();
      throw error;
    } finally { inFlight--; }
  });

  return {
    get: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return result.rows[0];
    },
    getPrepared: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params, true);
      return result.rows[0];
    },
    run: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return { changes: result.rowCount ?? 0 };
    },
    all: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return result.rows;
    },
    close: (error?: Error) => {
      if (closed) { if (closeFailure !== undefined) throw closeFailure; return; }
      closed = true;
      const terminal = connectionError ?? (inFlight ? new Error('The PostgreSQL connection closed with a query in flight.') : undefined);
      const removeListener = () => { client.removeListener('error', onClientError); };
      client.once('end', removeListener);
      try {
        // pg installs its idle listener synchronously during release. A caller
        // discard must succeed even when B was poisoned, so recovery C can run.
        client.release(error ?? terminal);
      } catch (releaseError) {
        closeFailure = releaseError;
        throw releaseError;
      }
      client.removeListener('end', removeListener);
      removeListener();
      // A synchronous release observer can poison the still-active listener.
      const completedTerminal = connectionError ?? terminal;
      if (!error && completedTerminal) { closeFailure = completedTerminal; throw completedTerminal; }
    },
  };
}

export async function openDb(): Promise<SqlConnection> {
  assertRuntimeDatabaseProviderSupported();
  assertDatabaseAvailable();
  return openPostgresDb();
}

/** Releases the shared runtime pool after isolated scripts and graceful shutdowns. */
export async function closeDatabaseConnections(): Promise<void> {
  const pool = getPostgresRuntimeQueryable();
  await pool?.end();
}
