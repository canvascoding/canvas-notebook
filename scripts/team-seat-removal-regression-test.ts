import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { SqlConnection } from '../app/lib/db';
import { LicenseControlPlaneError } from '../app/lib/license/control-plane';
import fixtures from '../app/lib/license/fixtures/team-seat-protocol-v1.json';
import {
  createTeamSeatExecuteRequest,
  createTeamSeatPrepareRequest,
  parseTeamSeatPrepareResponse,
  parseTeamSeatSnapshotResponse,
  type TeamSeatChangeType,
  type TeamSeatExecuteResponse,
  type TeamSeatPrepareResponse,
  type TeamSeatSnapshotRequest,
} from '../app/lib/license/team-seat-contract';
import {
  claimDueTeamSeatWorkOperations,
  enqueueTeamSeatOutboxOperation,
  getLatestTeamMembershipSnapshotOperation,
  getTeamMembershipSyncState,
  getTeamSeatOutboxOperation,
  recordTeamSeatOutboxOperationSuccess,
  recordTeamSeatSnapshotAcknowledgement,
  scheduleTeamSeatOutboxRetry,
  type TeamSeatOutboxOperation,
} from '../app/lib/license/team-seat-outbox';
import { runTeamSeatOutboxWorkerCycle } from '../app/lib/license/team-seat-outbox-worker';
import { assertMemberSeatRemovalSnapshotReady } from '../app/lib/license/team-seat-removal-snapshot';
import {
  assertMemberSeatReductionReadyForExecution,
  MembershipOrchestratorError,
  recordDirectMembershipSeatExecutionApplied,
  recordDirectMembershipSeatPreparation,
} from '../app/lib/organization/membership-orchestrator';
import {
  adoptActiveTeamMembership,
  getActiveTeamMembershipProjection,
  transitionTeamMembership,
  type TeamMembership,
} from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const now = Date.parse('2030-01-01T00:00:00.000Z');

async function seedRemovalOrganization(database: SqlConnection, organizationId: string): Promise<TeamMembership[]> {
  await seedTeamSeatOrganization(database, organizationId, now);
  await adoptActiveTeamMembership(database, {
    organizationId,
    userId: `owner-${organizationId}`,
    role: 'owner',
    source: 'first_owner',
    now,
  });
  const members: TeamMembership[] = [];
  for (const index of [1, 2, 3]) {
    const userId = `${organizationId}-member-${index}`;
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, $1, $2, 1, 'user', $3, $3)
    `, [userId, `${userId}@example.test`, now]);
    members.push(await adoptActiveTeamMembership(database, {
      organizationId,
      userId,
      role: 'member',
      source: 'migration',
      now,
    }));
  }
  assert.equal((await getActiveTeamMembershipProjection(database, organizationId)).observedQuantity, 4);
  return members;
}

async function queueRemoval(
  database: SqlConnection,
  membership: TeamMembership,
  removedAt: number,
): Promise<TeamSeatOutboxOperation> {
  await transitionTeamMembership(database, {
    organizationId: membership.organizationId,
    membershipId: membership.id,
    expectedStatus: 'active',
    toStatus: 'removed',
    actorUserId: `owner-${membership.organizationId}`,
    source: 'local_admin',
    seatOperationType: 'member_remove',
    enqueueSeatReduction: true,
    now: removedAt,
  });
  const row = await database.get(`
    SELECT operation_id
    FROM team_seat_outbox
    WHERE membership_id = $1 AND operation_type = 'member_remove'
      AND operation_kind = 'seat_prepare'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [membership.id]) as { operation_id: string } | undefined;
  assert.ok(row, 'Removing active membership must persist a Seat preparation.');
  const operation = await getTeamSeatOutboxOperation(database, row.operation_id);
  assert.ok(operation);
  return operation;
}

function removalPreparation(
  operation: TeamSeatOutboxOperation,
  licensedQuantity: number,
  observedQuantity: number,
): TeamSeatPrepareResponse {
  const response = structuredClone(fixtures.positive.seatChange.prepare);
  const request = JSON.parse(operation.requestJson) as { desiredQuantity: number };
  response.quote.quoteId = randomUUID();
  response.quote.quoteHash = `removal-regression-${operation.operationId}`;
  response.quote.quantityBefore = licensedQuantity;
  response.quote.quantityAfter = request.desiredQuantity;
  response.quote.quantityDelta = request.desiredQuantity - licensedQuantity;
  response.quote.unitAmountCents = 0;
  response.authorization.authorizationId = randomUUID();
  response.authorization.quoteId = response.quote.quoteId;
  response.authorization.quoteHash = response.quote.quoteHash;
  response.authorization.quantityBefore = licensedQuantity;
  response.authorization.quantityAfter = request.desiredQuantity;
  response.snapshot.revision = operation.membershipRevision!;
  response.snapshot.observedQuantity = observedQuantity;
  response.snapshot.licensedQuantity = licensedQuantity;
  response.snapshot.approvedQuantity = 4;
  return parseTeamSeatPrepareResponse(response);
}

function removalExecution(operation: TeamSeatOutboxOperation, preparation: TeamSeatPrepareResponse) {
  const response = structuredClone(fixtures.positive.seatChange.execute);
  response.operation.operationId = randomUUID();
  response.operation.operationKey = operation.operationId;
  response.operation.operationType = 'member_remove';
  response.operation.previousQuantity = preparation.quote.quantityBefore;
  response.operation.requestedQuantity = preparation.quote.quantityAfter;
  response.operation.effectiveQuantity = preparation.quote.quantityAfter;
  response.license.details.quotas.users = preparation.quote.quantityAfter;
  return response;
}

async function enqueueExecutionFixture(
  database: SqlConnection,
  organizationId: string,
  operationType: TeamSeatChangeType,
  createdAt: number,
  prepare?: TeamSeatOutboxOperation,
  preparation?: TeamSeatPrepareResponse,
): Promise<TeamSeatOutboxOperation> {
  const operationId = preparation?.authorization.authorizationId ?? randomUUID();
  return (await enqueueTeamSeatOutboxOperation(database, {
    organizationId,
    operationId,
    dedupeKey: `removal-regression:${organizationId}:${operationType}:${operationId}`,
    operationKind: 'seat_execute',
    operationType,
    membershipId: prepare?.membershipId ?? null,
    membershipRevision: prepare?.membershipRevision ?? null,
    request: createTeamSeatExecuteRequest({ authorizationId: operationId, operationKey: operationId, operationType }),
    nextAttemptAt: createdAt,
    now: createdAt,
  })).operation;
}

async function acceptsRemovalSnapshot(observedQuantity: 2 | 3): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = `remove-observed-${observedQuantity}`;
    const members = await seedRemovalOrganization(database, organizationId);
    const prepare = await queueRemoval(database, members[0], now + 1);
    if (observedQuantity === 2) await queueRemoval(database, members[1], now + 2);
    const response = removalPreparation(prepare, 4, observedQuantity);
    const result = await recordDirectMembershipSeatPreparation({
      organizationId,
      membershipId: members[0].id,
      prepareOperationId: prepare.operationId,
      response,
      database,
      now: now + 100,
    });
    assert.equal(result.stage, 'seat_execute_pending');
    assert.equal(result.membership.status, 'removed');
    assert.equal(result.desiredQuantity, 3);
    assert.equal(result.executeOperation?.operationType, 'member_remove');
    assert.equal((await getTeamSeatOutboxOperation(database, prepare.operationId))?.status, 'succeeded');
    assert.equal(result.executeOperation?.status, 'pending');
  });
}

async function rejectsBelowObservedRemoval(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-below-observed';
    const members = await seedRemovalOrganization(database, organizationId);
    const prepare = await queueRemoval(database, members[0], now + 1);
    await assert.rejects(recordDirectMembershipSeatPreparation({
      organizationId,
      membershipId: members[0].id,
      prepareOperationId: prepare.operationId,
      response: removalPreparation(prepare, 4, 4),
      database,
      now: now + 100,
    }), (error: unknown) => error instanceof MembershipOrchestratorError
      && error.code === 'MEMBERSHIP_SEAT_RESPONSE_INVALID');
    const executed = await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'seat_execute'
    `, [organizationId]);
    assert.equal(executed.length, 0, 'Rejected reduction must not queue execution.');
  });
}

async function claimsRemovalExecutionOnly(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-execute-gate';
    await seedTeamSeatOrganization(database, organizationId, now);
    const remove = await enqueueExecutionFixture(database, organizationId, 'member_remove', now);
    const add = await enqueueExecutionFixture(database, organizationId, 'member_create', now + 1);
    const invite = await enqueueExecutionFixture(database, organizationId, 'invitation_accept', now + 2);
    const dispatched: string[] = [];
    const result = await runTeamSeatOutboxWorkerCycle({
      database,
      now: now + 100,
      pendingDelayMs: 0,
      dispatchOperation: async (operation, connection) => {
        dispatched.push(operation.operationId);
        const response = structuredClone(fixtures.positive.seatChange.execute);
        response.operation.operationKey = operation.operationId;
        response.operation.operationType = 'member_remove';
        await recordTeamSeatOutboxOperationSuccess(connection, {
          operationId: operation.operationId,
          response,
          now: now + 100,
        });
      },
    });
    assert.deepEqual(dispatched, [remove.operationId]);
    assert.deepEqual(result, { claimed: 1, succeeded: 1, deferred: 0, failed: 0 });
    for (const gated of [add, invite]) {
      const persisted = await getTeamSeatOutboxOperation(database, gated.operationId);
      assert.equal(persisted?.status, 'pending');
      assert.equal(persisted?.attemptCount, 0);
      assert.equal(persisted?.lastAttemptAt, null);
    }
  });
}

async function serializesRemovalChains(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-serialized-chains';
    const members = await seedRemovalOrganization(database, organizationId);
    const first = await queueRemoval(database, members[0], now + 1);
    const second = await queueRemoval(database, members[1], now + 2);
    const preparations = new Map<string, TeamSeatPrepareResponse>();
    let licensedQuantity = 4;
    for (const [index, expected] of [first, null, second, null].entries()) {
      const claimed = await claimDueTeamSeatWorkOperations(database, {
        now: now + 100 + index,
        pendingDelayMs: 0,
      });
      assert.equal(claimed.length, 1, 'Only one removal step per organization may be claimed.');
      const operation = claimed[0];
      if (expected) {
        assert.equal(operation.operationId, expected.operationId);
        assert.equal(operation.operationKind, 'seat_prepare');
        const prepared = removalPreparation(operation, licensedQuantity, 2);
        const result = await recordDirectMembershipSeatPreparation({
          organizationId,
          membershipId: operation.membershipId!,
          prepareOperationId: operation.operationId,
          response: prepared,
          database,
          now: now + 100 + index,
        });
        assert.ok(result.executeOperation);
        preparations.set(result.executeOperation.operationId, prepared);
      } else {
        assert.equal(operation.operationKind, 'seat_execute', 'Execution must precede the next removal preparation.');
        const prepared = preparations.get(operation.operationId);
        assert.ok(prepared);
        await recordDirectMembershipSeatExecutionApplied({
          organizationId,
          membershipId: operation.membershipId!,
          executeOperationId: operation.operationId,
          response: removalExecution(operation, prepared),
          database,
          verifyCertificate: async (response, desiredQuantity) => {
            assert.equal(response.operation.effectiveQuantity, desiredQuantity);
            assert.equal(response.license?.details.quotas?.users, desiredQuantity);
          },
          now: now + 100 + index,
        });
        licensedQuantity = prepared.quote.quantityAfter;
      }
    }
    assert.equal(licensedQuantity, 2);
    assert.equal((await getActiveTeamMembershipProjection(database, organizationId)).observedQuantity, 2);
    assert.deepEqual(await claimDueTeamSeatWorkOperations(database, {
      now: now + 200,
      pendingDelayMs: 0,
    }), []);
  });
}

async function deferredExecutionBlocksPreparation(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-deferred-execute';
    const members = await seedRemovalOrganization(database, organizationId);
    const first = await queueRemoval(database, members[0], now + 1);
    const second = await queueRemoval(database, members[1], now + 2);
    const prepared = removalPreparation(first, 4, 2);
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: first.operationId,
      response: prepared,
      controlPlaneOperationId: prepared.authorization.authorizationId,
      now: now + 10,
    });
    const execute = await enqueueExecutionFixture(database, organizationId, 'member_remove', now + 10, first, prepared);
    await scheduleTeamSeatOutboxRetry(database, {
      operationId: execute.operationId,
      errorCode: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
      error: 'Simulated retry of the same removal operation.',
      retryAt: now + 10_000,
      now: now + 20,
    });
    assert.deepEqual(await claimDueTeamSeatWorkOperations(database, {
      now: now + 100,
      pendingDelayMs: 0,
    }), [], 'A deferred removal execution must block another preparation in its organization.');
    assert.equal((await getTeamSeatOutboxOperation(database, second.operationId))?.status, 'pending');
    const resumed = await claimDueTeamSeatWorkOperations(database, {
      now: now + 10_000,
      pendingDelayMs: 0,
    });
    assert.deepEqual(resumed.map((operation) => operation.operationId), [execute.operationId]);
    assert.equal((await getTeamSeatOutboxOperation(database, second.operationId))?.status, 'pending');
  });
}

async function rejectsReductionAfterActiveCountIncreases(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-current-active-count';
    const members = await seedRemovalOrganization(database, organizationId);
    const prepare = await queueRemoval(database, members[0], now + 1);
    const prepared = await recordDirectMembershipSeatPreparation({
      organizationId,
      membershipId: members[0].id,
      prepareOperationId: prepare.operationId,
      response: removalPreparation(prepare, 4, 3),
      database,
      now: now + 10,
    });
    assert.ok(prepared.executeOperation);
    await assertMemberSeatReductionReadyForExecution(database, prepared.executeOperation);

    const addedUserId = `${organizationId}-additional-member`;
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, $1, $2, 1, 'user', $3, $3)
    `, [addedUserId, `${addedUserId}@example.test`, now + 20]);
    await adoptActiveTeamMembership(database, {
      organizationId,
      userId: addedUserId,
      role: 'member',
      source: 'migration',
      now: now + 20,
    });
    assert.equal((await getActiveTeamMembershipProjection(database, organizationId)).observedQuantity, 4);
    await assert.rejects(
      assertMemberSeatReductionReadyForExecution(database, prepared.executeOperation),
      (error: unknown) => error instanceof MembershipOrchestratorError
        && error.code === 'MEMBERSHIP_OPERATION_CONFLICT'
        && error.message.includes('current active membership count'),
    );
    const execution = await getTeamSeatOutboxOperation(database, prepared.executeOperation.operationId);
    assert.equal(execution?.status, 'pending');
    assert.equal(execution?.attemptCount, 0, 'Rejected readiness must not begin the remote execution.');
  });
}

async function appliedExecutionUsesCorrespondingAuthorization(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-exact-authorization';
    const members = await seedRemovalOrganization(database, organizationId);
    const first = await queueRemoval(database, members[0], now + 1);
    const firstResponse = removalPreparation(first, 4, 3);
    const firstResult = await recordDirectMembershipSeatPreparation({
      organizationId,
      membershipId: members[0].id,
      prepareOperationId: first.operationId,
      response: firstResponse,
      database,
      now: now + 10,
    });
    assert.ok(firstResult.executeOperation);
    const secondRemoval = await queueRemoval(database, members[1], now + 20);
    const later = (await enqueueTeamSeatOutboxOperation(database, {
      organizationId,
      dedupeKey: `removal-regression:${organizationId}:later-prepare`,
      operationKind: 'seat_prepare',
      operationType: 'member_remove',
      membershipId: members[0].id,
      membershipRevision: secondRemoval.membershipRevision,
      request: createTeamSeatPrepareRequest({
        desiredQuantity: 2,
        triggerType: 'member_remove',
        externalReference: members[0].id,
      }),
      now: now + 30,
    })).operation;
    const laterResponse = removalPreparation(later, 4, 2);
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: later.operationId,
      response: laterResponse,
      controlPlaneOperationId: laterResponse.authorization.authorizationId,
      now: now + 30,
    });
    assert.notEqual(laterResponse.authorization.authorizationId, firstResponse.authorization.authorizationId);
    assert.notEqual(laterResponse.quote.quantityAfter, firstResponse.quote.quantityAfter);

    let verifiedQuantity: number | null = null;
    const persisted = await recordDirectMembershipSeatExecutionApplied({
      organizationId,
      membershipId: members[0].id,
      executeOperationId: firstResult.executeOperation.operationId,
      response: removalExecution(firstResult.executeOperation, firstResponse),
      database,
      verifyCertificate: async (response, desiredQuantity) => {
        verifiedQuantity = desiredQuantity;
        assert.equal(response.operation.effectiveQuantity, 3);
        assert.equal(response.license?.details.quotas?.users, 3);
      },
      now: now + 40,
    });
    assert.equal(verifiedQuantity, 3, 'The late execution belongs to its original authorization and quantity.');
    assert.equal(persisted.status, 'succeeded');
    const storedResponse = JSON.parse(persisted.responseJson!) as {
      operation: { requestedQuantity: number };
      license: { certificatePersisted: boolean };
    };
    assert.equal(storedResponse.operation.requestedQuantity, 3);
    assert.equal(storedResponse.license.certificatePersisted, true);
    assert.equal((await getTeamSeatOutboxOperation(database, later.operationId))?.responseJson,
      JSON.stringify(laterResponse), 'Recording the earlier execution must leave the later preparation intact.');
  });
}

async function acknowledgeRemovalProjection(
  database: SqlConnection,
  organizationId: string,
  licensedQuantity: number,
  acknowledgedAt: number,
): Promise<void> {
  const operation = await getLatestTeamMembershipSnapshotOperation(database, organizationId);
  assert.ok(operation);
  const request = JSON.parse(operation.requestJson) as TeamSeatSnapshotRequest;
  const response = parseTeamSeatSnapshotResponse(structuredClone(fixtures.positive.snapshotResponse));
  response.snapshot = {
    ...response.snapshot,
    ...request,
    receivedAt: new Date(acknowledgedAt).toISOString(),
    reconciledAt: new Date(acknowledgedAt).toISOString(),
    driftStatus: request.observedQuantity === licensedQuantity ? 'in_sync' : 'observed_below_approved',
  };
  response.observedQuantity = request.observedQuantity;
  response.approvedQuantity = 4;
  response.billedQuantity = 0;
  response.licensedQuantity = licensedQuantity;
  response.expectedLicensedQuantity = licensedQuantity;
  response.nextReportAt = new Date(acknowledgedAt + 60_000).toISOString();
  await recordTeamSeatSnapshotAcknowledgement(database, {
    organizationId, operationId: operation.operationId, response, now: acknowledgedAt,
  });
}

async function appliedRemovalQueuesSnapshotBeforeNextPreparation(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-applied-fresh-snapshot';
    const members = await seedRemovalOrganization(database, organizationId);
    const first = await queueRemoval(database, members[0], now + 1);
    const second = await queueRemoval(database, members[1], now + 2);
    await acknowledgeRemovalProjection(database, organizationId, 4, now + 10);
    await assertMemberSeatRemovalSnapshotReady(database, second, now + 20);
    const preparation = removalPreparation(first, 4, 2);
    const prepared = await recordDirectMembershipSeatPreparation({
      organizationId, membershipId: members[0].id, prepareOperationId: first.operationId,
      response: preparation, database, now: now + 30,
    });
    assert.ok(prepared.executeOperation);
    const beforeState = await getTeamMembershipSyncState(database, organizationId);
    assert.ok(beforeState);
    const beforeSnapshots = await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot'
    `, [organizationId]);
    const executed = removalExecution(prepared.executeOperation, preparation);
    const verifiedCertificate = async (response: TeamSeatExecuteResponse, desiredQuantity: number) => {
      assert.equal(desiredQuantity, 3);
      assert.equal(response.operation.effectiveQuantity, 3);
      assert.equal(response.license?.details.quotas?.users, 3);
    };
    const applied = await recordDirectMembershipSeatExecutionApplied({
      organizationId, membershipId: members[0].id,
      executeOperationId: prepared.executeOperation.operationId,
      response: executed, database, verifyCertificate: verifiedCertificate, now: now + 40,
    });
    assert.equal(applied.status, 'succeeded');
    const afterState = await getTeamMembershipSyncState(database, organizationId);
    assert.ok(afterState);
    assert.equal(afterState.currentRevision, beforeState.currentRevision + 1);
    assert.equal(afterState.acknowledgedRevision, beforeState.acknowledgedRevision);
    assert.ok(afterState.acknowledgedRevision < afterState.currentRevision);
    const refreshSnapshot = await getLatestTeamMembershipSnapshotOperation(database, organizationId);
    assert.ok(refreshSnapshot);
    assert.equal(refreshSnapshot.status, 'pending');
    assert.equal(refreshSnapshot.operationType, 'reconcile');
    assert.equal(refreshSnapshot.membershipRevision, afterState.currentRevision);
    assert.equal((JSON.parse(refreshSnapshot.requestJson) as TeamSeatSnapshotRequest).observedQuantity, 2);
    assert.equal((await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot'
    `, [organizationId])).length, beforeSnapshots.length + 1);
    await assert.rejects(assertMemberSeatRemovalSnapshotReady(database, second, now + 50),
      (error: unknown) => error instanceof LicenseControlPlaneError
        && error.code === 'TEAM_SEAT_MEMBERSHIP_SYNC_PENDING');

    await acknowledgeRemovalProjection(database, organizationId, 3, now + 60);
    await assertMemberSeatRemovalSnapshotReady(database, second, now + 70);
    const replayState = await getTeamMembershipSyncState(database, organizationId);
    const replaySnapshots = await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot' ORDER BY membership_revision
    `, [organizationId]);
    const replay = await recordDirectMembershipSeatExecutionApplied({
      organizationId, membershipId: members[0].id,
      executeOperationId: prepared.executeOperation.operationId,
      response: executed, database, verifyCertificate: verifiedCertificate, now: now + 80,
    });
    assert.equal(replay.status, 'succeeded');
    assert.equal(replay.responseJson, applied.responseJson);
    assert.deepEqual(await getTeamMembershipSyncState(database, organizationId), replayState,
      'Replaying the same applied execution must not allocate another snapshot revision.');
    assert.deepEqual(await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot' ORDER BY membership_revision
    `, [organizationId]), replaySnapshots);
  });
}

async function invalidRemovalCertificateDoesNotPersistSnapshot(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-invalid-certificate-snapshot';
    const members = await seedRemovalOrganization(database, organizationId);
    const prepare = await queueRemoval(database, members[0], now + 1);
    const preparation = removalPreparation(prepare, 4, 3);
    const prepared = await recordDirectMembershipSeatPreparation({
      organizationId, membershipId: members[0].id, prepareOperationId: prepare.operationId,
      response: preparation, database, now: now + 10,
    });
    assert.ok(prepared.executeOperation);
    const beforeState = await getTeamMembershipSyncState(database, organizationId);
    const beforeSnapshots = await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot'
    `, [organizationId]);
    const executed = removalExecution(prepared.executeOperation, preparation);
    executed.license.license = 'invalid-removal-certificate-'.repeat(4);
    const certificateError = new MembershipOrchestratorError(
      'MEMBERSHIP_SIGNED_LIMIT_INVALID', 'Synthetic certificate verification failure.',
    );
    await assert.rejects(recordDirectMembershipSeatExecutionApplied({
      organizationId, membershipId: members[0].id,
      executeOperationId: prepared.executeOperation.operationId,
      response: executed, database, now: now + 20,
      verifyCertificate: async (response) => {
        assert.equal(response.license?.license, executed.license.license);
        throw certificateError;
      },
    }), (error: unknown) => error === certificateError);
    assert.deepEqual(await getTeamMembershipSyncState(database, organizationId), beforeState);
    assert.deepEqual(await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot'
    `, [organizationId]), beforeSnapshots);
    const unchanged = await getTeamSeatOutboxOperation(database, prepared.executeOperation.operationId);
    assert.equal(unchanged?.status, 'pending');
    assert.equal(unchanged?.responseJson, null);
    assert.equal(unchanged?.completedAt, null);
  });
}

async function removalSnapshotWriteFailureRollsBackExecution(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = 'remove-atomic-snapshot-failure';
    const members = await seedRemovalOrganization(database, organizationId);
    const prepare = await queueRemoval(database, members[0], now + 1);
    const preparation = removalPreparation(prepare, 4, 3);
    const prepared = await recordDirectMembershipSeatPreparation({
      organizationId, membershipId: members[0].id, prepareOperationId: prepare.operationId,
      response: preparation, database, now: now + 10,
    });
    assert.ok(prepared.executeOperation);
    const beforeState = await getTeamMembershipSyncState(database, organizationId);
    const beforeSnapshots = await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot'
    `, [organizationId]);
    await database.run(`
      CREATE FUNCTION reject_removal_refresh_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_kind = 'membership_snapshot' THEN
          RAISE EXCEPTION 'Synthetic removal snapshot persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.run(`
      CREATE TRIGGER reject_removal_refresh_snapshot_insert
      BEFORE INSERT ON team_seat_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_removal_refresh_snapshot()
    `);
    await assert.rejects(recordDirectMembershipSeatExecutionApplied({
      organizationId, membershipId: members[0].id,
      executeOperationId: prepared.executeOperation.operationId,
      response: removalExecution(prepared.executeOperation, preparation), database,
      verifyCertificate: async () => undefined, now: now + 20,
    }), /Synthetic removal snapshot persistence failure/);
    assert.deepEqual(await getTeamMembershipSyncState(database, organizationId), beforeState,
      'A failed snapshot INSERT must roll back the preceding revision allocation.');
    assert.deepEqual(await database.all(`
      SELECT operation_id FROM team_seat_outbox
      WHERE organization_id = $1 AND operation_kind = 'membership_snapshot'
    `, [organizationId]), beforeSnapshots);
    const unchanged = await getTeamSeatOutboxOperation(database, prepared.executeOperation.operationId);
    assert.equal(unchanged?.status, 'pending', 'Execution success and its fresh snapshot must commit together.');
    assert.equal(unchanged?.responseJson, null);
    assert.equal(unchanged?.completedAt, null);
  });
}

async function main(): Promise<void> {
  const previousMode = process.env.CANVAS_DEPLOYMENT_MODE;
  process.env.CANVAS_DEPLOYMENT_MODE = 'community';
  const scenarios: Array<[string, () => Promise<void>]> = [
    ['remove accepts observed quantity equal to target', () => acceptsRemovalSnapshot(3)],
    ['remove accepts observed quantity below target', () => acceptsRemovalSnapshot(2)],
    ['remove rejects target below observed quantity', rejectsBelowObservedRemoval],
    ['worker executes removals without executing pending adds or invitations', claimsRemovalExecutionOnly],
    ['removal preparations and executions serialize per organization', serializesRemovalChains],
    ['deferred removal execution blocks the next preparation', deferredExecutionBlocksPreparation],
    ['remove execution rejects a newer active count above its target', rejectsReductionAfterActiveCountIncreases],
    ['late execution matches its exact authorization rather than a newer preparation', appliedExecutionUsesCorrespondingAuthorization],
    ['applied removal queues a fresh snapshot, blocks the next preparation and replays without another snapshot', appliedRemovalQueuesSnapshotBeforeNextPreparation],
    ['invalid removal certificate leaves snapshots and execution unchanged', invalidRemovalCertificateDoesNotPersistSnapshot],
    ['snapshot persistence failure rolls back removal execution success and its revision', removalSnapshotWriteFailureRollsBackExecution],
  ];
  const failures: Error[] = [];
  try {
    for (const [name, scenario] of scenarios) {
      try {
        await scenario();
        console.info(`PASS: ${name}`);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        console.error(`FAIL: ${name}: ${failure.message}`);
      }
    }
  } finally {
    if (previousMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
    else process.env.CANVAS_DEPLOYMENT_MODE = previousMode;
  }
  assert.equal(failures.length, 0, `${failures.length} of ${scenarios.length} removal regression scenarios failed.`);
  console.info('team-seat-removal-regression-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
