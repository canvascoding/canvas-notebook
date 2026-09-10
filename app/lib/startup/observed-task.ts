/**
 * Own a task immediately, even if a later startup phase consumes its result.
 * The stored outcome never rejects; calling the returned waiter still throws
 * the original error. Do not call the waiter until its promise can be awaited.
 */
export function observeStartupTask<T>(operation: Promise<T>): () => Promise<T> {
  const outcome = operation.then(
    (value) => ({ ok: true, value } as const),
    (error: unknown) => ({ ok: false, error } as const),
  );
  return async () => {
    const result = await outcome;
    if (!result.ok) throw result.error;
    return result.value;
  };
}
