import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';
import { type SqlConnection } from '@/app/lib/db';

export async function lockPiSessionCreationForUser(
  connection: SqlConnection,
  userId: string,
): Promise<void> {
  const actor = await connection.get(
    'SELECT id FROM "user" WHERE id = $1 LIMIT 1 FOR UPDATE',
    [userId],
  ) as { id?: string } | undefined;
  if (!actor?.id) {
    throw new Error('Session owner not found.');
  }
}

export async function withPiSessionUserStateLock<T>(
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedOperationLock('pi-session-user-state', JSON.stringify([userId]), operation);
}
