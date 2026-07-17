import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pi-delegation-store-'));
process.env.DATA = dataDir;

const moduleLoader = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    const { db } = await import('../app/lib/db');
    const { piDelegations, user } = await import('../app/lib/db/schema');
    const {
      cancelRunningPiDelegation,
      claimQueuedPiDelegation,
      completeRunningPiDelegation,
      createPiDelegation,
      getOwnedPiDelegation,
      listOwnedPiDelegations,
      piDelegationToolsets,
      requeueInterruptedPiDelegations,
      requestPiDelegationCancellation,
      updatePiDelegationDelivery,
    } = await import('../app/lib/pi/delegation-store');

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
    assert.deepEqual(listed.map((record) => record.id), ['delegation-1']);

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
    await claimQueuedPiDelegation(interrupted.id);
    assert.equal(await requeueInterruptedPiDelegations(), 1);
    const recovered = await claimQueuedPiDelegation(interrupted.id);
    assert.equal(recovered?.status, 'running');
    assert.equal(recovered?.attemptCount, 2);

    const rows = await db.select().from(piDelegations);
    assert.equal(rows.length, 4);

    console.log('pi-delegation-store-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
