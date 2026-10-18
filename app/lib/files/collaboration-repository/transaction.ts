import 'server-only';

import type { SqlConnection } from '@/app/lib/db';

import type { FileCollaborationTransaction } from './types';

type FileCollaborationConnectionFactory = () => Promise<SqlConnection>;

let testConnectionFactory: FileCollaborationConnectionFactory | null = null;

export function setFileCollaborationConnectionFactoryForTests(
  factory: FileCollaborationConnectionFactory | null,
): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The file collaboration test connection factory is unavailable in production.');
  }
  testConnectionFactory = factory;
}

async function openRuntimeDatabaseConnection(): Promise<SqlConnection> {
  if (testConnectionFactory) return testConnectionFactory();
  const { openDb } = await import('@/app/lib/db');
  return openDb();
}

export async function withFileCollaborationTransaction<T>(
  callback: (transaction: FileCollaborationTransaction) => Promise<T>,
  openConnection: () => Promise<SqlConnection> = openRuntimeDatabaseConnection,
  options: { strictCleanup?: boolean } = {},
): Promise<T> {
  const strictCleanup = options.strictCleanup === true;
  const connection = await openConnection();
  let operationFailed = false;
  let operationFailure: unknown;
  let rollbackFailed = false;
  let rollbackFailure: unknown;
  let discardError: Error | undefined;
  try {
    await connection.run('BEGIN');
    const result = await callback(connection);
    await connection.run('COMMIT');
    return result;
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
    try {
      await connection.run('ROLLBACK');
    } catch (rollbackError) {
      // Legacy callers preserve their original operation or commit error.
      if (strictCleanup) {
        rollbackFailed = true;
        rollbackFailure = rollbackError;
        discardError = new AggregateError(
          [error, rollbackError],
          'File collaboration transaction rollback failed.',
        );
      }
    }
    if (discardError) throw discardError;
    throw error;
  } finally {
    if (!strictCleanup) {
      await connection.close();
    } else {
      try {
        // A failed rollback must request pg pool discard rather than ordinary
        // release. Await the adapter call; this is not a backend-death receipt.
        await connection.close(discardError);
      } catch (closeError) {
        const causes: unknown[] = operationFailed ? [operationFailure] : [];
        if (rollbackFailed) causes.push(rollbackFailure);
        causes.push(closeError);
        throw new AggregateError(causes, 'File collaboration transaction cleanup failed.');
      }
    }
  }
}

/** Consistent metadata only: callers perform all filesystem work before entry. */
export async function withFileCollaborationReadSnapshot<T>(
  callback: (transaction: FileCollaborationTransaction) => Promise<T>,
  openConnection: () => Promise<SqlConnection> = openRuntimeDatabaseConnection,
): Promise<T> {
  const connection = await openConnection();
  let discardError: Error | undefined;
  try {
    await connection.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await callback(connection);
    await connection.run('COMMIT');
    return result;
  } catch (error) {
    try { await connection.run('ROLLBACK'); }
    catch (rollbackError) {
      discardError = new Error('Discarding unresolved file metadata read transaction.', { cause: rollbackError });
    }
    throw error;
  } finally { await connection.close(discardError); }
}

export async function lockFileCollaborationPaths(
  transaction: FileCollaborationTransaction,
  workspaceId: string,
  paths: string[],
): Promise<void> {
  const orderedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  for (const filePath of orderedPaths) {
    await transaction.get(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [workspaceId, filePath],
    );
  }
}
