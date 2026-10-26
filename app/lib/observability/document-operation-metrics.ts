import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';

export type DocumentOperation = 'read' | 'save' | 'create' | 'links' | 'rename' | 'move' | 'copy' | 'delete';
export type DocumentOperationActor = 'request' | 'agent' | 'mcp' | 'system';
export type DocumentOperationPhase = 'operation' | 'authorization' | 'snapshot' | 'parse' | 'resolve' | 'transaction'
  | 'snapshot_validate' | 'receipt_begin' | 'file_write' | 'checkpoint_confirm' | 'projection_finalize' | 'receipt_finalize'
  | 'create_observe' | 'create_native' | 'create_effects' | 'publication_authority'
  | 'birth_open' | 'birth_verify' | 'birth_prepare' | 'birth_publish' | 'birth_observe' | 'birth_complete' | 'birth_finalize';
type Counts = { calls: number; wallMs: number; statements: number; databaseMs: number; failedStatements: number };
export type DocumentOperationMeasurement = Readonly<{
  component: 'document_operation'; version: 1; operationId: string; operation: DocumentOperation; actor: DocumentOperationActor;
  outcome: 'succeeded' | 'failed'; wallMs: number; statements: number; databaseMs: number; failedStatements: number;
  poolWaitMs: number; checkouts: number; peakConnections: number; openConnectionsAtCompletion: number;
  openQueriesAtCompletion: number; unsupportedQueryForms: number;
  phases: ReadonlyArray<Counts & { phase: DocumentOperationPhase }>;
}>;
type State = { operationId: string; operation: DocumentOperation; actor: DocumentOperationActor; started: number; closed: boolean;
  statements: number; databaseMs: number; failedStatements: number; poolWaitMs: number; checkouts: number;
  connections: number; peakConnections: number; queries: number; unsupportedQueryForms: number;
  phases: Map<DocumentOperationPhase, Counts> };
type Context = { state: State; phases: readonly DocumentOperationPhase[] };
const context = new AsyncLocalStorage<Context | undefined>();
type MetricObserver = (value: DocumentOperationMeasurement) => void;
const observers = new AsyncLocalStorage<MetricObserver | undefined>();
const operationNames = new Set<DocumentOperation>(['read','save','create','links','rename','move','copy','delete']);
const actorNames = new Set<DocumentOperationActor>(['request','agent','mcp','system']);
const phaseNames = new Set<DocumentOperationPhase>(['operation','authorization','snapshot','parse','resolve','transaction',
  'snapshot_validate','receipt_begin','file_write','checkpoint_confirm','projection_finalize','receipt_finalize',
  'create_observe','create_native','create_effects','publication_authority','birth_open','birth_verify','birth_prepare',
  'birth_publish','birth_observe','birth_complete','birth_finalize']);
const rounded = (value: number) => Math.round(Math.max(0, value) * 100) / 100;
const phaseCounts = (state: State, phase: DocumentOperationPhase) => {
  let counts = state.phases.get(phase);
  if (!counts) { counts = { calls: 0, wallMs: 0, statements: 0, databaseMs: 0, failedStatements: 0 }; state.phases.set(phase, counts); }
  return counts;
};

/** Scope-local measurements only. The sink never receives SQL, parameters,
 * document paths/content, user IDs, credentials or original exceptions. */
export function withDocumentOperationMetricObserver<T>(observe: MetricObserver, operation: () => Promise<T>): Promise<T> {
  return observers.run(observe, operation);
}
export async function measureDocumentOperation<T>(operation: DocumentOperation, actor: DocumentOperationActor,
  execute: () => Promise<T>): Promise<T> {
  // A shared service joins its caller's measurement; it cannot mint authority.
  if (context.getStore() || !operationNames.has(operation) || !actorNames.has(actor)) return execute();
  const state: State = { operationId: randomUUID(), operation, actor, started: performance.now(), closed: false,
    statements: 0, databaseMs: 0, failedStatements: 0, poolWaitMs: 0, checkouts: 0, connections: 0,
    peakConnections: 0, queries: 0, unsupportedQueryForms: 0, phases: new Map() };
  phaseCounts(state, 'operation').calls = 1;
  let outcome: DocumentOperationMeasurement['outcome'] = 'failed';
  try {
    const result = await context.run({ state, phases: ['operation'] }, execute); outcome = 'succeeded'; return result;
  } finally {
    state.closed = true;
    phaseCounts(state, 'operation').wallMs = performance.now() - state.started;
    const value: DocumentOperationMeasurement = Object.freeze({ component: 'document_operation', version: 1,
      operationId: state.operationId, operation, actor, outcome, wallMs: rounded(performance.now() - state.started),
      statements: state.statements, databaseMs: rounded(state.databaseMs), failedStatements: state.failedStatements,
      poolWaitMs: rounded(state.poolWaitMs), checkouts: state.checkouts, peakConnections: state.peakConnections,
      openConnectionsAtCompletion: state.connections, openQueriesAtCompletion: state.queries,
      unsupportedQueryForms: state.unsupportedQueryForms, phases: Object.freeze([...state.phases].map(([phase, counts]) =>
        Object.freeze({ phase, ...counts, wallMs: rounded(counts.wallMs), databaseMs: rounded(counts.databaseMs) }))) });
    try {
      const pending: unknown = observers.getStore()?.(value);
      if (pending instanceof Promise) void pending.catch(() => undefined);
    } catch { /* Diagnostics cannot alter an operation result. */ }
    // Keep normal traffic quiet; retain actionable, content-free slow-operation facts.
    if (value.statements >= 500 || value.wallMs >= 1000 || value.openQueriesAtCompletion || value.openConnectionsAtCompletion) {
      try { console.info(JSON.stringify(value)); } catch { /* Logging is best-effort. */ }
    }
  }
}
export async function measureDocumentPhase<T>(phase: DocumentOperationPhase, execute: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (!parent || parent.state.closed || !phaseNames.has(phase) || parent.phases.length >= 8) return execute();
  const counts = phaseCounts(parent.state, phase), started = performance.now(); counts.calls++;
  try { return await context.run({ state: parent.state, phases: [...new Set([...parent.phases, phase])] }, execute); }
  finally { counts.wallMs += performance.now() - started; }
}

function beginStatement() {
  const current = context.getStore();
  if (!current || current.state.closed) return null;
  const { state, phases } = current, started = performance.now(); let finished = false;
  state.statements++; state.queries++;
  for (const phase of phases) phaseCounts(state, phase).statements++;
  return (failed: boolean, unsupported = false) => {
    if (finished) return; finished = true;
    const elapsed = performance.now() - started;
    state.databaseMs += elapsed; state.queries--; if (failed) state.failedStatements++;
    if (unsupported) state.unsupportedQueryForms++;
    for (const phase of phases) {
      const counts = phaseCounts(state, phase); counts.databaseMs += elapsed; if (failed) counts.failedStatements++;
    }
  };
}
const measuredClients = new WeakSet<PoolClient>();
function instrumentClient(client: PoolClient): void {
  if (measuredClients.has(client)) return;
  const originalOwnMethod = Object.getOwnPropertyDescriptor(client, 'query')?.value;
  const measured = function(this: PoolClient, ...args: unknown[]) {
    // Keep later instrumentation/fault probes on Client.prototype visible.
    // Capturing an inherited method here would silently bypass those guards.
    const original = originalOwnMethod ?? Reflect.get(Object.getPrototypeOf(this), 'query', this);
    const finish = beginStatement();
    if (!finish) return Reflect.apply(original, this, args);
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      const captured = context.getStore();
      args[args.length - 1] = function(this: unknown, ...values: unknown[]) {
        finish(values[0] != null);
        return context.run(captured, () => Reflect.apply(callback, this, values));
      };
    }
    try {
      const result = Reflect.apply(original, this, args);
      if (typeof callback === 'function') return result;
      if (result instanceof Promise) return result.then(value => { finish(false); return value; }, error => { finish(true); throw error; });
      // Preserve custom Query/event/stream semantics without adding error listeners.
      finish(false, true); return result;
    } catch (error) { finish(true); throw error; }
  } as PoolClient['query'];
  Object.defineProperty(client, 'query', { configurable: true, writable: true, value: measured });
  measuredClients.add(client);
}
const measuredPools = new WeakSet<Pool>();

/** Counts actual pg executions for SQL adapters, Drizzle and pool.query. It
 * forwards the original arguments/results/errors and never supplies query data. */
export function installDocumentDatabaseMetrics(pool: Pool): void {
  if (measuredPools.has(pool)) return;
  const original = pool.connect, leases = new WeakMap<PoolClient, State>();
  const acquired = (captured: Context | undefined, started: number, client?: PoolClient) => {
    const state = captured?.state;
    if (!state || state.closed) return;
    state.poolWaitMs += performance.now() - started; state.checkouts++;
    if (client) { state.connections++; state.peakConnections = Math.max(state.peakConnections, state.connections); leases.set(client, state); }
  };
  pool.on('connect', instrumentClient);
  pool.on('release', (_error, client) => { const state = leases.get(client); if (state) { state.connections--; leases.delete(client); } });
  const connect = function(this: Pool, ...args: unknown[]) {
    const captured = context.getStore(), started = performance.now(), callback = args[0];
    if (typeof callback === 'function') {
      args[0] = function(this: unknown, ...values: unknown[]) {
        acquired(captured, started, values[0] == null ? values[1] as PoolClient : undefined);
        return context.run(captured, () => Reflect.apply(callback, this, values));
      };
      return Reflect.apply(original, this, args);
    }
    const result = Reflect.apply(original, this, args) as Promise<PoolClient>;
    return result.then(client => { acquired(captured, started, client); return client; }, error => { acquired(captured, started); throw error; });
  } as typeof original;
  Object.defineProperty(pool, 'connect', { configurable: true, writable: true, value: connect });
  measuredPools.add(pool);
}
