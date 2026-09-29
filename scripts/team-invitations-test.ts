import assert from 'node:assert/strict';

import {
  acceptTeamMembershipInvitation,
  createTeamMembershipInvitation,
  previewTeamMembershipInvitation,
  revokeTeamMembershipInvitation,
  TeamInvitationError,
} from '../app/lib/organization/team-invitations';
import { getTeamMembershipById } from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

process.env.CANVAS_DEPLOYMENT_MODE = 'community';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const organizationId = 'team-invitations';
const actorUserId = `owner-${organizationId}`;
const requestId = '6763b812-3d13-467f-bb70-540f7d40bb96';
const differentRequestId = '7752d650-3767-48c6-a250-f75c840f2e1e';

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    await seedTeamSeatOrganization(database, organizationId, now);
    const created = await createTeamMembershipInvitation({
      organizationId, actorUserId, email: ' Invitee@Example.Test ',
      displayName: 'Invitee', role: 'member', database, now,
    });
    assert.equal(created.invitation.status, 'pending');
    assert.equal(created.membership.status, 'invited');
    assert.equal((await previewTeamMembershipInvitation({ token: created.token, database, now })).resumeRequestId, null);

    const accepted = await acceptTeamMembershipInvitation({ token: created.token, requestId, database, now: now + 1 });
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.membership.status, 'approval_required');
    assert.equal(accepted.membership.userId, null);
    assert.equal((await previewTeamMembershipInvitation({ token: created.token, database, now: now + 2 })).resumeRequestId, requestId);
    const replay = await acceptTeamMembershipInvitation({ token: created.token, requestId, database, now: now + 2 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.membership.id, accepted.membership.id);
    await assert.rejects(acceptTeamMembershipInvitation({
      token: created.token, requestId: differentRequestId, database, now: now + 2,
    }), (error: unknown) => error instanceof TeamInvitationError && error.code === 'INVITATION_ALREADY_USED');

    const declined = await revokeTeamMembershipInvitation({
      organizationId, invitationId: created.invitation.id, actorUserId, database, now: now + 3,
    });
    assert.equal(declined.status, 'revoked');
    assert.equal((await getTeamMembershipById(database, organizationId, created.membership.id))?.status, 'removed');
    await assert.rejects(previewTeamMembershipInvitation({ token: created.token, database, now: now + 4 }),
      (error: unknown) => error instanceof TeamInvitationError && error.code === 'INVITATION_REVOKED');

    const expiring = await createTeamMembershipInvitation({
      organizationId, actorUserId, email: 'expiring@example.test', role: 'member',
      ttlMs: 15 * 60_000, database, now,
    });
    await assert.rejects(acceptTeamMembershipInvitation({
      token: expiring.token, requestId: differentRequestId, database, now: now + 15 * 60_000,
    }), (error: unknown) => error instanceof TeamInvitationError && error.code === 'INVITATION_EXPIRED');
    assert.equal((await getTeamMembershipById(database, organizationId, expiring.membership.id))?.status, 'removed');
  });
  console.info('invitation accept replay, conflicting ID, decline, and expiry passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
