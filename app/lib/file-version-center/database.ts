import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';

export type FileVersionCenterQueryResult<Row> = {
  rows: Row[];
  rowCount?: number | null;
};

export type FileVersionCenterTransaction = {
  query: <Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<FileVersionCenterQueryResult<Row>>;
};

export type FileVersionCenterDatabase = {
  transaction: <T>(
    action: (transaction: FileVersionCenterTransaction) => Promise<T>,
  ) => Promise<T>;
};

/** Read-only adapter. Only the caller may commit, write or release the owned transaction. */
export function createFileVersionCenterTransactionReader(sql: FileVersionCenterTransaction): SqlConnection {
  return {
    get: async (statement, params) => (await sql.query(statement, params)).rows[0],
    all: async (statement, params) => (await sql.query(statement, params)).rows,
    run: () => { throw new Error('A scoped proposal reader cannot write.'); },
    close: () => { throw new Error('A scoped proposal reader cannot release its owner connection.'); },
  };
}

/** Shared PostgreSQL transaction mechanics; domain services keep policy and authorization. */
export function createRuntimeFileVersionCenterDatabase(): FileVersionCenterDatabase {
  return {
    transaction: async <T>(action: (transaction: FileVersionCenterTransaction) => Promise<T>) => {
      const connection = await openDb();
      let discard: Error | undefined;
      try {
        await connection.run('BEGIN');
        const transaction: FileVersionCenterTransaction = {
          query: async <Row>(sql: string, params?: unknown[]) => ({
            rows: await connection.all(sql, params) as Row[],
          }),
        };
        const result = await action(transaction);
        await connection.run('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.run('ROLLBACK');
        } catch (rollbackError) {
          discard = rollbackError instanceof Error
            ? rollbackError
            : new Error('File version center transaction rollback failed.');
        }
        throw error;
      } finally {
        await connection.close(discard);
      }
    },
  };
}
