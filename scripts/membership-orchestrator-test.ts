import assert from 'node:assert/strict';
import {
  beginDirectMembershipActivation,
  getMembershipSeatPrepareRequest,
  MembershipOrchestratorError,
} from '../app/lib/organization/membership-orchestrator';
import { adoptActiveTeamMembership } from '../app/lib/organization/team-membership';
import { getTeamSeatOutboxOperation } from '../app/lib/license/team-seat-outbox';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    const organizationId = 'membership-orchestrator-test';
    const actorUserId = `owner-${organizationId}`;
    await seedTeamSeatOrganization(database, organizationId, now);
    await adoptActiveTeamMembership(database, {
      organizationId,
      userId: actorUserId,
      role: 'owner',
      source: 'first_owner',
      now,
    });
    const input = {
      organizationId,
      actorUserId,
      email: 'new-member@example.test',
      displayName: 'New Member',
      role: 'member' as const,
      database,
      now: now + 1_000,
    };
    const first = await beginDirectMembershipActivation(input);
    assert.equal(first.stage, 'seat_prepare_pending');
    assert.equal(first.membership.status, 'approval_required');
    assert.equal(first.membership.userId, null);
    assert.equal(first.observedQuantity, 1);
    assert.equal(first.desiredQuantity, 2);
    assert.equal(first.prepareOperation.operationKind, 'seat_prepare');
    assert.equal(first.replayed, false);
    const prepareRequest = getMembershipSeatPrepareRequest(first.prepareOperation);
    assert.equal(prepareRequest.desiredQuantity, 2);
    assert.equal(prepareRequest.externalReference, first.membership.id);
    assert.equal((await getTeamSeatOutboxOperation(database, first.prepareOperation.operationId))?.status, 'pending');
    const replay = await beginDirectMembershipActivation(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.membership.id, first.membership.id);
    assert.equal(replay.prepareOperation.operationId, first.prepareOperation.operationId);
    await assert.rejects(
      beginDirectMembershipActivation({ ...input, role: 'admin' }),
      (error) => error instanceof MembershipOrchestratorError && error.code === 'MEMBERSHIP_OPERATION_CONFLICT',
    );
    await assert.rejects(
      beginDirectMembershipActivation({ ...input, email: 'other@example.test', displayName: ' ' }),
      (error) => error instanceof MembershipOrchestratorError && error.status === 400,
    );
  });
  console.log('membership-orchestrator-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
