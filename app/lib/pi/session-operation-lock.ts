type SessionOperationStore = {
  tails: Map<string, Promise<void>>;
};

export type PiSessionOperationLease = {
  /**
   * Keeps subsequent operations queued after the current callback returns.
   * This is used to quarantine a session while detached provider/tool work is
   * still settling after an abort timeout.
   */
  holdUntil: (settlement: Promise<unknown>) => void;
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
async function withPiSessionOperationLease<T>(
  sessionId: string,
  userId: string,
  operation: (lease: PiSessionOperationLease) => Promise<T>,
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
  const leaseState: { holdSettlement: Promise<void> | null } = {
    holdSettlement: null,
  };
  const lease: PiSessionOperationLease = {
    holdUntil(settlement) {
      const normalizedSettlement = settlement.then(() => undefined, () => undefined);
      leaseState.holdSettlement = leaseState.holdSettlement
        ? Promise.all([leaseState.holdSettlement, normalizedSettlement]).then(() => undefined)
        : normalizedSettlement;
    },
  };

  const releaseLease = () => {
    release();
    if (store.tails.get(key) === tail) {
      store.tails.delete(key);
    }
  };

  await previous.catch(() => undefined);
  try {
    return await operation(lease);
  } finally {
    const holdSettlement = leaseState.holdSettlement;
    if (holdSettlement) {
      void holdSettlement.finally(releaseLease);
    } else {
      releaseLease();
    }
  }
}

export async function withPiSessionOperationLock<T>(
  sessionId: string,
  userId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withPiSessionOperationLease(sessionId, userId, operation);
}

export async function withQuarantinablePiSessionOperationLock<T>(
  sessionId: string,
  userId: string,
  operation: (lease: PiSessionOperationLease) => Promise<T>,
): Promise<T> {
  return withPiSessionOperationLease(sessionId, userId, operation);
}
