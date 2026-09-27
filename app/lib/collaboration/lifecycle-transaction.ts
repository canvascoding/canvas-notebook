import 'server-only';

import type { SqlConnection } from '@/app/lib/db';

/** Connection mechanics only; the caller owns mutation and durable proof. */
export async function executeLifecycleTransaction<T>(input: {
  openConnection: () => Promise<SqlConnection>;
  execute: (database: SqlConnection) => Promise<T>;
  recoverCommitted: (value: T, commitError: unknown) => Promise<T>;
}): Promise<T> {
  const database = await input.openConnection();
  let closed = false;
  const close = async (error?: Error) => {
    // A failed release must never be retried as an ordinary pool release.
    closed = true;
    await database.close(error);
  };
  try {
    let value: T;
    try {
      await database.run('BEGIN');
      value = await input.execute(database);
    } catch (operationError) {
      try {
        await database.run('ROLLBACK');
      } catch (rollbackError) {
        const errors = [operationError, rollbackError];
        try {
          await close(new Error('Discarding unresolved lifecycle transaction.', { cause: rollbackError }));
        } catch (discardError) { errors.push(discardError); }
        throw new AggregateError(errors, 'Lifecycle mutation rollback could not be confirmed.');
      }
      throw operationError;
    }
    try {
      await database.run('COMMIT');
    } catch (commitError) {
      // ROLLBACK cannot distinguish a rejected COMMIT from a committed one
      // whose response was lost. Discard first, then inspect durable proof.
      try {
        await close(new Error('Discarding unconfirmed lifecycle commit.', { cause: commitError }));
      } catch (discardError) {
        throw new AggregateError([commitError, discardError], 'Lifecycle commit connection could not be discarded.');
      }
      return await input.recoverCommitted(value, commitError);
    }
    return value;
  } finally {
    if (!closed) await close();
  }
}
