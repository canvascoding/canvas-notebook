import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-delegation-store-'));
process.env.DATA = dataDir;

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
let testDatabase: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
  if (testDatabase && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request))) {
    return testDatabase;
  }
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    testDatabase = await createPiTestDatabase();
    const { db } = testDatabase;
    const { piDelegations, piSessions, user } = await import('../app/lib/db/schema');
    const {
      cancelRunningPiDelegation,
      claimPiDelegationDelivery,
      claimQueuedPiDelegation,
      completeRunningPiDelegation,
      createPiDelegation,
      getOwnedPiDelegation,
      listOwnedPiDelegations,
      piDelegationToolsets,
      recoverInterruptedPiDelegationDeliveries,
      failInterruptedPiDelegations,
      requestPiDelegationCancellation,
      updatePiDelegationDelivery,
    } = await import('../app/lib/pi/delegation-store');
    const { getDelegatedWorkerToolsets, requireDelegationSource, DelegationPolicyError } = await import('../app/lib/pi/delegation-policy');

    const now = new Date();
    await db.insert(user).values([
      {
        id: 'delegation-user-1',
        name: 'Delegation User One',
        email: 'delegation-one@example.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'delegation-user-2',
        name: 'Delegation User Two',
        email: 'delegation-two@example.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(piSessions).values({
      sessionId: 'reused-managed-session',
      userId: 'delegation-user-1',
      agentId: 'research-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: 'off',
      channelId: 'app',
      sessionKind: 'delegation_worker',
      parentSessionId: 'source-session-1',
      delegationId: 'delegation-reused-managed-session',
      delegationDepth: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(piSessions).values([
      { sessionId: 'source-session-1', userId: 'delegation-user-1', agentId: 'bradley',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 0,
        createdAt: now, updatedAt: now },
      { sessionId: 'invalid-worker-parent', userId: 'delegation-user-1', agentId: 'bradley',
        provider: 'test-provider', model: 'test-model', sessionKind: 'delegation_worker', delegationDepth: 1,
        createdAt: now, updatedAt: now },
      { sessionId: 'invalid-depth-parent', userId: 'delegation-user-1', agentId: 'bradley',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 1,
        createdAt: now, updatedAt: now },
      { sessionId: 'invalid-agent-parent', userId: 'delegation-user-1', agentId: 'research-agent',
        provider: 'test-provider', model: 'test-model', sessionKind: 'conversation', delegationDepth: 0,
        createdAt: now, updatedAt: now },
    ]);
    assert.equal((await requireDelegationSource({
      userId: 'delegation-user-1', sourceSessionId: 'source-session-1', sourceAgentId: 'bradley',
    })).sourceAgentId, 'bradley');
    for (const sourceSessionId of ['invalid-worker-parent', 'invalid-depth-parent', 'invalid-agent-parent']) {
      await assert.rejects(requireDelegationSource({ userId: 'delegation-user-1', sourceSessionId }),
        (error) => error instanceof DelegationPolicyError && error.code === 'DELEGATION_NOT_ALLOWED');
    }
    await assert.rejects(requireDelegationSource({
      userId: 'delegation-user-2', sourceSessionId: 'source-session-1',
    }), (error) => error instanceof DelegationPolicyError && error.code === 'SOURCE_SESSION_NOT_FOUND');

    await createPiDelegation({
      id: 'delegation-reused-managed-session',
      userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1',
      sourceAgentId: 'canvas-agent',
      workerSessionId: 'reused-managed-session',
      workerType: 'managed',
      targetAgentId: 'research-agent',
      goal: 'Apply a reduced toolset to an existing managed session',
      toolsets: ['web'],
    });
    assert.deepEqual(await getDelegatedWorkerToolsets({
      userId: 'delegation-user-1',
      sessionId: 'reused-managed-session',
    }), [], 'a queued managed task must not activate tools before the worker starts');
    await claimQueuedPiDelegation('delegation-reused-managed-session');
    assert.deepEqual(await getDelegatedWorkerToolsets({
      userId: 'delegation-user-1', sessionId: 'reused-managed-session',
    }), ['web']);
    await completeRunningPiDelegation({ id: 'delegation-reused-managed-session', resultStatus: 'ok', resultText: 'First task complete.' });
    assert.deepEqual(await getDelegatedWorkerToolsets({
      userId: 'delegation-user-1', sessionId: 'reused-managed-session',
    }), [], 'an idle managed worker must not retain its previous toolset');
    await createPiDelegation({
      id: 'delegation-reused-managed-followup', userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1', sourceAgentId: 'canvas-agent',
      workerSessionId: 'reused-managed-session', requestedSessionId: 'reused-managed-session',
      workerType: 'managed', targetAgentId: 'research-agent',
      goal: 'Continue with file access only', toolsets: ['file'],
    });
    assert.deepEqual(await getDelegatedWorkerToolsets({
      userId: 'delegation-user-1', sessionId: 'reused-managed-session',
    }), [], 'queued follow-up permissions stay inactive');
    await claimQueuedPiDelegation('delegation-reused-managed-followup');
    assert.deepEqual(await getDelegatedWorkerToolsets({
      userId: 'delegation-user-1', sessionId: 'reused-managed-session',
    }), ['file'], 'a running follow-up uses its current toolset, not the original delegation');
    await completeRunningPiDelegation({ id: 'delegation-reused-managed-followup', resultStatus: 'ok', resultText: 'Follow-up complete.' });
    assert.deepEqual(await getDelegatedWorkerToolsets({
      userId: 'delegation-user-1', sessionId: 'reused-managed-session',
    }), [], 'completed follow-up permissions must return to the idle state');

    const concurrentManaged = await Promise.allSettled(['first', 'second'].map((suffix) => createPiDelegation({
      id: `delegation-concurrent-${suffix}`, userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1', sourceAgentId: 'canvas-agent',
      workerSessionId: 'concurrent-managed-worker', requestedSessionId: 'concurrent-managed-worker',
      workerType: 'managed', targetAgentId: 'research-agent',
      goal: `Concurrent task ${suffix}`, toolsets: ['file'],
    })));
    const acceptedConcurrent = concurrentManaged.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createPiDelegation>>> => result.status === 'fulfilled');
    assert.equal(acceptedConcurrent.length, 1, 'only one queued or running task may own a managed worker session');
    await claimQueuedPiDelegation(acceptedConcurrent[0].value.id);
    await completeRunningPiDelegation({ id: acceptedConcurrent[0].value.id, resultStatus: 'ok', resultText: 'Concurrent winner complete.' });
    const afterConcurrent = await createPiDelegation({
      id: 'delegation-after-concurrent', userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1', sourceAgentId: 'canvas-agent',
      workerSessionId: 'concurrent-managed-worker', requestedSessionId: 'concurrent-managed-worker',
      workerType: 'managed', targetAgentId: 'research-agent',
      goal: 'Continue after the first task completes', toolsets: ['web'],
    });
    assert.equal(afterConcurrent.status, 'queued');

    const created = await createPiDelegation({
      id: 'delegation-1',
      userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1',
      sourceAgentId: 'canvas-agent',
      workerSessionId: 'worker-session-1',
      workerType: 'ephemeral',
      goal: 'Inspect the repository',
      context: 'Focus on delegation code.',
      workerRole: 'reviewer',
      toolsets: ['file', 'terminal'],
    });
    assert.equal(created.status, 'queued');
    assert.equal(created.deliveryStatus, 'pending');
    assert.deepEqual(piDelegationToolsets(created), ['file', 'terminal']);
    assert.equal(await getOwnedPiDelegation(created.id, 'delegation-user-2'), null);

    const listed = await listOwnedPiDelegations({
      userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1',
    });
    assert.deepEqual(new Set(listed.map((record) => record.id)), new Set([
      'delegation-reused-managed-session',
      'delegation-reused-managed-followup',
      acceptedConcurrent[0].value.id,
      'delegation-after-concurrent',
      'delegation-1',
    ]));

    const [firstClaim, duplicateClaim] = await Promise.all([
      claimQueuedPiDelegation(created.id),
      claimQueuedPiDelegation(created.id),
    ]);
    assert.equal([firstClaim, duplicateClaim].filter(Boolean).length, 1);
    const claimed = firstClaim ?? duplicateClaim;
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.attemptCount, 1);

    const completed = await completeRunningPiDelegation({
      id: created.id,
      resultStatus: 'ok',
      resultText: 'Repository inspection complete.',
    });
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.resultText, 'Repository inspection complete.');
    assert.ok(completed?.completedAt instanceof Date);

    const delivered = await updatePiDelegationDelivery({
      id: created.id,
      status: 'delivered',
    });
    assert.equal(delivered?.deliveryStatus, 'delivered');
    assert.ok(delivered?.deliveredAt instanceof Date);
    assert.equal(delivered?.resultText, 'Repository inspection complete.');

    const queuedCancellation = await createPiDelegation({
      id: 'delegation-cancel-queued',
      userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1',
      sourceAgentId: 'canvas-agent',
      workerSessionId: 'worker-session-cancel-queued',
      workerType: 'managed',
      targetAgentId: 'research-agent',
      goal: 'Cancel before start',
      toolsets: [],
    });
    const cancelledQueued = await requestPiDelegationCancellation(
      queuedCancellation.id,
      'delegation-user-1',
    );
    assert.equal(cancelledQueued?.status, 'cancelled');
    assert.equal(cancelledQueued?.deliveryStatus, 'skipped');

    const runningCancellation = await createPiDelegation({
      id: 'delegation-cancel-running',
      userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1',
      sourceAgentId: 'canvas-agent',
      workerSessionId: 'worker-session-cancel-running',
      workerType: 'ephemeral',
      goal: 'Cancel while running',
      toolsets: ['file'],
    });
    await claimQueuedPiDelegation(runningCancellation.id);
    const cancellationRequested = await requestPiDelegationCancellation(
      runningCancellation.id,
      'delegation-user-1',
    );
    assert.equal(cancellationRequested?.status, 'running');
    assert.ok(cancellationRequested?.cancelRequestedAt instanceof Date);
    const cancelledRunning = await cancelRunningPiDelegation(
      runningCancellation.id,
      'Delegated task was cancelled.',
    );
    assert.equal(cancelledRunning?.status, 'cancelled');

    const interrupted = await createPiDelegation({
      id: 'delegation-interrupted',
      userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1',
      sourceAgentId: 'canvas-agent',
      workerSessionId: 'worker-session-interrupted',
      workerType: 'ephemeral',
      goal: 'Recover after restart',
      toolsets: ['file'],
    });
    await claimQueuedPiDelegation(interrupted.id, 'crashed-process');
    await db.update(piDelegations).set({ runHeartbeatAt: new Date(1) }).where((await import('drizzle-orm')).eq(piDelegations.id, interrupted.id));
    const failedAfterRestart = await failInterruptedPiDelegations();
    assert.equal(failedAfterRestart.length, 1);
    assert.equal(failedAfterRestart[0].status, 'failed');
    assert.match(failedAfterRestart[0].errorText || '', /interrupted by a process restart/u);
    assert.equal(await claimQueuedPiDelegation(interrupted.id), null, 'an interrupted worker must never replay');

    const interruptedDelivery = await createPiDelegation({
      id: 'delegation-interrupted-delivery',
      userId: 'delegation-user-1',
      sourceSessionId: 'source-session-1',
      sourceAgentId: 'canvas-agent',
      workerSessionId: 'worker-session-interrupted-delivery',
      workerType: 'ephemeral',
      goal: 'Recover completion delivery',
      toolsets: ['file'],
    });
    await claimQueuedPiDelegation(interruptedDelivery.id);
    await completeRunningPiDelegation({
      id: interruptedDelivery.id,
      resultStatus: 'ok',
      resultText: 'Ready for delivery.',
    });
    assert.equal((await claimPiDelegationDelivery(interruptedDelivery.id, 'crashed-delivery'))?.deliveryStatus, 'delivering');
    await db.update(piDelegations).set({ deliveryHeartbeatAt: new Date(1) }).where((await import('drizzle-orm')).eq(piDelegations.id, interruptedDelivery.id));
    assert.equal(await recoverInterruptedPiDelegationDeliveries(), 1);
    const recoveredDelivery = await getOwnedPiDelegation(interruptedDelivery.id, 'delegation-user-1');
    assert.equal(recoveredDelivery?.deliveryStatus, 'skipped');
    assert.match(recoveredDelivery?.deliveryErrorText ?? '', /receipt is uncertain/);

    const rows = await db.select().from(piDelegations);
    assert.equal(rows.length, 9);

    console.log('pi-delegation-store-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    await testDatabase?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
