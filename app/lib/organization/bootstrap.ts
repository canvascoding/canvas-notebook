import 'server-only';

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { getBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';
import { runMigrations } from '@/app/lib/db/migrate';
import { resolveWorkspaceDataRoot } from '@/app/lib/workspaces/context';

export const LOCAL_ORGANIZATION_ID_PREFIX = 'org_';

export type OrganizationRole = 'owner' | 'admin' | 'member' | 'external';

export type OrganizationPermissionSnapshot = {
  role: OrganizationRole;
  canWriteTeamWorkspace: boolean;
  canCreatePublicLinks: boolean;
  canCreateTeamAutomations: boolean;
  canSharePluginsAndSkills: boolean;
  canExport: boolean;
  canDeleteTeamFiles: boolean;
  canDeleteStudioAssets: boolean;
  canManageBackups: boolean;
  canMigrateDatabase: boolean;
  canEnableKnowledge: boolean;
  canRecoverWorkspaces: boolean;
};

export type OrganizationBootstrapStatus = {
  configured: boolean;
  organizationId: string | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
  deploymentMode: string;
  teamFeaturesEnabled: boolean;
  databaseProvider: string;
  permission: OrganizationPermissionSnapshot | null;
  paths: {
    personalWorkspace: string | null;
    userSettings: string | null;
    userSecrets: string | null;
    organizationRoot: string | null;
    teamWorkspace: string | null;
    systemBackups: string;
  };
  warnings: string[];
};

type UserRow = {
  id: string;
  email: string | null;
  role: string | null;
  created_at: number;
};

type OrganizationRow = {
  organization_id: string;
  owner_user_id: string;
  deployment_mode: string;
  team_features_enabled: number;
  created_at: number;
  updated_at: number;
};

type PermissionRow = {
  role: string;
  can_write_team_workspace: number;
  can_create_public_links: number;
  can_create_team_automations: number;
  can_share_plugins_and_skills: number;
  can_export: number;
  can_delete_team_files: number;
  can_delete_studio_assets: number;
  can_manage_backups: number;
  can_migrate_database: number;
  can_enable_knowledge: number;
  can_recover_workspaces: number;
};

export class OrganizationBootstrapError extends Error {
  constructor(
    public readonly code: 'NO_USERS' | 'ORGANIZATION_ID_CONFLICT' | 'DATABASE_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationBootstrapError';
  }
}

function normalizeRole(role: string | null | undefined): OrganizationRole {
  if (role === 'owner' || role === 'admin' || role === 'external') return role;
  return 'member';
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

export function getConfiguredOrganizationId(): string | null {
  const value = process.env.CANVAS_ORGANIZATION_ID?.trim();
  return value || null;
}

export function getDatabaseProvider(): string {
  return process.env.CANVAS_DATABASE_PROVIDER?.trim().toLowerCase() || 'sqlite';
}

export function getDeploymentMode(): string {
  const explicit = process.env.CANVAS_DEPLOYMENT_MODE?.trim();
  if (explicit) return explicit;
  if (process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' || process.env.CANVAS_INSTANCE_TOKEN?.trim()) {
    return 'managed-single';
  }
  return 'single_user';
}

export function areTeamFeaturesEnabled(deploymentMode = getDeploymentMode()): boolean {
  return isTruthyEnv(process.env.CANVAS_TEAM_FEATURES_ENABLED) || deploymentMode.toLowerCase().includes('team');
}

function booleanFromDb(value: number | null | undefined): boolean {
  return value === 1;
}

function organizationIdFromEnvironmentOrLocal(): string {
  return getConfiguredOrganizationId() || `${LOCAL_ORGANIZATION_ID_PREFIX}${randomUUID()}`;
}

function getDataRoot(): string {
  return resolveWorkspaceDataRoot();
}

function buildScopedPaths(organizationId: string, userId: string, teamFeaturesEnabled: boolean) {
  const dataRoot = getDataRoot();
  return {
    personalWorkspace: path.join(dataRoot, 'workspaces', 'personal', userId, 'files'),
    userSettings: path.join(dataRoot, 'users', userId, 'settings'),
    userSecrets: path.join(dataRoot, 'users', userId, 'secrets'),
    userAgents: path.join(dataRoot, 'users', userId, 'agents'),
    userSkills: path.join(dataRoot, 'users', userId, 'skills'),
    userPlugins: path.join(dataRoot, 'users', userId, 'plugins'),
    userMcp: path.join(dataRoot, 'users', userId, 'mcp'),
    userMail: path.join(dataRoot, 'users', userId, 'mail'),
    organizationRoot: path.join(dataRoot, 'organizations', organizationId),
    organizationSecrets: path.join(dataRoot, 'organizations', organizationId, 'secrets'),
    organizationPolicies: path.join(dataRoot, 'organizations', organizationId, 'policies'),
    organizationAgentTemplates: path.join(dataRoot, 'organizations', organizationId, 'agent-templates'),
    organizationMcpTemplates: path.join(dataRoot, 'organizations', organizationId, 'mcp-templates'),
    organizationSkillTemplates: path.join(dataRoot, 'organizations', organizationId, 'skill-templates'),
    organizationPluginTemplates: path.join(dataRoot, 'organizations', organizationId, 'plugin-templates'),
    teamWorkspace: teamFeaturesEnabled
      ? path.join(dataRoot, 'workspaces', 'team', organizationId, 'files')
      : null,
    systemBackups: path.join(dataRoot, 'system', 'backups'),
    systemMigration: path.join(dataRoot, 'system', 'migration'),
    systemLogs: path.join(dataRoot, 'system', 'logs'),
  };
}

function ensureScopedDirectories(organizationId: string, userId: string, teamFeaturesEnabled: boolean): void {
  const paths = buildScopedPaths(organizationId, userId, teamFeaturesEnabled);
  for (const directory of Object.values(paths)) {
    if (directory) {
      mkdirSync(directory, { recursive: true });
    }
  }
}

function getPrimaryOrganization(sqlite: Database.Database): OrganizationRow | null {
  return sqlite.prepare(`
    SELECT organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as OrganizationRow | undefined || null;
}

function getUserById(sqlite: Database.Database, userId: string): UserRow | null {
  return sqlite.prepare(`
    SELECT id, email, role, created_at
    FROM user
    WHERE id = ?
    LIMIT 1
  `).get(userId) as UserRow | undefined || null;
}

function getOwnerCandidate(sqlite: Database.Database): UserRow | null {
  const bootstrapEmail = getBootstrapAdminEmail();
  if (bootstrapEmail) {
    const bootstrapUser = sqlite.prepare(`
      SELECT id, email, role, created_at
      FROM user
      WHERE lower(email) = lower(?)
      LIMIT 1
    `).get(bootstrapEmail) as UserRow | undefined;
    if (bootstrapUser) return bootstrapUser;
  }

  return sqlite.prepare(`
    SELECT id, email, role, created_at
    FROM user
    ORDER BY
      CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
      created_at ASC
    LIMIT 1
  `).get() as UserRow | undefined || null;
}

function assertOrganizationIdMatchesEnvironment(organizationId: string): void {
  const configuredOrganizationId = getConfiguredOrganizationId();
  if (configuredOrganizationId && configuredOrganizationId !== organizationId) {
    throw new OrganizationBootstrapError(
      'ORGANIZATION_ID_CONFLICT',
      `Persisted organization ${organizationId} does not match CANVAS_ORGANIZATION_ID ${configuredOrganizationId}.`,
    );
  }
}

function permissionDefaults(role: OrganizationRole): OrganizationPermissionSnapshot {
  const isAdminLike = role === 'owner' || role === 'admin';
  return {
    role,
    canWriteTeamWorkspace: isAdminLike,
    canCreatePublicLinks: true,
    canCreateTeamAutomations: isAdminLike,
    canSharePluginsAndSkills: isAdminLike,
    canExport: isAdminLike,
    canDeleteTeamFiles: isAdminLike,
    canDeleteStudioAssets: true,
    canManageBackups: isAdminLike,
    canMigrateDatabase: isAdminLike,
    canEnableKnowledge: isAdminLike,
    canRecoverWorkspaces: isAdminLike,
  };
}

function ensurePermissionRow(
  sqlite: Database.Database,
  organizationId: string,
  userId: string,
  requestedRole: OrganizationRole,
): OrganizationPermissionSnapshot {
  const existing = sqlite.prepare(`
    SELECT role
    FROM organization_user_permissions
    WHERE organization_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, userId) as { role?: string } | undefined;
  const role = existing?.role === 'owner' ? 'owner' : requestedRole;
  const defaults = permissionDefaults(role);
  const now = Date.now();

  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role,
      can_write_team_workspace, can_create_public_links, can_create_team_automations,
      can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
      can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, user_id) DO UPDATE SET
      role = excluded.role,
      can_write_team_workspace = excluded.can_write_team_workspace,
      can_create_public_links = excluded.can_create_public_links,
      can_create_team_automations = excluded.can_create_team_automations,
      can_share_plugins_and_skills = excluded.can_share_plugins_and_skills,
      can_export = excluded.can_export,
      can_delete_team_files = excluded.can_delete_team_files,
      can_delete_studio_assets = excluded.can_delete_studio_assets,
      can_manage_backups = excluded.can_manage_backups,
      can_migrate_database = excluded.can_migrate_database,
      can_enable_knowledge = excluded.can_enable_knowledge,
      can_recover_workspaces = excluded.can_recover_workspaces,
      updated_at = excluded.updated_at
  `).run(
    organizationId,
    userId,
    defaults.role,
    defaults.canWriteTeamWorkspace ? 1 : 0,
    defaults.canCreatePublicLinks ? 1 : 0,
    defaults.canCreateTeamAutomations ? 1 : 0,
    defaults.canSharePluginsAndSkills ? 1 : 0,
    defaults.canExport ? 1 : 0,
    defaults.canDeleteTeamFiles ? 1 : 0,
    defaults.canDeleteStudioAssets ? 1 : 0,
    defaults.canManageBackups ? 1 : 0,
    defaults.canMigrateDatabase ? 1 : 0,
    defaults.canEnableKnowledge ? 1 : 0,
    defaults.canRecoverWorkspaces ? 1 : 0,
    now,
    now,
  );

  return defaults;
}

function getPermissionRow(
  sqlite: Database.Database,
  organizationId: string,
  userId: string,
): OrganizationPermissionSnapshot | null {
  const row = sqlite.prepare(`
    SELECT role, can_write_team_workspace, can_create_public_links, can_create_team_automations,
      can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
      can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces
    FROM organization_user_permissions
    WHERE organization_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, userId) as PermissionRow | undefined;

  if (!row) return null;

  return {
    role: normalizeRole(row.role),
    canWriteTeamWorkspace: booleanFromDb(row.can_write_team_workspace),
    canCreatePublicLinks: booleanFromDb(row.can_create_public_links),
    canCreateTeamAutomations: booleanFromDb(row.can_create_team_automations),
    canSharePluginsAndSkills: booleanFromDb(row.can_share_plugins_and_skills),
    canExport: booleanFromDb(row.can_export),
    canDeleteTeamFiles: booleanFromDb(row.can_delete_team_files),
    canDeleteStudioAssets: booleanFromDb(row.can_delete_studio_assets),
    canManageBackups: booleanFromDb(row.can_manage_backups),
    canMigrateDatabase: booleanFromDb(row.can_migrate_database),
    canEnableKnowledge: booleanFromDb(row.can_enable_knowledge),
    canRecoverWorkspaces: booleanFromDb(row.can_recover_workspaces),
  };
}

export function ensureOrganizationBootstrapForUser(
  sqlite: Database.Database,
  userId: string,
): OrganizationBootstrapStatus {
  const targetUser = getUserById(sqlite, userId);
  if (!targetUser) {
    throw new OrganizationBootstrapError('NO_USERS', 'Cannot bootstrap organization without a valid user.');
  }

  const deploymentMode = getDeploymentMode();
  const teamFeaturesEnabled = areTeamFeaturesEnabled(deploymentMode);
  const now = Date.now();
  let organization = getPrimaryOrganization(sqlite);

  if (organization) {
    assertOrganizationIdMatchesEnvironment(organization.organization_id);
    sqlite.prepare(`
      UPDATE canvas_organization_settings
      SET deployment_mode = ?, team_features_enabled = ?, updated_at = ?
      WHERE organization_id = ?
    `).run(deploymentMode, teamFeaturesEnabled ? 1 : 0, now, organization.organization_id);
    organization = {
      ...organization,
      deployment_mode: deploymentMode,
      team_features_enabled: teamFeaturesEnabled ? 1 : 0,
      updated_at: now,
    };
  } else {
    const organizationId = organizationIdFromEnvironmentOrLocal();
    sqlite.prepare(`
      INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(organizationId, userId, deploymentMode, teamFeaturesEnabled ? 1 : 0, now, now);
    organization = {
      organization_id: organizationId,
      owner_user_id: userId,
      deployment_mode: deploymentMode,
      team_features_enabled: teamFeaturesEnabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
  }

  const ownerUser = getUserById(sqlite, organization.owner_user_id) || targetUser;
  sqlite.prepare('UPDATE user SET role = ?, updated_at = ? WHERE id = ?').run('admin', now, ownerUser.id);

  const ownerPermission = ensurePermissionRow(sqlite, organization.organization_id, ownerUser.id, 'owner');
  if (targetUser.id !== ownerUser.id) {
    sqlite.prepare('UPDATE user SET role = ?, updated_at = ? WHERE id = ?').run('admin', now, targetUser.id);
    ensurePermissionRow(sqlite, organization.organization_id, targetUser.id, 'admin');
  }

  ensureScopedDirectories(organization.organization_id, ownerUser.id, teamFeaturesEnabled);
  if (targetUser.id !== ownerUser.id) {
    ensureScopedDirectories(organization.organization_id, targetUser.id, teamFeaturesEnabled);
  }

  return buildStatus(sqlite, organization, ownerUser, ownerPermission);
}

export function ensureOrganizationBootstrapForExistingUsers(sqlite: Database.Database): OrganizationBootstrapStatus {
  const organization = getPrimaryOrganization(sqlite);
  if (organization) {
    assertOrganizationIdMatchesEnvironment(organization.organization_id);
    const ownerUser = getUserById(sqlite, organization.owner_user_id);
    if (ownerUser) {
      return ensureOrganizationBootstrapForUser(sqlite, ownerUser.id);
    }
  }

  const ownerCandidate = getOwnerCandidate(sqlite);
  if (!ownerCandidate) {
    throw new OrganizationBootstrapError('NO_USERS', 'Cannot bootstrap organization before the first user exists.');
  }

  return ensureOrganizationBootstrapForUser(sqlite, ownerCandidate.id);
}

function buildStatus(
  sqlite: Database.Database,
  organization: OrganizationRow | null,
  ownerUser: UserRow | null,
  permission: OrganizationPermissionSnapshot | null,
): OrganizationBootstrapStatus {
  const deploymentMode = organization?.deployment_mode || getDeploymentMode();
  const teamFeaturesEnabled = organization
    ? booleanFromDb(organization.team_features_enabled)
    : areTeamFeaturesEnabled(deploymentMode);
  const databaseProvider = getDatabaseProvider();
  const organizationId = organization?.organization_id || null;
  const ownerUserId = organization?.owner_user_id || ownerUser?.id || null;
  const paths = organizationId && ownerUserId
    ? buildScopedPaths(organizationId, ownerUserId, teamFeaturesEnabled)
    : null;
  const warnings: string[] = [];

  if (teamFeaturesEnabled && databaseProvider !== 'postgres') {
    warnings.push('Team features are enabled but CANVAS_DATABASE_PROVIDER is not postgres.');
  }

  const configuredOrganizationId = getConfiguredOrganizationId();
  if (configuredOrganizationId && organizationId && configuredOrganizationId !== organizationId) {
    warnings.push('Persisted organization does not match CANVAS_ORGANIZATION_ID.');
  }

  if (organization && ownerUserId && !permission) {
    permission = getPermissionRow(sqlite, organization.organization_id, ownerUserId);
  }

  return {
    configured: Boolean(organization && ownerUser),
    organizationId,
    ownerUserId,
    ownerEmail: ownerUser?.email || null,
    deploymentMode,
    teamFeaturesEnabled,
    databaseProvider,
    permission,
    paths: {
      personalWorkspace: paths?.personalWorkspace || null,
      userSettings: paths?.userSettings || null,
      userSecrets: paths?.userSecrets || null,
      organizationRoot: paths?.organizationRoot || null,
      teamWorkspace: paths?.teamWorkspace || null,
      systemBackups: paths?.systemBackups || path.join(getDataRoot(), 'system', 'backups'),
    },
    warnings,
  };
}

export function getOrganizationBootstrapStatus(sqlite: Database.Database): OrganizationBootstrapStatus {
  const organization = getPrimaryOrganization(sqlite);
  const ownerUser = organization ? getUserById(sqlite, organization.owner_user_id) : getOwnerCandidate(sqlite);
  const permission = organization && ownerUser
    ? getPermissionRow(sqlite, organization.organization_id, ownerUser.id)
    : null;
  return buildStatus(sqlite, organization, ownerUser, permission);
}

function getSqlitePath(): string {
  return path.join(getDataRoot(), 'sqlite.db');
}

export function openOrganizationBootstrapDatabase(): Database.Database {
  const sqlite = new Database(getSqlitePath());
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  runMigrations(sqlite);
  return sqlite;
}

export function ensureOrganizationBootstrapStatus(): OrganizationBootstrapStatus {
  const sqlite = openOrganizationBootstrapDatabase();
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const status = ensureOrganizationBootstrapForExistingUsers(sqlite);
    sqlite.exec('COMMIT');
    return status;
  } catch (error) {
    if (sqlite.inTransaction) {
      sqlite.exec('ROLLBACK');
    }
    if (error instanceof OrganizationBootstrapError) {
      throw error;
    }
    throw new OrganizationBootstrapError('DATABASE_ERROR', 'Could not ensure organization bootstrap state.');
  } finally {
    sqlite.close();
  }
}
