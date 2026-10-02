/**
 * Explicit local E2E launcher, never imported by the application. Runs the real
 * server and registered tools in ONE process so direct edits use its real room,
 * authorization and persistence bridge. No HTTP testing endpoint or fake apply.
 */
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { unlinkSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const requireFromHere = createRequire(__filename);
const MAX_REQUEST = 256 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 10_000;
// pi_sessions.created_at uses the repository's bigint epoch-millisecond format.
const hostStartedAt = Date.now();
const fixtureTurns = new Map<string, string>();

async function executeFixtureTool(value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object') throw new Error('Invalid fixture request.');
  const input = value as Record<string, unknown>;
  const context = input.context as Record<string, unknown> | undefined;
  const params = input.params as Record<string, unknown> | undefined;
  const patchFiles = input.toolName === 'apply_patch' && Array.isArray(params?.files) ? params.files : null;
  const fixturePath = patchFiles?.length === 1 && patchFiles[0] && typeof patchFiles[0] === 'object'
    ? (patchFiles[0] as Record<string, unknown>).path : params?.path;
  if (!['read', 'write', 'edit_file', 'apply_patch'].includes(String(input.toolName))
    || typeof input.toolCallId !== 'string' || !/^ordinary-[a-z-]+[a-f0-9-]{36}$/u.test(input.toolCallId)
    || !params || (input.toolName === 'apply_patch' ? patchFiles?.length !== 1 : typeof params.path !== 'string')
    || typeof fixturePath !== 'string' || !/^fvrc-1008-ordinary-[a-f0-9-]{36}\.md$/u.test(fixturePath)
    || !context || !['sessionId', 'userId', 'agentId', 'workspaceId'].every(key =>
      typeof context[key] === 'string' && context[key].length > 0 && context[key].length <= 256)) {
    throw new Error('Invalid fixture request.');
  }
  const { openDb } = requireFromHere('../app/lib/db');
  const database = await openDb();
  try {
    // No session/configuration is manufactured here. The authenticated browser
    // must have created this specifically named fixture session through the API.
    const session = await database.get(`SELECT 1 FROM pi_sessions
      WHERE session_id = $1 AND user_id = $2 AND agent_id = $3 AND workspace_id = $4
        AND title = $5 AND archived_at IS NULL AND created_at >= $6 LIMIT 1`,
    [context.sessionId, context.userId, context.agentId, context.workspaceId,
      `FVRC ordinary graph tool acceptance:${fixturePath}`, hostStartedAt]);
    if (!session) throw new Error('Unavailable fixture session.');
  } finally { await database.close(); }
  const { resolveAgentExecutionContextForStoredSession } = requireFromHere('../app/lib/pi/session-workspace-context');
  const authority = await resolveAgentExecutionContextForStoredSession({
    sessionId: context.sessionId, userId: context.userId, agentId: context.agentId,
    permissions: ['canRead', 'canWrite', 'canRunAgent'],
  });
  if (authority.workspaceId !== context.workspaceId || authority.legacy) throw new Error('Invalid fixture scope.');
  const turnKey = JSON.stringify([authority.workspaceId, authority.userId, authority.sessionId]);
  if (input.turnAction !== undefined) {
    if (!['begin', 'finish'].includes(String(input.turnAction))) throw new Error('Invalid fixture turn action.');
    const { agentTurnHistoryService } = requireFromHere('../app/lib/file-version-center/agent-turn-history');
    const turnId = input.turnAction === 'begin' ? randomUUID() : fixtureTurns.get(turnKey);
    if (!turnId || (input.turnAction === 'begin' && fixtureTurns.has(turnKey))) throw new Error('Invalid fixture turn lifecycle.');
    const identity = { turnId, workspaceId: authority.workspaceId, userId: authority.userId, sessionId: authority.sessionId };
    if (input.turnAction === 'begin') {
      await agentTurnHistoryService.begin(identity);
      fixtureTurns.set(turnKey, turnId);
    } else {
      await agentTurnHistoryService.finish(identity, 'completed');
      fixtureTurns.delete(turnKey);
    }
    return { details: { agentTurnId: turnId } };
  }
  const turnId = fixtureTurns.get(turnKey);
  if (turnId) {
    // The launcher, like the live runtime, issues the ID. Caller context is ignored.
    authority.agentTurnId = turnId;
    const { agentTurnHistoryService } = requireFromHere('../app/lib/file-version-center/agent-turn-history');
    await agentTurnHistoryService.touch({ turnId, workspaceId: authority.workspaceId, userId: authority.userId, sessionId: authority.sessionId });
  }
  // Ignore all caller-supplied paths and permissions: derive current authority.
  const { runWithAgentExecutionContext } = requireFromHere('../app/lib/pi/agent-execution-context');
  const { piTools } = requireFromHere('../app/lib/pi/core-tools');
  const tool = piTools.find((candidate: { name: string }) => candidate.name === input.toolName);
  if (!tool) throw new Error('Unavailable fixture tool.');
  return runWithAgentExecutionContext(authority, () => tool.execute(input.toolCallId, params));
}

async function main(): Promise<void> {
  const databaseUrl = new URL(process.env.DATABASE_URL || '');
  if (process.env.NODE_ENV !== 'development' || process.env.COLLABORATION_E2E !== '1'
    || process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST !== '1'
    || process.env.HOSTNAME !== '127.0.0.1' || process.env.PORT !== '3000'
    || process.env.CANVAS_DATABASE_PROVIDER !== 'postgres'
    || databaseUrl.hostname !== '127.0.0.1' || databaseUrl.port !== '55433'
    || databaseUrl.pathname !== '/canvas_notebook') {
    throw new Error('This launcher requires the explicitly enabled managed loopback development stack.');
  }
  await startHost({ baseURL: 'http://127.0.0.1:3000', port: 3000 });
}

export async function startOwnedCollaborationAgentTestHost(): Promise<LocalAgentTestHost> {
  // The production profile has its own stronger target verifier. Do not relax
  // the original development entry or import any application module first.
  const { requireOwnedCollaborationQaTarget } = requireFromHere('./lib/owned-collaboration-qa');
  const target = await requireOwnedCollaborationQaTarget();
  return startHost({ baseURL: target.baseURL, port: target.port, qaBindingHash: target.bindingHash });
}

type LocalAgentTestHost = {
  socketPath: string;
  receiptPath: string | null;
  close(): Promise<void>;
};

async function startHost(input: { baseURL: string; port: number; qaBindingHash?: string }): Promise<LocalAgentTestHost> {
  // Refuse a second app runtime BEFORE loading server.js or any room hooks.
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection({ host: '127.0.0.1', port: input.port });
    probe.setTimeout(2_000, () => { probe.destroy(); reject(new Error('Port preflight unavailable.')); });
    probe.once('connect', () => { probe.destroy(); reject(new Error('Port occupied.')); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED') resolve(); else reject(new Error('Port preflight unavailable.'));
    });
  });
  const privateDirectory = await mkdtemp(input.qaBindingHash ? '/tmp/canvas-agent-qa-e2e-' : '/tmp/canvas-agent-e2e-');
  await chmod(privateDirectory, 0o700);
  const socketPath = path.join(privateDirectory, 'tools.sock');
  const receiptPath = input.qaBindingHash ? path.join(privateDirectory, 'host-binding.json') : null;
  let retainExitEvidence = false;
  process.once('exit', () => {
    if (retainExitEvidence) return;
    // Synchronous cleanup survives server.js's explicit exit after shutdown.
    try { unlinkSync(socketPath); } catch { /* Already unlinked by net.Server. */ }
    if (receiptPath) { try { unlinkSync(receiptPath); } catch { /* Only this host's private receipt. */ } }
    try { rmdirSync(privateDirectory); } catch { /* Never recursively remove unknown contents. */ }
  });
  let busy = false;
  let closing = false;
  let activeExecution: Promise<void> | null = null;
  const connections = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    let buffer = Buffer.alloc(0);
    let submitted = false;
    socket.setTimeout(60_000, () => socket.destroy());
    socket.on('error', () => { /* Client failure is not a second tool execution. */ });
    socket.on('data', (chunk: Buffer) => {
      if (submitted) { socket.destroy(); return; }
      if (buffer.length + chunk.length > MAX_REQUEST) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      submitted = true;
      if (end !== buffer.length - 1 || busy || closing) { socket.end('{"error":"unavailable"}\n'); return; }
      busy = true;
      activeExecution = (async () => {
        try {
          const bridge = globalThis as typeof globalThis & { __canvasCollaborationDirectConnection?: unknown };
          if (typeof bridge.__canvasCollaborationDirectConnection !== 'function') throw new Error('Not ready.');
          const envelope = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          const result = await executeFixtureTool(envelope.input);
          const response = JSON.stringify({ result }) + '\n';
          if (Buffer.byteLength(response) > MAX_RESPONSE) throw new Error('Response too large.');
          socket.end(response);
        } catch {
          socket.end('{"error":"unavailable"}\n');
        } finally { busy = false; activeExecution = null; }
      })();
    });
  });
  server.on('error', () => { console.error('Local fixture transport unavailable.'); process.exitCode = 1; });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = new Promise<void>((resolve, reject) => server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
      // Observe an early transport-close error even while a tool is pending.
      void stopped.catch(() => undefined);
      const drain = (async () => {
        await activeExecution;
        for (const socket of connections) socket.destroy();
        await stopped;
      })();
      try {
        await Promise.race([drain, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Local fixture execution did not drain within 10000ms.')), DRAIN_TIMEOUT_MS);
        })]);
      } finally { clearTimeout(timer); }
    })();
    return closePromise;
  };
  // Only this test launcher installs the socket. Normal dev/prod startup does not.
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const previousHandlers = new Map(signals.map(signal => [signal, new Set(process.rawListeners(signal))]));
  const applicationHandlers = new Map(signals.map(signal => [signal, [] as ReturnType<typeof process.rawListeners>]));
  const ownHandlers = new Set<ReturnType<typeof process.rawListeners>[number]>();
  const adoptApplicationHandlers = () => {
    for (const signal of signals) {
      const captured = applicationHandlers.get(signal)!;
      for (const handler of process.rawListeners(signal)) {
        if (previousHandlers.get(signal)!.has(handler) || ownHandlers.has(handler)) continue;
        process.removeListener(signal, handler);
        if (!captured.includes(handler)) captured.push(handler);
      }
    }
  };
  let adoptionQueued = false;
  const observeNewListener = (eventName: string | symbol, listener: (...args: unknown[]) => void) => {
    if ((eventName !== 'SIGTERM' && eventName !== 'SIGINT') || ownHandlers.has(listener) || adoptionQueued) return;
    adoptionQueued = true;
    // newListener fires before the actual registration. A subsequent OS signal
    // is dispatched after this microtask has adopted the new raw once wrapper.
    queueMicrotask(() => { adoptionQueued = false; adoptApplicationHandlers(); });
  };
  if (input.qaBindingHash) process.on('newListener', observeNewListener);
  requireFromHere('../server.js');
  adoptApplicationHandlers();
  let shutdownPromise: Promise<void> | undefined;
  for (const signal of signals) {
    const stop = () => {
      if (shutdownPromise) return;
      shutdownPromise = close().then(async () => {
        if (input.qaBindingHash) adoptApplicationHandlers();
        // Node dispatches signal listeners synchronously. Yield only after all
        // original handlers have started, preserving their existing grace periods.
        const handlers = applicationHandlers.get(signal)!.slice();
        const results = handlers.map(handler => handler.call(process, signal));
        await Promise.all(results);
      }).catch(async () => {
        retainExitEvidence = true;
        process.exitCode = 1;
        try {
          await writeFile(path.join(privateDirectory, 'drain-failed.json'), `${JSON.stringify({
            version: 1, pid: process.pid, signal, deadlineMs: DRAIN_TIMEOUT_MS,
            activeExecutionPending: activeExecution !== null, failedAt: Date.now(),
          })}\n`, { mode: 0o600, flag: 'wx' });
        } catch { /* Keep the private receipt and report failure even if the marker cannot be written. */ }
        console.error('Local fixture shutdown failed; drain evidence retained.');
      });
    };
    ownHandlers.add(stop);
    process.on(signal, stop);
  }
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const bridge = globalThis as typeof globalThis & { __canvasCollaborationDirectConnection?: unknown };
      const response = await fetch(new URL('/api/health', input.baseURL), { signal: AbortSignal.timeout(2_000) });
      const health = await response.json();
      ready = response.ok && health.status === 'healthy' && health.collaboration?.websocketReady === true
        && health.collaboration?.persistenceReady === true
        && typeof bridge.__canvasCollaborationDirectConnection === 'function';
    } catch { /* Startup is still in progress; nothing can call this socket yet. */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) { process.kill(process.pid, 'SIGTERM'); throw new Error('The real collaboration server did not become ready.'); }
  if (closing) throw new Error('Local fixture host stopped during startup.');
  if (input.qaBindingHash) adoptApplicationHandlers();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  await chmod(socketPath, 0o600);
  if (receiptPath) {
    adoptApplicationHandlers();
    // UID + start identity is checked afresh by the client, without argv or ENV.
    const processStartIdentity = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'uid=', '-o', 'lstart='],
      { encoding: 'utf8', timeout: 5_000 }).trim().replace(/\s+/gu, ' ');
    if (!processStartIdentity.startsWith(`${process.getuid?.()} `)) throw new Error('QA host process ownership is unavailable.');
    await writeFile(receiptPath, `${JSON.stringify({ version: 1, pid: process.pid, port: input.port,
      bindingHash: input.qaBindingHash, startedAt: hostStartedAt, processStartIdentity })}\n`, { mode: 0o600, flag: 'wx' });
  }
  if (input.qaBindingHash) {
    adoptApplicationHandlers();
    if (closing) throw new Error('Local fixture host stopped during startup.');
  }
  console.log(`[Local agent E2E] Socket: ${socketPath}`);
  return { socketPath, receiptPath, close };
}

if (require.main === module) {
  void main().catch(() => { console.error('Local agent E2E launcher refused startup.'); process.exitCode = 1; });
}
