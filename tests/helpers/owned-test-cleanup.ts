type CleanupStep = { label: string; run: () => void | Promise<void> };

/** Preserve the body failure and still attempt every independently owned cleanup. */
export async function withOwnedTestCleanup<T>(body: () => Promise<T>, steps: readonly CleanupStep[]): Promise<T> {
  let failed = false;
  let primary: unknown;
  let result!: T;
  try { result = await body(); } catch (error) { failed = true; primary = error; }
  const cleanupErrors: Error[] = [];
  for (const step of steps) {
    try { await step.run(); }
    catch (error) { cleanupErrors.push(new Error(`Owned test cleanup failed (${step.label}).`, { cause: error })); }
  }
  if (cleanupErrors.length) {
    const combined = new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors,
      'Owned test body or cleanup failed.');
    if (primary && typeof primary === 'object' && Object.hasOwn(primary, 'ownedChildReceipt')) {
      Object.assign(combined, { ownedChildReceipt: (primary as { ownedChildReceipt: unknown }).ownedChildReceipt });
    }
    throw combined;
  }
  if (failed) throw primary;
  return result;
}
