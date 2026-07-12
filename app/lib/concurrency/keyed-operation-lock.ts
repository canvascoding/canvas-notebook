type KeyedOperationStore = {
  tails: Map<string, Promise<void>>;
};

export type KeyedOperationLease = {
  /**
   * Keeps later operations queued after the current callback returns.
   * This is useful when aborted work is still settling asynchronously.
   */
  holdUntil: (settlement: Promise<unknown>) => void;
};

const globalOperationStores = globalThis as typeof globalThis & {
  __canvasKeyedOperationStores?: Map<string, KeyedOperationStore>;
};

function getOperationStore(namespace: string): KeyedOperationStore {
  if (!globalOperationStores.__canvasKeyedOperationStores) {
    globalOperationStores.__canvasKeyedOperationStores = new Map();
  }
  let store = globalOperationStores.__canvasKeyedOperationStores.get(namespace);
  if (!store) {
    store = { tails: new Map() };
    globalOperationStores.__canvasKeyedOperationStores.set(namespace, store);
  }
  return store;
}

export async function withKeyedOperationLease<T>(
  namespace: string,
  key: string,
  operation: (lease: KeyedOperationLease) => Promise<T>,
): Promise<T> {
  const store = getOperationStore(namespace);
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
  const lease: KeyedOperationLease = {
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

export async function withKeyedOperationLock<T>(
  namespace: string,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedOperationLease(namespace, key, operation);
}
