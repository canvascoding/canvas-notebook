import 'server-only';

type Reason = 'required' | 'invalid' | 'reentrant' | 'detached';

/** Callback settlement only. The caller retains its genuine authority check,
 * attribution, errors and transaction ownership. This never authenticates a
 * principal, opens SQL or grants access from a stored job. */
export async function withWorkspaceOperationJobPolicyLifetime<Access, Result>(input: Readonly<{
  check: () => Promise<void>;
  assertCoreCurrent: () => Promise<void>;
  access: (assertCurrent: () => Promise<void>) => Access;
  error: (reason: Reason) => Error;
  closingFailure: (error: unknown) => void;
}>, operation: (access: Access) => Promise<Result>): Promise<Result> {
  let active = true, accepting = true, checking = false, failure: unknown;
  const pending = new Set<Promise<void>>();
  const check = async (): Promise<void> => {
    try {
      if (!active) throw input.error('required');
      if (failure !== undefined) throw failure;
      if (checking) throw input.error('reentrant');
      checking = true;
      try { await input.check(); }
      finally { checking = false; }
    } catch (error) { failure ??= error ?? input.error('invalid'); throw failure; }
  };
  const assertCurrent = (): Promise<void> => {
    const promise = (async () => {
      try {
        if (!accepting) {
          // Preserve the real Core phase's poison/drain contract while its
          // final policy check can still be completing after this callback.
          await input.assertCoreCurrent();
          throw input.error('required');
        }
        await check();
      } catch (error) {
        failure ??= error ?? input.error('invalid');
        input.closingFailure(failure);
        throw failure;
      }
    })();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
    return promise;
  };
  try {
    await check();
    const result = await operation(input.access(assertCurrent));
    accepting = false;
    if (pending.size) {
      failure ??= input.error('detached');
      await Promise.allSettled([...pending]);
    }
    if (failure !== undefined) throw failure;
    await check();
    if (failure !== undefined) throw failure;
    return result;
  } finally {
    accepting = false;
    if (pending.size) await Promise.allSettled([...pending]);
    active = false;
  }
}
