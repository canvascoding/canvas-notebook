import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import fixtures from '../app/lib/license/fixtures/team-seat-protocol-v1.json';
import type { SqlConnection } from '../app/lib/db';
import { LicenseControlPlaneError } from '../app/lib/license/control-plane';
import {
  beginDirectMembershipSeatRequote,
  beginInvitationMembershipActivation,
  beginSuspendedMembershipReactivation,
  getDirectMembershipSeatQuote,
  getMembershipSeatPrepareRequest,
  MembershipOrchestratorError,
  recordDirectMembershipSeatPreparation,
} from '../app/lib/organization/membership-orchestrator';
import {
  acceptTeamMembershipInvitation,
  createTeamMembershipInvitation,
  revokeTeamMembershipInvitation,
  TeamInvitationError,
} from '../app/lib/organization/team-invitations';
import {
  adoptActiveTeamMembership,
  getActiveTeamMembershipProjection,
  getTeamMembershipById,
  transitionTeamMembership,
} from '../app/lib/organization/team-membership';
import {
  claimTeamSeatOutboxOperation,
  enqueueTeamSeatOutboxOperation,
  getTeamSeatOutboxOperation,
  recordTeamSeatOutboxOperationFailure,
  recordTeamSeatOutboxOperationPending,
  recordTeamSeatOutboxOperationSuccess,
  TeamSeatOutboxError,
} from '../app/lib/license/team-seat-outbox';
import {
  createTeamSeatExecuteRequest,
  createTeamSeatPrepareRequest,
  parseTeamSeatPrepareResponse,
  parseTeamSeatQuoteStatusResponse,
  TeamSeatContractError,
  type TeamSeatPrepareResponse,
  type TeamSeatQuoteStatusResponse,
} from '../app/lib/license/team-seat-contract';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';
import {
  MembershipSeatRecoveryConflict,
  membershipSeatQuoteNeedsRefresh,
  recordMembershipSeatExecutionRejection,
} from '../app/lib/organization/membership-seat-recovery';
import { dispatchDirectMembershipSeatPreparation } from '../app/lib/organization/membership-seat-quote';

process.env.CANVAS_DEPLOYMENT_MODE = 'community';
const fixtureTime = Date.parse('2030-01-01T00:00:00.000Z');
let unexpectedHttpCalls = 0;

class RecoveryRemoteRetirementError extends Error {
  readonly status = 409;
  readonly code = 'TEAM_SEAT_AUTHORIZATION_REPLAY';
}

class RecoveryQuoteServer {
  readonly quotes = new Map<string, TeamSeatQuoteStatusResponse>();
  readonly prepareOperationIds = new Map<string, string>();
  reads = 0;
  retirements = 0;
  executions = 0;
  charges = 0;
  rejectRetirement = false;
  consumedBeforeRetirement = false;
  mismatchRetirementResponse = false;

  constructor(preparation: TeamSeatPrepareResponse, prepareOperationId: string) {
    this.quotes.set(preparation.quote.quoteId, parseTeamSeatQuoteStatusResponse(preparation));
    this.prepareOperationIds.set(preparation.quote.quoteId, prepareOperationId);
  }

  readQuoteStatus = async (quoteId: string, operationId: string): Promise<unknown> => {
    assert.equal(operationId, this.prepareOperationIds.get(quoteId), 'The exact persisted Prepare must scope every status lookup.');
    this.reads += 1;
    const current = this.quotes.get(quoteId);
    assert.ok(current);
    return structuredClone(current);
  };

  revokeQuote = async (quoteId: string, input: {
    authorizationId: string; quoteHash: string; reason: 'activation_refresh' | 'activation_cancel';
  }, operationId: string): Promise<unknown> => {
    assert.equal(operationId, this.prepareOperationIds.get(quoteId));
    assert.ok(['activation_refresh', 'activation_cancel'].includes(input.reason));
    this.retirements += 1;
    const current = this.quotes.get(quoteId);
    assert.ok(current);
    assert.equal(input.authorizationId, current.authorization.authorizationId);
    assert.equal(input.quoteHash, current.quote.quoteHash);
    if (this.consumedBeforeRetirement) {
      current.authorization.status = 'consumed';
      current.authorization.consumedAt = new Date(fixtureTime + 1_000).toISOString();
    }
    if (this.rejectRetirement || current.authorization.status === 'consumed') {
      throw new RecoveryRemoteRetirementError('The remote authorization cannot be retired.');
    }
    current.quote.status = 'revoked';
    current.authorization.status = 'revoked';
    current.authorization.consumedAt = null;
    const response = structuredClone(current);
    if (this.mismatchRetirementResponse) response.authorization.authorizationId = randomUUID();
    return response;
  };

  execute(quoteId: string): void {
    const current = this.quotes.get(quoteId);
    assert.ok(current);
    assert.equal(current.authorization.status, 'approved', 'A retired authorization must fence later execution.');
    this.executions += 1;
    this.charges += 1;
  }
}

async function withRecoveryFixture(
  run: (fixture: Awaited<ReturnType<typeof createRecoveryFixture>>) => Promise<void>,
  options: { authorizationPending?: boolean; expired?: boolean } = {},
): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => run(await createRecoveryFixture(database, options)));
}

async function createRecoveryFixture(database: SqlConnection, options: {
  authorizationPending?: boolean; expired?: boolean;
}) {
  const organizationId = `seat-recovery-${randomUUID()}`;
  const actorUserId = `owner-${organizationId}`;
  await seedTeamSeatOrganization(database, organizationId, fixtureTime);
  await adoptActiveTeamMembership(database, {
    organizationId, userId: actorUserId, role: 'owner', source: 'first_owner', now: fixtureTime,
  });
  const created = await createTeamMembershipInvitation({
    organizationId, actorUserId, email: `candidate-${randomUUID()}@example.test`,
    displayName: 'Recovery candidate', role: 'member', database, now: fixtureTime + 1,
  });
  const requestId = randomUUID();
  const accepted = await acceptTeamMembershipInvitation({
    token: created.token, requestId, database, now: fixtureTime + 2,
  });
  const activation = await beginInvitationMembershipActivation({
    organizationId, membershipId: accepted.membership.id, invitationId: created.invitation.id,
    database, now: fixtureTime + 3,
  });
  const raw = structuredClone(fixtures.positive.seatChange.prepare);
  raw.quote.quoteId = randomUUID();
  raw.quote.quoteHash = `recovery-quote-${randomUUID()}`;
  raw.quote.quantityBefore = 1;
  raw.quote.quantityAfter = 2;
  raw.quote.quantityDelta = 1;
  raw.quote.unitAmountCents = 0;
  raw.quote.expiresAt = new Date(fixtureTime + (options.expired ? 1_000 : 60_000)).toISOString();
  raw.authorization.authorizationId = randomUUID();
  raw.authorization.quoteId = raw.quote.quoteId;
  raw.authorization.quoteHash = raw.quote.quoteHash;
  raw.authorization.quantityBefore = 1;
  raw.authorization.quantityAfter = 2;
  raw.authorization.expiresAt = raw.quote.expiresAt;
  raw.snapshot.revision = activation.prepareOperation.membershipRevision!;
  raw.snapshot.observedQuantity = 1;
  raw.snapshot.licensedQuantity = 1;
  raw.snapshot.approvedQuantity = 4;
  const preparation: TeamSeatPrepareResponse = parseTeamSeatPrepareResponse(raw);
  if (options.authorizationPending) {
    preparation.requiresBillingApproval = true;
    preparation.authorization.status = 'pending';
    preparation.authorization.approvedAt = null;
  }
  const prepared = await recordDirectMembershipSeatPreparation({
    organizationId, membershipId: accepted.membership.id,
    prepareOperationId: activation.prepareOperation.operationId, response: preparation,
    actorUserId, database, now: fixtureTime + 4,
  });
  const remote = new RecoveryQuoteServer(preparation, prepared.prepareOperation.operationId);
  return { database, organizationId, actorUserId, requestId, created, accepted, prepared,
    preparation, remote, now: fixtureTime + 2_000 };
}

type RecoveryFixture = Awaited<ReturnType<typeof createRecoveryFixture>>;

async function recoverySnapshot(fixture: Pick<RecoveryFixture, 'database' | 'organizationId'>) {
  const { database, organizationId } = fixture;
  return {
    memberships: await database.all('SELECT * FROM team_memberships WHERE organization_id = $1 ORDER BY id', [organizationId]),
    invitations: await database.all('SELECT * FROM team_membership_invitations WHERE organization_id = $1 ORDER BY id', [organizationId]) as Array<Record<string, unknown>>,
    outbox: await database.all('SELECT * FROM team_seat_outbox WHERE organization_id = $1 ORDER BY id', [organizationId]),
    events: await database.all('SELECT * FROM team_membership_transitions WHERE organization_id = $1 ORDER BY id', [organizationId]),
    sync: await database.all('SELECT * FROM team_membership_sync_state WHERE organization_id = $1', [organizationId]),
    projection: await getActiveTeamMembershipProjection(database, organizationId),
  };
}

function requestRequote(fixture: RecoveryFixture) {
  return beginDirectMembershipSeatRequote({
    organizationId: fixture.organizationId, membershipId: fixture.accepted.membership.id,
    staleQuoteId: fixture.preparation.quote.quoteId, actorUserId: fixture.actorUserId,
    database: fixture.database, now: fixture.now,
    readQuoteStatus: fixture.remote.readQuoteStatus, revokeQuote: fixture.remote.revokeQuote,
  });
}

function requestCancel(fixture: RecoveryFixture) {
  return revokeTeamMembershipInvitation({
    organizationId: fixture.organizationId, invitationId: fixture.created.invitation.id,
    actorUserId: fixture.actorUserId, database: fixture.database, now: fixture.now,
    readQuoteStatus: fixture.remote.readQuoteStatus, revokeQuote: fixture.remote.revokeQuote,
  });
}

async function failExecution(fixture: RecoveryFixture, errorCode = 'TEAM_SEAT_QUOTE_STALE', response?: unknown) {
  const execution = fixture.prepared.executeOperation;
  assert.ok(execution);
  await claimTeamSeatOutboxOperation(fixture.database, {
    operationId: execution.operationId, allowPending: true, now: fixtureTime + 10,
  });
  return recordTeamSeatOutboxOperationFailure(fixture.database, {
    operationId: execution.operationId, errorCode, error: 'Isolated recovery regression failure.',
    response, now: fixtureTime + 20,
  });
}

async function assertRejectedWithoutLocalMutation(fixture: RecoveryFixture, allowInvalidContract = false) {
  for (const action of [requestRequote, requestCancel]) {
    const before = await recoverySnapshot(fixture);
    const remotelyConsumed = fixture.remote.quotes.get(fixture.preparation.quote.quoteId)?.authorization.status === 'consumed';
    await assert.rejects(action(fixture), (error) => {
      if (error instanceof MembershipOrchestratorError) return error.code === 'MEMBERSHIP_OPERATION_CONFLICT'
        || (action === requestRequote && remotelyConsumed && error.code === 'MEMBERSHIP_QUOTE_STILL_ACTIVE');
      if (error instanceof TeamInvitationError) return error.code === 'INVITATION_CONFLICT';
      return error instanceof MembershipSeatRecoveryConflict
        || error instanceof RecoveryRemoteRetirementError
        || (allowInvalidContract && error instanceof TeamSeatContractError);
    });
    assert.deepEqual(await recoverySnapshot(fixture), before, 'Rejected recovery must not change domain, queue, events, or projection.');
    assert.equal(fixture.remote.executions, 0);
    assert.equal(fixture.remote.charges, 0);
  }
}

async function expiredPendingExecutionRequotes() {
  await withRecoveryFixture(async (fixture) => {
    const oldPrepare = await getTeamSeatOutboxOperation(fixture.database, fixture.prepared.prepareOperation.operationId);
    const oldExecute = await getTeamSeatOutboxOperation(fixture.database, fixture.prepared.executeOperation!.operationId);
    const before = await recoverySnapshot(fixture);
    const beforeProjection = await getActiveTeamMembershipProjection(fixture.database, fixture.organizationId);
    const next = await requestRequote(fixture);
    assert.equal(next.membership.id, fixture.accepted.membership.id);
    assert.equal(next.membership.status, 'approval_required');
    assert.equal(next.membership.userId, null);
    assert.equal(next.stage, 'seat_prepare_pending');
    assert.notEqual(next.prepareOperation.operationId, oldPrepare?.operationId);
    assert.equal(next.prepareOperation.operationType, 'invitation_accept');
    assert.equal(getMembershipSeatPrepareRequest(next.prepareOperation).externalReference, fixture.created.invitation.id);
    assert.equal(getMembershipSeatPrepareRequest(next.prepareOperation).desiredQuantity, 2);
    assert.deepEqual(await getTeamSeatOutboxOperation(fixture.database, oldPrepare!.operationId), oldPrepare);
    assert.deepEqual((await recoverySnapshot(fixture)).invitations, before.invitations);
    const retired = await getTeamSeatOutboxOperation(fixture.database, fixture.prepared.executeOperation!.operationId);
    assert.equal(retired?.status, 'failed');
    assert.equal(retired?.lastErrorCode, 'TEAM_SEAT_QUOTE_SUPERSEDED');
    assert.equal(retired?.attemptCount, 0);
    assert.equal(retired?.lastAttemptAt, null);
    assert.equal(retired?.nextAttemptAt, null);
    assert.equal(retired?.requestJson, oldExecute?.requestJson);
    assert.equal(retired?.requestHash, oldExecute?.requestHash);
    assert.equal(fixture.remote.retirements, 1);
    assert.throws(() => fixture.remote.execute(fixture.preparation.quote.quoteId));
    assert.equal(fixture.remote.executions, 0);
    assert.equal(fixture.remote.charges, 0);
    assert.deepEqual(await getActiveTeamMembershipProjection(fixture.database, fixture.organizationId), beforeProjection);
  }, { expired: true });
}

async function expiredPendingAuthorizationRequotes() {
  await withRecoveryFixture(async (fixture) => {
    assert.equal(fixture.prepared.executeOperation, null);
    const old = await getTeamSeatOutboxOperation(fixture.database, fixture.prepared.prepareOperation.operationId);
    const next = await requestRequote(fixture);
    assert.equal(next.membership.id, fixture.accepted.membership.id);
    assert.equal(next.prepareOperation.status, 'pending');
    assert.deepEqual(await getTeamSeatOutboxOperation(fixture.database, old!.operationId), old);
    assert.equal(fixture.remote.retirements, 1);
  }, { expired: true, authorizationPending: true });
}

async function staleUnexpiredExecutionRequotes() {
  await withRecoveryFixture(async (fixture) => {
    const failed = await failExecution(fixture);
    const before = await recoverySnapshot(fixture);
    assert.ok(Date.parse(fixture.preparation.quote.expiresAt) > fixture.now);
    const oldQuote = await getDirectMembershipSeatQuote({
      organizationId: fixture.organizationId, membershipId: fixture.accepted.membership.id, database: fixture.database,
    });
    assert.equal(oldQuote.preparation.authorization.status, 'approved');
    const next = await requestRequote(fixture);
    assert.equal(next.membership.id, fixture.accepted.membership.id);
    assert.equal(next.membership.status, 'approval_required');
    assert.notEqual(next.prepareOperation.operationId, fixture.prepared.prepareOperation.operationId);
    assert.deepEqual(await getTeamSeatOutboxOperation(fixture.database, failed.operationId), failed, 'The original failure is immutable history.');
    assert.deepEqual((await recoverySnapshot(fixture)).invitations, before.invitations);
    assert.equal(fixture.remote.retirements, 1);
    assert.throws(() => fixture.remote.execute(fixture.preparation.quote.quoteId));
    assert.equal(fixture.remote.charges, 0);
  });
}

async function staleAcceptedInvitationCanBeCancelled() {
  await withRecoveryFixture(async (fixture) => {
    const failed = await failExecution(fixture);
    const before = await recoverySnapshot(fixture);
    const revoked = await requestCancel(fixture);
    assert.equal(revoked.id, fixture.created.invitation.id);
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.acceptedAt, fixture.accepted.invitation.acceptedAt);
    const persistedInvitation = await fixture.database.get(
      'SELECT accepted_request_id, accepted_at, token_hash FROM team_membership_invitations WHERE id = $1',
      [revoked.id],
    ) as { accepted_request_id: string; accepted_at: number; token_hash: string };
    assert.equal(persistedInvitation.accepted_request_id, fixture.requestId);
    assert.equal(persistedInvitation.accepted_at, fixture.accepted.invitation.acceptedAt);
    const membership = await getTeamMembershipById(fixture.database, fixture.organizationId, fixture.accepted.membership.id);
    assert.equal(membership?.status, 'removed');
    assert.equal(membership?.userId, null);
    assert.deepEqual(await getTeamSeatOutboxOperation(fixture.database, failed.operationId), failed);
    const after = await recoverySnapshot(fixture);
    assert.deepEqual(after.outbox, before.outbox, 'Cancellation preserves Prepare and failed Execute history.');
    assert.deepEqual(after.invitations, before.invitations.map((invitation) => ({
      ...invitation, status: 'revoked', revoked_at: fixture.now, updated_at: fixture.now,
    })), 'Cancellation preserves the token hash, accepted request, and original acceptance timestamp.');
    assert.deepEqual(after.sync, before.sync);
    assert.deepEqual(after.projection, before.projection);
    assert.ok(after.events.length > before.events.length);
    assert.equal(fixture.remote.retirements, 1);
    assert.throws(() => fixture.remote.execute(fixture.preparation.quote.quoteId));
    assert.equal(fixture.remote.charges, 0);
  });
}

async function healthyQuoteCannotBeRefreshed() {
  await withRecoveryFixture(async (fixture) => {
    const before = await recoverySnapshot(fixture);
    await assert.rejects(requestRequote(fixture), (error) => error instanceof MembershipOrchestratorError
      && error.code === 'MEMBERSHIP_QUOTE_STILL_ACTIVE');
    assert.deepEqual(await recoverySnapshot(fixture), before);
    assert.equal(fixture.remote.retirements, 0, 'Healthy approval must not be revoked by a Refresh request.');
  });
}

async function rejectsUnsafeExecutionStates() {
  const cases: Array<[string, (fixture: RecoveryFixture) => Promise<void>, boolean?]> = [
    ['remote consumed', async (fixture) => {
      const current = fixture.remote.quotes.get(fixture.preparation.quote.quoteId)!;
      current.authorization.status = 'consumed';
      current.authorization.consumedAt = new Date(fixtureTime + 10).toISOString();
    }],
    ['currently processing', async (fixture) => {
      await claimTeamSeatOutboxOperation(fixture.database, {
        operationId: fixture.prepared.executeOperation!.operationId, allowPending: true, now: fixtureTime + 10,
      });
    }],
    ['retry waiting with uncertain response', async (fixture) => {
      await recordTeamSeatOutboxOperationPending(fixture.database, {
        operationId: fixture.prepared.executeOperation!.operationId,
        response: { unconfirmed: true }, errorCode: 'TEAM_SEAT_UPSTREAM_UNAVAILABLE',
        error: 'Uncertain remote result.', retryAt: fixtureTime + 60_000, now: fixtureTime + 10,
      });
    }],
    ['terminal unknown', async (fixture) => { await failExecution(fixture, 'TEAM_SEAT_UPSTREAM_UNAVAILABLE'); }],
    ['safe code with remote response', async (fixture) => { await failExecution(fixture, 'TEAM_SEAT_QUOTE_STALE', { unconfirmed: true }); }],
    ['safe code with remote operation identity', async (fixture) => {
      await recordTeamSeatOutboxOperationFailure(fixture.database, {
        operationId: fixture.prepared.executeOperation!.operationId,
        errorCode: 'TEAM_SEAT_QUOTE_STALE', error: 'A remote operation is already known.',
        controlPlaneOperationId: randomUUID(), now: fixtureTime + 10,
      });
    }],
    ['mismatched persisted Execute binding', async (fixture) => {
      const execution = fixture.prepared.executeOperation!;
      const request = JSON.parse(execution.requestJson) as { operationKey: string };
      request.operationKey = randomUUID();
      await fixture.database.run('UPDATE team_seat_outbox SET request_json = $1 WHERE operation_id = $2',
        [JSON.stringify(request), execution.operationId]);
    }],
    ['mismatched remote authorization', async (fixture) => {
      fixture.remote.quotes.get(fixture.preparation.quote.quoteId)!.authorization.authorizationId = randomUUID();
    }],
    ['unknown status reader result', async (fixture) => {
      fixture.remote.readQuoteStatus = async () => ({ unknown: true });
    }, true],
  ];
  for (const [name, mutate, allowInvalidContract] of cases) {
    await withRecoveryFixture(async (fixture) => {
      await mutate(fixture);
      await assertRejectedWithoutLocalMutation(fixture, allowInvalidContract);
    }, { expired: true });
    console.log(`membership-seat-recovery-test: rejects ${name}`);
  }
}

async function unknownFailedPreparationBlocksRecovery() {
  await withRecoveryFixture(async (fixture) => {
    // A previous Prepare may have reached the remote service before its answer
    // was lost. Its missing response must not be treated as proof of no quote.
    const previous = await enqueueTeamSeatOutboxOperation(fixture.database, {
      organizationId: fixture.organizationId,
      membershipId: fixture.accepted.membership.id,
      membershipRevision: fixture.prepared.prepareOperation.membershipRevision,
      dedupeKey: `unknown-prepare:${randomUUID()}`,
      operationKind: 'seat_prepare', operationType: 'invitation_accept',
      request: getMembershipSeatPrepareRequest(fixture.prepared.prepareOperation),
      now: fixtureTime + 2,
    });
    await recordTeamSeatOutboxOperationFailure(fixture.database, {
      operationId: previous.operation.operationId,
      errorCode: 'TEAM_SEAT_UPSTREAM_UNAVAILABLE', error: 'The earlier remote Prepare result is unknown.',
      now: fixtureTime + 10,
    });
    await assertRejectedWithoutLocalMutation(fixture);
    assert.equal(fixture.remote.retirements, 0, 'An unknown earlier Prepare must block before any remote mutation.');
  }, { expired: true });
}

async function stalePreparationDispatchCannotContactRemoteService() {
  for (const mode of ['cached-superseded', 'pending-superseded', 'pending-cancelled'] as const) {
    await withRecoveryFixture(async (fixture) => {
      let staleActivation = fixture.prepared;
      if (mode !== 'cached-superseded') {
        const olderPending = await enqueueTeamSeatOutboxOperation(fixture.database, {
          organizationId: fixture.organizationId,
          membershipId: fixture.accepted.membership.id,
          membershipRevision: fixture.prepared.prepareOperation.membershipRevision,
          dedupeKey: `stale-dispatch:${randomUUID()}`,
          operationKind: 'seat_prepare', operationType: 'invitation_accept',
          request: getMembershipSeatPrepareRequest(fixture.prepared.prepareOperation),
          now: fixtureTime + 2,
        });
        staleActivation = { ...fixture.prepared, prepareOperation: olderPending.operation };
      }
      if (mode === 'pending-cancelled') await requestCancel(fixture);
      else await requestRequote(fixture);
      if (mode !== 'cached-superseded') {
        const retired = await getTeamSeatOutboxOperation(fixture.database, staleActivation.prepareOperation.operationId);
        assert.equal(retired?.status, 'failed');
        assert.equal(retired?.attemptCount, 0);
        assert.equal(retired?.lastErrorCode, mode === 'pending-cancelled'
          ? 'TEAM_SEAT_ACTIVATION_CANCELLED' : 'TEAM_SEAT_QUOTE_SUPERSEDED');
      }
      let remotePrepareCalls = 0;
      const before = await recoverySnapshot(fixture);
      await assert.rejects(dispatchDirectMembershipSeatPreparation({
        activation: staleActivation, actorUserId: fixture.actorUserId, database: fixture.database,
        prepareSeatChange: async () => {
          remotePrepareCalls += 1;
          throw new Error('Stale preparation reached the remote service.');
        },
      }), (error) => error instanceof TeamSeatOutboxError && error.code === 'TEAM_SEAT_OUTBOX_CONFLICT');
      assert.equal(remotePrepareCalls, 0);
      assert.deepEqual(await recoverySnapshot(fixture), before);
    }, { expired: true });
    console.log(`membership-seat-recovery-test: rejects dispatch ${mode}`);
  }
}

async function recoveryAfterCachedPreparationClaimIsFenced() {
  for (const mode of ['refresh', 'cancel'] as const) {
    await withRecoveryFixture(async (fixture) => {
      let recovered = false;
      let afterRecovery: Awaited<ReturnType<typeof recoverySnapshot>> | null = null;
      const interleavedDatabase: SqlConnection = {
        ...fixture.database,
        run: async (sql, params) => {
          const result = await fixture.database.run(sql, params);
          if (!recovered && sql.trim().toUpperCase() === 'COMMIT') {
            recovered = true;
            if (mode === 'refresh') await requestRequote(fixture);
            else await requestCancel(fixture);
            afterRecovery = await recoverySnapshot(fixture);
          }
          return result;
        },
      };
      let remotePrepareCalls = 0;
      await assert.rejects(dispatchDirectMembershipSeatPreparation({
        activation: fixture.prepared, actorUserId: fixture.actorUserId, database: interleavedDatabase,
        prepareSeatChange: async () => {
          remotePrepareCalls += 1;
          throw new Error('Cached preparation unexpectedly contacted the remote service.');
        },
      }), (error) => (error instanceof TeamSeatOutboxError && error.code === 'TEAM_SEAT_OUTBOX_CONFLICT')
        || (error instanceof MembershipOrchestratorError && error.code === 'MEMBERSHIP_OPERATION_CONFLICT'));
      assert.equal(recovered, true, 'Recovery must interleave after the claim transaction commits.');
      assert.equal(remotePrepareCalls, 0);
      assert.deepEqual(await recoverySnapshot(fixture), afterRecovery,
        'A cached response must not change membership, authorization binding, or history after recovery.');
    }, { expired: true });
    console.log(`membership-seat-recovery-test: fences cached response after ${mode}`);
  }
}

async function reactivationIgnoresConsumedHistoryAndPreservesLifecycleMarker() {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = `reactivation-recovery-${randomUUID()}`;
    const actorUserId = `owner-${organizationId}`;
    const userId = `member-${randomUUID()}`;
    await seedTeamSeatOrganization(database, organizationId, fixtureTime);
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Reactivation member', $2, 1, 'user', $3, $3)
    `, [userId, `${userId}@example.test`, fixtureTime]);
    await adoptActiveTeamMembership(database, {
      organizationId, userId: actorUserId, role: 'owner', source: 'first_owner', now: fixtureTime,
    });
    const active = await adoptActiveTeamMembership(database, {
      organizationId, userId, role: 'member', source: 'migration', now: fixtureTime + 1,
    });
    const originalPrepare = await enqueueTeamSeatOutboxOperation(database, {
      organizationId, membershipId: active.id, membershipRevision: 1,
      operationKind: 'seat_prepare', operationType: 'member_create',
      dedupeKey: `original-creation:${active.id}`,
      request: createTeamSeatPrepareRequest({
        desiredQuantity: fixtures.positive.seatChange.prepare.quote.quantityAfter,
        triggerType: 'member_create', externalReference: active.id,
      }),
      now: fixtureTime + 2,
    });
    const historical = parseTeamSeatPrepareResponse(structuredClone(fixtures.positive.seatChange.prepare));
    historical.quote.quoteId = randomUUID();
    historical.quote.quoteHash = `original-quote-${randomUUID()}`;
    historical.authorization.authorizationId = randomUUID();
    historical.authorization.quoteId = historical.quote.quoteId;
    historical.authorization.quoteHash = historical.quote.quoteHash;
    historical.authorization.status = 'consumed';
    historical.authorization.approvedAt = new Date(fixtureTime + 2).toISOString();
    historical.authorization.consumedAt = new Date(fixtureTime + 3).toISOString();
    historical.snapshot.revision = 1;
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: originalPrepare.operation.operationId, response: historical,
      controlPlaneOperationId: historical.authorization.authorizationId, now: fixtureTime + 3,
    });
    const originalExecute = await enqueueTeamSeatOutboxOperation(database, {
      organizationId, membershipId: active.id, membershipRevision: 1,
      operationKind: 'seat_execute', operationType: 'member_create',
      operationId: historical.authorization.authorizationId,
      dedupeKey: `original-execution:${active.id}`,
      request: createTeamSeatExecuteRequest({
        authorizationId: historical.authorization.authorizationId,
        operationKey: historical.authorization.authorizationId, operationType: 'member_create',
      }),
      now: fixtureTime + 4,
    });
    const historicalExecution = structuredClone(fixtures.positive.seatChange.execute);
    historicalExecution.operation.operationKey = historical.authorization.authorizationId;
    await recordTeamSeatOutboxOperationSuccess(database, {
      operationId: originalExecute.operation.operationId, response: historicalExecution,
      controlPlaneOperationId: historicalExecution.operation.operationId, now: fixtureTime + 5,
    });
    const historyBefore = await database.all(`
      SELECT * FROM team_seat_outbox WHERE operation_id IN ($1, $2) ORDER BY id
    `, [originalPrepare.operation.operationId, originalExecute.operation.operationId]);
    await transitionTeamMembership(database, {
      organizationId, membershipId: active.id, expectedStatus: 'active', toStatus: 'suspended',
      actorUserId, source: 'local_admin', reason: 'Isolated reactivation fixture', now: fixtureTime + 20,
    });
    const activation = await beginSuspendedMembershipReactivation({
      organizationId, membershipId: active.id, actorUserId, database, now: fixtureTime + 30,
    });
    const current = parseTeamSeatPrepareResponse(structuredClone(fixtures.positive.seatChange.prepare));
    current.quote.quoteId = randomUUID();
    current.quote.quoteHash = `reactivation-quote-${randomUUID()}`;
    current.quote.quantityBefore = 1;
    current.quote.quantityAfter = 2;
    current.quote.quantityDelta = 1;
    current.quote.expiresAt = new Date(fixtureTime + 1_000).toISOString();
    current.authorization.authorizationId = randomUUID();
    current.authorization.quoteId = current.quote.quoteId;
    current.authorization.quoteHash = current.quote.quoteHash;
    current.authorization.quantityBefore = 1;
    current.authorization.quantityAfter = 2;
    current.authorization.expiresAt = current.quote.expiresAt;
    current.authorization.approvedAt = new Date(fixtureTime + 35).toISOString();
    current.snapshot.revision = activation.prepareOperation.membershipRevision!;
    current.snapshot.observedQuantity = 1;
    current.snapshot.licensedQuantity = 1;
    const prepared = await recordDirectMembershipSeatPreparation({
      organizationId, membershipId: active.id, prepareOperationId: activation.prepareOperation.operationId,
      response: current, actorUserId, database, now: fixtureTime + 40,
    });
    const remote = new RecoveryQuoteServer(current, prepared.prepareOperation.operationId);
    remote.quotes.set(historical.quote.quoteId, parseTeamSeatQuoteStatusResponse(historical));
    remote.prepareOperationIds.set(historical.quote.quoteId, originalPrepare.operation.operationId);
    const before = await recoverySnapshot({ database, organizationId });
    const next = await beginDirectMembershipSeatRequote({
      organizationId, membershipId: active.id, staleQuoteId: current.quote.quoteId, actorUserId,
      database, now: fixtureTime + 2_000, readQuoteStatus: remote.readQuoteStatus, revokeQuote: remote.revokeQuote,
    });
    assert.equal(next.membership.status, 'suspended');
    assert.equal(next.membership.userId, userId);
    assert.ok(next.prepareOperation.dedupeKey.includes(':reactivation:'), 'Refreshed preparation must retain the reactivation lifecycle marker.');
    assert.equal(getMembershipSeatPrepareRequest(next.prepareOperation).externalReference, active.id);
    assert.equal(remote.reads, 1, 'Only the current reactivation quote is read; consumed creation history is outside this lifecycle.');
    assert.equal(remote.retirements, 1);
    assert.equal(remote.quotes.get(historical.quote.quoteId)?.authorization.status, 'consumed');
    const renewed = structuredClone(current);
    renewed.quote.quoteId = randomUUID();
    renewed.quote.quoteHash = `renewed-reactivation-${randomUUID()}`;
    renewed.quote.expiresAt = new Date(fixtureTime + 10_000).toISOString();
    renewed.authorization.authorizationId = randomUUID();
    renewed.authorization.quoteId = renewed.quote.quoteId;
    renewed.authorization.quoteHash = renewed.quote.quoteHash;
    renewed.authorization.expiresAt = renewed.quote.expiresAt;
    let remotePrepareCalls = 0;
    const dispatched = await dispatchDirectMembershipSeatPreparation({
      activation: next, actorUserId, database,
      prepareSeatChange: async () => { remotePrepareCalls += 1; return renewed; },
    });
    assert.equal(remotePrepareCalls, 1, 'A valid refreshed reactivation must remain dispatchable.');
    assert.equal(dispatched.activation.membership.status, 'suspended');
    assert.equal(dispatched.activation.membership.userId, userId);
    assert.ok(dispatched.activation.executeOperation);
    assert.deepEqual(await database.all(`
      SELECT * FROM team_seat_outbox WHERE operation_id IN ($1, $2) ORDER BY id
    `, [originalPrepare.operation.operationId, originalExecute.operation.operationId]), historyBefore);
    assert.deepEqual((await recoverySnapshot({ database, organizationId })).projection, before.projection);
  });
}

async function reactivationCannotDiscardEarlierRemovalPreparation() {
  await withTeamSeatTestDatabase(async (database) => {
    const organizationId = `removal-reactivation-${randomUUID()}`;
    const actorUserId = `owner-${organizationId}`;
    const userId = `removal-member-${randomUUID()}`;
    await seedTeamSeatOrganization(database, organizationId, fixtureTime);
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Removal member', $2, 1, 'user', $3, $3)
    `, [userId, `${userId}@example.test`, fixtureTime]);
    await adoptActiveTeamMembership(database, {
      organizationId, userId: actorUserId, role: 'owner', source: 'first_owner', now: fixtureTime,
    });
    const active = await adoptActiveTeamMembership(database, {
      organizationId, userId, role: 'member', source: 'migration', now: fixtureTime + 1,
    });
    await transitionTeamMembership(database, {
      organizationId, membershipId: active.id, expectedStatus: 'active', toStatus: 'suspended',
      actorUserId, source: 'local_admin', reason: 'Isolated concurrent reactivation fixture',
      seatOperationType: 'member_remove', enqueueSeatReduction: true, now: fixtureTime + 20,
    });
    const row = await database.get(`
      SELECT operation_id FROM team_seat_outbox WHERE organization_id = $1 AND membership_id = $2
        AND operation_kind = 'seat_prepare' AND operation_type = 'member_remove'
    `, [organizationId, active.id]) as { operation_id: string };
    assert.ok(row, 'Suspension must persist the Seat removal preparation.');
    const removal = await getTeamSeatOutboxOperation(database, row.operation_id);
    assert.ok(removal);
    const beforeReactivation = await recoverySnapshot({ database, organizationId });
    try {
      await beginSuspendedMembershipReactivation({
        organizationId, membershipId: active.id, actorUserId, database, now: fixtureTime + 30,
      });
    } catch (error) {
      assert.ok(error instanceof MembershipOrchestratorError && error.code === 'MEMBERSHIP_OPERATION_CONFLICT');
      assert.deepEqual(await recoverySnapshot({ database, organizationId }), beforeReactivation,
        'If reactivation waits for Seat removal, it must reject before enqueuing another Prepare.');
    }
    const prepared = parseTeamSeatPrepareResponse(structuredClone(fixtures.positive.seatChange.prepare));
    prepared.quote.quoteId = randomUUID();
    prepared.quote.quoteHash = `removal-quote-${randomUUID()}`;
    prepared.quote.quantityBefore = 2;
    prepared.quote.quantityAfter = 1;
    prepared.quote.quantityDelta = -1;
    prepared.authorization.authorizationId = randomUUID();
    prepared.authorization.quoteId = prepared.quote.quoteId;
    prepared.authorization.quoteHash = prepared.quote.quoteHash;
    prepared.authorization.quantityBefore = 2;
    prepared.authorization.quantityAfter = 1;
    prepared.snapshot.revision = removal.membershipRevision!;
    prepared.snapshot.observedQuantity = 1;
    prepared.snapshot.licensedQuantity = 2;
    const persisted = await recordDirectMembershipSeatPreparation({
      organizationId, membershipId: active.id, prepareOperationId: removal.operationId,
      response: prepared, actorUserId, database, now: fixtureTime + 40,
    });
    assert.equal(persisted.membership.status, 'suspended');
    assert.equal(persisted.membership.userId, userId);
    assert.equal(persisted.prepareOperation.status, 'succeeded');
    assert.equal(persisted.executeOperation?.operationType, 'member_remove');
    assert.equal(persisted.executeOperation?.status, 'pending');
  });
}

async function claimRecoveryExecution(fixture: RecoveryFixture, now = fixture.now) {
  assert.ok(fixture.prepared.executeOperation);
  const claim = await claimTeamSeatOutboxOperation(fixture.database, {
    operationId: fixture.prepared.executeOperation.operationId, allowPending: true, now,
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.operation.status, 'processing');
  return claim.operation;
}

function executionRejection(code: 'TEAM_SEAT_QUOTE_STALE' | 'TEAM_SEAT_AUTHORIZATION_EXPIRED') {
  return new LicenseControlPlaneError('The isolated Seat execution was rejected.', 409, code);
}

async function knownClaimRejectionAllowsImmediateRecovery() {
  for (const code of ['TEAM_SEAT_QUOTE_STALE', 'TEAM_SEAT_AUTHORIZATION_EXPIRED'] as const) {
    for (const action of [requestRequote, requestCancel]) {
      await withRecoveryFixture(async (fixture) => {
        const operation = await claimRecoveryExecution(fixture);
        const originalError = executionRejection(code);
        Object.freeze(originalError);
        assert.equal(originalError.category, 'business');
        const before = await recoverySnapshot(fixture);
        assert.equal(await recordMembershipSeatExecutionRejection({
          operation, error: originalError, database: fixture.database, now: fixture.now + 1,
        }), true);
        const failed = await getTeamSeatOutboxOperation(fixture.database, operation.operationId);
        assert.equal(failed?.status, 'failed');
        assert.equal(failed?.lastErrorCode, originalError.code);
        assert.equal(failed?.lastError, originalError.message);
        assert.equal(failed?.completedAt, fixture.now + 1);
        assert.equal(failed?.nextAttemptAt, null);
        assert.equal(failed?.responseJson, null);
        assert.equal(failed?.controlPlaneOperationId, null);
        assert.equal(failed?.requestJson, operation.requestJson);
        assert.equal(failed?.requestHash, operation.requestHash);
        assert.equal(failed?.attemptCount, operation.attemptCount + 1);
        const after = await recoverySnapshot(fixture);
        assert.deepEqual(after.memberships, before.memberships);
        assert.deepEqual(after.invitations, before.invitations);
        assert.deepEqual(after.events, before.events);
        assert.deepEqual(after.sync, before.sync);
        assert.deepEqual(after.projection, before.projection);
        const quote = await getDirectMembershipSeatQuote({
          organizationId: fixture.organizationId, membershipId: fixture.accepted.membership.id, database: fixture.database,
        });
        assert.ok(Date.parse(quote.preparation.quote.expiresAt) > fixture.now);
        assert.equal(membershipSeatQuoteNeedsRefresh(quote, fixture.now + 2), true);
        assert.equal(await recordMembershipSeatExecutionRejection({
          operation, error: executionRejection(code === 'TEAM_SEAT_QUOTE_STALE'
            ? 'TEAM_SEAT_AUTHORIZATION_EXPIRED' : 'TEAM_SEAT_QUOTE_STALE'),
          database: fixture.database, now: fixture.now + 2,
        }), false, 'A second rejection must preserve the original recorded failure.');
        assert.deepEqual(await getTeamSeatOutboxOperation(fixture.database, operation.operationId), failed);
        fixture.now += 3;
        assert.ok(fixture.now - operation.lastAttemptAt! < 60_000);
        await action(fixture);
        assert.deepEqual(await getTeamSeatOutboxOperation(fixture.database, operation.operationId), failed);
      });
    }
  }
}

async function uncertainExecutionRejectionsKeepOwnedClaim() {
  const errors = [
    new Error('The isolated socket closed without a response.'),
    new LicenseControlPlaneError('Temporary isolated failure.', 503, 'TEAM_SEAT_UPSTREAM_UNAVAILABLE', true, 2),
    new LicenseControlPlaneError('Retryable isolated conflict.', 409, 'TEAM_SEAT_QUOTE_STALE', true, 2),
    new LicenseControlPlaneError('Authorization might already be consumed.', 409, 'TEAM_SEAT_AUTHORIZATION_REPLAY'),
    new LicenseControlPlaneError('Instance authorization rejected.', 401, 'TEAM_SEAT_QUOTE_STALE'),
    new LicenseControlPlaneError('Unexpected upstream status.', 503, 'TEAM_SEAT_QUOTE_STALE'),
    { status: 409, code: 'TEAM_SEAT_QUOTE_STALE', retryable: false, category: 'business' },
  ];
  for (const error of errors) {
    await withRecoveryFixture(async (fixture) => {
      const operation = await claimRecoveryExecution(fixture);
      const before = await recoverySnapshot(fixture);
      assert.equal(await recordMembershipSeatExecutionRejection({
        operation, error, database: fixture.database, now: fixture.now + 1,
      }), false);
      assert.deepEqual(await recoverySnapshot(fixture), before,
        'Network, retryable, replay, authentication, or untyped failures must keep the uncertain claim unchanged.');
    });
  }
}

async function olderExecutionRejectionCannotOverwriteProgress() {
  const changes = ['new-claim', 'attempt-count', 'next-attempt', 'updated-at', 'request', 'response', 'remote-operation', 'succeeded'] as const;
  for (const change of changes) {
    await withRecoveryFixture(async (fixture) => {
      const operation = await claimRecoveryExecution(fixture);
      if (change === 'new-claim') {
        const newer = await claimTeamSeatOutboxOperation(fixture.database, {
          operationId: operation.operationId, allowPending: true, now: fixture.now + 60_001,
        });
        assert.equal(newer.claimed, true);
        assert.notEqual(newer.operation.lastAttemptAt, operation.lastAttemptAt);
      } else if (change === 'succeeded') {
        await recordTeamSeatOutboxOperationSuccess(fixture.database, {
          operationId: operation.operationId, response: fixtures.positive.seatChange.execute,
          controlPlaneOperationId: randomUUID(), now: fixture.now + 1,
        });
      } else {
        const updates: Record<Exclude<typeof change, 'new-claim' | 'succeeded'>, [string, unknown]> = {
          'attempt-count': ['attempt_count', operation.attemptCount + 1],
          'next-attempt': ['next_attempt_at', fixture.now + 10_000],
          'updated-at': ['updated_at', fixture.now + 1],
          request: ['request_json', JSON.stringify({ ...JSON.parse(operation.requestJson), operationKey: randomUUID() })],
          response: ['response_json', JSON.stringify({ unconfirmed: true })],
          'remote-operation': ['control_plane_operation_id', randomUUID()],
        };
        const [column, value] = updates[change];
        await fixture.database.run(`UPDATE team_seat_outbox SET ${column} = $1 WHERE operation_id = $2`, [value, operation.operationId]);
      }
      const before = await recoverySnapshot(fixture);
      assert.equal(await recordMembershipSeatExecutionRejection({
        operation, error: executionRejection('TEAM_SEAT_QUOTE_STALE'), database: fixture.database,
        now: fixture.now + 60_002,
      }), false);
      assert.deepEqual(await recoverySnapshot(fixture), before,
        `An earlier rejection must preserve later ${change} state exactly.`);
    });
  }
}

async function rejectedExecutionStillRequiresRemoteRetirementProof() {
  for (const mode of ['consumed', 'retirement-rejected'] as const) {
    await withRecoveryFixture(async (fixture) => {
      const operation = await claimRecoveryExecution(fixture);
      assert.equal(await recordMembershipSeatExecutionRejection({
        operation, error: executionRejection('TEAM_SEAT_QUOTE_STALE'), database: fixture.database, now: fixture.now + 1,
      }), true);
      if (mode === 'consumed') {
        const current = fixture.remote.quotes.get(fixture.preparation.quote.quoteId)!;
        current.authorization.status = 'consumed';
        current.authorization.consumedAt = new Date(fixture.now).toISOString();
      } else {
        fixture.remote.rejectRetirement = true;
      }
      await assertRejectedWithoutLocalMutation(fixture);
    });
  }
}

async function retirementBarrierFailureDoesNotChangeLocalState() {
  for (const mode of ['rejected', 'consumed-during-retire', 'binding-mismatch'] as const) {
    await withRecoveryFixture(async (fixture) => {
      fixture.remote.rejectRetirement = mode === 'rejected';
      fixture.remote.consumedBeforeRetirement = mode === 'consumed-during-retire';
      fixture.remote.mismatchRetirementResponse = mode === 'binding-mismatch';
      await assertRejectedWithoutLocalMutation(fixture);
      assert.ok(fixture.remote.retirements >= 1);
    }, { expired: true });
    console.log(`membership-seat-recovery-test: retirement barrier ${mode}`);
  }
}

async function main(): Promise<void> {
  const fetchBeforeTest = globalThis.fetch;
  globalThis.fetch = async () => {
    unexpectedHttpCalls += 1;
    throw new Error('Unexpected HTTP request in isolated membership Seat recovery test.');
  };
  try {
    for (const test of [expiredPendingExecutionRequotes, expiredPendingAuthorizationRequotes,
      staleUnexpiredExecutionRequotes, staleAcceptedInvitationCanBeCancelled,
      healthyQuoteCannotBeRefreshed, rejectsUnsafeExecutionStates,
      retirementBarrierFailureDoesNotChangeLocalState, unknownFailedPreparationBlocksRecovery,
      stalePreparationDispatchCannotContactRemoteService, recoveryAfterCachedPreparationClaimIsFenced,
      reactivationIgnoresConsumedHistoryAndPreservesLifecycleMarker,
      reactivationCannotDiscardEarlierRemovalPreparation,
      knownClaimRejectionAllowsImmediateRecovery, uncertainExecutionRejectionsKeepOwnedClaim,
      olderExecutionRejectionCannotOverwriteProgress, rejectedExecutionStillRequiresRemoteRetirementProof]) {
      await test();
    }
    console.log('membership-seat-recovery-test: production Requote, cancellation, and safe failure regressions passed');
  } finally {
    globalThis.fetch = fetchBeforeTest;
    assert.equal(unexpectedHttpCalls, 0, 'The regression suite must never contact a real provider or service.');
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
