import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { createDurableMessageExecutionFixture } from './durable-message-execution-fixture';

export type DurableExecutionWorkerCommand =
  | { type: 'initialize'; nonce: string; userId: string; sessionId: string; agentId: string; workspaceId: string; clientMessageId: string }
  | { type: 'go' | 'finish' | 'abort'; nonce: string };
export type DurableExecutionWorkerReply = {
  type: 'boot' | 'ready' | 'result' | 'finished' | 'error'; nonce: string; pid: number;
  clientMessageId?: string; outcome?: 'claimed' | 'conflict'; phase?: 'cancelled' | null;
  networkAttempts?: number; poolClosed?: boolean; runtimeAbsent?: boolean; stage?: string; code?: string;
};
type Fixture = Awaited<ReturnType<typeof createDurableMessageExecutionFixture>>;
type Row = { client_message_id: string; execution_phase: string; execution_revision: number | string;
  runtime_token: string; payload_hash: string; private_payload: string };

function within<T>(promise: Promise<T>, milliseconds: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Durable execution workers timed out during ${stage}.`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function workerChannel(child: ChildProcess, nonce: string) {
  const queue: DurableExecutionWorkerReply[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let wake: (() => void) | undefined;
  let transportError = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => { exited = { code, signal }; wake?.(); resolve(exited); });
  });
  child.on('error', () => { transportError = true; wake?.(); });
  child.on('message', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { transportError = true; wake?.(); return; }
    const reply = value as DurableExecutionWorkerReply;
    if (reply.nonce !== nonce || reply.pid !== child.pid || !['boot', 'ready', 'result', 'finished', 'error'].includes(reply.type)) {
      transportError = true; wake?.(); return;
    }
    queue.push(reply); wake?.();
  });
  const send = (command: DurableExecutionWorkerCommand) => new Promise<void>((resolve, reject) => {
    if (!child.connected) return reject(new Error('Durable execution worker IPC is unavailable.'));
    child.send(command, error => error ? reject(new Error('Durable execution worker IPC send failed.')) : resolve());
  });
  const receive = (type: DurableExecutionWorkerReply['type']) => within((async () => {
    for (;;) {
      if (transportError) throw new Error('Durable execution worker transport failed.');
      const reply = queue.shift();
      if (reply) {
        if (reply.type === 'error') {
          const stage = typeof reply.stage === 'string' && /^[a-z_]{1,32}$/u.test(reply.stage) ? reply.stage : 'unknown';
          const code = typeof reply.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(reply.code) ? reply.code : 'WORKER_FAILED';
          throw new Error(`Durable execution worker failed at ${stage} (${code}).`);
        }
        assert.equal(reply.type, type, 'Unexpected durable execution worker phase.');
        return reply;
      }
      if (exited) throw new Error('Durable execution worker exited before its verified reply.');
      await new Promise<void>(resolve => { wake = resolve; });
    }
  })(), 30_000, type);
  return { child, send, receive, exit,
    async stopAfterFailure() {
      if (exited) return;
      try { await send({ type: 'abort', nonce }); } catch { /* Only failure cleanup; never a success receipt. */ }
      try { await within(exit, 5_000, 'failure cleanup'); return; } catch { /* Owned child only. */ }
      child.kill('SIGTERM');
      try { await within(exit, 5_000, 'failure termination'); return; } catch { /* Preserve failure. */ }
      child.kill('SIGKILL');
      await within(exit, 5_000, 'forced failure termination');
    } };
}

/** Two real processes, two genuine Runtime registries, one already owned native
 * SQL session. No URL, credential, private payload or owner/claim token escapes. */
export async function runDurableExecutionClaimRace(input: {
  fixture: Fixture; session: { userId: string; sessionId: string; agentId: string };
  clientMessageIds: readonly [string, string];
}) {
  const { fixture, session, clientMessageIds } = input, application = fixture.application;
  assert.equal(clientMessageIds.length, 2);
  assert.equal(application.native, true, 'The two-process race requires the existing native fixture.');
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1');
  assert.equal(process.env.DATA, application.root); assert.equal(process.env.CANVAS_DATA_ROOT, application.root);
  assert.match(path.basename(application.root), /^canvas-store-application-/u);
  const rootStat = await fs.lstat(application.root); assert(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const pool = application.database.getPostgresRuntimeQueryable() as unknown as { options?: { connectionString?: unknown } };
  assert.equal(typeof pool.options?.connectionString, 'string', 'Use the actual native pool, never the fixture’s inert environment URL.');
  const connectionString = pool.options!.connectionString as string, databaseUrl = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
  assert.equal(databaseUrl.hostname, '127.0.0.1'); assert.equal(databaseUrl.port, '55433');
  assert.equal(databaseUrl.search, ''); assert.equal(databaseUrl.hash, '');
  const databaseName = databaseUrl.pathname.slice(1); assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
  const nonce = randomUUID().replaceAll('-', '');
  const sql = async <T>(operation: (database: import('../../app/lib/db').SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await application.database.openDb();
    try { return await operation(database); } finally { await database.close(); }
  };
  const stored = await sql(async database => {
    assert.equal((await database.get('SELECT current_database() AS name') as { name: string }).name, databaseName);
    return await database.get(`SELECT id,user_id,agent_id,workspace_id FROM pi_sessions
      WHERE user_id=$1 AND session_id=$2 AND archived_at IS NULL`, [session.userId, session.sessionId]) as
      { id: number; user_id: string; agent_id: string; workspace_id: string } | undefined;
  });
  assert(stored); assert.equal(stored.agent_id, session.agentId); assert(stored.workspace_id);
  const ids = [...new Set(clientMessageIds)];
  for (const id of ids) assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  const rows = () => sql(database => database.all(`SELECT client_message_id,execution_phase,execution_revision,runtime_token,payload_hash,private_payload
    FROM pi_message_delivery_receipts WHERE pi_session_db_id=$1 AND client_message_id=ANY($2::text[]) ORDER BY client_message_id`, [stored.id, ids])) as Promise<Row[]>;
  const before = await rows(); assert.equal(before.length, ids.length);
  for (const row of before) { assert.equal(row.execution_phase, 'queued'); assert.equal(Number(row.execution_revision), 1); assert.equal(row.runtime_token, 'unclaimed'); }
  const immutable = (actual: Row[]) => {
    assert.equal(actual.length, before.length);
    for (const row of actual) {
      const original = before.find(value => value.client_message_id === row.client_message_id); assert(original);
      assert.equal(row.private_payload, original.private_payload); assert.equal(row.payload_hash, original.payload_hash);
    }
  };
  const workerPath = path.resolve('scripts/durable-message-execution-worker.ts');
  assert((await fs.lstat(workerPath)).isFile());
  const workers: ReturnType<typeof workerChannel>[] = [];
  try {
    for (const clientMessageId of clientMessageIds) {
      const child = fork(workerPath, [], { cwd: process.cwd(), execArgv: ['--conditions=react-server', '--import', 'tsx'],
        // Credentials remain in this inherited private process environment.
        // Child stdout/stderr are deliberately not forwarded or interpolated.
        env: { ...process.env, DATABASE_URL: connectionString, CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external',
          CANVAS_DURABLE_EXECUTION_WORKER: '1',
          CANVAS_DURABLE_EXECUTION_WORKER_NONCE: nonce, CANVAS_DURABLE_EXECUTION_WORKER_PARENT_PID: String(process.pid),
          CANVAS_DURABLE_EXECUTION_WORKER_DATA_ROOT: application.root, CANVAS_DURABLE_EXECUTION_WORKER_DATABASE: databaseName,
          CANVAS_POSTGRES_POOL_MAX: '2', CANVAS_POSTGRES_CONNECTION_TIMEOUT_MS: '5000' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const channel = workerChannel(child, nonce); workers.push(channel);
      await channel.receive('boot');
      await channel.send({ type: 'initialize', nonce, ...session, workspaceId: stored.workspace_id, clientMessageId });
    }
    const ready = await Promise.all(workers.map(worker => worker.receive('ready')));
    assert.notEqual(ready[0]!.pid, ready[1]!.pid);
    for (const reply of ready) assert.equal(reply.networkAttempts, 0);
    await Promise.all(workers.map(worker => worker.send({ type: 'go', nonce })));
    const results = await Promise.all(workers.map(worker => worker.receive('result')));
    results.forEach((reply, index) => assert.equal(reply.clientMessageId, clientMessageIds[index]));
    assert.equal(results.filter(value => value.outcome === 'claimed').length, 1);
    assert.equal(results.filter(value => value.outcome === 'conflict').length, 1);
    const winnerIndex = results[0]!.outcome === 'claimed' ? 0 : 1;
    const claimedRows = await rows(); immutable(claimedRows);
    assert.equal(claimedRows.filter(row => row.execution_phase === 'dispatching').length, 1);
    for (const row of claimedRows) {
      const won = row.client_message_id === clientMessageIds[winnerIndex];
      assert.equal(row.execution_phase, won ? 'dispatching' : 'queued'); assert.equal(Number(row.execution_revision), won ? 2 : 1);
      if (won) assert.notEqual(row.runtime_token, 'unclaimed'); else assert.equal(row.runtime_token, 'unclaimed');
    }
    // Only this actual parent SQL observation releases the winner to settle.
    await Promise.all(workers.map(worker => worker.send({ type: 'finish', nonce })));
    const finished = await Promise.all(workers.map(worker => worker.receive('finished')));
    finished.forEach((reply, index) => {
      assert.equal(reply.phase, index === winnerIndex ? 'cancelled' : null); assert.equal(reply.networkAttempts, 0);
      assert.equal(reply.poolClosed, true); assert.equal(reply.runtimeAbsent, true);
    });
    const exits = await Promise.all(workers.map(worker => within(worker.exit, 15_000, 'normal process exit')));
    for (const exit of exits) { assert.equal(exit.code, 0); assert.equal(exit.signal, null); }
    const finalRows = await rows(); immutable(finalRows);
    for (const row of finalRows) {
      const won = row.client_message_id === clientMessageIds[winnerIndex];
      assert.equal(row.execution_phase, won ? 'cancelled' : 'queued'); assert.equal(Number(row.execution_revision), won ? 3 : 1);
      assert.equal(row.runtime_token, claimedRows.find(value => value.client_message_id === row.client_message_id)!.runtime_token);
    }
    const publicRows = (values: Row[]) => values.map(row => ({ clientMessageId: row.client_message_id,
      phase: row.execution_phase, executionRevision: Number(row.execution_revision) }));
    return { winnerIndex, outcomes: results.map(reply => ({ outcome: reply.outcome!, clientMessageId: reply.clientMessageId! })),
      processIds: ready.map(reply => reply.pid), beforeWinnerRelease: publicRows(claimedRows), afterSettlement: publicRows(finalRows),
      normalExitCodes: exits.map(exit => exit.code) };
  } catch (error) {
    const cleanup = await Promise.allSettled(workers.map(worker => worker.stopAfterFailure()));
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError([error, ...failures], 'Execution race failed and owned worker cleanup could not be confirmed.');
    throw error;
  }
}
