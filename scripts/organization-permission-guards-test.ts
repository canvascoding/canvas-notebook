import assert from 'node:assert/strict';
import {
  assertOrganizationPermission,
  hasOrganizationPermission,
  isOrganizationAdminLike,
  isOrganizationBillingApprover,
  OrganizationPermissionError,
} from '../app/lib/organization/permissions';
import type { OrganizationPermissionSnapshot } from '../app/lib/organization/contracts';
import {
  ensureOrganizationPermissionRow,
  OrganizationPermissionProvisioningError,
} from '../app/lib/organization/permission-provisioning';
import {
  adoptActiveTeamMembership,
  getActiveTeamMembershipProjection,
  getTeamMembershipByUserId,
  updateTeamMembershipRole,
} from '../app/lib/organization/team-membership';
import { seedTeamSeatOrganization, withTeamSeatTestDatabase } from './team-seat-test-db';

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    const organizationId = 'permission-guards-test';
    const ownerId = `owner-${organizationId}`;
    const memberId = 'permission-member';
    await seedTeamSeatOrganization(database, organizationId, now);
    await database.run(`
      INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at)
      VALUES ($1, 'Member', 'member-permissions@example.test', 1, 'user', $2, $2)
    `, [memberId, now]);
    await adoptActiveTeamMembership(database, {
      organizationId, userId: ownerId, role: 'owner', source: 'first_owner', now,
    });
    await adoptActiveTeamMembership(database, {
      organizationId, userId: memberId, role: 'member', source: 'migration', now,
    });
    await ensureOrganizationPermissionRow(database, {
      organizationId, userId: ownerId, role: 'owner', activateExisting: true, now,
    });
    await ensureOrganizationPermissionRow(database, {
      organizationId, userId: memberId, role: 'member', activateExisting: true, now,
    });
    const owner = await database.get(`SELECT * FROM organization_user_permissions WHERE organization_id = $1 AND user_id = $2`, [organizationId, ownerId]) as Record<string, unknown>;
    const member = await database.get(`SELECT * FROM organization_user_permissions WHERE organization_id = $1 AND user_id = $2`, [organizationId, memberId]) as Record<string, unknown>;
    assert.equal(owner.role, 'owner');
    assert.equal(owner.can_manage_backups, 1);
    assert.equal(member.can_manage_backups, 0);
    const ownerPermission = { role: 'owner', status: 'active', canManageBackups: true } as OrganizationPermissionSnapshot;
    const memberPermission = { role: 'member', status: 'active', canManageBackups: false } as OrganizationPermissionSnapshot;
    assert.equal(hasOrganizationPermission(ownerPermission, 'canManageBackups'), true);
    assert.equal(hasOrganizationPermission(memberPermission, 'canManageBackups'), false);
    assert.equal(isOrganizationAdminLike(ownerPermission), true);
    assert.equal(isOrganizationBillingApprover(memberPermission), false);
    assertOrganizationPermission(ownerPermission, 'canManageBackups');
    assert.throws(
      () => assertOrganizationPermission(memberPermission, 'canManageBackups'),
      (error) => error instanceof OrganizationPermissionError && error.status === 403,
    );
    assert.equal(hasOrganizationPermission({ ...ownerPermission, status: 'disabled' }, 'canManageBackups'), false);
    const before = await getActiveTeamMembershipProjection(database, organizationId);
    const updated = await updateTeamMembershipRole(database, {
      organizationId, userId: memberId, role: 'admin', actorUserId: ownerId, now: now + 1_000,
    });
    assert.equal(updated.role, 'admin');
    assert.equal((await getActiveTeamMembershipProjection(database, organizationId)).observedQuantity, before.observedQuantity);
    const replay = await updateTeamMembershipRole(database, {
      organizationId, userId: memberId, role: 'admin', actorUserId: ownerId, now: now + 2_000,
    });
    assert.equal(replay.role, 'admin');
    assert.equal((await getTeamMembershipByUserId(database, organizationId, memberId))?.role, 'admin');
    await ensureOrganizationPermissionRow(database, {
      organizationId, userId: ownerId, role: 'member', activateExisting: true, now: now + 3_000,
    });
    assert.equal((await database.get(`SELECT role FROM organization_user_permissions WHERE organization_id = $1 AND user_id = $2`, [organizationId, ownerId]) as { role: string }).role, 'owner');
    await database.run(`UPDATE organization_user_permissions SET status = 'archived' WHERE organization_id = $1 AND user_id = $2`, [organizationId, memberId]);
    await assert.rejects(
      ensureOrganizationPermissionRow(database, {
        organizationId, userId: memberId, role: 'member', activateExisting: true, now: now + 4_000,
      }),
      (error) => error instanceof OrganizationPermissionProvisioningError
        && error.code === 'ORGANIZATION_PERMISSION_REACTIVATION_DENIED',
    );
  });
  console.log('organization-permission-guards-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
