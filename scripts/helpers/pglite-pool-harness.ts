import { EventEmitter } from 'node:events';
import type { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

/** Embedded SQL only: this adapter does not model independent PG backends,
 * concurrent transactions, advisory locks, principals, or COMMIT finality. */
export function installPglitePoolHarness(postgres: PGlite) {
  const originalQuery = Object.getOwnPropertyDescriptor(Pool.prototype, 'query');
  const originalConnect = Object.getOwnPropertyDescriptor(Pool.prototype, 'connect');
  if (typeof Pool.prototype.query !== 'function' || typeof Pool.prototype.connect !== 'function') throw new Error('The pg Pool prototype is unavailable.');
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return {
      ...result,
      rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array'
        ? result.rows.map(row => result.fields.map(field => row[field.name]))
        : result.rows,
    };
  };
  const checkedOut = new Set<FixtureClient>();
  const createClient = () => {
    const client = Object.assign(new EventEmitter(), {
      query,
      release(_error?: Error) {
        if (!checkedOut.delete(client)) throw new Error('The PGlite fixture client was already released.');
      },
    });
    checkedOut.add(client);
    return client;
  };
  type FixtureClient = ReturnType<typeof createClient>;
  type ConnectCallback = (error: Error | undefined, client: FixtureClient | undefined, release: (error?: Error) => void) => void;
  function connect(): Promise<FixtureClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<FixtureClient> | void {
    const client = createClient();
    if (callback) {
      // openDb installs its error observer inside this actual callback.
      queueMicrotask(() => callback(undefined, client, client.release));
      return;
    }
    return Promise.resolve(client);
  }
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, ...originalQuery, value: query });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, ...originalConnect, value: connect });
  let restored = false;
  return {
    get activeClientCount() { return checkedOut.size; },
    restore() {
      if (restored) return;
      restored = true;
      if (originalQuery) Object.defineProperty(Pool.prototype, 'query', originalQuery);
      else Reflect.deleteProperty(Pool.prototype, 'query');
      if (originalConnect) Object.defineProperty(Pool.prototype, 'connect', originalConnect);
      else Reflect.deleteProperty(Pool.prototype, 'connect');
    },
  };
}

/** An unresolved Promise cannot turn a partial standalone fixture into Exit 0.
 * The operation must include all cleanup before the success marker is printed. */
export async function runPgliteFixture(input: {
  label: string;
  operation: () => Promise<void>;
  successMessage: string;
  watchdogMs?: number;
}): Promise<void> {
  const watchdogMs = input.watchdogMs ?? 180_000;
  if (!Number.isSafeInteger(watchdogMs) || watchdogMs < 1 || watchdogMs > 180_000) throw new Error('A bounded fixture watchdog is required.');
  let settled = false, reported = false;
  const incomplete = (reason: string) => {
    if (settled) return;
    if (!reported) console.error(`${input.label}: INCOMPLETE (${reason}); assertions and cleanup completion are unconfirmed.`);
    reported = true;
    process.exitCode = 1;
  };
  const beforeExit = () => incomplete('beforeExit');
  const exit = () => incomplete('exit');
  process.once('beforeExit', beforeExit);
  process.once('exit', exit);
  const watchdog = setTimeout(() => { incomplete('watchdog'); process.exit(1); }, watchdogMs);
  watchdog.ref();
  console.log(`${input.label}: started`);
  try {
    await input.operation();
    console.log(input.successMessage);
    console.log(`${input.label}: COMPLETED: all assertions and cleanup settled.`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`${input.label}: failed; no completion marker was emitted.`);
    console.error(error);
  } finally {
    settled = true;
    clearTimeout(watchdog);
    process.removeListener('beforeExit', beforeExit);
    process.removeListener('exit', exit);
  }
}
