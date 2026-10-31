import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import type { Pool, PoolClient } from 'pg';
import { isWorkspaceFileInvalidation } from '../app/lib/files/file-events';

type ListenerModule = typeof import('../app/lib/filesystem/workspace-file-invalidation');
type Listener = ReturnType<ListenerModule['installWorkspaceFileInvalidationNotificationListener']>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() { for (let turn = 0; turn < 80; turn++) await Promise.resolve(); }

/** Declared model only: these are EventEmitter objects, not PostgreSQL clients. */
class ListenerClientModel extends EventEmitter {
  readonly statements: string[] = [];
  releases = 0;
  queryFailure: Error | null = null;
  constructor(readonly listenGate: ReturnType<typeof deferred<void>> | null = null) { super(); }
  async query(sql: string) {
    this.statements.push(sql);
    if (this.listenGate) await this.listenGate.promise;
    if (this.queryFailure) throw this.queryFailure;
    return { rows: [] };
  }
  release(discard: unknown) {
    assert.equal(discard, true, 'the listener must discard its owned LISTEN checkout');
    this.releases++;
    assert.equal(this.releases, 1, 'each modeled checkout has exactly one disposal owner');
  }
  hint(payload: unknown, channel = 'canvas_workspace_files') {
    this.emit('notification', { channel, payload: JSON.stringify(payload) });
  }
}

/** Declared callback-handoff model; real pg wire behavior has a separate test. */
class ListenerPoolModel {
  readonly available: ListenerClientModel[];
  readonly pending: Array<(error: Error | null, client?: PoolClient) => void> = [];
  calls = 0;
  readonly handoffFailure = new Error('Declared model: error during callback handoff');
  constructor(clients: ListenerClientModel[], readonly manual = false,
    readonly handoff: 'error' | 'end' | null = null) { this.available = [...clients]; }
  connect(callback: (error: Error | null, client?: PoolClient) => void) {
    this.calls++;
    if (this.manual) { this.pending.push(callback); return; }
    const client = this.available.shift();
    assert(client, 'a reconnect must use one of this fixture\'s declared clients');
    callback(null, client as unknown as PoolClient);
    if (this.handoff) {
      assert(client.listenerCount(this.handoff) > 0,
        'the product pool callback must install its handler before returning the acquired client');
      if (this.handoff === 'error') client.emit('error', this.handoffFailure);
      else client.emit('end');
    }
  }
}

/** Only the product listener's retry clock is modeled. No elapsed-time oracle. */
class ListenerTimerModel {
  readonly pending = new Map<object, () => void>();
  fired = 0;
  setTimeout(callback: () => void, _milliseconds?: number) {
    const handle = { unref() { return this; } };
    this.pending.set(handle, callback);
    return handle;
  }
  clearTimeout(handle: unknown) { this.pending.delete(handle as object); }
  fireNext() {
    const entry = this.pending.entries().next().value;
    assert(entry, 'the real listener must have scheduled its retry');
    this.pending.delete(entry[0]);
    this.fired++;
    entry[1]();
  }
}

async function loadListenerModel(holder: { current: ListenerPoolModel | null }): Promise<ListenerModule> {
  const internal = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const previous = internal._load;
  internal._load = (name, ...args) => {
    if (name === '@/app/lib/db' || name.endsWith('/app/lib/db')) {
      return { getPostgresRuntimeQueryable: () => holder.current };
    }
    return previous(name, ...args);
  };
  try { return await import('../app/lib/filesystem/workspace-file-invalidation'); }
  finally { internal._load = previous; }
}

async function main() {
  const holder: { current: ListenerPoolModel | null } = { current: null };
  const { installWorkspaceFileInvalidationNotificationListener, WORKSPACE_FILE_INVALIDATION_CHANNEL } = await loadListenerModel(holder);
  const timers = new ListenerTimerModel();
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const listeners: Listener[] = [];
  const pools: ListenerPoolModel[] = [];
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  globalThis.setTimeout = timers.setTimeout.bind(timers) as unknown as typeof setTimeout;
  globalThis.clearTimeout = timers.clearTimeout.bind(timers) as unknown as typeof clearTimeout;
  try {
    assert.equal(WORKSPACE_FILE_INVALIDATION_CHANNEL, 'canvas_workspace_files');
    assert(isWorkspaceFileInvalidation(Object.freeze({ workspaceId: 'workspace-1' })));
    let getterReads = 0;
    const accessor = Object.defineProperty({}, 'workspaceId', { enumerable: true, get: () => { getterReads++; return 'workspace'; } });
    for (const payload of [null, [], {}, { workspaceId: '' }, { workspaceId: 'x'.repeat(129) },
      { workspaceId: 'workspace\n' }, { workspaceId: '../workspace' }, { workspaceId: 1 },
      { workspaceId: 'workspace', path: 'invented.md' }, { workspaceId: 'workspace', [Symbol('extra')]: true },
      Object.assign(Object.create(null), { workspaceId: 'workspace' }), accessor]) {
      assert.equal(isWorkspaceFileInvalidation(payload), false);
    }
    assert.equal(getterReads, 0, 'payload validation cannot evaluate an accessor');

    {
      const client = new ListenerClientModel();
      const pool = new ListenerPoolModel([client]); pools.push(pool); holder.current = pool;
      let workspaceIds = ['workspace-a', 'workspace-b'];
      const delivered: string[] = [];
      const listener = installWorkspaceFileInvalidationNotificationListener({ workspaceIds: () => workspaceIds,
        onInvalidate: hint => { delivered.push(hint.workspaceId); } }); listeners.push(listener);
      await listener.ready;
      assert.deepEqual(client.statements, ['LISTEN canvas_workspace_files']);
      assert.deepEqual(delivered, ['workspace-a', 'workspace-b'], 'LISTEN completion resyncs each current subscription');
      delivered.length = 0;
      client.hint({ workspaceId: 'workspace-a' });
      client.hint({ workspaceId: 'foreign' });
      client.hint({ workspaceId: 'workspace-a', path: 'invented.md' });
      client.hint({ workspaceId: 'workspace-a' }, 'canvas_excalidraw_scene');
      client.emit('notification', { channel: WORKSPACE_FILE_INVALIDATION_CHANNEL, payload: '{' });
      client.emit('notification', { channel: WORKSPACE_FILE_INVALIDATION_CHANNEL, payload: 'x'.repeat(4097) });
      await flush();
      assert.deepEqual(delivered, ['workspace-a']);
      workspaceIds = ['workspace-b'];
      client.hint({ workspaceId: 'workspace-a' }); await flush();
      assert.deepEqual(delivered, ['workspace-a'], 'removed subscriptions cannot receive a retained PG hint');
      await listener.resync(); assert.deepEqual(delivered, ['workspace-a', 'workspace-b']);
      await listener.stop();
      const count = delivered.length;
      client.hint({ workspaceId: 'workspace-b' }); await listener.resync();
      assert.equal(delivered.length, count);
      assert.equal(client.releases, 1); assert.equal(timers.pending.size, 0);
    }

    for (const handoff of ['error', 'end'] as const) {
      const client = new ListenerClientModel();
      const pool = new ListenerPoolModel([client], false, handoff); pools.push(pool); holder.current = pool;
      const failures: unknown[] = [], delivered: string[] = [];
      const listener = installWorkspaceFileInvalidationNotificationListener({ workspaceIds: () => ['workspace'],
        onInvalidate: hint => { delivered.push(hint.workspaceId); }, onError: error => { failures.push(error); } }); listeners.push(listener);
      await assert.rejects(listener.ready, error => handoff === 'error' ? error === pool.handoffFailure
        : error instanceof Error && /ended during acquisition/u.test(error.message));
      await listener.stop();
      assert.deepEqual(client.statements, []); assert.deepEqual(delivered, []);
      assert.equal(client.releases, 1); assert(failures.length > 0); assert.equal(timers.pending.size, 0);
    }

    {
      const client = new ListenerClientModel(), pool = new ListenerPoolModel([client], true);
      pools.push(pool); holder.current = pool;
      const delivered: string[] = [];
      const listener = installWorkspaceFileInvalidationNotificationListener({ workspaceIds: () => ['workspace'],
        onInvalidate: hint => { delivered.push(hint.workspaceId); } }); listeners.push(listener);
      let finished = false;
      const stopping = listener.stop();
      assert.equal(listener.stop(), stopping, 'concurrent listener stop calls share one disposal promise');
      void stopping.then(() => { finished = true; }); await flush();
      assert.equal(finished, false, 'stop must wait for its actual pending acquisition');
      const callback = pool.pending.shift(); assert(callback);
      assert.equal(pool.available.shift(), client);
      callback(null, client as unknown as PoolClient);
      await stopping;
      assert.equal(finished, true); assert.equal(client.releases, 1);
      assert.deepEqual(client.statements, []); assert.deepEqual(delivered, []);
    }

    {
      const gate = deferred<void>(); gates.push(gate);
      const client = new ListenerClientModel(gate), pool = new ListenerPoolModel([client]);
      pools.push(pool); holder.current = pool;
      const delivered: string[] = [];
      const listener = installWorkspaceFileInvalidationNotificationListener({ workspaceIds: () => ['workspace'],
        onInvalidate: hint => { delivered.push(hint.workspaceId); } }); listeners.push(listener);
      await flush(); assert.equal(client.statements.length, 1);
      let finished = false;
      const stopping = listener.stop(); void stopping.then(() => { finished = true; }); await flush();
      assert.equal(client.releases, 1); assert.equal(finished, false);
      gate.resolve(undefined); await listener.ready; await stopping;
      assert.deepEqual(delivered, []); assert.equal(finished, true);
    }

    {
      const gate = deferred<void>(); gates.push(gate);
      const first = new ListenerClientModel(), second = new ListenerClientModel();
      const pool = new ListenerPoolModel([first, second]); pools.push(pool); holder.current = pool;
      let workspaceIds = ['before'];
      const delivered: string[] = [], failures: unknown[] = [];
      const listener = installWorkspaceFileInvalidationNotificationListener({ workspaceIds: () => workspaceIds,
        onInvalidate: async hint => { delivered.push(hint.workspaceId); if (hint.workspaceId === 'before') await gate.promise; },
        onError: error => { failures.push(error); } }); listeners.push(listener);
      await flush(); assert.deepEqual(delivered, ['before']);
      first.emit('error', new Error('Declared model: disconnect while initial resync is gated'));
      workspaceIds = ['after-a', 'after-b'];
      timers.fireNext(); await flush();
      assert.equal(pool.calls, 1, 'the first retry still observes the initial pending connect');
      gate.resolve(undefined); await listener.ready; await flush();
      assert.equal(timers.pending.size, 1, 'settling the old connect must preserve the reconnect request');
      timers.fireNext(); await flush();
      assert.equal(pool.calls, 2); assert.equal(first.releases, 1);
      assert.deepEqual(delivered, ['before', 'after-a', 'after-b']);
      first.hint({ workspaceId: 'after-a' }); await flush();
      assert.equal(delivered.length, 3, 'a replaced client cannot deliver more hints');
      assert.equal(failures.length, 1);
      await listener.stop(); assert.equal(second.releases, 1); assert.equal(timers.pending.size, 0);
    }

    {
      const gate = deferred<void>(); gates.push(gate);
      const client = new ListenerClientModel(), pool = new ListenerPoolModel([client]);
      pools.push(pool); holder.current = pool;
      let hold = false, callbacks = 0, reporterCalls = 0;
      const listener = installWorkspaceFileInvalidationNotificationListener({ workspaceIds: () => ['workspace'],
        onInvalidate: async () => { callbacks++; if (hold) await gate.promise; },
        onError: () => { reporterCalls++; throw new Error('Declared model: error reporter failure'); } }); listeners.push(listener);
      await listener.ready; hold = true;
      const explicitResync = listener.resync(); await flush();
      assert.equal(callbacks, 2);
      assert.doesNotThrow(() => client.emit('error', new Error('Declared model: disconnect before stop')));
      assert.equal(reporterCalls, 1, 'a throwing error sink must be contained in the actual report path');
      let finished = false;
      const stopping = listener.stop(); void stopping.then(() => { finished = true; }); await flush();
      assert.equal(client.releases, 1); assert.equal(finished, false, 'stop also awaits explicitly requested resync work');
      client.hint({ workspaceId: 'workspace' }); await flush(); assert.equal(callbacks, 2);
      gate.resolve(undefined); await explicitResync; await stopping; assert.equal(finished, true);
      assert.equal(timers.pending.size, 0);
    }
    {
      const first = new ListenerClientModel(), second = new ListenerClientModel();
      const pool = new ListenerPoolModel([first, second]); pools.push(pool); holder.current = null;
      const delivered: string[] = []; let rescans = 0;
      const listener = installWorkspaceFileInvalidationNotificationListener({ pool: pool as unknown as Pool, allWorkspaces: true,
        onResync: async () => { rescans++; }, onInvalidate: async hint => { delivered.push(hint.workspaceId); } });
      listeners.push(listener); await listener.ready;
      assert.equal(rescans, 1, 'a trusted outbox worker rescans after its actual listener setup');
      first.hint({ workspaceId: 'unopened-workspace' });
      first.hint({ workspaceId: 'workspace', path: 'invented-state.md' });
      await flush(); assert.deepEqual(delivered, ['unopened-workspace']);
      first.emit('end'); timers.fireNext(); await flush();
      assert.equal(rescans, 2, 'reconnection requests a fresh durable scan');
      first.hint({ workspaceId: 'old-client' }); second.hint({ workspaceId: 'another-workspace' });
      await flush(); assert.deepEqual(delivered, ['unopened-workspace', 'another-workspace']);
      await listener.stop(); second.hint({ workspaceId: 'after-stop' }); await flush();
      assert.equal(delivered.length, 2); assert.equal(first.releases, 1); assert.equal(second.releases, 1);
      assert.equal(timers.pending.size, 0);
    }
    console.log('workspace-file-invalidation-listener-test: declared callback/clock models passed; no PostgreSQL or owner outcome claim.');
  } finally {
    for (const gate of gates) gate.resolve(undefined);
    for (const pool of pools) while (pool.pending.length) {
      const callback = pool.pending.shift()!;
      const client = pool.available.shift() ?? new ListenerClientModel();
      callback(null, client as unknown as PoolClient);
    }
    for (const listener of listeners) await listener.stop();
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
