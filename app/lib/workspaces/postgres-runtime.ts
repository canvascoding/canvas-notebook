import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { openDb } from '@/app/lib/db';
import {
  areTeamFeaturesEnabled,
  getConfiguredOrganizationId,
  getDeploymentMode,
  LOCAL_ORGANIZATION_ID_PREFIX,
  type OrganizationBootstrapStatus,
  type OrganizationPermissionSnapshot,
  OrganizationBootstrapError,
} from '@/app/lib/organization/bootstrap';
import {
  getDatabaseProvider,
  getDatabaseProviderProblemMessages,
  resolveDatabaseProviderGate,
} from '@/app/lib/db/provider';
import { resolveWorkspacePermissions } from './permissions';
import type { WorkspaceActor, WorkspaceContext, WorkspaceStatus, WorkspaceType } from './types';
import {
  personalWorkspaceRootRelativePath,
  teamWorkspaceRootRelativePath,
  workspaceAbsoluteRoot,
} from './service';

export interface PostgresRuntimeDb {
  get: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  run: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]>;
  close?: () => void | Promise<void>;
}

type RuntimeDb = PostgresRuntimeDb;

export type PostgresUserRow = {
  id: string;
  name: string | null;
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
  status: string | null;
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

type ProjectPermissionRow = {
  project_id?: string;
  role: string;
  status: string;
  can_read: number;
  can_write: number;
  can_manage: number;
};

type WorkspaceRow = {
  id: string;
  organization_id: string;
  type: string;
  owner_user_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  root_relative_path: string;
  display_name: string;
  status: string;
  created_at: number;
  updated_at: number;
};

export interface PostgresWorkspaceState {
  status: OrganizationBootstrapStatus;
  defaultWorkspace: WorkspaceContext | null;
  workspaces: WorkspaceContext[];
}

function booleanFromDb(value: number | null | undefined): boolean {
  return value === 1;
}

function normalizeRole(role: string | null | undefined): OrganizationPermissionSnapshot['role'] {
  if (role === 'owner' || role === 'admin' || role === 'external') return role;
  return 'member';
}

function normalizeUserStatus(status: string | null | undefined): OrganizationPermissionSnapshot['status'] {
  if (status === 'disabled' || status === 'archived' || status === 'recovery_locked') return status;
  return 'active';
}

function normalizeWorkspaceType(value: string): WorkspaceType {
  if (value === 'team' || value === 'project') return value;
  return 'personal';
}

function normalizeWorkspaceStatus(value: string): WorkspaceStatus {
  if (value === 'archived' || value === 'disabled' || value === 'recovery_locked') return value;
  return 'active';
}

function permissionDefaults(role: OrganizationPermissionSnapshot['role']): OrganizationPermissionSnapshot {
  const isAdminLike = role === 'owner' || role === 'admin';
  const isInternal = role !== 'external';
  return {
    role,
    status: 'active',
    canWriteTeamWorkspace: isAdminLike,
    canCreatePublicLinks: isInternal,
    canCreateTeamAutomations: isAdminLike,
    canSharePluginsAndSkills: isAdminLike,
    canExport: isAdminLike,
    canDeleteTeamFiles: isAdminLike,
    canDeleteStudioAssets: isInternal,
    canManageBackups: isAdminLike,
    canMigrateDatabase: isAdminLike,
    canEnableKnowledge: isAdminLike,
    canRecoverWorkspaces: isAdminLike,
  };
}

function rowToPermissionSnapshot(row: PermissionRow | null): OrganizationPermissionSnapshot | null {
  if (!row) return null;
  const status = normalizeUserStatus(row.status);
  const enabled = status === 'active';

  return {
    role: normalizeRole(row.role),
    status,
    canWriteTeamWorkspace: enabled && booleanFromDb(row.can_write_team_workspace),
    canCreatePublicLinks: enabled && booleanFromDb(row.can_create_public_links),
    canCreateTeamAutomations: enabled && booleanFromDb(row.can_create_team_automations),
    canSharePluginsAndSkills: enabled && booleanFromDb(row.can_share_plugins_and_skills),
    canExport: enabled && booleanFromDb(row.can_export),
    canDeleteTeamFiles: enabled && booleanFromDb(row.can_delete_team_files),
    canDeleteStudioAssets: enabled && booleanFromDb(row.can_delete_studio_assets),
    canManageBackups: enabled && booleanFromDb(row.can_manage_backups),
    canMigrateDatabase: enabled && booleanFromDb(row.can_migrate_database),
    canEnableKnowledge: enabled && booleanFromDb(row.can_enable_knowledge),
    canRecoverWorkspaces: enabled && booleanFromDb(row.can_recover_workspaces),
  };
}

function rowToWorkspaceRecord(row: WorkspaceRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: normalizeWorkspaceType(row.type),
    ownerUserId: row.owner_user_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    rootRelativePath: row.root_relative_path,
    displayName: row.display_name,
    status: normalizeWorkspaceStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureWorkspaceDirectory(rootRelativePath: string): void {
  mkdirSync(workspaceAbsoluteRoot(rootRelativePath), { recursive: true });
}

export async function getPostgresAuthUserCount(database: RuntimeDb): Promise<number> {
  const row = await database.get('SELECT COUNT(*) AS count FROM "user"') as { count?: string | number } | undefined;
  return Number(row?.count || 0);
}

export async function findPostgresUserById(database: RuntimeDb, userId: string): Promise<PostgresUserRow | null> {
  return await database.get(
    'SELECT id, name, email, role, created_at FROM "user" WHERE id = ? LIMIT 1',
    [userId],
  ) as PostgresUserRow | undefined || null;
}

export async function findPostgresUserByEmail(database: RuntimeDb, email: string): Promise<PostgresUserRow | null> {
  return await database.get(
    'SELECT id, name, email, role, created_at FROM "user" WHERE lower(email) = lower(?) LIMIT 1',
    [email],
  ) as PostgresUserRow | undefined || null;
}

export async function findPostgresBootstrapTargetUser(database: RuntimeDb): Promise<PostgresUserRow | null> {
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrapEmail) {
    const bootstrapUser = await findPostgresUserByEmail(database, bootstrapEmail);
    if (bootstrapUser) return bootstrapUser;
  }

  return await database.get(`
    SELECT id, name, email, role, created_at
    FROM "user"
    ORDER BY
      CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
      created_at ASC
    LIMIT 1
  `) as PostgresUserRow | undefined || null;
}

export async function updatePostgresAuthUser(
  database: RuntimeDb,
  input: {
    userId: string;
    email: string;
    name: string;
    role?: string;
  },
): Promise<void> {
  await database.run(
    'UPDATE "user" SET name = ?, email = ?, role = ?, updated_at = ? WHERE id = ?',
    [input.name, input.email, input.role || 'admin', Date.now(), input.userId],
  );
}

export async function insertPostgresAuthUser(
  database: RuntimeDb,
  input: {
    userId?: string;
    email: string;
    name: string;
    role?: string;
  },
): Promise<string> {
  const userId = input.userId || randomUUID();
  const now = Date.now();
  await database.run(
    `
      INSERT INTO "user" (
        id, name, email, email_verified, image, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [userId, input.name, input.email, 1, null, input.role || 'admin', now, now],
  );
  return userId;
}

export async function ensurePostgresCredentialPassword(
  database: RuntimeDb,
  input: {
    userId: string;
    passwordHash: string;
    accountId?: string;
  },
): Promise<void> {
  const existingAccount = await database.get(
    'SELECT id FROM account WHERE user_id = ? AND provider_id = ? LIMIT 1',
    [input.userId, 'credential'],
  ) as { id: string } | undefined;
  const now = Date.now();

  if (existingAccount) {
    await database.run(
      'UPDATE account SET account_id = ?, password = ?, updated_at = ? WHERE id = ?',
      [input.userId, input.passwordHash, now, existingAccount.id],
    );
    return;
  }

  await database.run(
    `
      INSERT INTO account (
        id, account_id, provider_id, user_id, password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [input.accountId || randomUUID(), input.userId, 'credential', input.userId, input.passwordHash, now, now],
  );
}

async function getPrimaryOrganization(database: RuntimeDb): Promise<OrganizationRow | null> {
  return await database.get(`
    SELECT organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    FROM canvas_organization_settings
    ORDER BY created_at ASC
    LIMIT 1
  `) as OrganizationRow | undefined || null;
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

async function getPermissionRow(
  database: RuntimeDb,
  organizationId: string,
  userId: string,
): Promise<PermissionRow | null> {
  return await database.get(
    `
      SELECT role, status, can_write_team_workspace, can_create_public_links, can_create_team_automations,
        can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
        can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces
      FROM organization_user_permissions
      WHERE organization_id = ? AND user_id = ?
      LIMIT 1
    `,
    [organizationId, userId],
  ) as PermissionRow | undefined || null;
}

async function ensurePermissionRow(
  database: RuntimeDb,
  organizationId: string,
  userId: string,
  requestedRole: OrganizationPermissionSnapshot['role'],
): Promise<OrganizationPermissionSnapshot> {
  const existing = await database.get(
    'SELECT role FROM organization_user_permissions WHERE organization_id = ? AND user_id = ? LIMIT 1',
    [organizationId, userId],
  ) as { role?: string } | undefined;
  const role = existing?.role === 'owner' ? 'owner' : requestedRole;
  const defaults = permissionDefaults(role);
  const now = Date.now();

  await database.run(
    `
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role,
        can_write_team_workspace, can_create_public_links, can_create_team_automations,
        can_share_plugins_and_skills, can_export, can_delete_team_files, can_delete_studio_assets,
        can_manage_backups, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = excluded.updated_at
    `,
    [
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
    ],
  );

  return rowToPermissionSnapshot(await getPermissionRow(database, organizationId, userId)) || defaults;
}

async function getWorkspaceById(database: RuntimeDb, workspaceId: string) {
  const row = await database.get(
    `
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, status, created_at, updated_at
      FROM canvas_workspaces
      WHERE id = ?
      LIMIT 1
    `,
    [workspaceId],
  ) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

async function getPersonalWorkspace(database: RuntimeDb, userId: string) {
  const row = await database.get(
    `
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, status, created_at, updated_at
      FROM canvas_workspaces
      WHERE type = 'personal' AND owner_user_id = ?
      LIMIT 1
    `,
    [userId],
  ) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

async function getTeamWorkspace(database: RuntimeDb, organizationId: string) {
  const row = await database.get(
    `
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, status, created_at, updated_at
      FROM canvas_workspaces
      WHERE type = 'team' AND organization_id = ?
      LIMIT 1
    `,
    [organizationId],
  ) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

async function ensureWorkspaceRecord(database: RuntimeDb, input: {
  organizationId: string;
  type: 'personal' | 'team';
  ownerUserId: string | null;
  rootRelativePath: string;
  displayName: string;
}) {
  const existing = input.type === 'personal'
    ? await getPersonalWorkspace(database, input.ownerUserId || '')
    : await getTeamWorkspace(database, input.organizationId);
  const now = Date.now();

  if (existing) {
    await database.run(
      'UPDATE canvas_workspaces SET root_relative_path = ?, display_name = ?, updated_at = ? WHERE id = ?',
      [input.rootRelativePath, input.displayName, now, existing.id],
    );
    ensureWorkspaceDirectory(input.rootRelativePath);
    return await getWorkspaceById(database, existing.id);
  }

  const id = `ws_${randomUUID()}`;
  await database.run(
    `
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `,
    [id, input.organizationId, input.type, input.ownerUserId, input.rootRelativePath, input.displayName, now, now],
  );
  ensureWorkspaceDirectory(input.rootRelativePath);
  return await getWorkspaceById(database, id);
}

function canReadWorkspace(
  record: ReturnType<typeof rowToWorkspaceRecord>,
  actor: WorkspaceActor,
  permission: PermissionRow | null,
  projectPermission: ProjectPermissionRow | null = null,
): boolean {
  if (record.status !== 'active') return false;
  if (record.type === 'personal') return record.ownerUserId === actor.userId;
  if (record.type === 'team') return Boolean(permission && permission.status === 'active' && permission.role !== 'external');
  if (record.type === 'project') {
    if (permission && permission.status !== 'active') return false;
    if ((actor.role === 'owner' || actor.role === 'admin') && permission?.status === 'active') return true;
    if (!permission && projectPermission?.role !== 'external') return false;
    return Boolean(projectPermission?.status === 'active' && projectPermission.can_read === 1);
  }
  return false;
}

function workspaceContextFromRecord(
  record: ReturnType<typeof rowToWorkspaceRecord>,
  actor: WorkspaceActor,
  permission: PermissionRow | null = null,
  projectPermission: ProjectPermissionRow | null = null,
): WorkspaceContext {
  const role = actor.role;
  const ownsPersonalWorkspace = record.type === 'personal' && record.ownerUserId === actor.userId;
  const canAccessTeamWorkspace = record.type === 'team' && Boolean(permission && permission.status === 'active' && permission.role !== 'external');
  const canWriteTeamWorkspace = record.type === 'team' && (
    permission?.status === 'active' &&
    (
      role === 'owner' ||
      role === 'admin' ||
      permission?.can_write_team_workspace === 1
    )
  );
  const canUseProjectMembership = record.type === 'project' && projectPermission?.status === 'active';
  const canReadProjectWorkspace = canUseProjectMembership && projectPermission.can_read === 1;
  const canWriteProjectWorkspace = canUseProjectMembership && projectPermission.can_write === 1;
  const canManageProjectWorkspace = canUseProjectMembership && projectPermission.can_manage === 1;

  return {
    workspaceId: record.id,
    workspaceType: record.type,
    rootPath: workspaceAbsoluteRoot(record.rootRelativePath),
    rootRelativePath: record.rootRelativePath,
    displayName: record.displayName,
    status: record.status,
    actor,
    organizationId: record.organizationId,
    customerId: record.customerId,
    projectId: record.projectId,
    ownerUserId: record.ownerUserId,
    permissions: resolveWorkspacePermissions({
      role,
      workspaceType: record.type,
      ownsPersonalWorkspace,
      canAccessTeamWorkspace,
      canWriteTeamWorkspace,
      canReadProjectWorkspace,
      canWriteProjectWorkspace,
      canManageProjectWorkspace,
      canCreatePublicLinks: permission?.can_create_public_links === 1,
    }),
    legacy: false,
  };
}

async function getProjectPermissionRows(
  database: RuntimeDb,
  organizationId: string,
  userId: string,
  projectIds: string[],
): Promise<Map<string, ProjectPermissionRow>> {
  const uniqueProjectIds = Array.from(new Set(projectIds.filter(Boolean)));
  if (uniqueProjectIds.length === 0) return new Map();
  const placeholders = uniqueProjectIds.map(() => '?').join(', ');
  const rows = await database.all(
    `
      SELECT project_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
      FROM canvas_project_members
      WHERE organization_id = ? AND user_id = ? AND project_id IN (${placeholders})
    `,
    [organizationId, userId, ...uniqueProjectIds],
  ) as ProjectPermissionRow[];

  return new Map(rows.flatMap((row) => (row.project_id ? [[row.project_id, row]] : [])));
}

async function getProjectPermissionRow(
  database: RuntimeDb,
  organizationId: string,
  projectId: string | null,
  userId: string,
): Promise<ProjectPermissionRow | null> {
  if (!projectId) return null;
  return await database.get(
    `
      SELECT role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
      FROM canvas_project_members
      WHERE organization_id = ? AND project_id = ? AND user_id = ?
      LIMIT 1
    `,
    [organizationId, projectId, userId],
  ) as ProjectPermissionRow | undefined || null;
}

async function listWorkspaceContextsForUser(
  database: RuntimeDb,
  actor: WorkspaceActor,
  organizationId: string,
): Promise<WorkspaceContext[]> {
  const rows = await database.all(
    `
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, status, created_at, updated_at
      FROM canvas_workspaces
      WHERE organization_id = ? AND status = 'active'
        AND (type != 'personal' OR owner_user_id = ?)
      ORDER BY CASE type WHEN 'personal' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, created_at ASC
    `,
    [organizationId, actor.userId],
  ) as WorkspaceRow[];
  const permission = await getPermissionRow(database, organizationId, actor.userId);
  const projectPermissionRows = await getProjectPermissionRows(
    database,
    organizationId,
    actor.userId,
    rows.flatMap((row) => (row.type === 'project' && row.project_id ? [row.project_id] : [])),
  );

  return rows
    .map(rowToWorkspaceRecord)
    .map((record) => ({
      record,
      projectPermission: record.projectId ? projectPermissionRows.get(record.projectId) ?? null : null,
    }))
    .filter(({ record, projectPermission }) => canReadWorkspace(record, actor, permission, projectPermission))
    .map(({ record, projectPermission }) => workspaceContextFromRecord(record, actor, permission, projectPermission));
}

async function resolveDefaultWorkspaceContext(
  database: RuntimeDb,
  actor: WorkspaceActor,
  organizationId: string,
): Promise<WorkspaceContext | null> {
  const personal = await getPersonalWorkspace(database, actor.userId);
  if (!personal) return null;
  const permission = await getPermissionRow(database, organizationId, actor.userId);
  if (!canReadWorkspace(personal, actor, permission)) return null;
  return workspaceContextFromRecord(personal, actor, permission);
}

async function resolveWorkspaceContextById(
  database: RuntimeDb,
  actor: WorkspaceActor,
  workspaceId: string,
): Promise<WorkspaceContext | null> {
  const record = await getWorkspaceById(database, workspaceId);
  if (!record) return null;
  const permission = await getPermissionRow(database, record.organizationId, actor.userId);
  const projectPermission = await getProjectPermissionRow(database, record.organizationId, record.projectId, actor.userId);
  if (!canReadWorkspace(record, actor, permission, projectPermission)) return null;
  return workspaceContextFromRecord(record, actor, permission, projectPermission);
}

function buildStatus(
  organization: OrganizationRow | null,
  ownerUser: PostgresUserRow | null,
  permission: OrganizationPermissionSnapshot | null,
): OrganizationBootstrapStatus {
  const deploymentMode = organization?.deployment_mode || getDeploymentMode();
  const teamFeaturesEnabled = organization
    ? booleanFromDb(organization.team_features_enabled)
    : areTeamFeaturesEnabled(deploymentMode);
  const databaseProvider = getDatabaseProvider();
  const databaseProviderGate = resolveDatabaseProviderGate({ teamFeaturesEnabled });
  const organizationId = organization?.organization_id || null;
  const ownerUserId = organization?.owner_user_id || ownerUser?.id || null;
  const dataRoot = process.env.DATA || path.resolve(process.cwd(), 'data');
  const warnings = getDatabaseProviderProblemMessages(databaseProviderGate.blockers);

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
      personalWorkspace: ownerUserId ? path.join(dataRoot, personalWorkspaceRootRelativePath(ownerUserId)) : null,
      userSettings: ownerUserId ? path.join(dataRoot, 'users', ownerUserId, 'settings') : null,
      userSecrets: ownerUserId ? path.join(dataRoot, 'users', ownerUserId, 'secrets') : null,
      organizationRoot: organizationId ? path.join(dataRoot, 'organizations', organizationId) : null,
      teamWorkspace: teamFeaturesEnabled && organizationId ? path.join(dataRoot, teamWorkspaceRootRelativePath(organizationId)) : null,
      systemBackups: path.join(dataRoot, 'system', 'backups'),
    },
    warnings,
  };
}

export async function getPostgresOrganizationBootstrapStatus(): Promise<OrganizationBootstrapStatus> {
  const database = await openDb();
  try {
    const organization = await getPrimaryOrganization(database);
    const ownerUser = organization ? await findPostgresUserById(database, organization.owner_user_id) : await findPostgresBootstrapTargetUser(database);
    const permission = organization && ownerUser
      ? rowToPermissionSnapshot(await getPermissionRow(database, organization.organization_id, ownerUser.id))
      : null;
    return buildStatus(organization, ownerUser, permission);
  } finally {
    await database.close();
  }
}

export async function ensurePostgresOrganizationBootstrapForUser(
  database: RuntimeDb,
  userId: string,
): Promise<OrganizationBootstrapStatus> {
  const targetUser = await findPostgresUserById(database, userId);
  if (!targetUser) {
    throw new OrganizationBootstrapError('NO_USERS', 'Cannot bootstrap organization without a valid user.');
  }

  const deploymentMode = getDeploymentMode();
  const teamFeaturesEnabled = areTeamFeaturesEnabled(deploymentMode);
  const now = Date.now();
  let organization = await getPrimaryOrganization(database);

  if (organization) {
    assertOrganizationIdMatchesEnvironment(organization.organization_id);
    await database.run(
      'UPDATE canvas_organization_settings SET deployment_mode = ?, team_features_enabled = ?, updated_at = ? WHERE organization_id = ?',
      [deploymentMode, teamFeaturesEnabled ? 1 : 0, now, organization.organization_id],
    );
    organization = {
      ...organization,
      deployment_mode: deploymentMode,
      team_features_enabled: teamFeaturesEnabled ? 1 : 0,
      updated_at: now,
    };
  } else {
    const organizationId = getConfiguredOrganizationId() || `${LOCAL_ORGANIZATION_ID_PREFIX}${randomUUID()}`;
    await database.run(
      `
        INSERT INTO canvas_organization_settings (
          organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [organizationId, userId, deploymentMode, teamFeaturesEnabled ? 1 : 0, now, now],
    );
    organization = {
      organization_id: organizationId,
      owner_user_id: userId,
      deployment_mode: deploymentMode,
      team_features_enabled: teamFeaturesEnabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
  }

  const ownerUser = await findPostgresUserById(database, organization.owner_user_id) || targetUser;
  await database.run('UPDATE "user" SET role = ?, updated_at = ? WHERE id = ?', ['admin', now, ownerUser.id]);
  const ownerPermission = await ensurePermissionRow(database, organization.organization_id, ownerUser.id, 'owner');
  if (targetUser.id !== ownerUser.id) {
    await database.run('UPDATE "user" SET role = ?, updated_at = ? WHERE id = ?', ['admin', now, targetUser.id]);
    await ensurePermissionRow(database, organization.organization_id, targetUser.id, 'admin');
  }

  await ensureWorkspaceRecord(database, {
    organizationId: organization.organization_id,
    type: 'personal',
    ownerUserId: ownerUser.id,
    rootRelativePath: personalWorkspaceRootRelativePath(ownerUser.id),
    displayName: 'Personal Workspace',
  });
  if (teamFeaturesEnabled) {
    await ensureWorkspaceRecord(database, {
      organizationId: organization.organization_id,
      type: 'team',
      ownerUserId: null,
      rootRelativePath: teamWorkspaceRootRelativePath(organization.organization_id),
      displayName: 'Team Workspace',
    });
  }
  if (targetUser.id !== ownerUser.id) {
    await ensureWorkspaceRecord(database, {
      organizationId: organization.organization_id,
      type: 'personal',
      ownerUserId: targetUser.id,
      rootRelativePath: personalWorkspaceRootRelativePath(targetUser.id),
      displayName: 'Personal Workspace',
    });
  }

  return buildStatus(organization, ownerUser, ownerPermission);
}

export async function getPostgresWorkspaceState(actor: WorkspaceActor): Promise<PostgresWorkspaceState> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const status = await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    if (!status.organizationId) {
      await database.run('ROLLBACK');
      throw new OrganizationBootstrapError('DATABASE_ERROR', 'Organization is not configured.');
    }
    const defaultWorkspace = await resolveDefaultWorkspaceContext(database, actor, status.organizationId);
    const workspaces = await listWorkspaceContextsForUser(database, actor, status.organizationId);
    await database.run('COMMIT');
    return { status, defaultWorkspace, workspaces };
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Ignore rollback errors; preserve the original failure.
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function resolvePostgresWorkspaceForActor(
  actor: WorkspaceActor,
  workspaceId: string,
): Promise<WorkspaceContext | null> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const status = await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    if (!status.organizationId) {
      await database.run('ROLLBACK');
      throw new OrganizationBootstrapError('DATABASE_ERROR', 'Organization is not configured.');
    }
    const workspace = await resolveWorkspaceContextById(database, actor, workspaceId);
    await database.run('COMMIT');
    return workspace;
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Ignore rollback errors; preserve the original failure.
    }
    throw error;
  } finally {
    await database.close();
  }
}
