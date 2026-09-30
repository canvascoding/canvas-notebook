import assert from 'node:assert/strict';

import { assertUserSeatAccess, SeatLimitGuardError } from '../app/lib/license/seat-limit';
import type { LicenseStatus } from '../app/lib/license/types';
import { adoptActiveTeamMembership, createTeamMembershipCandidate } from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const organizationId = 'auth-seat-limit';
const ownerId = `owner-${organizationId}`;
const team = (seatLimit: number) => ({
  plan: 'community', licensed: true, hostingMode: 'community', edition: 'team',
  licenseState: 'active', seatLimit,
}) as LicenseStatus;
const solo = { plan: 'community', licensed: true, hostingMode: 'community', edition: 'solo',
  licenseState: 'active', seatLimit: 1 } as LicenseStatus;

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    await seedTeamSeatOrganization(database, organizationId, now);
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Member', 'member@example.test', 1, 'user', $2, $2),
             ($3, 'Pending', 'pending@example.test', 1, 'user', $2, $2)
    `, ['member-user', now, 'pending-user']);
    await adoptActiveTeamMembership(database, {
      organizationId, userId: ownerId, role: 'owner', source: 'first_owner', now,
    });
    await adoptActiveTeamMembership(database, {
      organizationId, userId: 'member-user', role: 'member', source: 'migration', now,
    });
    await createTeamMembershipCandidate(database, {
      organizationId, email: 'pending@example.test', status: 'approval_required', source: 'invitation', now,
    });
    for (const [userId, role] of [[ownerId, 'owner'], ['member-user', 'member']] as const) {
      await database.run(`
        INSERT INTO organization_user_permissions (organization_id, user_id, role, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', $4, $4)
      `, [organizationId, userId, role, now]);
    }

    const owner = await assertUserSeatAccess({ userId: ownerId, database, licenseStatus: team(1) });
    assert.equal(owner.observedQuantity, 2);
    assert.equal(owner.overallocated, true);
    await assert.rejects(assertUserSeatAccess({ userId: 'member-user', database, licenseStatus: team(1) }),
      (error: unknown) => error instanceof SeatLimitGuardError && error.code === 'SEAT_LIMIT_EXCEEDED');
    const member = await assertUserSeatAccess({ userId: 'member-user', database, licenseStatus: team(2) });
    assert.equal(member.overallocated, false);
    await assert.rejects(assertUserSeatAccess({ userId: 'pending-user', database, licenseStatus: team(3) }),
      (error: unknown) => error instanceof SeatLimitGuardError && error.code === 'SEAT_MEMBERSHIP_REQUIRED');
    assert.equal((await assertUserSeatAccess({ userId: ownerId, database, licenseStatus: solo })).mode, 'solo');
    await assert.rejects(assertUserSeatAccess({ userId: 'member-user', database, licenseStatus: solo }),
      (error: unknown) => error instanceof SeatLimitGuardError && error.code === 'SEAT_LIMIT_EXCEEDED');
    await database.run(`UPDATE "user" SET banned = 1 WHERE id = $1`, ['member-user']);
    await assert.rejects(assertUserSeatAccess({ userId: 'member-user', database, licenseStatus: team(2) }),
      (error: unknown) => error instanceof SeatLimitGuardError && error.code === 'SEAT_ACCESS_INACTIVE');
  });
  console.info('auth seat access enforces active membership, signed capacity, and account ban');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
