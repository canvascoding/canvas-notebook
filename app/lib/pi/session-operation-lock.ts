type SessionOperationStore = {
  tails: Map<string, Promise<void>>;
};

const globalOperationStore = globalThis as typeof globalThis & {
  __canvasPiSessionOperationStore?: SessionOperationStore;
};

function getOperationStore(): SessionOperationStore {
  if (!globalOperationStore.__canvasPiSessionOperationStore) {
    globalOperationStore.__canvasPiSessionOperationStore = {
      tails: new Map<string, Promise<void>>(),
    };
  }
  return globalOperationStore.__canvasPiSessionOperationStore;
}

function sessionOperationKey(sessionId: string, userId: string): string {
  return `${userId}:${sessionId}`;
}

/**
 * Serializes operations that may start or replace a live runtime for one
 * user-owned session. The lock intentionally spans asynchronous preparation:
 * a model change cannot pass its idle check while a prompt is preparing, and
 * a prompt cannot obtain the old runtime while a model change is being saved.
 */
export async function withPiSessionOperationLock<T>(
  sessionId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const store = getOperationStore();
  const key = sessionOperationKey(sessionId, userId);
  const previous = store.tails.get(key) ?? Promise.resolve();

  let release!: () => void;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => completion);
  store.tails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (store.tails.get(key) === tail) {
      store.tails.delete(key);
    }
  }
}
