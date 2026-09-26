/** Private IPC-controlled crash launcher. It never changes stored application state. */
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { installProposalCrashProbe, type CrashPoint, type CrashTarget } from './collaboration-proposal-crash-probe';

const requireFromHere = createRequire(__filename);
const startedAt = Date.now();
let armed = false;
let arming = false;

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  if (!process.send || !process.connected || process.env.NODE_ENV !== 'development'
    || process.env.COLLABORATION_E2E !== '1' || process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST !== '1'
    || process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1' || process.env.HOSTNAME !== '127.0.0.1'
    || process.env.PORT !== '3000' || process.env.CANVAS_DATABASE_PROVIDER !== 'postgres'
    || url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/canvas_notebook') {
    throw new Error('The crash launcher requires explicit local IPC test opt-ins.');
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection({ host: '127.0.0.1', port: 3000 });
    probe.setTimeout(2_000, () => { probe.destroy(); reject(new Error('Port preflight unavailable.')); });
    probe.once('connect', () => { probe.destroy(); reject(new Error('Port occupied.')); });
    probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
  });
  // Observe even connections attempted by startup recovery, before HTTP ready.
  // The one-time setter delegates the installed handler without changing it.
  Object.defineProperty(globalThis, '__canvasCollaborationDirectConnection', {
    configurable: true,
    set(handler: (...args: unknown[]) => unknown) {
      Object.defineProperty(globalThis, '__canvasCollaborationDirectConnection', {
        configurable: true, writable: true,
        value: (...args: unknown[]) => {
          const input = args[0] as { operationId: string; documentId: string };
          process.send?.({ type: 'direct', operationId: input.operationId, documentId: input.documentId });
          return handler(...args);
        },
      });
    },
  });
  requireFromHere('../server.js');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(2_000) });
      const value = await response.json();
      if (response.ok && value.status === 'healthy' && value.collaboration?.websocketReady
        && value.collaboration?.persistenceReady) break;
    } catch { /* The owned process has not reached readiness yet. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (Date.now() >= deadline) throw new Error('The crash launcher did not become ready.');
  process.on('message', message => {
    void arm(message).catch(() => process.send?.({ type: 'refused' }));
  });
  process.send({ type: 'ready', pid: process.pid });
}

async function arm(message: unknown) {
  if (armed || arming || !message || typeof message !== 'object') throw new Error('Invalid control request.');
  const input = message as { type: string; target: CrashTarget; point: CrashPoint; sessionId: string; agentId: string };
  if (input.type !== 'arm' || !input.target || ![input.sessionId, input.agentId].every(id =>
    typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) throw new Error('Invalid control request.');
  arming = true;
  try {
    const { openDb } = requireFromHere('../app/lib/db');
    const db = await openDb();
    try {
      const session = await db.get(`SELECT 1 FROM pi_sessions WHERE session_id=$1 AND agent_id=$2
        AND user_id=$3 AND workspace_id=$4 AND title=$5 AND archived_at IS NULL AND created_at >= $6 LIMIT 1`,
      [input.sessionId, input.agentId, input.target.userId, input.target.workspaceId,
        `FVRC ordinary graph tool acceptance:${input.target.path}`, startedAt]);
      const document = await db.get(`SELECT 1 FROM collaboration_yjs_states WHERE document_id=$1
        AND workspace_id=$2 AND path=$3 AND status='active' LIMIT 1`,
      [input.target.documentId, input.target.workspaceId, input.target.path]);
      if (!session || !document) throw new Error('Unavailable crash fixture.');
    } finally { await db.close(); }
    const { fileVersionHistoryService } = requireFromHere('../app/lib/file-version-center/history-service');
    const { Y } = requireFromHere('../app/lib/collaboration/server-runtime');
    const { proposalYjsRecoveryStateMatches } = requireFromHere('../app/lib/file-version-center/proposal-yjs-candidate');
    installProposalCrashProbe({ bridge: globalThis as Parameters<typeof installProposalCrashProbe>[0]['bridge'],
      history: fileVersionHistoryService, target: input.target, point: input.point,
      encodeApplied: Y.encodeStateAsUpdate, persistedMatches: proposalYjsRecoveryStateMatches,
      interrupt: async evidence => {
        const database = await openDb();
        try {
          const operation = await database.get(`SELECT status,resulting_state_snapshot,version_revision_id
            FROM collaboration_agent_operations WHERE operation_id=$1 AND document_id=$2 AND workspace_id=$3`,
          [evidence.operationId, input.target.documentId, input.target.workspaceId]);
          const expected = input.point === 'persisted-before-ack' ? 'applying' : 'applied_to_ydoc';
          if (!operation || operation.status !== expected || operation.version_revision_id
            || Boolean(operation.resulting_state_snapshot) !== (expected === 'applied_to_ydoc')) {
            throw new Error('The persisted operation does not match the requested crash boundary.');
          }
        } finally { await database.close(); }
        await new Promise<void>((resolve, reject) => process.send!({ type: 'boundary', ...evidence }, error => error ? reject(error) : resolve()));
        // No graceful shutdown: pending room stores and callbacks must not flush.
        process.kill(process.pid, 'SIGKILL');
        return new Promise<never>(() => {});
      } });
    armed = true;
    process.send?.({ type: 'armed' });
  } finally { arming = false; }
}

void main().catch(() => {
  console.error('Local proposal crash launcher refused startup.');
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
