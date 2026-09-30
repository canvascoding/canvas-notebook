import assert from 'node:assert/strict';

import { adoptActiveTeamMembership, getTeamMembershipByUserId } from '../app/lib/organization/team-membership';
import { MembershipSuspensionError, suspendTeamMembershipUser } from '../app/lib/organization/membership-suspension';
import { TEAM_MEMBERSHIP_SUSPENSION_BAN_PREFIX } from '../app/lib/organization/membership-ban-reasons';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

process.env.CANVAS_DEPLOYMENT_MODE = 'community';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const organizationId = 'membership-suspension';
const ownerId = `owner-${organizationId}`;
const memberId = 'suspended-member';

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    await seedTeamSeatOrganization(database, organizationId, now);
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Member', 'suspended-member@example.test', 1, 'user', $2, $2)
    `, [memberId, now]);
    await adoptActiveTeamMembership(database, {
      organizationId, userId: ownerId, role: 'owner', source: 'first_owner', now,
    });
    await adoptActiveTeamMembership(database, {
      organizationId, userId: memberId, role: 'member', source: 'migration', now,
    });
    for (const [userId, role] of [[ownerId, 'owner'], [memberId, 'member']] as const) {
      await database.run(`
        INSERT INTO organization_user_permissions (organization_id, user_id, role, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', $4, $4)
      `, [organizationId, userId, role, now]);
    }
    await database.run(`
      INSERT INTO "session" (id, user_id, token, expires_at, created_at, updated_at)
      VALUES ('member-session', $1, 'member-token', $2, $3, $3)
    `, [memberId, now + 60_000, now]);

    await assert.rejects(suspendTeamMembershipUser({
      organizationId, targetUserId: ownerId, actorUserId: memberId, database, now,
    }), (error: unknown) => error instanceof MembershipSuspensionError && error.code === 'MEMBERSHIP_LAST_OWNER');
    await assert.rejects(suspendTeamMembershipUser({
      organizationId, targetUserId: memberId, actorUserId: memberId, database, now,
    }), (error: unknown) => error instanceof MembershipSuspensionError && error.code === 'MEMBERSHIP_SELF_SUSPENSION');

    const result = await suspendTeamMembershipUser({
      organizationId, targetUserId: memberId, actorUserId: ownerId,
      reason: 'Access revoked', database, now: now + 1,
    });
    assert.equal(result.membership.status, 'suspended');
    assert.equal(result.sessionsRevoked, 1);
    assert.equal(result.replayed, false);
    const user = await database.get(`SELECT banned, ban_reason FROM "user" WHERE id = $1`, [memberId]) as {
      banned: number; ban_reason: string;
    };
    assert.equal(Number(user.banned), 1);
    assert.equal(user.ban_reason, `${TEAM_MEMBERSHIP_SUSPENSION_BAN_PREFIX}Access revoked`);
    assert.equal((await database.get(`SELECT COUNT(*) AS count FROM "session" WHERE user_id = $1`, [memberId]) as { count: number }).count, 0);
    assert.equal((await getTeamMembershipByUserId(database, organizationId, memberId))?.status, 'suspended');
    assert.equal((await getTeamMembershipByUserId(database, organizationId, ownerId))?.status, 'active');
  });
  console.info('membership suspension protects owner and revokes member sessions');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
