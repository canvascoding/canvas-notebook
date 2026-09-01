import 'server-only';

import type { SqlConnection } from '@/app/lib/db';

export type ProvisionedOrganizationRole = 'owner' | 'admin' | 'member' | 'external';

export type OrganizationPermissionDefaults = {
  role: ProvisionedOrganizationRole;
  status: 'active';
  canWriteTeamWorkspace: boolean;
  canCreatePublicLinks: boolean;
  canCreateTeamAutomations: boolean;
  canSharePluginsAndSkills: boolean;
  canExport: boolean;
  canDeleteTeamFiles: boolean;
  canDeleteStudioAssets: boolean;
  canManageBackups: boolean;
  canManageOrganizationMemory: boolean;
  canMigrateDatabase: boolean;
  canEnableKnowledge: boolean;
  canRecoverWorkspaces: boolean;
};

type PermissionProvisioningDatabase = Pick<SqlConnection, 'get' | 'run'>;

type ExistingPermissionRow = {
  role: string;
  status: string;
};

export class OrganizationPermissionProvisioningError extends Error {
  constructor(
    public readonly code: 'ORGANIZATION_PERMISSION_REACTIVATION_DENIED',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'OrganizationPermissionProvisioningError';
  }
}

export function organizationPermissionDefaults(
  role: ProvisionedOrganizationRole,
): OrganizationPermissionDefaults {
  const isAdminLikeRole = role === 'owner' || role === 'admin';
  const isInternal = role !== 'external';
  return {
    role,
    status: 'active',
    canWriteTeamWorkspace: isAdminLikeRole,
    canCreatePublicLinks: isInternal,
    canCreateTeamAutomations: isAdminLikeRole,
    canSharePluginsAndSkills: isAdminLikeRole,
    canExport: isAdminLikeRole,
    canDeleteTeamFiles: isAdminLikeRole,
    canDeleteStudioAssets: isInternal,
    canManageBackups: isAdminLikeRole,
    canManageOrganizationMemory: false,
    canMigrateDatabase: isAdminLikeRole,
    canEnableKnowledge: isAdminLikeRole,
    canRecoverWorkspaces: isAdminLikeRole,
  };
}

export async function ensureOrganizationPermissionRow(
  database: PermissionProvisioningDatabase,
  input: {
    organizationId: string;
    userId: string;
    role: ProvisionedOrganizationRole;
    activateExisting: boolean;
    now?: number;
  },
): Promise<void> {
  const existing = await database.get(`
    SELECT role, status
    FROM organization_user_permissions
    WHERE organization_id = ? AND user_id = ?
    LIMIT 1
  `, [
    input.organizationId,
    input.userId,
  ]) as ExistingPermissionRow | undefined;
  const role = existing?.role === 'owner' ? 'owner' : input.role;
  const defaults = organizationPermissionDefaults(role);
  const now = input.now ?? Date.now();

  if (
    input.activateExisting
    && existing
    && existing.status !== 'active'
    && existing.status !== 'disabled'
  ) {
    throw new OrganizationPermissionProvisioningError(
      'ORGANIZATION_PERMISSION_REACTIVATION_DENIED',
      `Organization permission cannot be activated from status ${existing.status}.`,
    );
  }

  await database.run(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status,
      can_write_team_workspace, can_create_public_links,
      can_create_team_automations, can_share_plugins_and_skills,
      can_export, can_delete_team_files, can_delete_studio_assets,
      can_manage_backups, can_manage_organization_memory, can_migrate_database, can_enable_knowledge,
      can_recover_workspaces, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, user_id) DO NOTHING
  `, [
    input.organizationId,
    input.userId,
    defaults.role,
    defaults.canWriteTeamWorkspace ? 1 : 0,
    defaults.canCreatePublicLinks ? 1 : 0,
    defaults.canCreateTeamAutomations ? 1 : 0,
    defaults.canSharePluginsAndSkills ? 1 : 0,
    defaults.canExport ? 1 : 0,
    defaults.canDeleteTeamFiles ? 1 : 0,
    defaults.canDeleteStudioAssets ? 1 : 0,
    defaults.canManageBackups ? 1 : 0,
    defaults.canManageOrganizationMemory ? 1 : 0,
    defaults.canMigrateDatabase ? 1 : 0,
    defaults.canEnableKnowledge ? 1 : 0,
    defaults.canRecoverWorkspaces ? 1 : 0,
    now,
    now,
  ]);

  if (!input.activateExisting) return;
  await database.run(`
    UPDATE organization_user_permissions
    SET role = ?, status = 'active', updated_at = ?
    WHERE organization_id = ?
      AND user_id = ?
      AND status IN ('active', 'disabled')
  `, [
    defaults.role,
    now,
    input.organizationId,
    input.userId,
  ]);
}
