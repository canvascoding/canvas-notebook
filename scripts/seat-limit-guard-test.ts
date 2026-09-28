import assert from 'node:assert/strict';

import {
  assertOrganizationSeatProjectionNotOverLimit,
  assertSeatActivationCapacity,
  resolveEffectiveSeatPolicy,
  SeatLimitGuardError,
} from '../app/lib/license/seat-limit';
import type { LicenseStatus } from '../app/lib/license/types';
import { adoptActiveTeamMembership, createTeamMembershipCandidate } from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const organizationId = 'seat-limit-guard';
const team = (seatLimit: number, licenseState: LicenseStatus['licenseState'] = 'active') => ({
  plan: 'community', licensed: true, hostingMode: 'community', edition: 'team',
  licenseState, seatLimit,
}) as LicenseStatus;

async function main(): Promise<void> {
  assert.deepEqual(resolveEffectiveSeatPolicy(team(3)), {
    mode: 'team', seatLimit: 3, reason: 'team_license_active',
  });
  assert.equal(resolveEffectiveSeatPolicy(team(3, 'grace')).reason, 'team_license_offline_grace');
  assert.deepEqual(resolveEffectiveSeatPolicy(team(3, 'expired')), {
    mode: 'solo', seatLimit: 1, reason: 'team_license_grace_expired',
  });
  await withTeamSeatTestDatabase(async (database) => {
    await seedTeamSeatOrganization(database, organizationId, now);
    await adoptActiveTeamMembership(database, {
      organizationId, userId: `owner-${organizationId}`, role: 'owner', source: 'first_owner', now,
    });
    for (const status of ['invited', 'approval_required', 'billing_pending'] as const) {
      await createTeamMembershipCandidate(database, {
        organizationId, email: `${status}@example.test`, status, source: 'invitation', now,
      });
    }
    assert.deepEqual(await assertSeatActivationCapacity(database, {
      organizationId, desiredQuantity: 2, signedSeatLimit: 2,
    }), { observedQuantity: 1 });
    assert.deepEqual(await assertOrganizationSeatProjectionNotOverLimit({
      organizationId, database, licenseStatus: team(1),
    }), { seatLimit: 1, observedQuantity: 1 });
    await assert.rejects(assertSeatActivationCapacity(database, {
      organizationId, desiredQuantity: 2, signedSeatLimit: 1,
    }), (error: unknown) => error instanceof SeatLimitGuardError && error.code === 'SEAT_LIMIT_EXCEEDED');
    await assert.rejects(assertSeatActivationCapacity(database, {
      organizationId, desiredQuantity: 3, signedSeatLimit: 3,
    }), (error: unknown) => error instanceof SeatLimitGuardError && error.code === 'SEAT_ACTIVATION_STALE');
    await assert.rejects(assertOrganizationSeatProjectionNotOverLimit({
      organizationId, database, licenseStatus: team(2, 'expired'),
    }), (error: unknown) => error instanceof SeatLimitGuardError && error.code === 'SEAT_LIMIT_EXCEEDED');
  });
  console.info('seat-limit guard excludes pending members and requires signed capacity');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
