export class HealthCheckTimeoutError extends Error {
  constructor(checkName: string, timeoutMillis: number) {
    super(`${checkName} did not finish within ${timeoutMillis}ms.`);
    this.name = 'HealthCheckTimeoutError';
  }
}

export async function withHealthCheckTimeout<T>(
  checkName: string,
  operation: Promise<T>,
  timeoutMillis: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new HealthCheckTimeoutError(checkName, timeoutMillis)),
          timeoutMillis,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createCachedAsyncCheck<T>(loader: () => Promise<T>, ttlMillis: number): () => Promise<T> {
  let cached: { expiresAt: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;

  return async (): Promise<T> => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (inFlight) return inFlight;

    inFlight = loader()
      .then((value) => {
        cached = { expiresAt: Date.now() + ttlMillis, value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
