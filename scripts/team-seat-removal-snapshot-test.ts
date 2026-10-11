import assert from 'node:assert/strict';

import type { SqlConnection } from '../app/lib/db';
import { LicenseControlPlaneError } from '../app/lib/license/control-plane';
import fixtures from '../app/lib/license/fixtures/team-seat-protocol-v1.json';
import {
  parseTeamSeatSnapshotResponse,
  TEAM_SEAT_PROTOCOL_VERSION,
  type TeamSeatSnapshotRequest,
} from '../app/lib/license/team-seat-contract';
import { registerTeamMembershipSyncSignal } from '../app/lib/license/team-membership-sync-signal';
import {
  getLatestTeamMembershipSnapshotOperation,
  getTeamMembershipSyncState,
  getTeamSeatOutboxOperation,
  recordTeamSeatSnapshotAcknowledgement,
  TeamSeatOutboxError,
  type TeamSeatOutboxOperation,
} from '../app/lib/license/team-seat-outbox';
import { classifyTeamSeatOutboxFailure } from '../app/lib/license/team-seat-outbox-errors';
import { runTeamSeatOutboxWorkerCycle } from '../app/lib/license/team-seat-outbox-worker';
import { assertMemberSeatRemovalSnapshotReady } from '../app/lib/license/team-seat-removal-snapshot';
import {
  adoptActiveTeamMembership,
  transitionTeamMembership,
  type TeamMembership,
} from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const now = Date.parse('2030-01-01T00:00:00.000Z');
let signals: Array<{ forceReport?: boolean } | undefined> = [];

async function removalFixture(database: SqlConnection, organizationId: string): Promise<{
  operation: TeamSeatOutboxOperation;
  members: TeamMembership[];
}> {
  await seedTeamSeatOrganization(database, organizationId, now);
  await adoptActiveTeamMembership(database, {
    organizationId, userId: `owner-${organizationId}`, role: 'owner', source: 'first_owner', now,
  });
  const members: TeamMembership[] = [];
  for (const index of [1, 2, 3]) {
    const userId = `${organizationId}-member-${index}`;
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, $1, $2, 1, 'user', $3, $3)
    `, [userId, `${userId}@example.test`, now]);
    members.push(await adoptActiveTeamMembership(database, {
      organizationId, userId, role: 'member', source: 'migration', now,
    }));
  }
  await transitionTeamMembership(database, {
    organizationId, membershipId: members[0].id, expectedStatus: 'active', toStatus: 'removed',
    actorUserId: `owner-${organizationId}`, source: 'local_admin', seatOperationType: 'member_remove',
    enqueueSeatReduction: true, now: now + 1,
  });
  const row = await database.get(`
    SELECT operation_id FROM team_seat_outbox
    WHERE organization_id = $1 AND operation_kind = 'seat_prepare' AND operation_type = 'member_remove'
    ORDER BY created_at ASC, id ASC LIMIT 1
  `, [organizationId]) as { operation_id: string } | undefined;
  assert.ok(row);
  const operation = await getTeamSeatOutboxOperation(database, row.operation_id);
  assert.ok(operation);
  assert.equal(JSON.parse(operation.requestJson).desiredQuantity, 3);
  return { operation, members };
}

async function acknowledgeCurrentSnapshot(database: SqlConnection, organizationId: string): Promise<void> {
  const operation = await getLatestTeamMembershipSnapshotOperation(database, organizationId);
  assert.ok(operation);
  const request = JSON.parse(operation.requestJson) as TeamSeatSnapshotRequest;
  const response = parseTeamSeatSnapshotResponse(structuredClone(fixtures.positive.snapshotResponse));
  response.snapshot = {
    ...response.snapshot,
    ...request,
    receivedAt: new Date(now + 10).toISOString(),
    reconciledAt: new Date(now + 10).toISOString(),
    driftStatus: 'observed_below_approved',
  };
  response.observedQuantity = request.observedQuantity;
  response.approvedQuantity = 4;
  response.billedQuantity = 0;
  response.licensedQuantity = 4;
  response.expectedLicensedQuantity = 4;
  response.nextReportAt = new Date(now + 60_000).toISOString();
  await recordTeamSeatSnapshotAcknowledgement(database, {
    organizationId, operationId: operation.operationId, response, now: now + 10,
  });
}

async function expectsSnapshotWait(database: SqlConnection, operation: TeamSeatOutboxOperation, at = now + 100): Promise<void> {
  const before = await getTeamMembershipSyncState(database, operation.organizationId);
  signals = [];
  await assert.rejects(assertMemberSeatRemovalSnapshotReady(database, operation, at), (error: unknown) => {
    assert.ok(error instanceof LicenseControlPlaneError);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'TEAM_SEAT_MEMBERSHIP_SYNC_PENDING');
    assert.equal(error.retryAfterSeconds, 2);
    assert.deepEqual(classifyTeamSeatOutboxFailure(error), {
      code: error.code, message: error.message, terminal: false, retryAfterMs: 2_000,
    });
    return true;
  });
  assert.equal(signals.length, 1);
  assert.notEqual(signals[0]?.forceReport, true, 'The barrier must never request a forced new snapshot revision.');
  assert.deepEqual(await getTeamMembershipSyncState(database, operation.organizationId), before,
    'Waiting must preserve the persisted snapshot and acknowledgement.');
}

async function snapshotReadinessScenarios(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const waiting = await removalFixture(database, 'snapshot-removal-waiting');
    await expectsSnapshotWait(database, waiting.operation);

    const newer = await removalFixture(database, 'snapshot-removal-newer-local');
    await acknowledgeCurrentSnapshot(database, newer.operation.organizationId);
    await transitionTeamMembership(database, {
      organizationId: newer.operation.organizationId, membershipId: newer.members[1].id,
      expectedStatus: 'active', toStatus: 'removed', source: 'local_admin', seatOperationType: 'member_remove',
      enqueueSeatReduction: true, now: now + 20,
    });
    const newerState = await getTeamMembershipSyncState(database, newer.operation.organizationId);
    assert.equal(newerState?.currentRevision, 2);
    assert.equal(newerState?.acknowledgedRevision, 1);
    await expectsSnapshotWait(database, newer.operation);

    const wrongHash = await removalFixture(database, 'snapshot-removal-wrong-hash');
    await acknowledgeCurrentSnapshot(database, wrongHash.operation.organizationId);
    await database.run('UPDATE team_membership_sync_state SET acknowledged_snapshot_hash = $1 WHERE organization_id = $2',
      ['different-snapshot-hash', wrongHash.operation.organizationId]);
    await expectsSnapshotWait(database, wrongHash.operation);

    for (const quantityField of ['control_plane_observed_quantity', 'current_observed_quantity']) {
      const mismatch = await removalFixture(database, `snapshot-removal-${quantityField}`);
      await acknowledgeCurrentSnapshot(database, mismatch.operation.organizationId);
      // Both identifiers are fixed test-owned values, never external input.
      await database.run(`UPDATE team_membership_sync_state SET ${quantityField} = 2 WHERE organization_id = $1`,
        [mismatch.operation.organizationId]);
      await expectsSnapshotWait(database, mismatch.operation);
    }

    const ready = await removalFixture(database, 'snapshot-removal-ready');
    await acknowledgeCurrentSnapshot(database, ready.operation.organizationId);
    const beforeReady = await getTeamMembershipSyncState(database, ready.operation.organizationId);
    signals = [];
    await assertMemberSeatRemovalSnapshotReady(database, ready.operation, now + 100);
    assert.equal(signals.length, 0);
    assert.deepEqual(await getTeamMembershipSyncState(database, ready.operation.organizationId), beforeReady);
    assert.equal((await getTeamSeatOutboxOperation(database, ready.operation.operationId))?.status, 'pending');

    const stale = await removalFixture(database, 'snapshot-removal-stale');
    await acknowledgeCurrentSnapshot(database, stale.operation.organizationId);
    await expectsSnapshotWait(database, stale.operation, now + 60_000);
    await database.run('UPDATE team_membership_sync_state SET acknowledged_at = $1 WHERE organization_id = $2',
      [now + 200, stale.operation.organizationId]);
    await expectsSnapshotWait(database, stale.operation, now + 100);
    await database.run(`
      UPDATE team_membership_sync_state SET acknowledged_at = $1, next_report_at = $2 WHERE organization_id = $3
    `, [now - 15 * 60_000, now + 60_000, stale.operation.organizationId]);
    await expectsSnapshotWait(database, stale.operation, now);

    const unsafe = await removalFixture(database, 'snapshot-removal-unsafe-target');
    await acknowledgeCurrentSnapshot(database, unsafe.operation.organizationId);
    const addedUserId = `${unsafe.operation.organizationId}-additional-member`;
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, $1, $2, 1, 'user', $3, $3)
    `, [addedUserId, `${addedUserId}@example.test`, now + 20]);
    await adoptActiveTeamMembership(database, {
      organizationId: unsafe.operation.organizationId, userId: addedUserId,
      role: 'member', source: 'migration', now: now + 20,
    });
    signals = [];
    await assert.rejects(assertMemberSeatRemovalSnapshotReady(database, unsafe.operation, now + 100), (error: unknown) => (
      error instanceof TeamSeatOutboxError && error.code === 'TEAM_SEAT_OUTBOX_CONFLICT'
      && error.message.includes('current active membership count')
      && classifyTeamSeatOutboxFailure(error).terminal
    ));
    assert.equal(signals.length, 0, 'An unsafe reduction must fail without scheduling snapshot work.');
    await assert.rejects(assertMemberSeatRemovalSnapshotReady(database,
      { ...ready.operation, operationType: 'member_create' }, now + 100), TeamSeatOutboxError);
  });
}

async function snapshotWorkerRetryIsBounded(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const { operation } = await removalFixture(database, 'snapshot-removal-bounded-retry');
    await database.run('UPDATE team_seat_outbox SET max_attempts = 2 WHERE operation_id = $1', [operation.operationId]);
    const dispatchOperation = async (claimed: TeamSeatOutboxOperation, connection: Pick<SqlConnection, 'get' | 'all'>) => {
      await assertMemberSeatRemovalSnapshotReady(connection, claimed, now + 100);
      throw new Error('An unacknowledged removal must not reach a Control Plane preparation.');
    };
    const first = await runTeamSeatOutboxWorkerCycle({
      database, now: now + 100, pendingDelayMs: 0, dispatchOperation,
    });
    assert.deepEqual(first, { claimed: 1, succeeded: 0, deferred: 1, failed: 0 });
    const retry = await getTeamSeatOutboxOperation(database, operation.operationId);
    assert.equal(retry?.status, 'retry_wait');
    assert.equal(retry?.attemptCount, 1);
    assert.equal(retry?.nextAttemptAt, now + 2_100);
    assert.equal(retry?.lastErrorCode, 'TEAM_SEAT_MEMBERSHIP_SYNC_PENDING');
    const early = await runTeamSeatOutboxWorkerCycle({
      database, now: now + 2_099, pendingDelayMs: 0, dispatchOperation,
    });
    assert.equal(early.claimed, 0);
    const exhausted = await runTeamSeatOutboxWorkerCycle({
      database, now: now + 2_100, pendingDelayMs: 0, dispatchOperation,
    });
    assert.deepEqual(exhausted, { claimed: 1, succeeded: 0, deferred: 0, failed: 1 });
    const failed = await getTeamSeatOutboxOperation(database, operation.operationId);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.attemptCount, 2);
    assert.equal(failed?.nextAttemptAt, null);
    assert.equal(failed?.responseJson, null);
    assert.equal(failed?.lastErrorCode, 'TEAM_SEAT_MEMBERSHIP_SYNC_PENDING');
    assert.deepEqual(await database.all(`
      SELECT operation_id FROM team_seat_outbox WHERE organization_id = $1 AND operation_kind = 'seat_execute'
    `, [operation.organizationId]), []);
    const actualReconciliationFailure = new LicenseControlPlaneError(
      'Observed membership and licensed Seat quantity must be in sync before a Seat change',
      409, 'TEAM_SEAT_RECONCILIATION_REQUIRED', false,
    );
    assert.equal(classifyTeamSeatOutboxFailure(actualReconciliationFailure).terminal, true,
      'The local wait exception must not make general Control Plane policy failures retryable.');
  });
}

async function main(): Promise<void> {
  const previousMode = process.env.CANVAS_DEPLOYMENT_MODE;
  process.env.CANVAS_DEPLOYMENT_MODE = 'community';
  registerTeamMembershipSyncSignal((options) => { signals.push(options); });
  try {
    assert.equal(TEAM_SEAT_PROTOCOL_VERSION, fixtures.protocolVersion);
    await snapshotReadinessScenarios();
    await snapshotWorkerRetryIsBounded();
    console.log('Removal snapshot barrier passed: pending/newer acknowledgements, hash/count consistency, freshness, unsafe target rejection and bounded worker retry.');
  } finally {
    registerTeamMembershipSyncSignal(null);
    if (previousMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
    else process.env.CANVAS_DEPLOYMENT_MODE = previousMode;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
