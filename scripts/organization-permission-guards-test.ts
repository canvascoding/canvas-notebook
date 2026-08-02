import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-org-permissions-'));
process.env.DATA = dataDir;

function insertMemberPermission(sqlite: Database.Database, organizationId: string, userId: string) {
  const now = Date.now();
  const email = `${userId}@example.test`;
  sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, 'Member User', email, 1, null, 'user', null, null, null, now, now);

  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role,
      can_write_team_workspace, can_create_public_links, can_create_team_automations,
      can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
      can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    organizationId,
    userId,
    'member',
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    now,
    now,
  );
}

function insertActiveMembership(
  sqlite: Database.Database,
  organizationId: string,
  userId: string,
  email: string,
  role: 'owner' | 'admin' | 'member' | 'external',
) {
  sqlite.prepare(`
    INSERT INTO team_memberships (
      id,
      organization_id,
      candidate_email,
      user_id,
      role,
      status,
      invited_at,
      accepted_at,
      activated_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 1000, 1000, 1000, 1000, 1000)
  `).run(`membership-${userId}`, organizationId, email, userId, role);
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const {
    assertUserOrganizationPermission,
    getOrganizationUserPermissionDetails,
    hasOrganizationPermission,
    readOrganizationPermissionForUser,
    revokeOrganizationPermissionSessions,
    updateOrganizationPermissions,
    updateOrganizationRole,
  } = await import('../app/lib/organization/permissions');
  const {
    assertCanCreateRequestedAutomation,
    automationInputRequiresTeamPermission,
  } = await import('../app/lib/automations/api');

  const owner = await createInitialOwner({
    name: 'Owner User',
    email: 'owner@example.test',
    password: 'OwnerPassword123!',
  });

  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  const organization = sqlite.prepare(`
    SELECT organization_id AS organizationId
    FROM canvas_organization_settings
    LIMIT 1
  `).get() as { organizationId: string };

  assert.ok(organization.organizationId);
  assert.equal(existsSync(path.join(dataDir, 'users', owner.id, 'settings')), true);

  const ownerState = await readOrganizationPermissionForUser(owner.id);
  assert.equal(ownerState.permission?.role, 'owner');
  assert.equal(hasOrganizationPermission(ownerState.permission, 'canExport'), true);
  assert.equal(hasOrganizationPermission(ownerState.permission, 'canRecoverWorkspaces'), true);
  await assert.doesNotReject(async () => assertUserOrganizationPermission(owner.id, 'canExport'));

  const memberId = 'member-user-1';
  insertMemberPermission(sqlite, organization.organizationId, memberId);
  sqlite.close();

  const memberState = await readOrganizationPermissionForUser(memberId);
  assert.equal(memberState.permission?.role, 'member');
  assert.equal(hasOrganizationPermission(memberState.permission, 'canCreatePublicLinks'), true);
  assert.equal(hasOrganizationPermission(memberState.permission, 'canExport'), false);
  assert.equal(hasOrganizationPermission(memberState.permission, 'canDeleteStudioAssets'), true);
  assert.equal(hasOrganizationPermission(memberState.permission, 'canSharePluginsAndSkills'), false);
  await assert.doesNotReject(async () => assertUserOrganizationPermission(memberId, 'canCreatePublicLinks'));
  await assert.doesNotReject(async () => assertUserOrganizationPermission(memberId, 'canDeleteStudioAssets'));
  await assert.rejects(
    async () => assertUserOrganizationPermission(memberId, 'canExport'),
    /Missing organization permission: canExport/,
  );
  await assert.rejects(
    async () => assertUserOrganizationPermission(memberId, 'canSharePluginsAndSkills'),
    /Missing organization permission: canSharePluginsAndSkills/,
  );

  assert.equal(automationInputRequiresTeamPermission({ scope: 'personal' }), false);
  assert.equal(automationInputRequiresTeamPermission({ scope: 'team' }), true);
  await assert.doesNotReject(async () => assertCanCreateRequestedAutomation({ scope: 'personal' }, { id: memberId }));
  await assert.rejects(
    async () => assertCanCreateRequestedAutomation({ workspaceType: 'team' }, { id: memberId }),
    /Team automation permission required/,
  );

  const permissionsDb = new Database(path.join(dataDir, 'sqlite.db'));
  permissionsDb.prepare(`
    UPDATE organization_user_permissions
    SET can_export = 1, can_create_team_automations = 1, updated_at = ?
    WHERE organization_id = ? AND user_id = ?
  `).run(Date.now(), organization.organizationId, memberId);
  permissionsDb.close();

  await assert.doesNotReject(async () => assertUserOrganizationPermission(memberId, 'canExport'));
  await assert.doesNotReject(async () => assertCanCreateRequestedAutomation({ teamAutomation: true }, { id: memberId }));

  const mutationDb = new Database(path.join(dataDir, 'sqlite.db'));
  const managedMemberId = 'managed-member-1';
  insertMemberPermission(mutationDb, organization.organizationId, managedMemberId);
  insertActiveMembership(
    mutationDb,
    organization.organizationId,
    managedMemberId,
    `${managedMemberId}@example.test`,
    'member',
  );
  mutationDb.close();

  const managedMember = await getOrganizationUserPermissionDetails(managedMemberId, owner.id);
  assert.equal(managedMember.organizationId, organization.organizationId);
  assert.equal(managedMember.role, 'member');
  assert.equal(managedMember.permissions.canExport, false);

  const permissionUpdate = await updateOrganizationPermissions({
    actorUserId: owner.id,
    targetUserId: managedMemberId,
    permissions: { canExport: true, canManageBackups: true },
  });
  assert.equal(permissionUpdate.permissions.canExport, true);
  assert.equal(permissionUpdate.permissions.canManageBackups, true);

  const sessionDb = new Database(path.join(dataDir, 'sqlite.db'));
  sessionDb.prepare(`
    INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('managed-session-1', Date.now() + 60_000, 'managed-token-1', Date.now(), Date.now(), managedMemberId);
  sessionDb.close();
  assert.equal(await revokeOrganizationPermissionSessions(managedMemberId), 1);

  await assert.rejects(
    async () => updateOrganizationRole({
      actorUserId: owner.id,
      targetUserId: owner.id,
      role: 'member',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LAST_OWNER',
  );

  await assert.rejects(
    async () => updateOrganizationRole({
      actorUserId: managedMemberId,
      targetUserId: owner.id,
      role: 'member',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ORGANIZATION_PERMISSION_DENIED',
  );

  await assert.rejects(
    async () => updateOrganizationRole({
      actorUserId: owner.id,
      targetUserId: managedMemberId,
      role: 'external',
      externalUsersEnabled: false,
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EXTERNAL_USERS_DISABLED',
  );

  const externalUser = await updateOrganizationRole({
    actorUserId: owner.id,
    targetUserId: managedMemberId,
    role: 'external',
    externalUsersEnabled: true,
  });
  assert.equal(externalUser.role, 'external');
  assert.equal(Object.values(externalUser.permissions).every((value) => value === false), true);
  const roleProjectionDb = new Database(path.join(dataDir, 'sqlite.db'));
  const externalSnapshot = JSON.parse(
    roleProjectionDb.prepare(`
      SELECT request_json
      FROM team_seat_outbox
      WHERE operation_kind = 'membership_snapshot'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).pluck().get() as string,
  ) as {
    observedQuantity: number;
    roleSummary: Record<string, number>;
  };
  assert.equal(externalSnapshot.observedQuantity, 2);
  assert.deepEqual(externalSnapshot.roleSummary, {
    owner: 1,
    admin: 0,
    member: 0,
    external: 1,
  });
  assert.equal(
    roleProjectionDb.prepare(`
      SELECT COUNT(*)
      FROM team_seat_outbox
      WHERE operation_kind = 'seat_prepare'
    `).pluck().get(),
    0,
    'a pure role change must not prepare a billable Seat quantity change',
  );
  roleProjectionDb.close();

  await assert.rejects(
    async () => updateOrganizationPermissions({
      actorUserId: owner.id,
      targetUserId: managedMemberId,
      permissions: { canExport: true },
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EXTERNAL_NO_ORG_PERMISSIONS',
  );

  const adminUser = await updateOrganizationRole({
    actorUserId: owner.id,
    targetUserId: managedMemberId,
    role: 'admin',
  });
  assert.equal(adminUser.role, 'admin');
  const adminProjectionDb = new Database(path.join(dataDir, 'sqlite.db'));
  const adminSnapshot = JSON.parse(
    adminProjectionDb.prepare(`
      SELECT request_json
      FROM team_seat_outbox
      WHERE operation_kind = 'membership_snapshot'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).pluck().get() as string,
  ) as {
    observedQuantity: number;
    roleSummary: Record<string, number>;
  };
  assert.equal(adminSnapshot.observedQuantity, 2);
  assert.deepEqual(adminSnapshot.roleSummary, {
    owner: 1,
    admin: 1,
    member: 0,
    external: 0,
  });
  const revisionBeforeReplay = adminProjectionDb.prepare(`
    SELECT current_revision
    FROM team_membership_sync_state
    WHERE organization_id = ?
  `).pluck().get(organization.organizationId);
  adminProjectionDb.close();
  await updateOrganizationRole({
    actorUserId: owner.id,
    targetUserId: managedMemberId,
    role: 'admin',
  });
  const replayDb = new Database(path.join(dataDir, 'sqlite.db'));
  assert.equal(
    replayDb.prepare(`
      SELECT current_revision
      FROM team_membership_sync_state
      WHERE organization_id = ?
    `).pluck().get(organization.organizationId),
    revisionBeforeReplay,
    'replaying the same role must not allocate another membership revision',
  );
  replayDb.close();

  const legacyDb = new Database(path.join(dataDir, 'sqlite.db'));
  legacyDb.prepare('DELETE FROM organization_user_permissions').run();
  legacyDb.prepare('DELETE FROM canvas_organization_settings').run();
  legacyDb.close();

  await assert.doesNotReject(async () => assertUserOrganizationPermission(owner.id, 'canCreatePublicLinks'));
  await assert.rejects(
    async () => assertUserOrganizationPermission(memberId, 'canCreatePublicLinks'),
    /Missing organization permission: canCreatePublicLinks/,
  );
  await assert.doesNotReject(async () => assertCanCreateRequestedAutomation(
    { scope: 'team' },
    { id: owner.id, role: 'admin', email: owner.email },
  ));
  await assert.rejects(
    async () => assertCanCreateRequestedAutomation({ scope: 'team' }, { id: memberId, role: 'user', email: 'member@example.test' }),
    /Team automation permission required/,
  );

  console.log('organization permission guard tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
