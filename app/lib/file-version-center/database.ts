import 'server-only';

import { openDb } from '@/app/lib/db';

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
