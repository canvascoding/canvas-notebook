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
): Promise<T> {
  const connection = await openConnection();
  try {
    await connection.run('BEGIN');
    const result = await callback(connection);
    await connection.run('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.run('ROLLBACK');
    } catch {
      // Preserve the original operation or commit error.
    }
    throw error;
  } finally {
    await connection.close();
  }
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
