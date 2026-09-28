import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTestDatabase } from './helpers/pi-test-database';

const moduleLoader = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
moduleLoader._load = (request, parent, isMain) => {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
  if (request === 'server-only') return {};
  if ((request.startsWith('.') || request.startsWith('@/')) && request.endsWith('/auth')) return { auth: {} };
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  }
  if (request === '@/app/lib/agents/access') return { requireAgentAccess: async () => undefined };
  if (request === '@/app/lib/pi/session-workspace-context') return {
    resolveAgentSessionWorkspaceForUser: async () => ({
      organizationId: 'managed-org', workspaceId: 'managed-workspace', workspaceType: 'personal', projectId: null,
    }),
  };
  return originalLoad(request, parent, isMain);
};

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function main() {
  try {
    database = await createPiTestDatabase();
    const { db } = database;
    const { user, piSessions, piMessages, piDelegations, piDelegationSteering } = await import('../app/lib/db/schema');
    const { attachManagedSteeringBridge } = await import('../app/lib/pi/delegation-managed-steering');
    const { acceptPiDelegationSteering, markUndeliveredPiDelegationSteeringMissed } = await import('../app/lib/pi/delegation-steering');
    const { completeRunningPiDelegation } = await import('../app/lib/pi/delegation-store');
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'managed-steering@example.test',
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(piSessions).values([
      { sessionId: 'parent', userId: 'owner', agentId: 'bradley', provider: 'test', model: 'test',
        sessionKind: 'conversation', delegationDepth: 0, organizationId: 'managed-org',
        workspaceId: 'managed-workspace', workspaceType: 'personal', createdAt: now, updatedAt: now },
      { sessionId: 'child', userId: 'owner', agentId: 'research-agent', provider: 'test', model: 'test',
        sessionKind: 'delegation_worker', delegationDepth: 1, parentSessionId: 'parent', delegationId: 'task-1',
        organizationId: 'managed-org', workspaceId: 'managed-workspace', workspaceType: 'personal',
        createdAt: now, updatedAt: now },
    ]);
    const child = await db.query.piSessions.findFirst({ where: eq(piSessions.sessionId, 'child') });
    assert.ok(child);
    const insertTask = async (id: string, runOwnerId: string) => db.insert(piDelegations).values({
      id, userId: 'owner', sourceSessionId: 'parent', sourceAgentId: 'bradley',
      targetAgentId: 'research-agent', workerSessionId: 'child', workerType: 'managed',
      goal: 'Inspect a file', status: 'running', runOwnerId, runHeartbeatAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(),
    });
    await insertTask('task-1', 'owner-1');

    const listeners = new Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>();
    const queue: Array<{ id: string; clientMessageId: string; message: Extract<AgentMessage, { role: 'user' }> }> = [];
    const removed: string[] = [];
    let queueOrdinal = 0;
    const runtime = {
      agentId: 'research-agent',
      agent: {
        state: { messages: [] as AgentMessage[] },
        subscribe: (listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      },
      getStatus: () => ({ phase: 'running', canAbort: true,
        steeringQueue: queue.map(({ id, clientMessageId }) => ({ id, clientMessageId })) }),
      subscribe: () => () => undefined,
      abort: async () => undefined,
      reloadTools: async () => undefined,
      startPrompt: () => undefined,
      queueSteering: async (message: Extract<AgentMessage, { role: 'user' }>) => {
        const clientMessageId = (message as typeof message & { clientMessageId: string }).clientMessageId;
        queueOrdinal += 1;
        queue.push({ id: `sdk-queue-${queueOrdinal}`, clientMessageId, message });
      },
      removeQueuedMessage: async (id: string) => {
        removed.push(id);
        const index = queue.findIndex(item => item.id === id);
        if (index >= 0) queue.splice(index, 1);
      },
    };
    const emitTurnEnd = async () => {
      const event = { type: 'turn_end', message: { role: 'assistant' }, toolResults: [] } as unknown as AgentEvent;
      for (const listener of [...listeners]) await listener(event, new AbortController().signal);
    };
    let sequence = 0;
    const checkpointCorrection = async (message: Extract<AgentMessage, { role: 'user' }>) => {
      sequence += 1;
      await db.insert(piMessages).values({ piSessionDbId: child.id, role: 'user',
        content: JSON.stringify(message), timestamp: message.timestamp, sequence });
    };
    const receiptStatus = async (id: string) =>
      (await db.query.piDelegationSteering.findFirst({ where: eq(piDelegationSteering.id, id) }))?.status;
    const request = (id: string, runOwnerId: string) => ({
      delegationId: id, runOwnerId, userId: 'owner', sourceAgentId: 'bradley', sourceSessionId: 'parent',
      targetAgentId: 'research-agent', goal: 'Inspect a file', toolsets: ['file'],
      waitForResult: false, timeoutSeconds: 60,
    });

    const releaseFirst = attachManagedSteeringBridge(runtime, request('task-1', 'owner-1'), 'child');
    assert.equal(listeners.size, 1);
    const first = await acceptPiDelegationSteering({ delegationId: 'task-1', userId: 'owner',
      sourceSessionId: 'parent', idempotencyKey: 'managed-1', message: 'Inspect permissions too.' });
    await waitFor(() => queue.length === 1, 'Managed bridge did not enqueue the accepted correction.');
    assert.equal(queue[0].clientMessageId, first.id);
    assert.match(String(queue[0].message.content), /Inspect permissions too/u);
    assert.equal(await receiptStatus(first.id), 'claimed');
    await emitTurnEnd();
    assert.equal(await receiptStatus(first.id), 'claimed', 'SDK enqueue and turn end alone do not prove delivery');
    await checkpointCorrection(queue[0].message);
    await emitTurnEnd();
    assert.equal(await receiptStatus(first.id), 'delivered', 'a durable child message confirms delivery');
    queue.shift(); // The SDK consumed this first message.

    const second = await acceptPiDelegationSteering({ delegationId: 'task-1', userId: 'owner',
      sourceSessionId: 'parent', idempotencyKey: 'managed-2', message: 'Check a third file.' });
    await waitFor(() => queue.length === 1 && queue[0].clientMessageId === second.id,
      'Managed bridge did not enqueue the second correction.');
    const unconsumedQueueId = queue[0].id;
    await releaseFirst();
    assert.deepEqual(removed, [unconsumedQueueId],
      'release removes the unconsumed SDK entry');
    assert.equal(queue.length, 0);
    assert.equal(listeners.size, 0, 'release detaches the first bridge listener');
    assert.equal(await receiptStatus(second.id), 'claimed');
    await completeRunningPiDelegation({ id: 'task-1', resultStatus: 'ok', runOwnerId: 'owner-1' });
    assert.equal(await markUndeliveredPiDelegationSteeringMissed({ delegationId: 'task-1', userId: 'owner' }), 1);
    assert.equal(await receiptStatus(second.id), 'missed');

    await insertTask('task-2', 'owner-2');
    const releaseFollowup = attachManagedSteeringBridge(runtime, request('task-2', 'owner-2'), 'child');
    assert.equal(listeners.size, 1, 'the follow-up starts with only its own listener');
    const followup = await acceptPiDelegationSteering({ delegationId: 'task-2', userId: 'owner',
      sourceSessionId: 'parent', idempotencyKey: 'managed-followup', message: 'Summarize the result.' });
    await waitFor(() => queue.length === 1 && queue[0].clientMessageId === followup.id,
      'Follow-up bridge did not enqueue its correction.');
    await checkpointCorrection(queue[0].message);
    await emitTurnEnd();
    assert.equal(await receiptStatus(followup.id), 'delivered');
    assert.equal(await receiptStatus(second.id), 'missed', 'the previous task does not receive follow-up events');
    queue.shift();
    await releaseFollowup();
    assert.equal(listeners.size, 0);
    console.log('pi-delegation-managed-steering-integration-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    await database?.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
