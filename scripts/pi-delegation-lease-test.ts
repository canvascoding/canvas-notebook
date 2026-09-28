import assert from 'node:assert/strict';
import Module from 'node:module';

import { eq } from 'drizzle-orm';

import { createPiTestDatabase } from './helpers/pi-test-database';

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>>;
moduleLoader._load = function loadWithTestDatabase(request, parent, isMain) {
  if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) {
    return testDatabase;
  }
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-agent-core') return {};
  if (request === '@/app/lib/pi/session-workspace-context') return {};
  if (request === '@earendil-works/pi-ai' || request === '@earendil-works/pi-ai/compat') {
    return { registerBuiltInApiProviders: () => undefined, getProviders: () => [], getModels: () => [] };
  }
  if (request === '@earendil-works/pi-ai/oauth') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  let recoveryDispatcher: import('../app/lib/pi/delegation-dispatcher').PiDelegationDispatcher | null = null;
  try {
    testDatabase = await createPiTestDatabase();
    const { db } = testDatabase;
    const { piDelegations, piDelegationSteering, piMessages, piSessions, user } = await import('../app/lib/db/schema');
    const {
      claimQueuedPiDelegation,
      cancelRunningPiDelegation,
      completeRunningPiDelegation,
      createPiDelegation,
      failInterruptedPiDelegations,
      getPiDelegation,
      heartbeatOwnedPiDelegations,
      listStaleRunningPiDelegations,
      requestPiDelegationCancellation,
      updateRunningPiDelegationWorkerSession,
    } = await import('../app/lib/pi/delegation-store');
    const { PiDelegationDispatcher } = await import('../app/lib/pi/delegation-dispatcher');

    const now = new Date();
    await db.insert(user).values({
      id: 'lease-user', name: 'Lease User', email: 'lease-user@example.test',
      emailVerified: true, createdAt: now, updatedAt: now,
    });
    const create = (id: string) => createPiDelegation({
      id, userId: 'lease-user', sourceSessionId: 'lease-parent', sourceAgentId: 'bradley',
      workerSessionId: `lease-worker-${id}`, workerType: 'ephemeral', goal: `Run ${id}`, toolsets: ['file'],
    });

    // Two dispatchers can share the database. A fresh owner must retain its
    // running row even when the other process starts its recovery sweep.
    await create('healthy');
    const healthy = await claimQueuedPiDelegation('healthy', 'owner-a');
    assert.equal(healthy?.runOwnerId, 'owner-a');
    assert.equal(healthy?.attemptCount, 1);
    assert.equal(await claimQueuedPiDelegation('healthy', 'owner-b'), null);
    const otherOwnerHeartbeat = await heartbeatOwnedPiDelegations({
      runOwnerId: 'owner-b', runningIds: ['healthy'], deliveringIds: [],
    });
    assert.deepEqual(otherOwnerHeartbeat.runningIds, []);
    const ownerHeartbeat = await heartbeatOwnedPiDelegations({
      runOwnerId: 'owner-a', runningIds: ['healthy'], deliveringIds: [],
    });
    assert.deepEqual(ownerHeartbeat.runningIds, ['healthy']);
    assert.deepEqual(await listStaleRunningPiDelegations(), []);
    assert.deepEqual(await failInterruptedPiDelegations(), []);
    assert.equal((await getPiDelegation('healthy'))?.status, 'running');
    assert.equal(await completeRunningPiDelegation({
      id: 'healthy', resultStatus: 'ok', resultText: 'Wrong owner', runOwnerId: 'owner-b',
    }), null);

    // A stop requested by another process is visible to the run owner. A
    // completion that read the old row must still lose the database race.
    await create('remote-stop');
    await claimQueuedPiDelegation('remote-stop', 'owner-a');
    await requestPiDelegationCancellation('remote-stop', 'lease-user');
    const stopHeartbeat = await heartbeatOwnedPiDelegations({
      runOwnerId: 'owner-a', runningIds: ['remote-stop'], deliveringIds: [],
    });
    assert.deepEqual(stopHeartbeat.cancelRequestedIds, ['remote-stop']);
    assert.equal(await completeRunningPiDelegation({
      id: 'remote-stop', resultStatus: 'ok', resultText: 'Too late', runOwnerId: 'owner-a',
    }), null);
    assert.equal((await getPiDelegation('remote-stop'))?.status, 'running');
    assert.equal((await cancelRunningPiDelegation('remote-stop', 'Stopped.', 'owner-a'))?.status, 'cancelled');

    // A crashed owner loses its lease. The task becomes terminal without a
    // second claim or replay, and its late callback cannot overwrite failure.
    await db.update(piDelegations).set({ runHeartbeatAt: new Date(1) })
      .where(eq(piDelegations.id, 'healthy'));
    assert.deepEqual((await listStaleRunningPiDelegations()).map((row) => row.id), ['healthy']);
    assert.equal(await completeRunningPiDelegation({
      id: 'healthy', resultStatus: 'ok', resultText: 'Late owner result', runOwnerId: 'owner-a',
    }), null, 'an expired owner must not finalize before the recovery sweep');
    const failed = await failInterruptedPiDelegations();
    assert.deepEqual(failed.map((row) => row.id), ['healthy']);
    assert.equal(failed[0].status, 'failed');
    assert.equal(await claimQueuedPiDelegation('healthy', 'owner-b'), null, 'a crashed run must never replay');
    assert.equal(await completeRunningPiDelegation({
      id: 'healthy', resultStatus: 'ok', resultText: 'Late owner result', runOwnerId: 'owner-a',
    }), null);
    assert.equal(await updateRunningPiDelegationWorkerSession('healthy', 'different-session', 'owner-a'), null);
    assert.equal((await getPiDelegation('healthy'))?.resultText, null);

    // Old rows without a run owner cannot prove whether another process is
    // still alive. A new process must leave them alone instead of guessing.
    await create('legacy');
    await claimQueuedPiDelegation('legacy');
    assert.deepEqual(await failInterruptedPiDelegations(), []);
    assert.equal((await getPiDelegation('legacy'))?.status, 'running');

    // Recovery may use a persisted final assistant response as proof of a
    // completed run. An intermediate assistant message is insufficient.
    for (const id of ['persisted-final', 'persisted-partial', 'crash-stop']) {
      await create(id);
      await claimQueuedPiDelegation(id, 'owner-a');
      await db.update(piDelegations).set({ runHeartbeatAt: new Date(1) })
        .where(eq(piDelegations.id, id));
      const [session] = await db.insert(piSessions).values({
        sessionId: `lease-worker-${id}`, userId: 'lease-user', agentId: 'bradley',
        provider: 'test', model: 'test', sessionKind: 'delegation_worker',
        parentSessionId: 'lease-parent', delegationId: id, delegationDepth: 1,
        createdAt: now, updatedAt: now,
      }).returning();
      await db.insert(piMessages).values([
        {
          piSessionDbId: session.id, role: 'user', sequence: 1, timestamp: 1,
          content: JSON.stringify({ role: 'user', content: `Delegation task ID: ${id}`, timestamp: 1 }),
        },
        {
          piSessionDbId: session.id, role: 'assistant', sequence: 2, timestamp: 2,
          content: JSON.stringify({
            role: 'assistant', content: [{ type: 'text', text: `${id} response` }],
            stopReason: id === 'persisted-partial' ? 'toolUse' : 'stop', timestamp: 2,
          }),
        },
      ]);
    }
    await requestPiDelegationCancellation('crash-stop', 'lease-user');
    await db.insert(piDelegationSteering).values(
      ['persisted-final', 'persisted-partial', 'crash-stop'].map((id) => ({
        id: `steer-${id}`, delegationId: id, userId: 'lease-user',
        sourceSessionId: 'lease-parent', runOwnerId: 'owner-a',
        idempotencyKey: `key-${id}`, message: 'Check another file.',
        status: id === 'persisted-partial' ? 'claimed' : 'accepted',
        createdAt: now, updatedAt: now,
      })),
    );
    let replayCount = 0;
    const delivered: string[] = [];
    recoveryDispatcher = new PiDelegationDispatcher({
      maxConcurrency: 1,
      pollIntervalMs: 60_000,
      recoverInterrupted: true,
      startDelegatedRunFn: async () => {
        replayCount += 1;
        throw new Error('A recovered delegation must not run again.');
      },
      deliverCompletionFn: async (record) => { delivered.push(record.id); },
    });
    await recoveryDispatcher.initialize();
    const final = await getPiDelegation('persisted-final');
    const partial = await getPiDelegation('persisted-partial');
    const crashStop = await getPiDelegation('crash-stop');
    assert.equal(final?.status, 'completed');
    assert.equal(final?.resultText, 'persisted-final response');
    assert.equal(final?.attemptCount, 1);
    assert.equal(partial?.status, 'failed');
    assert.equal(partial?.resultText, null);
    assert.equal(partial?.attemptCount, 1);
    assert.equal(crashStop?.status, 'cancelled');
    assert.equal(crashStop?.deliveryStatus, 'delivered');
    assert.equal(crashStop?.resultText, null);
    assert.equal(delivered.includes('crash-stop'), true);
    const steering = await db.select().from(piDelegationSteering);
    assert.deepEqual(steering.map((receipt) => receipt.status), ['missed', 'missed', 'missed']);
    assert.equal(replayCount, 0);
    assert.equal(new Set(delivered).size, delivered.length, 'each recovered terminal result is delivered once');

    console.log('pi-delegation-lease-test: ok');
  } finally {
    recoveryDispatcher?.stop();
    moduleLoader._load = originalLoad;
    await testDatabase?.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
