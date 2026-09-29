import assert from 'node:assert/strict';
import {
  enqueueTeamSeatOutboxOperation,
  getTeamSeatOutboxOperation,
  recordTeamSeatOutboxOperationSuccess,
  TeamSeatOutboxError,
} from '../app/lib/license/team-seat-outbox';
import { initializeTeamSeatOutboxWorkerRuntime, runTeamSeatOutboxWorkerCycle } from '../app/lib/license/team-seat-outbox-worker';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    const organizationId = 'outbox-worker-test';
    await seedTeamSeatOrganization(database, organizationId, now);
    const operations = await Promise.all(['succeed', 'retry', 'terminal'].map(async (kind) => (
      enqueueTeamSeatOutboxOperation(database, {
        organizationId,
        dedupeKey: `worker:${kind}`,
        operationKind: 'license_refresh',
        request: { kind },
        now,
      })
    )));
    const result = await runTeamSeatOutboxWorkerCycle({
      database,
      now: now + 1_000,
      pendingDelayMs: 0,
      dispatchOperation: async (operation, connection) => {
        if (operation.dedupeKey === 'worker:retry') throw new Error('network unavailable');
        if (operation.dedupeKey === 'worker:terminal') {
          throw new TeamSeatOutboxError('TEAM_SEAT_OUTBOX_CONFLICT', 'persisted operation conflicts');
        }
        await recordTeamSeatOutboxOperationSuccess(connection, {
          operationId: operation.operationId,
          response: { licensed: true },
          now: now + 1_000,
        });
      },
    });
    assert.deepEqual(result, { claimed: 3, succeeded: 1, deferred: 1, failed: 1 });
    assert.equal((await getTeamSeatOutboxOperation(database, operations[0].operation.operationId))?.status, 'succeeded');
    const retry = await getTeamSeatOutboxOperation(database, operations[1].operation.operationId);
    assert.equal(retry?.status, 'retry_wait');
    assert.ok((retry?.nextAttemptAt ?? 0) > now + 1_000);
    const terminal = await getTeamSeatOutboxOperation(database, operations[2].operation.operationId);
    assert.equal(terminal?.status, 'failed');
    assert.equal(terminal?.lastErrorCode, 'TEAM_SEAT_OUTBOX_CONFLICT');
    const idle = await runTeamSeatOutboxWorkerCycle({ database, now: now + 2_000, pendingDelayMs: 0 });
    assert.equal(idle.claimed, 0);

    const historical = await Promise.all([
      ['pending', 'seat_prepare'],
      ['retry_wait', 'seat_execute'],
      ['processing', 'license_refresh'],
    ].map(async ([status, operationKind]) => {
      const entry = await enqueueTeamSeatOutboxOperation(database, {
        organizationId,
        dedupeKey: `historical:${status}`,
        operationKind: operationKind as 'seat_prepare' | 'seat_execute' | 'license_refresh',
        request: { status },
        now: now + 3_000,
      });
      if (status !== 'pending') {
        await database.run(`
          UPDATE team_seat_outbox
          SET status = $1, next_attempt_at = $2, last_attempt_at = $3
          WHERE operation_id = $4
        `, [status, now + 3_000, now - 120_000, entry.operation.operationId]);
      }
      return entry.operation.operationId;
    }));
    const previousMode = process.env.CANVAS_DEPLOYMENT_MODE;
    try {
      process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
      assert.equal(initializeTeamSeatOutboxWorkerRuntime().started, false);
      const managed = await runTeamSeatOutboxWorkerCycle({
        database,
        now: now + 4_000,
        pendingDelayMs: 0,
        dispatchOperation: async () => { throw new Error('Managed mode must not replay Community operations.'); },
      });
      assert.deepEqual(managed, { claimed: 0, succeeded: 0, deferred: 0, failed: 0 });
      for (const [index, operationId] of historical.entries()) {
        const persisted = await getTeamSeatOutboxOperation(database, operationId);
        assert.equal(persisted?.status, ['pending', 'retry_wait', 'processing'][index]);
        assert.equal(persisted?.attemptCount, 0);
      }
    } finally {
      if (previousMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
      else process.env.CANVAS_DEPLOYMENT_MODE = previousMode;
    }
    process.env.CANVAS_DEPLOYMENT_MODE = 'team';
    try {
      const resumed = await runTeamSeatOutboxWorkerCycle({
        database,
        now: now + 4_000,
        pendingDelayMs: 0,
        dispatchOperation: async (operation, connection) => {
          await recordTeamSeatOutboxOperationSuccess(connection, {
            operationId: operation.operationId,
            response: { licensed: true },
            now: now + 4_000,
          });
        },
      });
      assert.deepEqual(resumed, { claimed: 3, succeeded: 3, deferred: 0, failed: 0 });
    } finally {
      if (previousMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
      else process.env.CANVAS_DEPLOYMENT_MODE = previousMode;
    }
  });
  console.log('team-seat-outbox-worker-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
