import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import type { ClientBase, Pool, PoolClient } from 'pg';

export type DocumentOperation = 'read' | 'save' | 'create' | 'links' | 'rename' | 'move' | 'copy' | 'delete';
export type DocumentOperationActor = 'request' | 'agent' | 'mcp' | 'system';
export type DocumentOperationPhase = 'operation' | 'authorization' | 'snapshot' | 'parse' | 'resolve' | 'transaction'
  | 'snapshot_validate' | 'receipt_begin' | 'file_write' | 'checkpoint_confirm' | 'projection_finalize' | 'receipt_finalize'
  | 'create_observe' | 'create_native' | 'create_effects' | 'publication_authority'
  | 'birth_open' | 'birth_verify' | 'birth_prepare' | 'birth_publish' | 'birth_observe' | 'birth_complete' | 'birth_finalize';
type Counts = { calls: number; wallMs: number; statements: number; databaseMs: number; failedStatements: number };
type QueryCounts = Pick<Counts, 'statements' | 'databaseMs' | 'failedStatements'>;
type QueryGroup = 'transaction' | 'catalogue' | 'seat' | 'agent' | 'session' | 'workspace' | 'account'
  | 'document-state' | 'document-projection' | 'document-registry' | 'other';
export type DocumentOperationMeasurement = Readonly<{
  component: 'document_operation'; version: 1; operationId: string; operation: DocumentOperation; actor: DocumentOperationActor;
  outcome: 'succeeded' | 'failed'; wallMs: number; statements: number; databaseMs: number; failedStatements: number;
  poolWaitMs: number; checkouts: number; peakConnections: number; openConnectionsAtCompletion: number;
  openQueriesAtCompletion: number; unsupportedQueryForms: number;
  queryGroups: ReadonlyArray<QueryCounts & { group: QueryGroup }>;
  phases: ReadonlyArray<Counts & { phase: DocumentOperationPhase }>;
}>;
/** A controlled profiler window observes all instrumented runtime SQL in this
 * process, including callbacks without an operation context. It is neither a
 * caller-specific measurement nor authority. Overlapping windows overlap data. */
export type DocumentDatabaseActivityMeasurement = Readonly<Omit<DocumentOperationMeasurement, 'component'> & {
  component: 'document_database_activity'; coverage: 'instrumented-runtime-process-window';
  scopedStatements: number; unscopedStatements: number;
}>;
type State = { operationId: string; operation: DocumentOperation; actor: DocumentOperationActor; started: number; closed: boolean;
  statements: number; databaseMs: number; failedStatements: number; poolWaitMs: number; checkouts: number;
  connections: number; peakConnections: number; queries: number; unsupportedQueryForms: number;
  phases: Map<DocumentOperationPhase, Counts>; queryGroups: Map<QueryGroup, QueryCounts>;
  scopedStatements: number; unscopedStatements: number };
type Context = { state: State; phases: readonly DocumentOperationPhase[] };
type MetricObserver = (value: DocumentOperationMeasurement) => void;
type SharedMetricsRuntime = {
  context: AsyncLocalStorage<Context | undefined>; observers: AsyncLocalStorage<MetricObserver | undefined>;
  activities: Set<State>; measuredClients: WeakSet<ClientBase>; measuredPools: WeakSet<Pool>;
};
// The custom server and separately built application modules can use the same
// actual pool. Share diagnostics and wrapper identity across those bundles;
// otherwise queries disappear or wrappers stack. This registry holds no auth
// context, SQL text/parameters, document content or permission capabilities.
const metricsRuntimeKey = Symbol.for('canvas.document-operation-metrics.v1');
const processMetrics = globalThis as unknown as { [key: symbol]: SharedMetricsRuntime | undefined };
const sharedMetrics = processMetrics[metricsRuntimeKey] ??= {
  context: new AsyncLocalStorage<Context | undefined>(), observers: new AsyncLocalStorage<MetricObserver | undefined>(),
  activities: new Set<State>(), measuredClients: new WeakSet<ClientBase>(), measuredPools: new WeakSet<Pool>(),
};
const context = sharedMetrics.context, observers = sharedMetrics.observers, activities = sharedMetrics.activities;
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
function createMeasurementState(operation: DocumentOperation, actor: DocumentOperationActor): State {
  const state: State = { operationId: randomUUID(), operation, actor, started: performance.now(), closed: false,
    statements: 0, databaseMs: 0, failedStatements: 0, poolWaitMs: 0, checkouts: 0, connections: 0,
    peakConnections: 0, queries: 0, unsupportedQueryForms: 0, phases: new Map(), queryGroups: new Map(),
    scopedStatements: 0, unscopedStatements: 0 };
  phaseCounts(state, 'operation').calls = 1;
  return state;
}
function measurementSnapshot(state: State, outcome: DocumentOperationMeasurement['outcome']): DocumentOperationMeasurement {
  phaseCounts(state, 'operation').wallMs = performance.now() - state.started;
  return Object.freeze({ component: 'document_operation', version: 1,
    operationId: state.operationId, operation: state.operation, actor: state.actor, outcome,
    wallMs: rounded(performance.now() - state.started), statements: state.statements,
    databaseMs: rounded(state.databaseMs), failedStatements: state.failedStatements,
    poolWaitMs: rounded(state.poolWaitMs), checkouts: state.checkouts, peakConnections: state.peakConnections,
    openConnectionsAtCompletion: state.connections, openQueriesAtCompletion: state.queries,
    unsupportedQueryForms: state.unsupportedQueryForms,
    queryGroups: Object.freeze([...state.queryGroups].map(([group, counts]) => Object.freeze({ group, ...counts,
      databaseMs: rounded(counts.databaseMs) }))),
    phases: Object.freeze([...state.phases].map(([phase, counts]) =>
      Object.freeze({ phase, ...counts, wallMs: rounded(counts.wallMs), databaseMs: rounded(counts.databaseMs) }))) });
}
function deliverMeasurement<T>(observe: ((value: T) => void) | undefined, value: T): void {
  try {
    const pending: unknown = observe?.(value);
    if (pending instanceof Promise) void pending.catch(() => undefined);
  } catch { /* Diagnostics cannot alter an operation result. */ }
}

// Bounded diagnostic families, never SQL identities or authorization decisions.
// A statement is counted once; mixed statements use the first matching family.
// Unlike a SQL parser this can also match a spelling inside a comment/literal.
// Only the fixed label survives: neither text nor parameters enter State.
const queryFamilies: ReadonlyArray<readonly [QueryGroup, RegExp]> = [
  ['transaction', /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|LOCK)\b/iu],
  ['catalogue', /\b(?:pg_stat_activity|pg_namespace|pg_class|pg_database|pg_attribute|pg_constraint|pg_trigger|to_regclass|to_regnamespace|current_schema|pg_current_xact_id(?:_if_assigned)?)\b/iu],
  ['seat', /\b(?:team_memberships|team_membership_sync_state)\b/iu],
  ['agent', /\b(?:agents|agent_members|agent_grants)\b/iu],
  ['session', /\b(?:pi_sessions|session)\b/iu],
  ['workspace', /\b(?:canvas_workspaces|canvas_workspace_members|canvas_projects|canvas_project_members)\b/iu],
  ['account', /\b(?:canvas_organization_settings|organization_user_permissions|user)\b/iu],
  ['document-state', /\bcollaboration_yjs_states\b/iu],
  ['document-projection', /\b(?:collaboration_file_projections|file_revisions)\b/iu],
  ['document-registry', /\b(?:collaboration_documents|file_collaboration_lineages|workspace_file_metadata)\b/iu],
];
function queryGroup(input: unknown): QueryGroup {
  // Inspect only an own data property. Reading a getter or proxy would change
  // the original driver's observable behavior, including its number of traps.
  const text = typeof input === 'string' ? input
    : input && typeof input === 'object' && !isProxy(input) ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
  if (typeof text !== 'string' || text.length > 32768) return 'other';
  return queryFamilies.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

/** Scope-local measurements only. The sink never receives SQL, parameters,
 * document paths/content, user IDs, credentials or original exceptions. */
export function withDocumentOperationMetricObserver<T>(observe: MetricObserver, operation: () => Promise<T>): Promise<T> {
  return observers.run(observe, operation);
}
/** Retain only the diagnostic sink for callbacks entered by a socket/runtime.
 * Other AsyncLocalStorage contexts, including real authority, are not captured. */
export function captureDocumentOperationMetricObserver() {
  const observe = observers.getStore();
  return <T>(operation: () => Promise<T>): Promise<T> => observers.run(observe, operation);
}
export async function measureDocumentOperation<T>(operation: DocumentOperation, actor: DocumentOperationActor,
  execute: () => Promise<T>): Promise<T> {
  // A shared service joins its caller's measurement; it cannot mint authority.
  if (context.getStore()?.state.closed === false || !operationNames.has(operation) || !actorNames.has(actor)) return execute();
  const state = createMeasurementState(operation, actor);
  let outcome: DocumentOperationMeasurement['outcome'] = 'failed';
  try {
    const result = await context.run({ state, phases: ['operation'] }, execute); outcome = 'succeeded'; return result;
  } finally {
    state.closed = true;
    const value = measurementSnapshot(state, outcome);
    deliverMeasurement(observers.getStore(), value);
    // Keep normal traffic quiet; retain actionable, content-free slow-operation facts.
    if (value.statements >= 500 || value.wallMs >= 1000 || value.openQueriesAtCompletion || value.openConnectionsAtCompletion) {
      try { console.info(JSON.stringify(value)); } catch { /* Logging is best-effort. */ }
    }
  }
}
/** Opt-in process window for an isolated profiler. It does not capture or
 * reinstate AsyncLocalStorage authority, add SQL, or change the normal sink.
 * Pool counters cover leases acquired in the window, not dedicated lifetimes.
 * The caller must await the actual action/checkpoint before ending the window. */
export async function measureDocumentDatabaseActivity<T>(operation: DocumentOperation, actor: DocumentOperationActor,
  execute: () => Promise<T>, observe: (value: DocumentDatabaseActivityMeasurement) => void): Promise<T> {
  if (!operationNames.has(operation) || !actorNames.has(actor)) return execute();
  const state = createMeasurementState(operation, actor); activities.add(state);
  let outcome: DocumentOperationMeasurement['outcome'] = 'failed';
  try { const result = await execute(); outcome = 'succeeded'; return result; }
  finally {
    state.closed = true; activities.delete(state);
    const value: DocumentDatabaseActivityMeasurement = Object.freeze({ ...measurementSnapshot(state, outcome),
      component: 'document_database_activity', coverage: 'instrumented-runtime-process-window',
      scopedStatements: state.scopedStatements, unscopedStatements: state.unscopedStatements });
    deliverMeasurement(observe, value);
  }
}
export async function measureDocumentPhase<T>(phase: DocumentOperationPhase, execute: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (!parent || parent.state.closed || !phaseNames.has(phase) || parent.phases.length >= 8) return execute();
  const counts = phaseCounts(parent.state, phase), started = performance.now(); counts.calls++;
  try { return await context.run({ state: parent.state, phases: [...new Set([...parent.phases, phase])] }, execute); }
  finally { counts.wallMs += performance.now() - started; }
}

function beginStatement(input: unknown) {
  const current = context.getStore();
  if ((!current || current.state.closed) && activities.size === 0) return null;
  const scoped = current && !current.state.closed;
  const targets: Context[] = scoped ? [current] : [];
  for (const state of activities) {
    if (scoped) state.scopedStatements++; else state.unscopedStatements++;
    targets.push({ state, phases: ['operation'] });
  }
  if (!targets.length) return null;
  const started = performance.now(); let finished = false;
  const group = queryGroup(input);
  const counted = targets.map(({ state, phases }) => {
    let grouped = state.queryGroups.get(group);
    if (!grouped) { grouped = { statements: 0, databaseMs: 0, failedStatements: 0 }; state.queryGroups.set(group, grouped); }
    grouped.statements++; state.statements++; state.queries++;
    for (const phase of phases) phaseCounts(state, phase).statements++;
    return { state, phases, grouped };
  });
  return (failed: boolean, unsupported = false) => {
    if (finished) return; finished = true;
    const elapsed = performance.now() - started;
    for (const { state, phases, grouped } of counted) {
      grouped.databaseMs += elapsed; if (failed) grouped.failedStatements++;
      state.databaseMs += elapsed; state.queries--; if (failed) state.failedStatements++;
      if (unsupported) state.unsupportedQueryForms++;
      for (const phase of phases) {
        const counts = phaseCounts(state, phase); counts.databaseMs += elapsed; if (failed) counts.failedStatements++;
      }
    }
  };
}
const measuredClients = sharedMetrics.measuredClients;
function instrumentClient(client: ClientBase): void {
  if (measuredClients.has(client)) return;
  const originalOwnMethod = Object.getOwnPropertyDescriptor(client, 'query')?.value;
  const measured = function(this: ClientBase, ...args: unknown[]) {
    // Keep later instrumentation/fault probes on Client.prototype visible.
    // Capturing an inherited method here would silently bypass those guards.
    const original = originalOwnMethod ?? Reflect.get(Object.getPrototypeOf(this), 'query', this);
    const finish = beginStatement(args[0]);
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
  } as ClientBase['query'];
  Object.defineProperty(client, 'query', { configurable: true, writable: true, value: measured });
  measuredClients.add(client);
}

/** Observe real SQL on a caller-owned dedicated connection using the exact
 * same wrapper as pooled clients. This does not connect, close or lease it;
 * checkout/wait/connection counters continue to describe pool leases only. */
export function installDocumentClientQueryMetrics(client: ClientBase): void {
  instrumentClient(client);
}
const measuredPools = sharedMetrics.measuredPools;

/** Counts actual pg executions for SQL adapters, Drizzle and pool.query. It
 * forwards the original arguments/results/errors and never supplies query data. */
export function installDocumentDatabaseMetrics(pool: Pool): void {
  if (measuredPools.has(pool)) return;
  const original = pool.connect, leases = new WeakMap<PoolClient, readonly State[]>();
  const acquired = (captured: Context | undefined, started: number, client?: PoolClient) => {
    const targets = [...(captured && !captured.state.closed ? [captured.state] : []), ...activities];
    const waited = performance.now() - started;
    for (const state of targets) {
      state.poolWaitMs += waited; state.checkouts++;
      if (client) { state.connections++; state.peakConnections = Math.max(state.peakConnections, state.connections); }
    }
    if (client && targets.length) leases.set(client, targets);
  };
  pool.on('connect', instrumentClient);
  pool.on('release', (_error, client) => { const states = leases.get(client);
    if (states) { for (const state of states) state.connections--; leases.delete(client); } });
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
