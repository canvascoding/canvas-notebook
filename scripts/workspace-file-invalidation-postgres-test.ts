/** Owned transport acceptance only. No application migrations, HTTP server,
 * Docker, document authority or DA04 no-write-abort claim belongs here. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { Client, Pool, type PoolClient } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { signalOwnChild, ownedGroupEmpty } from './run-yjs-authority-e2e';

type Role = 'publisher' | 'subscriber';
type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void };
type Packet = { fixture: string; nodePid: number; kind: 'event' | 'reply'; event?: string;
  request?: number; ok?: boolean; data: Record<string, unknown> };
type Command = { fixture: string; request: number; command: string; workspaceId?: string;
  workspaceIds?: string[]; commit?: boolean; gated?: boolean; allWorkspaces?: boolean };
type OwnedChild = Parameters<typeof signalOwnChild>[0];
type Peer = { role: Role; applicationName: string; process: ChildProcess; entry: OwnedChild;
  fixture: string; pending: Map<number, Deferred<Record<string, unknown>>>; events: Packet[];
  sequence: number; stdout: string; stderr: string; failure?: unknown;
  exitCode: number | null; exitSignal: string | null; readyData: Record<string, unknown> };
type BackendFence = { pid: number; start: string; applicationName: string };
type ChildContext = { fixture: string; role: Role; applicationName: string;
  done: Deferred<void>; failure?: unknown };
type Shutdown = Deferred<void> | null;
type Publisher = { context: ChildContext; pool: Pool; client: PoolClient;
  database: SqlConnection; notify: typeof import('../app/lib/filesystem/workspace-file-invalidation').notifyWorkspaceFileInvalidationOnConnection;
  inTransaction: boolean; shutdown: Shutdown };
type Delivery = { workspaceId: string; backendPid: number; index: number };
type Subscriber = { context: ChildContext; pool: Pool;
  install: typeof import('../app/lib/filesystem/workspace-file-invalidation').installWorkspaceFileInvalidationNotificationListener;
  listener: ReturnType<typeof import('../app/lib/filesystem/workspace-file-invalidation').installWorkspaceFileInvalidationNotificationListener> | null;
  subscribed: Set<string>; ledger: Delivery[]; deliveredWorkspaces: string[]; allWorkspaces: boolean; rescans: number;
  acquisitions: number[]; removals: Set<number>; currentBackend: number;
  errors: Array<string | null>; gate: Deferred<void> | null; gateWorkspace: string | null;
  stopped: boolean; stopResolved: boolean; shutdown: Shutdown;
  workspaceIds: () => Iterable<string>; onInvalidate: (hint: Readonly<{ workspaceId: string }>) => Promise<void>;
  onError: (error: unknown) => void };

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
const deadlineMs = 8_000;
let stage = 'configuration';

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'], reject!: Deferred<T>['reject'];
  const promise = new Promise<T>(function captureDeferred(accept, decline) { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>(function captureDeadline(_resolve, reject) {
      timer = setTimeout(function expireDeadline() { reject(new Error(message)); }, deadlineMs);
    });
    return await Promise.race([promise, timeout]);
  } finally { if (timer) clearTimeout(timer); }
}

function guardManagedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook');
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert(url.username && url.password, 'An explicit managed credential is required; pgpass fallback is outside this fixture.');
  return url;
}

async function readManagedEnvironment(): Promise<string> {
  const named = await fs.lstat(privateEnvironment);
  assert(named.isFile() && !named.isSymbolicLink() && named.nlink === 1 && named.uid === process.getuid!());
  assert.equal(named.mode & 0o077, 0); assert(named.size > 0 && named.size < 64 * 1024);
  const handle = await fs.open(privateEnvironment, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    assert(held.isFile() && held.nlink === 1 && held.uid === named.uid && held.dev === named.dev && held.ino === named.ino);
    assert.equal(held.mode & 0o077, 0); assert.equal(held.size, named.size);
    const source = await handle.readFile('utf8'); assert(source.length < 64 * 1024);
    const after = await handle.stat(), final = await fs.lstat(privateEnvironment);
    assert.equal(after.size, held.size); assert.equal(after.mtimeMs, held.mtimeMs); assert.equal(after.ctimeMs, held.ctimeMs);
    assert(final.isFile() && !final.isSymbolicLink() && final.dev === held.dev && final.ino === held.ino && final.nlink === 1);
    assert.equal(final.uid, held.uid); assert.equal(final.mode & 0o077, 0);
    assert.equal(final.mtimeMs, held.mtimeMs); assert.equal(final.ctimeMs, held.ctimeMs);
    const connectionString = parse(source).DATABASE_URL; assert(connectionString);
    guardManagedDatabaseUrl(connectionString); return connectionString;
  } finally { await handle.close(); }
}

function fixtureEnvironment(connectionString: string, fixture: string, role: Role, cwd: string): NodeJS.ProcessEnv {
  assert.match(fixture, /^[a-f0-9]{32}$/u); guardManagedDatabaseUrl(connectionString);
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) environment[key] = process.env[key];
  const applicationName = `canvas_wi_${fixture}_${role}`;
  Object.assign(environment, { NODE_ENV: 'test', DATABASE_URL: connectionString, CANVAS_DATABASE_PROVIDER: 'postgres',
    CANVAS_POSTGRES_VECTOR_ENABLED: 'false', CANVAS_VECTOR_PROVIDER: 'none',
    CANVAS_POSTGRES_POOL_MAX: '1', CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: '5000', CANVAS_POSTGRES_IDLE_TIMEOUT_MS: '1000',
    PGSSLMODE: 'disable', PGAPPNAME: applicationName,
    PGOPTIONS: `-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=3000 -c application_name=${applicationName}`,
    CANVAS_NOTIFICATION_TEST_NONCE: fixture, CANVAS_NOTIFICATION_TEST_ROLE: role, CANVAS_NOTIFICATION_TEST_CWD: cwd });
  return environment;
}

async function sendIpc(context: ChildContext, kind: Packet['kind'], data: Record<string, unknown>,
  extra: Pick<Packet, 'event' | 'request' | 'ok'> = {}): Promise<void> {
  assert(process.connected && process.send, 'The owned IPC connection must remain live.');
  await within(new Promise<void>(function captureIpcSend(resolve, reject) {
    function onIpcSent(error: Error | null) { if (error) reject(error); else resolve(); }
    process.send!({ fixture: context.fixture, nodePid: process.pid, kind, data, ...extra }, onIpcSent);
  }), 'Owned child IPC send did not complete.');
}

async function startPeer(role: Role, environment: NodeJS.ProcessEnv, peers: Peer[]): Promise<Peer> {
  const cwd = environment.CANVAS_NOTIFICATION_TEST_CWD!;
  const processHandle = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx',
    path.join(cwd, 'scripts/workspace-file-invalidation-postgres-test.ts'), `--role=${role}`],
  { cwd, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = deferred<void>();
  const entry: OwnedChild = { process: processHandle, pid: processHandle.pid ?? 0, started: '', cwd,
    ended: false, closed: closed.promise, logPath: '[no fixture log file]' };
  const peer: Peer = { role, applicationName: environment.PGAPPNAME!, process: processHandle, entry,
    fixture: environment.CANVAS_NOTIFICATION_TEST_NONCE!, pending: new Map(), events: [], sequence: 0,
    stdout: '', stderr: '', exitCode: null, exitSignal: null, readyData: {} };
  peers.push(peer);
  function onPeerError(error: unknown) {
    peer.failure ??= error;
    for (const pending of peer.pending.values()) pending.reject(error);
  }
  function onPeerStdout(chunk: Buffer) {
    const value = String(chunk);
    if (peer.stdout.length + value.length > 65_536) {
      peer.stdout = (peer.stdout + value).slice(0, 65_536);
      onPeerError(new Error('Owned child stdout exceeded its finite limit.')); return;
    }
    peer.stdout += value;
  }
  function onPeerStderr(chunk: Buffer) {
    const value = String(chunk);
    if (peer.stderr.length + value.length > 65_536) {
      peer.stderr = (peer.stderr + value).slice(0, 65_536);
      onPeerError(new Error('Owned child stderr exceeded its finite limit.')); return;
    }
    peer.stderr += value;
  }
  function onPeerMessage(message: unknown) {
    try {
      assert(message && typeof message === 'object' && !Array.isArray(message));
      const packet = message as Packet;
      assert.equal(packet.fixture, peer.fixture); assert.equal(packet.nodePid, peer.entry.pid);
      assert(packet.data && typeof packet.data === 'object' && !Array.isArray(packet.data));
      if (packet.kind === 'reply') {
        assert(Number.isSafeInteger(packet.request) && packet.request! > 0);
        const pending = peer.pending.get(packet.request!); assert(pending, 'An owned child replied to an unknown command.');
        if (packet.ok === true) pending.resolve(packet.data);
        else pending.reject(new Error('Owned child command failed; raw driver output remains private.'));
      } else {
        assert.equal(packet.kind, 'event'); assert.equal(typeof packet.event, 'string');
        assert(peer.events.length < 256, 'Owned child event queue exceeded its finite limit.');
        peer.events.push(packet);
      }
    } catch (error) { onPeerError(error); }
  }
  function onPeerClose(code: number | null, signal: NodeJS.Signals | null) {
    peer.exitCode = code; peer.exitSignal = signal; entry.ended = true;
    if (code !== 0) onPeerError(new Error('Owned child did not exit successfully.'));
    closed.resolve(undefined);
    for (const pending of peer.pending.values()) pending.reject(new Error('Owned child closed before command acknowledgement.'));
  }
  processHandle.stdout!.on('data', onPeerStdout); processHandle.stderr!.on('data', onPeerStderr);
  processHandle.on('message', onPeerMessage); processHandle.once('error', onPeerError); processHandle.once('close', onPeerClose);
  assert(Number.isSafeInteger(entry.pid) && entry.pid > 0);
  for (let attempt = 0; attempt < 40 && !entry.ended; attempt++) {
    try { entry.started = execFileSync('ps', ['-p', String(entry.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); }
    catch { /* Observe only the exact child just spawned. */ }
    if (entry.started) break;
    await delay(25);
  }
  assert(entry.started || entry.ended, 'Owned child start identity was not observed.');
  if (!entry.ended) {
    assert.equal(execFileSync('ps', ['-p', String(entry.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim(), String(entry.pid));
    assert(execFileSync('lsof', ['-a', '-p', String(entry.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').includes(`n${cwd}`));
  }
  peer.readyData = (await waitPeerEvent(peer, 'role-ready')).data;
  assert.equal(peer.readyData.role, role);
  return peer;
}

async function requestPeer(peer: Peer, command: Omit<Command, 'fixture' | 'request'>): Promise<Record<string, unknown>> {
  if (peer.failure) throw peer.failure;
  assert(!peer.entry.ended && peer.process.connected);
  const request = ++peer.sequence, pending = deferred<Record<string, unknown>>();
  peer.pending.set(request, pending);
  try {
    peer.process.send!({ ...command, fixture: peer.fixture, request });
    return await within(pending.promise, 'Owned child command exceeded its finite deadline.');
  } finally { peer.pending.delete(request); }
}

async function waitPeerEvent(peer: Peer, event: string, workspaceId?: string, afterIndex = -1): Promise<Packet> {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    if (peer.failure) throw peer.failure;
    for (let index = 0; index < peer.events.length; index++) {
      const value = peer.events[index];
      if (value.event === event && (workspaceId === undefined || value.data.workspaceId === workspaceId)
        && (afterIndex < 0 || typeof value.data.index === 'number' && value.data.index >= afterIndex)) {
        peer.events.splice(index, 1); return value;
      }
    }
    assert(!peer.entry.ended, 'Owned child closed before the required event.');
    assert(performance.now() < deadline, 'Owned child event exceeded its finite deadline.');
    await delay(10);
  }
}

async function assertBackendFence(control: Client, pid: unknown, applicationName: string): Promise<BackendFence> {
  assert(Number.isSafeInteger(pid) && Number(pid) > 0);
  assert.match(applicationName, /^canvas_wi_[a-f0-9]{32}_(?:publisher|subscriber|control)$/u);
  const result = await control.query(`SELECT pid, backend_start::text AS start, application_name
    FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND application_name=$2
      AND datname=pg_catalog.current_database() AND usename=current_user AND backend_type='client backend'`, [pid, applicationName]);
  assert.equal(result.rowCount, 1); const row = result.rows[0];
  assert.equal(row.pid, pid); assert.equal(row.application_name, applicationName);
  assert.equal(typeof row.start, 'string'); assert(row.start.length > 0);
  return { pid: row.pid, start: row.start, applicationName };
}

async function terminateOwnedBackend(control: Client, fence: BackendFence, subscriberApplication: string): Promise<void> {
  assert.match(subscriberApplication, /^canvas_wi_[a-f0-9]{32}_subscriber$/u);
  assert.equal(fence.applicationName, subscriberApplication);
  const result = await control.query(`SELECT pg_catalog.pg_terminate_backend(pid) AS terminated
    FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND application_name=$3
      AND datname=pg_catalog.current_database() AND usename=current_user AND backend_type='client backend'
      AND pid<>pg_catalog.pg_backend_pid()`, [fence.pid, fence.start, subscriberApplication]);
  assert.equal(result.rowCount, 1, 'Only the exact owned subscriber backend may be terminated.');
  assert.equal(result.rows[0].terminated, true);
}

async function awaitOwnedBackendsGone(control: Client, applications: readonly string[]): Promise<void> {
  for (const name of applications) assert.match(name, /^canvas_wi_[a-f0-9]{32}_(?:publisher|subscriber)$/u);
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    const rows = (await control.query(`SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE application_name=ANY($1::text[]) AND datname=pg_catalog.current_database() AND usename=current_user`, [applications])).rows;
    if (rows.length === 0) return;
    assert(performance.now() < deadline, 'Own PostgreSQL backends did not close within the finite deadline.');
    await delay(20);
  }
}

async function closePeer(peer: Peer): Promise<void> {
  if (!peer.entry.ended && !peer.failure) {
    try { await requestPeer(peer, { command: 'close' }); }
    catch (error) { peer.failure ??= error; }
  }
  try { await within(peer.entry.closed, 'Own child close and pipe drain did not complete.'); }
  catch {
    try { await signalOwnChild(peer.entry, 'SIGTERM'); }
    catch { await signalOwnChild(peer.entry, 'SIGKILL'); }
  }
  assert(peer.entry.ended);
  if (peer.entry.pid > 0) assert(ownedGroupEmpty(peer.entry), 'An owned child group remains; cleanup is unconfirmed.');
  if (peer.failure) throw peer.failure;
  assert.equal(peer.exitCode, 0); assert.equal(peer.exitSignal, null);
  assert.doesNotMatch(peer.stderr, /Unhandled 'error' event|unhandledRejection/iu);
}

function notificationSqlConnection(client: PoolClient): SqlConnection {
  function notificationConnectionGet(): never { throw new Error('Notify helper must not request an adapter read.'); }
  function notificationConnectionAll(): never { throw new Error('Notify helper must not request an adapter scan.'); }
  async function notificationConnectionRun(sql: string, parameters?: unknown[]) {
    const result = await client.query(sql, parameters); return { changes: result.rowCount ?? 0 };
  }
  function notificationConnectionClose(): never { throw new Error('Notify helper must not close its caller-owned connection.'); }
  return { get: notificationConnectionGet, all: notificationConnectionAll, run: notificationConnectionRun, close: notificationConnectionClose };
}

async function publisherRole(context: ChildContext): Promise<Publisher> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1,
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 1_000, options: process.env.PGOPTIONS });
  function onPublisherClientError(error: Error) { context.failure ??= error; context.done.resolve(undefined); }
  function onPublisherPoolAcquire(client: PoolClient) { client.on('error', onPublisherClientError); }
  pool.on('error', onPublisherClientError); pool.on('acquire', onPublisherPoolAcquire);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const row = (await client.query(`SELECT pg_catalog.current_schema() AS schema,
      pg_catalog.current_database() AS database, pg_catalog.current_setting('application_name') AS application`)).rows[0];
    assert.equal(row.schema, 'pg_catalog'); assert.equal(row.database, 'canvas_notebook'); assert.equal(row.application, context.applicationName);
    const { notifyWorkspaceFileInvalidationOnConnection: notify } = await import('../app/lib/filesystem/workspace-file-invalidation');
    return { context, pool, client, database: notificationSqlConnection(client), notify, inTransaction: false, shutdown: null };
  } catch (error) {
    try { client?.release(true); } finally { await within(pool.end(), 'Failed own publisher initialization did not close.'); }
    throw error;
  }
}

async function subscriberRole(context: ChildContext): Promise<Subscriber> {
  const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
  const { installWorkspaceFileInvalidationNotificationListener: install } = await import('../app/lib/filesystem/workspace-file-invalidation');
  const pool = getPostgresRuntimeQueryable(); assert(pool);
  const state = { context, pool, install, listener: null, subscribed: new Set<string>(), ledger: [], deliveredWorkspaces: [],
    acquisitions: [], removals: new Set<number>(), currentBackend: 0, errors: [], gate: null, gateWorkspace: null,
    stopped: true, stopResolved: true, shutdown: null, allWorkspaces: false, rescans: 0 } as unknown as Subscriber;
  function workspaceIds() { return state.subscribed; }
  async function onInvalidate(hint: Readonly<{ workspaceId: string }>) {
    assert(Object.isFrozen(hint)); assert.deepEqual(Reflect.ownKeys(hint), ['workspaceId']);
    assert(state.allWorkspaces || state.subscribed.has(hint.workspaceId)); assert(!state.stopped);
    const selectedGate = state.gateWorkspace === hint.workspaceId ? state.gate : null;
    if (selectedGate) state.gateWorkspace = null;
    const item = { workspaceId: hint.workspaceId, backendPid: state.currentBackend, index: state.ledger.length };
    state.ledger.push(item); state.deliveredWorkspaces.push(item.workspaceId);
    await sendIpc(context, 'event', item, { event: 'invalidated' });
    if (selectedGate) { await sendIpc(context, 'event', item, { event: 'gate-entered' }); await selectedGate.promise; }
  }
  function onError(error: unknown) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
    state.errors.push(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(code) ? code : null);
  }
  function onPoolAcquire(client: PoolClient) {
    const pid = Reflect.get(client, 'processID'); assert(Number.isSafeInteger(pid) && pid > 0);
    state.currentBackend = pid; state.acquisitions.push(pid);
    // Observer only: never install a replacement error handler on product B.
    void sendIpc(context, 'event', { backendPid: pid }, { event: 'acquired' }).catch(onMainFailure);
  }
  function onPoolRemove(client: PoolClient) {
    const pid = Number(Reflect.get(client, 'processID'));
    assert(!state.removals.has(pid)); state.removals.add(pid);
  }
  state.workspaceIds = workspaceIds; state.onInvalidate = onInvalidate; state.onError = onError;
  pool.on('acquire', onPoolAcquire); pool.on('remove', onPoolRemove);
  return state;
}

async function handlePublisherCommand(state: Publisher, command: Command): Promise<Record<string, unknown>> {
  if (command.command === 'begin') {
    assert(!state.inTransaction); assert.equal(typeof command.workspaceId, 'string');
    await state.client.query('BEGIN'); state.inTransaction = true;
    await state.notify(state.database, command.workspaceId!); return { queued: true };
  }
  if (command.command === 'finish') {
    assert(state.inTransaction); assert.equal(typeof command.commit, 'boolean');
    await state.client.query(command.commit ? 'COMMIT' : 'ROLLBACK'); state.inTransaction = false;
    return { committed: command.commit };
  }
  if (command.command === 'notify') {
    assert(!state.inTransaction); assert.equal(typeof command.workspaceId, 'string');
    await state.notify(state.database, command.workspaceId!); return { notified: true };
  }
  assert.equal(command.command, 'close'); await shutdownPublisher(state); return { closed: true };
}

async function handleSubscriberCommand(state: Subscriber, command: Command): Promise<Record<string, unknown>> {
  if (command.command === 'start' || command.command === 'subscriptions') {
    assert(command.allWorkspaces === undefined || typeof command.allWorkspaces === 'boolean');
    assert(Array.isArray(command.workspaceIds) && command.workspaceIds.length >= (command.allWorkspaces === true ? 0 : 1)
      && command.workspaceIds.length <= 8);
    for (const id of command.workspaceIds) assert.match(id, new RegExp(`^wi_${state.context.fixture}_[a-z]+$`, 'u'));
    state.subscribed = new Set(command.workspaceIds); assert.equal(state.subscribed.size, command.workspaceIds.length);
    if (command.command === 'start') {
      assert(state.stopResolved && (!state.listener || state.stopped));
      state.stopped = false; state.stopResolved = false;
      state.allWorkspaces = command.allWorkspaces === true;
      if (command.gated) { state.gate = deferred<void>(); state.gateWorkspace = command.workspaceIds[0]; }
      // Exercise the default productive runtime-pool callback acquisition.
      // No options.connect override, mock client or copied module is supplied.
      state.listener = state.allWorkspaces
        ? state.install({ pool: state.pool, allWorkspaces: true, onInvalidate: state.onInvalidate, onError: state.onError, retryMs: 25,
          onResync: async () => {
            state.rescans++;
            await sendIpc(state.context, 'event', { backendPid: state.currentBackend, rescans: state.rescans }, { event: 'resync' });
          } })
        : state.install({ workspaceIds: state.workspaceIds, onInvalidate: state.onInvalidate,
          onError: state.onError, retryMs: 25 });
      await within(state.listener.ready, 'Actual listener LISTEN/initial resync did not complete.');
    }
    return { subscribed: [...state.subscribed] };
  }
  if (command.command === 'gate') {
    assert(!state.gate); assert(state.subscribed.has(command.workspaceId!));
    state.gate = deferred<void>(); state.gateWorkspace = command.workspaceId!; return { gated: true };
  }
  if (command.command === 'release') {
    assert(state.gate); state.gate.resolve(undefined); state.gate = null; state.gateWorkspace = null; return { released: true };
  }
  if (command.command === 'stop') {
    assert(state.listener && !state.stopped);
    state.stopped = true;
    const first = state.listener.stop(); assert.strictEqual(first, state.listener.stop());
    await sendIpc(state.context, 'event', { deliveries: state.ledger.length }, { event: 'stop-started' });
    await within(first, 'Actual listener stop did not drain its callback.'); state.stopResolved = true;
    return { stopped: true };
  }
  if (command.command === 'snapshot') return { workspaces: [...state.deliveredWorkspaces], ledger: structuredClone(state.ledger),
    acquisitions: [...state.acquisitions], removals: [...state.removals], errors: [...state.errors],
    stopResolved: state.stopResolved, stopped: state.stopped, allWorkspaces: state.allWorkspaces, rescans: state.rescans };
  assert.equal(command.command, 'close'); await shutdownSubscriber(state); return { closed: true };
}

async function shutdownPublisher(state: Publisher): Promise<void> {
  if (state.shutdown) return state.shutdown.promise;
  const completion = deferred<void>(); state.shutdown = completion;
  try {
    try { if (state.inTransaction) { await state.client.query('ROLLBACK'); state.inTransaction = false; } }
    finally { try { state.client.release(true); } finally { await within(state.pool.end(), 'Own publisher pool did not end.'); } }
    completion.resolve(undefined);
  } catch (error) { completion.reject(error); }
  return completion.promise;
}

async function shutdownSubscriber(state: Subscriber): Promise<void> {
  if (state.shutdown) return state.shutdown.promise;
  const completion = deferred<void>(); state.shutdown = completion;
  state.gate?.resolve(undefined); state.gate = null; state.gateWorkspace = null; state.stopped = true;
  try {
    try { if (state.listener) await within(state.listener.stop(), 'Own subscriber listener did not stop.'); }
    finally { await within(state.pool.end(), 'Own subscriber runtime pool did not end.'); }
    completion.resolve(undefined);
  } catch (error) { completion.reject(error); }
  return completion.promise;
}

async function childRole(role: Role): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_NOTIFICATION_TEST_ROLE, role);
  const fixture = process.env.CANVAS_NOTIFICATION_TEST_NONCE!; assert.match(fixture, /^[a-f0-9]{32}$/u);
  guardManagedDatabaseUrl(process.env.DATABASE_URL!);
  assert.equal(await fs.realpath(process.cwd()), process.env.CANVAS_NOTIFICATION_TEST_CWD);
  assert.equal(process.env.PGSSLMODE, 'disable'); assert.equal(process.env.NEXT_PHASE, undefined);
  assert.equal(process.env.DATA, undefined); assert.equal(process.env.CANVAS_DATA_ROOT, undefined);
  const context: ChildContext = { fixture, role, applicationName: `canvas_wi_${fixture}_${role}`, done: deferred<void>() };
  assert.equal(process.env.PGAPPNAME, context.applicationName);
  assert.equal(process.env.PGOPTIONS, `-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=3000 -c application_name=${context.applicationName}`);
  let publisher: Publisher | undefined, subscriber: Subscriber | undefined;
  const active = new Set<Promise<Record<string, unknown>>>();
  function onChildDisconnect() { subscriber?.gate?.resolve(undefined); context.done.resolve(undefined); }
  async function onChildMessage(message: unknown) {
    let work: Promise<Record<string, unknown>> | undefined;
    try {
      assert(message && typeof message === 'object' && !Array.isArray(message)); const command = message as Command;
      assert.equal(command.fixture, fixture); assert(Number.isSafeInteger(command.request) && command.request > 0);
      assert.equal(typeof command.command, 'string'); assert(!context.failure);
      work = role === 'publisher' ? handlePublisherCommand(publisher!, command) : handleSubscriberCommand(subscriber!, command);
      active.add(work); const data = await work;
      await sendIpc(context, 'reply', data, { request: command.request, ok: true });
      if (command.command === 'close') context.done.resolve(undefined);
    } catch (error) { context.failure ??= error; subscriber?.gate?.resolve(undefined); context.done.resolve(undefined); }
    finally { if (work) active.delete(work); }
  }
  process.on('message', onChildMessage); process.once('disconnect', onChildDisconnect);
  try {
    stage = `${role} initialization`;
    if (role === 'publisher') publisher = await publisherRole(context); else subscriber = await subscriberRole(context);
    await sendIpc(context, 'event', { role, backendPid: publisher ? Reflect.get(publisher.client, 'processID') : null }, { event: 'role-ready' });
    await context.done.promise;
    if (context.failure) throw context.failure;
  } finally {
    subscriber?.gate?.resolve(undefined);
    try { await within(Promise.allSettled(active), 'Own in-flight child commands did not settle.'); }
    finally {
      try { if (subscriber) await shutdownSubscriber(subscriber); }
      finally {
        try { if (publisher) await shutdownPublisher(publisher); }
        finally { process.removeListener('message', onChildMessage); process.removeListener('disconnect', onChildDisconnect);
          if (process.connected) process.disconnect!(); }
      }
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--role=publisher' || mode === '--role=subscriber') return childRole(mode.endsWith('publisher') ? 'publisher' : 'subscriber');
  assert.equal(mode, undefined); assert.equal(process.env.NODE_ENV, 'test');
  const connectionString = await readManagedEnvironment(), fixture = randomUUID().replaceAll('-', '');
  const cwd = await fs.realpath(process.cwd()), peers: Peer[] = [];
  const applicationName = `canvas_wi_${fixture}_control`;
  const control = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 5_000,
    options: `-c search_path=pg_catalog -c statement_timeout=5000 -c application_name=${applicationName}` });
  let connected = false, controlFailure: unknown;
  function onError(error: Error) { controlFailure ??= error; }
  control.on('error', onError);
  try {
    await control.connect(); connected = true;
    const server = (await control.query(`SELECT pg_catalog.current_database() AS database,
      pg_catalog.current_setting('server_version_num')::integer AS version, pg_catalog.pg_backend_pid() AS pid`)).rows[0];
    assert.equal(server.database, 'canvas_notebook'); assert.equal(Math.floor(server.version / 10_000), 18);
    const controlFence = await assertBackendFence(control, server.pid, applicationName);
    const publisher = await startPeer('publisher', fixtureEnvironment(connectionString, fixture, 'publisher', cwd), peers);
    const subscriber = await startPeer('subscriber', fixtureEnvironment(connectionString, fixture, 'subscriber', cwd), peers);
    assert.notEqual(publisher.entry.pid, subscriber.entry.pid);
    assert.notEqual(publisher.entry.pid, process.pid); assert.notEqual(subscriber.entry.pid, process.pid);
    const publisherFence = await assertBackendFence(control, publisher.readyData.backendPid, publisher.applicationName);
    assert.notEqual(publisherFence.pid, controlFence.pid);
    const { WORKSPACE_FILE_INVALIDATION_CHANNEL } = await import('../app/lib/filesystem/workspace-file-invalidation');
    const a = `wi_${fixture}_a`, barrier = `wi_${fixture}_barrier`, queued = `wi_${fixture}_queued`;
    const rollback = `wi_${fixture}_rollback`, foreign = `wi_${fixture}_foreign`, b = `wi_${fixture}_b`, c = `wi_${fixture}_c`;
    const expected = [a, barrier, queued, rollback];
    stage = 'productive LISTEN and initial resync';
    await requestPeer(subscriber, { command: 'start', workspaceIds: [...expected] });
    const first = await assertBackendFence(control, (await waitPeerEvent(subscriber, 'acquired')).data.backendPid, subscriber.applicationName);
    assert.notEqual(first.pid, publisherFence.pid); assert.notEqual(first.pid, controlFence.pid);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);

    stage = 'uncommitted notification remains invisible behind a committed barrier';
    await requestPeer(publisher, { command: 'begin', workspaceId: queued });
    await control.query('SELECT pg_catalog.pg_notify($1, $2)', [WORKSPACE_FILE_INVALIDATION_CHANNEL, JSON.stringify({ workspaceId: barrier })]);
    await waitPeerEvent(subscriber, 'invalidated', barrier, expected.length); expected.push(barrier);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);
    await requestPeer(publisher, { command: 'finish', commit: true });
    await waitPeerEvent(subscriber, 'invalidated', queued, expected.length); expected.push(queued);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);

    stage = 'rollback suppression and foreign workspace filtering';
    await requestPeer(publisher, { command: 'begin', workspaceId: rollback });
    await requestPeer(publisher, { command: 'finish', commit: false });
    await requestPeer(publisher, { command: 'notify', workspaceId: barrier });
    await waitPeerEvent(subscriber, 'invalidated', barrier, expected.length); expected.push(barrier);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);
    await requestPeer(publisher, { command: 'notify', workspaceId: foreign });
    await requestPeer(publisher, { command: 'notify', workspaceId: a });
    await waitPeerEvent(subscriber, 'invalidated', a, expected.length); expected.push(a);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);
    await requestPeer(subscriber, { command: 'stop' });
    await waitPeerEvent(subscriber, 'stop-started');
    await awaitOwnedBackendsGone(control, [subscriber.applicationName]);

    stage = 'real disconnect during a gated initial resync';
    const starting = requestPeer(subscriber, { command: 'start', workspaceIds: [a], gated: true });
    // Observe rejection immediately even while other IPC commands release the gate.
    void starting.catch(onMainFailure);
    const second = await assertBackendFence(control, (await waitPeerEvent(subscriber, 'acquired')).data.backendPid, subscriber.applicationName);
    assert.notEqual(second.pid, first.pid); assert.notEqual(second.pid, publisherFence.pid);
    await waitPeerEvent(subscriber, 'gate-entered', a, expected.length); expected.push(a);
    await terminateOwnedBackend(control, second, subscriber.applicationName);
    await awaitOwnedBackendsGone(control, [subscriber.applicationName]);
    await requestPeer(subscriber, { command: 'subscriptions', workspaceIds: [b, c] });
    await requestPeer(publisher, { command: 'notify', workspaceId: b });
    const gap = await requestPeer(subscriber, { command: 'snapshot' });
    assert.deepEqual(gap.acquisitions, [first.pid, second.pid]); assert.deepEqual(gap.workspaces, expected);
    await requestPeer(subscriber, { command: 'release' }); await starting;
    const third = await assertBackendFence(control, (await waitPeerEvent(subscriber, 'acquired')).data.backendPid, subscriber.applicationName);
    assert.notEqual(third.pid, second.pid); assert.notEqual(third.pid, first.pid); assert.notEqual(third.pid, publisherFence.pid);
    const bHint = await waitPeerEvent(subscriber, 'invalidated', b, expected.length); expected.push(b);
    const cHint = await waitPeerEvent(subscriber, 'invalidated', c, expected.length); expected.push(c);
    assert.equal(bHint.data.backendPid, third.pid); assert.equal(cHint.data.backendPid, third.pid);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);
    await requestPeer(publisher, { command: 'notify', workspaceId: a });
    await requestPeer(publisher, { command: 'notify', workspaceId: b });
    await waitPeerEvent(subscriber, 'invalidated', b, expected.length); expected.push(b);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);

    stage = 'stop releases the backend and waits for its running callback';
    await requestPeer(subscriber, { command: 'gate', workspaceId: b });
    await requestPeer(publisher, { command: 'notify', workspaceId: b });
    await waitPeerEvent(subscriber, 'gate-entered', b, expected.length); expected.push(b);
    const stopping = requestPeer(subscriber, { command: 'stop' }); void stopping.catch(onMainFailure);
    await waitPeerEvent(subscriber, 'stop-started');
    await awaitOwnedBackendsGone(control, [subscriber.applicationName]);
    const held = await requestPeer(subscriber, { command: 'snapshot' });
    assert.equal(held.stopResolved, false); assert.deepEqual(held.workspaces, expected);
    await requestPeer(publisher, { command: 'notify', workspaceId: b });
    await requestPeer(publisher, { command: 'notify', workspaceId: c });
    await requestPeer(subscriber, { command: 'release' }); await stopping;
    const final = await requestPeer(subscriber, { command: 'snapshot' });
    assert.equal(final.stopResolved, true); assert.deepEqual(final.workspaces, expected);
    assert.deepEqual(final.acquisitions, [first.pid, second.pid, third.pid]);
    const errors = final.errors as Array<string | null>; assert(Array.isArray(errors) && errors.length > 0);
    for (const code of errors) assert.equal(code, '57P01', 'Only the deliberately terminated owned backend may report an error.');
    await awaitOwnedBackendsGone(control, [subscriber.applicationName]);

    stage = 'trusted outbox listener with no open workspace subscriptions';
    await requestPeer(subscriber, { command: 'start', workspaceIds: [], allWorkspaces: true });
    const fourth = await assertBackendFence(control, (await waitPeerEvent(subscriber, 'acquired')).data.backendPid, subscriber.applicationName);
    const initialResync = await waitPeerEvent(subscriber, 'resync');
    assert.equal(initialResync.data.backendPid, fourth.pid); assert.equal(initialResync.data.rescans, 1);
    await requestPeer(publisher, { command: 'notify', workspaceId: foreign });
    await waitPeerEvent(subscriber, 'invalidated', foreign, expected.length); expected.push(foreign);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);

    stage = 'trusted outbox rollback and commit delivery';
    await requestPeer(publisher, { command: 'begin', workspaceId: queued });
    await control.query('SELECT pg_catalog.pg_notify($1, $2)', [WORKSPACE_FILE_INVALIDATION_CHANNEL, JSON.stringify({ workspaceId: barrier })]);
    await waitPeerEvent(subscriber, 'invalidated', barrier, expected.length); expected.push(barrier);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);
    await requestPeer(publisher, { command: 'finish', commit: false });
    await requestPeer(publisher, { command: 'notify', workspaceId: barrier });
    await waitPeerEvent(subscriber, 'invalidated', barrier, expected.length); expected.push(barrier);
    assert.deepEqual((await requestPeer(subscriber, { command: 'snapshot' })).workspaces, expected);
    await requestPeer(publisher, { command: 'begin', workspaceId: queued });
    await requestPeer(publisher, { command: 'finish', commit: true });
    await waitPeerEvent(subscriber, 'invalidated', queued, expected.length); expected.push(queued);

    stage = 'trusted outbox reconnect rescans and drains its real checkout';
    await terminateOwnedBackend(control, fourth, subscriber.applicationName);
    const fifth = await assertBackendFence(control, (await waitPeerEvent(subscriber, 'acquired')).data.backendPid, subscriber.applicationName);
    assert.notEqual(fifth.pid, fourth.pid);
    const reconnected = await waitPeerEvent(subscriber, 'resync');
    assert.equal(reconnected.data.backendPid, fifth.pid); assert.equal(reconnected.data.rescans, 2);
    await requestPeer(publisher, { command: 'notify', workspaceId: c });
    await waitPeerEvent(subscriber, 'invalidated', c, expected.length); expected.push(c);
    const resumed = await requestPeer(subscriber, { command: 'snapshot' });
    assert.equal(resumed.allWorkspaces, true); assert.deepEqual(resumed.workspaces, expected);
    assert.deepEqual(resumed.acquisitions, [first.pid, second.pid, third.pid, fourth.pid, fifth.pid]);
    assert.equal((resumed.ledger as Delivery[]).at(-1)!.backendPid, fifth.pid);
    for (const code of resumed.errors as Array<string | null>) assert.equal(code, '57P01');
    await requestPeer(subscriber, { command: 'stop' });
    await waitPeerEvent(subscriber, 'stop-started');
    await awaitOwnedBackendsGone(control, [subscriber.applicationName]);
    assert.equal(controlFailure, undefined);
  } finally {
    let cleanupFailure: unknown;
    for (const peer of peers) { try { await closePeer(peer); } catch (error) { cleanupFailure ??= error; } }
    try {
      if (connected && peers.length) {
        const applications: string[] = []; for (const peer of peers) applications.push(peer.applicationName);
        await awaitOwnedBackendsGone(control, applications);
      }
    } catch (error) { cleanupFailure ??= error; }
    finally { await control.end(); }
    if (cleanupFailure) throw cleanupFailure;
  }
  console.log('PASS real PG18 cross-process workspace invalidation: commit, rollback, workspace filter, trusted outbox mode without open workspaces, disconnect/resync and drained stop; no document/DA04-abort claim.');
}

function onMainFailure(error: unknown): void {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  console.error(JSON.stringify({ failed: true, stage, name: error instanceof Error ? error.name : 'unknown',
    code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(code) ? code : null }));
  process.exitCode = 1;
}

void main().catch(onMainFailure);
