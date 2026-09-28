import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
moduleLoader._load = function loadWithMocks(request, parent, isMain) {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    database = await createPiTestDatabase();
    const { db } = database;
    const { user, piSessions, piDelegationProgress } = await import('../app/lib/db/schema');
    const { createPiDelegation, claimQueuedPiDelegation } = await import('../app/lib/pi/delegation-store');
    const { attachManagedProgressBridge } = await import('../app/lib/pi/delegation-managed-progress');
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'managed-progress@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(piSessions).values({ sessionId: 'parent', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
      sessionKind: 'conversation', delegationDepth: 0, createdAt: now, updatedAt: now });
    await createPiDelegation({ id: 'managed-task', userId: 'owner', sourceSessionId: 'parent', sourceAgentId: 'bradley',
      workerSessionId: 'child', targetAgentId: 'research-agent', workerType: 'managed', goal: 'Inspect', toolsets: ['file'] });
    await claimQueuedPiDelegation('managed-task', 'worker-owner');

    const runtimeListeners = new Set<(event: Record<string, unknown>) => void>();
    const agentListeners = new Set<(event: Record<string, unknown>) => void>();
    const runtime = {
      agent: { subscribe: (listener: (event: Record<string, unknown>) => void) => {
        agentListeners.add(listener);
        return () => { agentListeners.delete(listener); };
      } },
      subscribe: (listener: (event: Record<string, unknown>) => void) => {
        runtimeListeners.add(listener);
        return () => { runtimeListeners.delete(listener); };
      },
    };
    const emit = (event: Record<string, unknown>) => {
      for (const listener of [...(event.type?.toString().startsWith('tool_') ? agentListeners : runtimeListeners)]) listener(event);
    };
    const release = attachManagedProgressBridge(
      runtime as unknown as Parameters<typeof attachManagedProgressBridge>[0],
      { delegationId: 'managed-task', userId: 'owner' } as Parameters<typeof attachManagedProgressBridge>[1],
    );
    emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read_file', secret: 'never-persist-me' });
    emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read_file', result: 'never-persist-me' });
    emit({ type: 'runtime_status', status: { phase: 'running', canAbort: true,
      compactionStatus: { state: 'running', attemptId: 'attempt-1', secret: 'never-persist-me' } } });
    emit({ type: 'context_compacted', attemptId: 'attempt-1', summary: 'never-persist-me' });
    emit({ type: 'runtime_status', status: { phase: 'running', canAbort: true,
      compactionStatus: { state: 'running', attemptId: 'attempt-1' } } });
    await release();
    assert.equal(runtimeListeners.size, 0);
    assert.equal(agentListeners.size, 0);
    const events = await db.select().from(piDelegationProgress).where(eq(piDelegationProgress.delegationId, 'managed-task'));
    assert.deepEqual(events.map(event => event.kind), ['tool_start', 'tool_end', 'compacting', 'resumed']);
    assert.deepEqual(events.map(event => event.revision), [1, 2, 3, 4]);
    assert.deepEqual(events.map(event => event.preview), ['read_file', 'read_file', null, null]);
    assert.ok(!JSON.stringify(events).includes('never-persist-me'));
    console.log('pi-delegation-managed-progress-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    await database?.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
