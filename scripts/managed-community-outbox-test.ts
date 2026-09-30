import assert from 'node:assert/strict';

import { retireManagedCommunitySnapshotOperations } from '../app/lib/license/managed-community-outbox';
import { enqueueTeamSeatOutboxOperation, getTeamSeatOutboxOperation } from '../app/lib/license/team-seat-outbox';
import { adoptActiveTeamMembership, transitionTeamMembership, updateTeamMembershipRole } from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const now = Date.parse('2026-09-30T12:00:00.000Z');
const previousMode = process.env.CANVAS_DEPLOYMENT_MODE;

async function main() {
  await withTeamSeatTestDatabase(async (database) => {
    process.env.CANVAS_DEPLOYMENT_MODE = 'community';
    await seedTeamSeatOrganization(database, 'managed-retirement', now);
    const make = (key: string, kind: 'membership_snapshot' | 'license_refresh' | 'seat_prepare') =>
      enqueueTeamSeatOutboxOperation(database, { organizationId: 'managed-retirement', dedupeKey: key,
        operationKind: kind, request: {}, now });
    const snapshot = (await make('snapshot', 'membership_snapshot')).operation;
    const refresh = (await make('refresh', 'license_refresh')).operation;
    const failed = (await make('failed', 'membership_snapshot')).operation;
    const invitation = (await make('invitation', 'seat_prepare')).operation;
    const processing = (await make('processing', 'membership_snapshot')).operation;
    await database.run("UPDATE team_seat_outbox SET status = 'failed' WHERE operation_id = $1", [failed.operationId]);
    await database.run("UPDATE team_seat_outbox SET status = 'processing' WHERE operation_id = $1", [processing.operationId]);
    await database.run("UPDATE team_seat_outbox SET status = 'retry_wait' WHERE operation_id = $1", [refresh.operationId]);
    const input = { organizationId: 'managed-retirement', adoptionApproved: true, acknowledgedAt: now + 1, now: now + 2 };
    assert.equal(await retireManagedCommunitySnapshotOperations(database, input), 0);
    process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
    assert.equal(await retireManagedCommunitySnapshotOperations(database, { ...input, adoptionApproved: false }), 0);
    assert.equal(await retireManagedCommunitySnapshotOperations(database, { ...input, acknowledgedAt: null }), 0);
    assert.equal(await retireManagedCommunitySnapshotOperations(database, { ...input, acknowledgedAt: now + 3 }), 0);
    assert.equal(await retireManagedCommunitySnapshotOperations(database, input), 2);
    assert.equal(await retireManagedCommunitySnapshotOperations(database, input), 0);
    assert.equal((await getTeamSeatOutboxOperation(database, snapshot.operationId))?.status, 'canceled');
    assert.equal((await getTeamSeatOutboxOperation(database, refresh.operationId))?.status, 'canceled');
    assert.equal((await getTeamSeatOutboxOperation(database, failed.operationId))?.status, 'failed');
    assert.equal((await getTeamSeatOutboxOperation(database, invitation.operationId))?.status, 'pending');
    assert.equal((await getTeamSeatOutboxOperation(database, processing.operationId))?.status, 'processing');
    const audit = await database.get("SELECT COUNT(*)::int AS count FROM audit_events WHERE event_type = 'managed_community_outbox_retirement'") as { count: number };
    assert.equal(audit.count, 2);
    await assert.rejects(make('managed-refresh', 'license_refresh'), /Managed Team synchronization/);
    await assert.rejects(make('managed-snapshot', 'membership_snapshot'), /Managed Team synchronization/);
    const member = await adoptActiveTeamMembership(database, {
      organizationId: 'managed-retirement', userId: 'owner-managed-retirement', role: 'owner',
      source: 'reconciliation', seatOperationType: 'reconcile', now: now + 10,
    });
    await updateTeamMembershipRole(database, {
      organizationId: 'managed-retirement', userId: 'owner-managed-retirement',
      role: 'admin', actorUserId: 'owner-managed-retirement', now: now + 11,
    });
    await transitionTeamMembership(database, {
      organizationId: 'managed-retirement', membershipId: member.id,
      expectedStatus: 'active', toStatus: 'suspended', source: 'reconciliation',
      seatOperationType: 'member_remove', enqueueSeatReduction: true, now: now + 12,
    });
    const remaining = await database.get('SELECT COUNT(*)::int AS count FROM team_seat_outbox') as { count: number };
    assert.equal(remaining.count, 5, 'Managed local changes must not create Community operations');
  });
  console.log('Managed Community outbox retirement and enqueue isolation passed.');
}

main().finally(() => {
  if (previousMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
  else process.env.CANVAS_DEPLOYMENT_MODE = previousMode;
}).catch((error) => { console.error(error); process.exitCode = 1; });
