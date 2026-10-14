import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import net from 'node:net';
import path from 'node:path';
import type { DurableExecutionWorkerCommand, DurableExecutionWorkerReply } from './helpers/durable-message-execution-workers';

/** Native child only. It reads the actual app pool/catalog/session and creates
 * its own genuine Runtime registration. No DB, source, policy or resolver stub. */
async function main(): Promise<void> {
  const nonce = process.env.CANVAS_DURABLE_EXECUTION_WORKER_NONCE ?? '';
  assert.match(nonce, /^[a-f0-9]{32}$/u); assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1');
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres'); assert.equal(process.env.CANVAS_POSTGRES_MODE, 'external');
  assert.equal(process.env.CANVAS_POSTGRES_POOL_MAX, '2');
  assert.equal(process.env.CANVAS_DURABLE_EXECUTION_WORKER, '1'); assert(process.send && process.connected);
  assert.equal(String(process.ppid), process.env.CANVAS_DURABLE_EXECUTION_WORKER_PARENT_PID);
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
  assert.equal(databaseUrl.hostname, '127.0.0.1'); assert.equal(databaseUrl.port, '55433');
  assert.equal(databaseUrl.search, ''); assert.equal(databaseUrl.hash, '');
  const databaseName = databaseUrl.pathname.slice(1); assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
  assert.equal(databaseName, process.env.CANVAS_DURABLE_EXECUTION_WORKER_DATABASE);
  const root = process.env.CANVAS_DURABLE_EXECUTION_WORKER_DATA_ROOT ?? '';
  assert.equal(process.env.DATA, root); assert.equal(process.env.CANVAS_DATA_ROOT, root);
  assert.match(path.basename(root), /^canvas-store-application-/u);
  const stat = await fs.lstat(root); assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await fs.realpath(root), path.join(await fs.realpath(path.dirname(root)), path.basename(root)));
  let stage = 'initialize', networkAttempts = 0;
  const send = (value: Omit<DurableExecutionWorkerReply, 'nonce' | 'pid'>) => new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error('Worker IPC unavailable.'));
    process.send({ ...value, nonce, pid: process.pid }, error => error ? reject(new Error('Worker IPC failed.')) : resolve());
  });
  const queue: DurableExecutionWorkerCommand[] = [];
  let wake: (() => void) | undefined;
  let protocolError = false;
  process.on('message', value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { protocolError = true; wake?.(); return; }
    const command = value as DurableExecutionWorkerCommand;
    const allowed = command.type === 'initialize'
      ? ['type', 'nonce', 'userId', 'sessionId', 'agentId', 'workspaceId', 'clientMessageId'] : ['type', 'nonce'];
    if (command.nonce !== nonce || !['initialize', 'go', 'finish', 'abort'].includes(command.type)
      || Object.keys(value).some(key => !allowed.includes(key))) { protocolError = true; wake?.(); return; }
    queue.push(command); wake?.();
  });
  process.on('disconnect', () => { queue.push({ type: 'abort', nonce }); wake?.(); });
  const next = async () => {
    for (;;) {
      assert.equal(protocolError, false, 'Invalid worker IPC.');
      const value = queue.shift(); if (value) return value;
      await new Promise<void>(resolve => { wake = resolve; });
    }
  };
  const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Worker network access is forbidden.'); };
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const first = args[0];
    const config = first && typeof first === 'object' && !Array.isArray(first) ? first as { host?: unknown; port?: unknown } : null;
    const port = config ? config.port : first, host = config ? config.host : args[1];
    if (host !== '127.0.0.1' || Number(port) !== 55433) { networkAttempts++; throw new Error('Only the owned native PostgreSQL connection is permitted.'); }
    return Reflect.apply(originalConnect, this, args);
  } as typeof originalConnect;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, sdk = new Map<string, unknown>();
  let runtimeApi: typeof import('../app/lib/pi/live-runtime') | undefined;
  let databaseApi: typeof import('../app/lib/db') | undefined;
  let execution: typeof import('../app/lib/pi/durable-message-execution') | undefined;
  let claim: import('../app/lib/pi/durable-message-execution').ChatMessageExecutionClaim | undefined;
  let initialization: Extract<DurableExecutionWorkerCommand, { type: 'initialize' }> | undefined;
  let clean = false;
  try {
    await send({ type: 'boot' });
    const command = await next(); assert.equal(command.type, 'initialize');
    if (command.type !== 'initialize') throw new Error('Initialization required.');
    initialization = command;
    assert(['owner', 'alice', 'bob'].includes(command.userId));
    for (const value of [command.sessionId, command.agentId, command.workspaceId, command.clientMessageId]) assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    stage = 'sdk';
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) sdk.set(name, await import(name));
    loader._load = (name, parent, isMain) => sdk.has(name) ? sdk.get(name) : originalLoad(name, parent, isMain);
    stage = 'database'; databaseApi = await import('../app/lib/db');
    const database = await databaseApi.openDb();
    try {
      assert.equal((await database.get('SELECT current_database() AS name') as { name: string }).name, databaseName);
      const stored = await database.get(`SELECT agent_id,workspace_id,organization_id FROM pi_sessions
        WHERE user_id=$1 AND session_id=$2 AND archived_at IS NULL`, [command.userId, command.sessionId]) as
        { agent_id: string; workspace_id: string; organization_id: string } | undefined;
      assert(stored); assert.equal(stored.agent_id, command.agentId); assert.equal(stored.workspace_id, command.workspaceId);
      assert.equal(stored.organization_id, process.env.CANVAS_ORGANIZATION_ID);
      const organization = await database.get('SELECT owner_user_id FROM canvas_organization_settings WHERE organization_id=$1',
        [stored.organization_id]) as { owner_user_id: string } | undefined;
      assert.equal(organization?.owner_user_id, 'owner');
    } finally { await database.close(); }
    stage = 'runtime'; runtimeApi = await import('../app/lib/pi/live-runtime');
    const { runtime } = await runtimeApi.getOrCreatePiRuntimeWithState(command.sessionId, command.userId, { metadataOnlyExternal: true });
    assert.equal(runtime.agentId, command.agentId); assert.equal(runtime.getStatus().phase, 'idle');
    const owner = await runtimeApi.getRegisteredPiRuntimeExecutionOwner(runtime);
    stage = 'owned';
    const admission = await import('../app/lib/pi/durable-message-admission');
    const owned = await admission.readOwnedAcceptedChatMessage({ userId: command.userId, sessionId: command.sessionId,
      expectedAgentId: command.agentId, expectedWorkspaceId: command.workspaceId, clientMessageId: command.clientMessageId });
    assert(owned); execution = await import('../app/lib/pi/durable-message-execution');
    assert.equal(networkAttempts, 0); await send({ type: 'ready', networkAttempts });
    const go = await next(); if (go.type === 'abort') return; assert.equal(go.type, 'go');
    stage = 'claim';
    try { claim = await execution.claimOwnedChatMessageExecution(owned, owner); }
    catch (error) { assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, 'MESSAGE_EXECUTION_CONFLICT'); }
    const won = Boolean(claim);
    await send({ type: 'result', clientMessageId: command.clientMessageId, outcome: claim ? 'claimed' : 'conflict' });
    const finish = await next(); assert(['finish', 'abort'].includes(finish.type));
    stage = 'settlement';
    if (claim) { const result = await execution.finishClaimedChatMessageExecution(claim, 'cancelled'); assert.equal(result.phase, 'cancelled'); claim = undefined; }
    stage = 'cleanup'; await runtimeApi.invalidatePiRuntime(command.sessionId, command.userId);
    assert.equal(await runtimeApi.getExistingPiRuntime(command.sessionId, command.userId), null);
    await databaseApi.closeDatabaseConnections(); assert.equal(networkAttempts, 0); clean = true;
    await send({ type: 'finished', phase: won ? 'cancelled' : null,
      networkAttempts, poolClosed: true, runtimeAbsent: true });
  } catch (error) {
    process.exitCode = 1;
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    await send({ type: 'error', stage, code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : 'WORKER_FAILED' }).catch(() => undefined);
  } finally {
    if (!clean) {
      if (claim && execution) await execution.finishClaimedChatMessageExecution(claim, 'cancelled').catch(() => { process.exitCode = 1; });
      if (initialization && runtimeApi) await runtimeApi.invalidatePiRuntime(initialization.sessionId, initialization.userId).catch(() => { process.exitCode = 1; });
      await databaseApi?.closeDatabaseConnections().catch(() => { process.exitCode = 1; });
    }
    loader._load = originalLoad; net.Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch;
    process.disconnect?.();
  }
}

void main().catch(() => { process.exitCode = 1; process.disconnect?.(); });
