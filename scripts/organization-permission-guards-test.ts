import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-org-permissions-'));
process.env.DATA = dataDir;

function insertMemberPermission(sqlite: Database.Database, organizationId: string, userId: string) {
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO user (
      id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, 'Member User', 'member@example.test', 1, null, 'user', null, null, null, now, now);

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

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const {
    assertUserOrganizationPermission,
    hasOrganizationPermission,
    readOrganizationPermissionForUser,
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

  const ownerState = readOrganizationPermissionForUser(owner.id);
  assert.equal(ownerState.permission?.role, 'owner');
  assert.equal(hasOrganizationPermission(ownerState.permission, 'canExport'), true);
  assert.equal(hasOrganizationPermission(ownerState.permission, 'canRecoverWorkspaces'), true);
  assert.doesNotThrow(() => assertUserOrganizationPermission(owner.id, 'canExport'));

  const memberId = 'member-user-1';
  insertMemberPermission(sqlite, organization.organizationId, memberId);
  sqlite.close();

  const memberState = readOrganizationPermissionForUser(memberId);
  assert.equal(memberState.permission?.role, 'member');
  assert.equal(hasOrganizationPermission(memberState.permission, 'canCreatePublicLinks'), true);
  assert.equal(hasOrganizationPermission(memberState.permission, 'canExport'), false);
  assert.equal(hasOrganizationPermission(memberState.permission, 'canDeleteStudioAssets'), true);
  assert.equal(hasOrganizationPermission(memberState.permission, 'canSharePluginsAndSkills'), false);
  assert.doesNotThrow(() => assertUserOrganizationPermission(memberId, 'canCreatePublicLinks'));
  assert.doesNotThrow(() => assertUserOrganizationPermission(memberId, 'canDeleteStudioAssets'));
  assert.throws(
    () => assertUserOrganizationPermission(memberId, 'canExport'),
    /Missing organization permission: canExport/,
  );
  assert.throws(
    () => assertUserOrganizationPermission(memberId, 'canSharePluginsAndSkills'),
    /Missing organization permission: canSharePluginsAndSkills/,
  );

  assert.equal(automationInputRequiresTeamPermission({ scope: 'personal' }), false);
  assert.equal(automationInputRequiresTeamPermission({ scope: 'team' }), true);
  assert.doesNotThrow(() => assertCanCreateRequestedAutomation({ scope: 'personal' }, { id: memberId }));
  assert.throws(
    () => assertCanCreateRequestedAutomation({ workspaceType: 'team' }, { id: memberId }),
    /Team automation permission required/,
  );

  const permissionsDb = new Database(path.join(dataDir, 'sqlite.db'));
  permissionsDb.prepare(`
    UPDATE organization_user_permissions
    SET can_export = 1, can_create_team_automations = 1, updated_at = ?
    WHERE organization_id = ? AND user_id = ?
  `).run(Date.now(), organization.organizationId, memberId);
  permissionsDb.close();

  assert.doesNotThrow(() => assertUserOrganizationPermission(memberId, 'canExport'));
  assert.doesNotThrow(() => assertCanCreateRequestedAutomation({ teamAutomation: true }, { id: memberId }));

  const legacyDb = new Database(path.join(dataDir, 'sqlite.db'));
  legacyDb.prepare('DELETE FROM organization_user_permissions').run();
  legacyDb.prepare('DELETE FROM canvas_organization_settings').run();
  legacyDb.close();

  assert.doesNotThrow(() => assertCanCreateRequestedAutomation(
    { scope: 'team' },
    { id: owner.id, role: 'admin', email: owner.email },
  ));
  assert.throws(
    () => assertCanCreateRequestedAutomation({ scope: 'team' }, { id: memberId, role: 'user', email: 'member@example.test' }),
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
