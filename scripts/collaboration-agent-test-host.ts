/**
 * Explicit local E2E launcher, never imported by the application. Runs the real
 * server and registered tools in ONE process so direct edits use its real room,
 * authorization and persistence bridge. No HTTP testing endpoint or fake apply.
 */
import { chmod, mkdtemp } from 'node:fs/promises';
import { unlinkSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';

const requireFromHere = createRequire(__filename);
const MAX_REQUEST = 256 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
// pi_sessions.created_at uses the repository's bigint epoch-millisecond format.
const hostStartedAt = Date.now();

async function executeFixtureTool(value: unknown): Promise<unknown> {
  if (!value || typeof value !== 'object') throw new Error('Invalid fixture request.');
  const input = value as Record<string, unknown>;
  const context = input.context as Record<string, unknown> | undefined;
  const params = input.params as Record<string, unknown> | undefined;
  if (!['read', 'edit_file'].includes(String(input.toolName))
    || typeof input.toolCallId !== 'string' || !/^ordinary-[a-z-]+[a-f0-9-]{36}$/u.test(input.toolCallId)
    || !params || typeof params.path !== 'string'
    || !/^fvrc-1008-ordinary-[a-f0-9-]{36}\.md$/u.test(params.path)
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
      `FVRC ordinary graph tool acceptance:${params.path}`, hostStartedAt]);
    if (!session) throw new Error('Unavailable fixture session.');
  } finally { await database.close(); }
  const { resolveAgentExecutionContextForStoredSession } = requireFromHere('../app/lib/pi/session-workspace-context');
  const authority = await resolveAgentExecutionContextForStoredSession({
    sessionId: context.sessionId, userId: context.userId, agentId: context.agentId,
    permissions: ['canRead', 'canWrite', 'canRunAgent'],
  });
  if (authority.workspaceId !== context.workspaceId || authority.legacy) throw new Error('Invalid fixture scope.');
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
  // Refuse a second app runtime BEFORE loading server.js or any room hooks.
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection({ host: '127.0.0.1', port: 3000 });
    probe.setTimeout(2_000, () => { probe.destroy(); reject(new Error('Port preflight unavailable.')); });
    probe.once('connect', () => { probe.destroy(); reject(new Error('Port occupied.')); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED') resolve(); else reject(new Error('Port preflight unavailable.'));
    });
  });
  const privateDirectory = await mkdtemp('/tmp/canvas-agent-e2e-');
  await chmod(privateDirectory, 0o700);
  const socketPath = path.join(privateDirectory, 'tools.sock');
  process.once('exit', () => {
    // Synchronous cleanup survives server.js's explicit exit after shutdown.
    try { unlinkSync(socketPath); } catch { /* Already unlinked by net.Server. */ }
    try { rmdirSync(privateDirectory); } catch { /* Never recursively remove unknown contents. */ }
  });
  let busy = false;
  const server = createServer(socket => {
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
      if (end !== buffer.length - 1 || busy) { socket.end('{"error":"unavailable"}\n'); return; }
      busy = true;
      void (async () => {
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
        } finally { busy = false; }
      })();
    });
  });
  server.on('error', () => { console.error('Local fixture transport unavailable.'); process.exitCode = 1; });
  // Only this test launcher installs the socket. Normal dev/prod startup does not.
  requireFromHere('../server.js');
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const bridge = globalThis as typeof globalThis & { __canvasCollaborationDirectConnection?: unknown };
      const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(2_000) });
      const health = await response.json();
      ready = response.ok && health.status === 'healthy' && health.collaboration?.websocketReady === true
        && health.collaboration?.persistenceReady === true
        && typeof bridge.__canvasCollaborationDirectConnection === 'function';
    } catch { /* Startup is still in progress; nothing can call this socket yet. */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) { process.kill(process.pid, 'SIGTERM'); return; }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  await chmod(socketPath, 0o600);
  console.log(`[Local agent E2E] Socket: ${socketPath}`);
  const close = () => {
    server.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

void main().catch(() => { console.error('Local agent E2E launcher refused startup.'); process.exitCode = 1; });
