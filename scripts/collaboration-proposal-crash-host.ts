/** Private IPC-controlled crash launcher. It never changes stored application state. */
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { installProposalCrashProbe, type CrashPoint, type CrashTarget } from './collaboration-proposal-crash-probe';
import { installProposalPreparingCrashProbe, type PreparingCrashPoint } from './collaboration-proposal-preparing-crash-probe';

const requireFromHere = createRequire(__filename);
const startedAt = Date.now();
let armed = false;
let arming = false;

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  const port = Number(process.env.PORT);
  const multiprocess = process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST === '1';
  const acceptedPort = multiprocess ? [3101, 3102].includes(port) : port === 3000;
  if (!process.send || !process.connected || process.env.NODE_ENV !== 'development'
    || process.env.COLLABORATION_E2E !== '1' || process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST !== '1'
    || process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1' || process.env.HOSTNAME !== '127.0.0.1'
    || !acceptedPort || (multiprocess && process.env.BASE_URL !== 'http://127.0.0.1:3000')
    || process.env.CANVAS_DATABASE_PROVIDER !== 'postgres'
    || url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/canvas_notebook') {
    throw new Error('The crash launcher requires explicit local IPC test opt-ins.');
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection({ host: '127.0.0.1', port });
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
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
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
  process.send({ type: 'ready', pid: process.pid, port });
}

async function arm(message: unknown) {
  if (armed || arming || !message || typeof message !== 'object') throw new Error('Invalid control request.');
  const input = message as { type: string; target: CrashTarget; point: CrashPoint | PreparingCrashPoint; sessionId: string; agentId: string };
  if (input.type !== 'arm' || !input.target
    || !/^fvrc-1008-ordinary-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.md$/u.test(input.target.path)
    || ![input.sessionId, input.agentId, input.target.documentId, input.target.workspaceId, input.target.userId].every(id =>
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
    if (input.point === 'prepared-before-apply') {
      const { Client } = requireFromHere('pg');
      let verifiedSequence: number | null = null;
      installProposalPreparingCrashProbe({ clientPrototype: Client.prototype,
        verify: async ({ operationId, casVersion, runGeneration }) => {
          const database = await openDb();
          try {
            const operation = await database.get(`SELECT state.document_sequence
              FROM collaboration_agent_operations operation
              JOIN file_proposal_action_receipts action ON action.action_id=operation.operation_id
                AND action.operation_id=operation.operation_id AND action.document_id=operation.document_id
                AND action.workspace_id=operation.workspace_id AND action.actor_id=operation.actor_id
                AND action.lifecycle_generation=operation.document_lifecycle_generation
                AND action.schema_version=operation.schema_version
              JOIN collaboration_yjs_states state ON state.document_id=operation.document_id
                AND state.workspace_id=operation.workspace_id AND state.path=operation.document_path
                AND state.lifecycle_generation=operation.document_lifecycle_generation
                AND state.schema_version=operation.schema_version
                AND state.representation=operation.document_representation
              WHERE operation.operation_id=$1 AND operation.document_id=$2 AND operation.workspace_id=$3
                AND operation.document_path=$4 AND operation.actor_id=$5 AND operation.initiated_by_user_id=$5
                AND operation.status='preparing' AND operation.cas_version=$6 AND operation.run_generation=$7
                AND operation.idempotency_key=$8 AND operation.result_json IS NULL
                AND operation.resulting_state_snapshot IS NULL AND operation.version_revision_id IS NULL
                AND operation.created_at >= $9 AND action.phase='applying' AND state.status='active'
                AND state.degraded=0 AND state.document_sequence=operation.base_document_sequence LIMIT 1`,
            [operationId, input.target.documentId, input.target.workspaceId, input.target.path, input.target.userId,
              casVersion, runGeneration, `proposal-action:${operationId}`, startedAt]);
            if (!operation) return false;
            verifiedSequence = Number(operation.document_sequence);
            return true;
          } finally { await database.close(); }
        },
        interrupt: operationId => crashAtBoundary({ point: input.point, operationId, mutations: 0,
          acknowledged: false, historyCaptured: false, documentSequence: verifiedSequence }),
      });
    } else {
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
          return crashAtBoundary(evidence);
        } });
    }
    armed = true;
    process.send?.({ type: 'armed' });
  } finally { arming = false; }
}

async function crashAtBoundary(evidence: Record<string, unknown>): Promise<never> {
  await new Promise<void>((resolve, reject) => process.send!({ type: 'boundary', ...evidence }, error => error ? reject(error) : resolve()));
  // No graceful shutdown: pending room stores and callbacks must not flush.
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => {});
}

void main().catch(() => {
  console.error('Local proposal crash launcher refused startup.');
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
