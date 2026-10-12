import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { SqlConnection } from '../app/lib/db';
import fixtures from '../app/lib/license/fixtures/team-seat-protocol-v1.json';
import {
  enqueueTeamSeatOutboxOperation,
  type TeamSeatOutboxStatus,
} from '../app/lib/license/team-seat-outbox';
import {
  getMemberSeatReductionStatuses,
  type MemberSeatReductionStatus,
} from '../app/lib/organization/member-seat-reduction-status';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const organizationId = 'removal-status';
const otherOrganizationId = 'other-removal-status';
const sensitiveText = 'private-authorization-certificate-error-payload';

async function seedMembership(
  database: SqlConnection,
  userId: string,
  organization = organizationId,
  status: 'active' | 'suspended' | 'removed' = 'removed',
): Promise<string> {
  const membershipId = `${organization}:${userId}`;
  await database.run(`
    INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
    VALUES ($1, 'Test Member', $2, 1, 'user', $3, $3)
    ON CONFLICT (id) DO NOTHING
  `, [userId, `${userId}@example.test`, now]);
  await database.run(`
    INSERT INTO team_memberships (
      id, organization_id, candidate_email, user_id, role, status,
      accepted_at, activated_at, suspended_at, removed_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'member', $5, $6, $6, $7, $8, $6, $6)
  `, [
    membershipId, organization, `${userId}@example.test`, userId, status, now,
    status === 'suspended' ? now : null, status === 'removed' ? now : null,
  ]);
  return membershipId;
}

async function prepare(
  database: SqlConnection,
  input: {
    membershipId: string;
    revision?: number;
    status?: TeamSeatOutboxStatus;
    organization?: string;
    errorCode?: string;
  },
): Promise<{ authorizationId: string; operationId: string; revision: number }> {
  const revision = input.revision ?? 1;
  const authorizationId = randomUUID();
  const response = structuredClone(fixtures.positive.seatChange.prepare);
  response.quote.quantityBefore = 4;
  response.quote.quantityAfter = 2;
  response.quote.quantityDelta = -2;
  response.authorization.authorizationId = authorizationId;
  response.authorization.quantityBefore = 4;
  response.authorization.quantityAfter = 2;
  response.snapshot.observedQuantity = 2;
  response.snapshot.licensedQuantity = 4;
  const entry = await enqueueTeamSeatOutboxOperation(database, {
    organizationId: input.organization ?? organizationId,
    membershipId: input.membershipId,
    membershipRevision: revision,
    dedupeKey: `prepare:${input.membershipId}:${revision}`,
    operationKind: 'seat_prepare',
    operationType: 'member_remove',
    request: { desiredQuantity: 2, triggerType: 'member_remove', externalReference: input.membershipId },
    now: now + revision,
  });
  await database.run(`
    UPDATE team_seat_outbox
    SET status = $1, response_json = $2, last_error_code = $3, last_error = $4
    WHERE operation_id = $5
  `, [input.status ?? 'succeeded', JSON.stringify(response), input.errorCode ?? null, sensitiveText, entry.operation.operationId]);
  return { authorizationId, operationId: entry.operation.operationId, revision };
}

async function execute(
  database: SqlConnection,
  input: {
    membershipId: string;
    chain: Awaited<ReturnType<typeof prepare>>;
    status?: TeamSeatOutboxStatus;
    organization?: string;
    errorCode?: string;
    membershipRevision?: number;
  },
): Promise<string> {
  const response = structuredClone(fixtures.positive.seatChange.execute);
  response.operation.operationKey = input.chain.authorizationId;
  response.operation.operationType = 'member_remove';
  response.operation.previousQuantity = 4;
  response.operation.requestedQuantity = 2;
  response.operation.effectiveQuantity = 2;
  const entry = await enqueueTeamSeatOutboxOperation(database, {
    organizationId: input.organization ?? organizationId,
    operationId: input.chain.authorizationId,
    membershipId: input.membershipId,
    membershipRevision: input.membershipRevision ?? input.chain.revision,
    dedupeKey: `execute:${input.chain.authorizationId}`,
    operationKind: 'seat_execute',
    operationType: 'member_remove',
    request: {
      authorizationId: input.chain.authorizationId,
      operationKey: input.chain.authorizationId,
      operationType: 'member_remove',
    },
    now: now + input.chain.revision + 1,
  });
  await database.run(`
    UPDATE team_seat_outbox
    SET status = $1, response_json = $2, last_error_code = $3, last_error = $4
    WHERE operation_id = $5
  `, [input.status ?? 'succeeded', JSON.stringify({
    ...response,
    license: { details: response.license.details, certificatePersisted: true },
  }), input.errorCode ?? null, sensitiveText, entry.operation.operationId]);
  return entry.operation.operationId;
}

function expected(
  userId: string,
  state: MemberSeatReductionStatus['state'],
  phase: MemberSeatReductionStatus['phase'],
  errorCode: string | null = null,
): MemberSeatReductionStatus {
  return { userId, state, phase, errorCode };
}

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    await seedTeamSeatOrganization(database, organizationId, now);
    await seedTeamSeatOrganization(database, otherOrganizationId, now);
    const read = (userIds: string[], organization = organizationId) => (
      getMemberSeatReductionStatuses(database, { organizationId: organization, userIds })
    );

    const pendingPrepare = await seedMembership(database, 'pending-prepare');
    await prepare(database, { membershipId: pendingPrepare, status: 'retry_wait', errorCode: 'TEMPORARY_NETWORK_ERROR' });
    const pendingExecute = await seedMembership(database, 'pending-execute', organizationId, 'suspended');
    const pendingChain = await prepare(database, { membershipId: pendingExecute });
    await execute(database, { membershipId: pendingExecute, chain: pendingChain, status: 'pending' });
    const missingExecute = await seedMembership(database, 'missing-execute');
    await prepare(database, { membershipId: missingExecute });
    const complete = await seedMembership(database, 'complete');
    const completeChain = await prepare(database, { membershipId: complete });
    await execute(database, { membershipId: complete, chain: completeChain });
    const failedPrepare = await seedMembership(database, 'failed-prepare');
    await prepare(database, { membershipId: failedPrepare, status: 'failed', errorCode: 'MEMBERSHIP_SEAT_RESPONSE_INVALID' });
    const failedExecute = await seedMembership(database, 'failed-execute');
    const failedChain = await prepare(database, { membershipId: failedExecute });
    await execute(database, { membershipId: failedExecute, chain: failedChain, status: 'failed', errorCode: 'TEAM_SEAT_QUOTE_STALE' });
    await seedMembership(database, 'no-chain');
    const addOnly = await seedMembership(database, 'add-only');
    const failedAdd = await enqueueTeamSeatOutboxOperation(database, {
      organizationId,
      membershipId: addOnly,
      dedupeKey: 'unrelated-member-create',
      operationKind: 'seat_prepare',
      operationType: 'member_create',
      request: { desiredQuantity: 4, triggerType: 'member_create', externalReference: addOnly },
      now,
    });
    await database.run(`UPDATE team_seat_outbox SET status = 'failed' WHERE operation_id = $1`, [failedAdd.operation.operationId]);

    assert.deepEqual(await read([
      'pending-prepare', 'pending-execute', 'missing-execute', 'complete', 'failed-prepare', 'failed-execute', 'no-chain', 'add-only',
    ]), [
      expected('pending-prepare', 'pending', 'prepare', 'TEMPORARY_NETWORK_ERROR'),
      expected('pending-execute', 'pending', 'execute'),
      expected('missing-execute', 'pending', 'execute'),
      expected('complete', 'completed', 'execute'),
      expected('failed-prepare', 'failed', 'prepare', 'MEMBERSHIP_SEAT_RESPONSE_INVALID'),
      expected('failed-execute', 'failed', 'execute', 'TEAM_SEAT_QUOTE_STALE'),
    ]);

    // Older errors and successes must never replace the latest removal lifecycle.
    const historical = await seedMembership(database, 'historical-errors');
    for (let revision = 1; revision <= 60; revision += 1) {
      await prepare(database, { membershipId: historical, revision, status: 'failed', errorCode: 'HISTORICAL_FAILURE' });
    }
    await prepare(database, { membershipId: historical, revision: 61, status: 'pending' });
    assert.deepEqual(await read(['complete', 'historical-errors']), [
      expected('complete', 'completed', 'execute'), expected('historical-errors', 'pending', 'prepare'),
    ]);
    await prepare(database, { membershipId: complete, revision: 2, status: 'pending' });
    assert.deepEqual(await read(['complete']), [expected('complete', 'pending', 'prepare')]);

    // Current active users and removals from an earlier activation are excluded.
    const active = await seedMembership(database, 'active', organizationId, 'active');
    await prepare(database, { membershipId: active, status: 'failed' });
    const reactivated = await seedMembership(database, 'reactivated');
    await prepare(database, { membershipId: reactivated, status: 'failed' });
    await database.run(`UPDATE team_memberships SET activated_at = $1 WHERE id = $2`, [now + 100, reactivated]);
    assert.deepEqual(await read(['active', 'reactivated']), []);

    // A shared user identity cannot reveal another organization's operation state.
    const sharedLocal = await seedMembership(database, 'shared');
    const sharedOther = await seedMembership(database, 'shared', otherOrganizationId);
    await prepare(database, { membershipId: sharedLocal, status: 'pending' });
    const otherChain = await prepare(database, { membershipId: sharedOther, organization: otherOrganizationId });
    await execute(database, { membershipId: sharedOther, organization: otherOrganizationId, chain: otherChain });
    const otherOnly = await seedMembership(database, 'other-only', otherOrganizationId);
    await prepare(database, { membershipId: otherOnly, organization: otherOrganizationId, status: 'failed' });
    assert.deepEqual(await read(['shared', 'other-only']), [expected('shared', 'pending', 'prepare')]);
    assert.deepEqual(await read(['shared'], otherOrganizationId), [expected('shared', 'completed', 'execute')]);

    const corrupt = await seedMembership(database, 'corrupt-prepare');
    const corruptChain = await prepare(database, { membershipId: corrupt });
    await execute(database, { membershipId: corrupt, chain: corruptChain });
    await database.run(`UPDATE team_seat_outbox SET response_json = '{broken' WHERE operation_id = $1`, [corruptChain.operationId]);
    assert.deepEqual(await read(['corrupt-prepare']), [expected('corrupt-prepare', 'failed', 'prepare', 'MEMBERSHIP_SEAT_RESPONSE_INVALID')]);

    const unconfirmed = await seedMembership(database, 'unconfirmed-execute');
    const unconfirmedChain = await prepare(database, { membershipId: unconfirmed });
    const unconfirmedExecution = await execute(database, { membershipId: unconfirmed, chain: unconfirmedChain });
    for (const response of [null, '{broken', JSON.stringify({ operation: fixtures.positive.seatChange.execute.operation })]) {
      await database.run(`UPDATE team_seat_outbox SET response_json = $1 WHERE operation_id = $2`, [response, unconfirmedExecution]);
      assert.deepEqual(await read(['unconfirmed-execute']), [expected('unconfirmed-execute', 'failed', 'execute', 'MEMBERSHIP_SEAT_NOT_CONFIRMED')]);
    }
    const validOperation = {
      ...fixtures.positive.seatChange.execute.operation,
      operationKey: unconfirmedChain.authorizationId,
      operationType: 'member_remove',
      previousQuantity: 4,
      requestedQuantity: 2,
      effectiveQuantity: 2,
    };
    for (const response of [
      { operation: validOperation, license: { certificatePersisted: false } },
      { operation: { ...validOperation, certificateReissueStatus: 'pending' }, license: { certificatePersisted: true } },
      { operation: { ...validOperation, effectiveQuantity: 3 }, license: { certificatePersisted: true } },
    ]) {
      await database.run(`UPDATE team_seat_outbox SET response_json = $1 WHERE operation_id = $2`, [JSON.stringify(response), unconfirmedExecution]);
      assert.deepEqual(await read(['unconfirmed-execute']), [expected('unconfirmed-execute', 'failed', 'execute', 'MEMBERSHIP_SEAT_NOT_CONFIRMED')]);
    }

    const wrongRevision = await seedMembership(database, 'wrong-revision');
    const wrongRevisionChain = await prepare(database, { membershipId: wrongRevision, revision: 5 });
    await execute(database, { membershipId: wrongRevision, chain: wrongRevisionChain, membershipRevision: 4 });
    assert.deepEqual(await read(['wrong-revision']), [expected('wrong-revision', 'pending', 'execute')]);

    const selected = await read(['pending-execute', 'failed-execute', 'historical-errors', 'shared', 'shared']);
    assert.equal(selected.length, 4);
    assert.equal(JSON.stringify(selected).includes(sensitiveText), false);
    assert.equal(JSON.stringify(selected).includes(pendingChain.authorizationId), false);
    for (const status of selected) assert.deepEqual(Object.keys(status), ['userId', 'state', 'phase', 'errorCode']);
    assert.deepEqual(await read([]), []);
    await assert.rejects(read(Array.from({ length: 101 }, (_, index) => `user-${index}`)), RangeError);
  });
  console.log('member-seat-reduction-status-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
