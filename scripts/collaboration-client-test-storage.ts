/** Minimal successful transaction adapter for tests that focus on transport callbacks. */
export function committedCollaborationTestDatabase(): IDBDatabase {
  return {
    transaction: () => {
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => ({ add: () => queueMicrotask(() => transaction.oncomplete?.()) }),
        abort: () => transaction.onabort?.(),
      };
      return transaction;
    },
  } as unknown as IDBDatabase;
}
