import assert from 'node:assert/strict';
import {
  claimTeamSeatOutboxOperation,
  enqueueTeamSeatOutboxOperation,
  getTeamSeatOutboxOperation,
  recordTeamSeatOutboxOperationSuccess,
  scheduleTeamSeatOutboxRetry,
  TeamSeatOutboxError,
} from '../app/lib/license/team-seat-outbox';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const now = Date.parse('2030-01-01T00:00:00.000Z');

async function main(): Promise<void> {
await withTeamSeatTestDatabase(async (database) => {
  await seedTeamSeatOrganization(database, 'outbox-test-organization', now);
  const input = {
    organizationId: 'outbox-test-organization',
    dedupeKey: 'refresh:stable-request',
    operationKind: 'license_refresh' as const,
    request: { reason: 'seat-change', revision: 4 },
    now,
  };
  const first = await enqueueTeamSeatOutboxOperation(database, input);
  assert.equal(first.replayed, false);
  assert.equal(first.operation.status, 'pending');
  const replay = await enqueueTeamSeatOutboxOperation(database, {
    ...input,
    request: { revision: 4, reason: 'seat-change' },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation.operationId, first.operation.operationId);
  await assert.rejects(
    enqueueTeamSeatOutboxOperation(database, { ...input, request: { revision: 5 } }),
    (error) => error instanceof TeamSeatOutboxError && error.code === 'TEAM_SEAT_OUTBOX_CONFLICT',
  );
  const claimed = await claimTeamSeatOutboxOperation(database, {
    operationId: first.operation.operationId,
    allowPending: true,
    now,
  });
  assert.equal(claimed.claimed, true);
  assert.equal((await claimTeamSeatOutboxOperation(database, {
    operationId: first.operation.operationId,
    allowPending: true,
    now: now + 100,
  })).claimed, false);
  const retry = await scheduleTeamSeatOutboxRetry(database, {
    operationId: first.operation.operationId,
    errorCode: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
    error: 'temporary',
    retryAt: now + 5_000,
    now: now + 100,
  });
  assert.equal(retry.status, 'retry_wait');
  assert.equal((await claimTeamSeatOutboxOperation(database, {
    operationId: first.operation.operationId,
    allowPending: false,
    now: now + 4_999,
  })).claimed, false);
  assert.equal((await claimTeamSeatOutboxOperation(database, {
    operationId: first.operation.operationId,
    allowPending: false,
    now: now + 5_000,
  })).claimed, true);
  await recordTeamSeatOutboxOperationSuccess(database, {
    operationId: first.operation.operationId,
    response: { seatLimit: 4 },
    now: now + 5_100,
  });
  assert.equal((await getTeamSeatOutboxOperation(database, first.operation.operationId))?.status, 'succeeded');
  await assert.rejects(
    recordTeamSeatOutboxOperationSuccess(database, {
      operationId: first.operation.operationId,
      response: { seatLimit: 3 },
      now: now + 5_200,
    }),
    (error) => error instanceof TeamSeatOutboxError && error.code === 'TEAM_SEAT_OUTBOX_CONFLICT',
  );
});
console.log('team-seat-outbox-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
