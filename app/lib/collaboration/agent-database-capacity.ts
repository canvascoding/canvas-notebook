import { resolvePostgresRuntimeOptions } from '../db/postgres-runtime-options';

export class AgentDatabaseCapacityError extends Error {
  readonly status = 503;
  readonly code = 'agent_database_busy';

  constructor() {
    super('Agent editing is busy. Retry the request.');
    this.name = 'AgentDatabaseCapacityError';
  }
}

/** Error identity must survive separate Next.js bundles sharing the admission queue. */
export function isAgentDatabaseCapacityError(error: unknown): error is AgentDatabaseCapacityError {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'agent_database_busy';
}

type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> };

/**
 * Grant transactions deliberately hold a row lock while the live mutation is
 * persisted. Their authorization and persistence use the same database pool.
 * Admit before leasing a client and reserve capacity for that nested work.
 * This bounds only long grant leases; ordinary queries keep using the app pool.
 */
export function createAgentDatabaseAdmission(poolMax: number, options: { waitMs?: number; maxWaiters?: number } = {}) {
  const limit = Math.floor((poolMax - 1) / 2);
  const waiters = new Set<Waiter>();
  let active = 0;
  function releaseLease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.values().next().value as Waiter | undefined;
      if (next) {
        waiters.delete(next);
        clearTimeout(next.timer);
        next.resolve(releaseLease());
      } else active--;
    };
  }
  async function acquire(): Promise<() => void> {
    // A one/two-client operator pool cannot support a held grant plus the
    // nested authorization/persistence work. Fail before leasing, never hang.
    if (limit < 1) throw new AgentDatabaseCapacityError();
    if (active < limit) {
      active++;
      return releaseLease();
    }
    if (waiters.size >= (options.maxWaiters ?? 256)) throw new AgentDatabaseCapacityError();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new AgentDatabaseCapacityError());
      }, options.waitMs ?? 30_000) };
      waiters.add(waiter);
    });
  }
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = await acquire();
    try { return await operation(); } finally { release(); }
  };
}

const STATE_KEY = Symbol.for('canvas.agent-database-admission.v1');

export function withAgentDatabaseCapacity<T>(operation: () => Promise<T>): Promise<T> {
  // Next.js may load several bundles in one process, all sharing one PG pool.
  const registry = globalThis as unknown as Record<symbol, ReturnType<typeof createAgentDatabaseAdmission> | undefined>;
  const run = registry[STATE_KEY] ??= createAgentDatabaseAdmission(resolvePostgresRuntimeOptions().max);
  return run(operation);
}
