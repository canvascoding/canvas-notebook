import 'server-only';

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
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
  type OrganizationPermissionState,
} from '@/app/lib/organization/bootstrap';
import {
  getDatabaseProvider,
  getDatabaseProviderProblemMessages,
  resolveDatabaseProviderGate,
} from '@/app/lib/db/provider';
import { getDefaultWorkspaceIcon, isWorkspaceIcon, type WorkspaceIcon } from './icons';
import {
  WORKSPACE_LAST_MANAGER_CODE,
  WORKSPACE_LAST_MANAGER_MESSAGE,
  wouldRemoveLastWorkspaceManager,
} from './member-manager-policy';
import { resolveWorkspacePermissions } from './permissions';
import type { WorkspaceActor, WorkspaceContext, WorkspaceStatus, WorkspaceType } from './types';
import {
  normalizeWorkspaceSlug,
  normalizeWorkspaceDescription,
  organizationWorkspaceRootRelativePathForSlug,
  personalWorkspaceRootRelativePath,
  personalWorkspaceRootRelativePathForSlug,
  projectWorkspaceRootRelativePath,
  teamWorkspaceRootRelativePathForSlug,
  WorkspaceOperationError,
  workspaceAbsoluteRoot,
  type WorkspaceMemberCandidate,
  type WorkspaceMemberRecord,
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
  can_manage_organization_memory: number;
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

type TeamWorkspacePermissionRow = {
  workspace_id?: string;
  role: string;
  status: string;
  can_read: number;
  can_write: number;
  can_manage: number;
};

type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  can_read: number;
  can_write: number;
  can_manage: number;
  created_at: number;
  updated_at: number;
};

type WorkspaceMemberCandidateRow = {
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  banned: unknown;
};

type WorkspaceMemberCandidateEligibilityRow = {
  organization_role: string | null;
  organization_status: string | null;
  banned: unknown;
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
  description: string;
  workspace_icon: string | null;
  status: string;
  is_default: number;
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
  if (value === 'organization' || value === 'team' || value === 'project') return value;
  return 'personal';
}

function normalizeWorkspaceStatus(value: string): WorkspaceStatus {
  if (value === 'archived' || value === 'disabled' || value === 'recovery_locked') return value;
  return 'active';
}

function isBannedWorkspaceUser(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeWorkspaceMemberRole(value: string): WorkspaceMemberRecord['role'] {
  if (value === 'owner' || value === 'admin' || value === 'external') return value;
  return 'member';
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
    canManageOrganizationMemory: false,
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
    canManageOrganizationMemory: enabled && booleanFromDb(row.can_manage_organization_memory),
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
    description: row.description,
    icon: isWorkspaceIcon(row.workspace_icon) ? row.workspace_icon : getDefaultWorkspaceIcon(row.type),
    status: normalizeWorkspaceStatus(row.status),
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkspaceMemberRecord(row: WorkspaceMemberRow): WorkspaceMemberRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: normalizeWorkspaceMemberRole(row.role),
    status: normalizeWorkspaceStatus(row.status),
    canRead: row.can_read === 1,
    canWrite: row.can_write === 1,
    canManage: row.can_manage === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkspaceMemberCandidate(row: WorkspaceMemberCandidateRow): WorkspaceMemberCandidate {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: normalizeWorkspaceMemberRole(row.role),
    status: normalizeWorkspaceStatus(row.status),
  };
}

async function ensurePostgresWorkspaceMemberCandidate(
  database: RuntimeDb,
  params: { organizationId: string; userId: string },
): Promise<void> {
  const candidate = await database.get(
    `
      SELECT
        p.role AS organization_role,
        p.status AS organization_status,
        u.banned
      FROM "user" u
      LEFT JOIN organization_user_permissions p
        ON p.user_id = u.id AND p.organization_id = ?
      WHERE u.id = ?
      LIMIT 1
    `,
    [params.organizationId, params.userId],
  ) as WorkspaceMemberCandidateEligibilityRow | undefined;

  if (
    !candidate ||
    isBannedWorkspaceUser(candidate.banned) ||
    (candidate.organization_status !== null && candidate.organization_status !== 'active') ||
    candidate.organization_role === 'external'
  ) {
    throw new WorkspaceOperationError('WORKSPACE_MEMBER_NOT_ELIGIBLE', 'User is unavailable for workspace access.', 400);
  }

  if (candidate.organization_role !== null) return;

  const now = Date.now();
  await database.run(
    `
      INSERT INTO organization_user_permissions (
        organization_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, 'member', 'active', ?, ?)
      ON CONFLICT(organization_id, user_id) DO NOTHING
    `,
    [params.organizationId, params.userId, now, now],
  );
}

function ensureWorkspaceDirectory(rootRelativePath: string): void {
  mkdirSync(workspaceAbsoluteRoot(rootRelativePath), { recursive: true });
}

function normalizeWorkspaceName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new WorkspaceOperationError('WORKSPACE_NAME_REQUIRED', 'Workspace name is required.', 400);
  }
  const name = value.trim();
  if (!name) {
    throw new WorkspaceOperationError('WORKSPACE_NAME_REQUIRED', 'Workspace name is required.', 400);
  }
  if (name.length > 80) {
    throw new WorkspaceOperationError('WORKSPACE_NAME_TOO_LONG', 'Workspace name must be 80 characters or fewer.', 400);
  }
  if (name.includes('\0') || path.isAbsolute(name)) {
    throw new WorkspaceOperationError('WORKSPACE_NAME_INVALID', 'Workspace name is invalid.', 400);
  }
  const normalized = name.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new WorkspaceOperationError('WORKSPACE_NAME_INVALID', 'Workspace name is invalid.', 400);
  }
  return name;
}

function normalizeWorkspaceIcon(value: unknown, type: WorkspaceType): WorkspaceIcon {
  if (value === undefined || value === null) return getDefaultWorkspaceIcon(type);
  if (isWorkspaceIcon(value)) return value;
  throw new WorkspaceOperationError('WORKSPACE_ICON_INVALID', 'Workspace icon is invalid.', 400);
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
      'UPDATE account SET account_id = ?, issuer = COALESCE(issuer, ?), password = ?, updated_at = ? WHERE id = ?',
      [input.userId, 'local:credential', input.passwordHash, now, existingAccount.id],
    );
    return;
  }

  await database.run(
    `
      INSERT INTO account (
        id, account_id, provider_id, user_id, issuer, password, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [input.accountId || randomUUID(), input.userId, 'credential', input.userId, 'local:credential', input.passwordHash, now, now],
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
        can_manage_backups, can_manage_organization_memory, can_migrate_database, can_enable_knowledge, can_recover_workspaces
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
        can_manage_backups, can_manage_organization_memory, can_migrate_database, can_enable_knowledge, can_recover_workspaces,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      defaults.canManageOrganizationMemory ? 1 : 0,
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
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, status, is_default, created_at, updated_at
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
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, status, is_default, created_at, updated_at
      FROM canvas_workspaces
      WHERE type = 'personal' AND owner_user_id = ?
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `,
    [userId],
  ) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

async function getActiveOrganizationWorkspace(database: RuntimeDb, organizationId: string) {
  const row = await database.get(
    `
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, status, is_default, created_at, updated_at
      FROM canvas_workspaces
      WHERE type = 'organization' AND organization_id = ? AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [organizationId],
  ) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

async function ensureWorkspaceRecord(database: RuntimeDb, input: {
  organizationId: string;
  type: 'personal';
  ownerUserId: string | null;
  rootRelativePath: string;
  displayName: string;
  icon: WorkspaceIcon;
  isDefault?: boolean;
  preserveExistingRoot?: boolean;
}) {
  const existing = await getPersonalWorkspace(database, input.ownerUserId || '');
  const now = Date.now();

  if (existing) {
    const nextRootRelativePath = input.preserveExistingRoot ? existing.rootRelativePath : input.rootRelativePath;
    await database.run(
      'UPDATE canvas_workspaces SET root_relative_path = ?, display_name = ?, is_default = ?, updated_at = ? WHERE id = ?',
      [nextRootRelativePath, existing.displayName || input.displayName, input.isDefault ? 1 : 0, now, existing.id],
    );
    ensureWorkspaceDirectory(nextRootRelativePath);
    return await getWorkspaceById(database, existing.id);
  }

  const id = `ws_${randomUUID()}`;
  await database.run(
    `
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name, workspace_icon, status, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `,
    [id, input.organizationId, input.type, input.ownerUserId, input.rootRelativePath, input.displayName, input.icon, input.isDefault ? 1 : 0, now, now],
  );
  ensureWorkspaceDirectory(input.rootRelativePath);
  return await getWorkspaceById(database, id);
}

async function reserveWorkspaceRootRelativePath(
  database: RuntimeDb,
  baseSlug: string,
  buildPath: (slug: string) => string,
): Promise<string> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const slug = suffix === 0 ? baseSlug : `${baseSlug}-${suffix + 1}`;
    const rootRelativePath = buildPath(slug);
    const existing = await database.get(
      'SELECT id FROM canvas_workspaces WHERE root_relative_path = ? LIMIT 1',
      [rootRelativePath],
    ) as { id: string } | undefined;
    if (!existing) return rootRelativePath;
  }

  throw new WorkspaceOperationError(
    'WORKSPACE_SLUG_UNAVAILABLE',
    'Could not allocate a unique workspace path.',
    409,
  );
}

async function insertWorkspaceRecord(database: RuntimeDb, input: {
  organizationId: string;
  type: WorkspaceType;
  ownerUserId: string | null;
  projectId?: string | null;
  rootRelativePath: string;
  displayName: string;
  description: string;
  icon: WorkspaceIcon;
  isDefault?: boolean;
}) {
  const id = `ws_${randomUUID()}`;
  const now = Date.now();
  await database.run(
    `
      INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, project_id, root_relative_path, display_name, description, workspace_icon, status, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `,
    [
      id,
      input.organizationId,
      input.type,
      input.ownerUserId,
      input.projectId ?? null,
      input.rootRelativePath,
      input.displayName,
      input.description,
      input.icon,
      input.isDefault ? 1 : 0,
      now,
      now,
    ],
  );
  ensureWorkspaceDirectory(input.rootRelativePath);
  const record = await getWorkspaceById(database, id);
  if (!record) throw new WorkspaceOperationError('WORKSPACE_CREATE_FAILED', 'Workspace insert failed.', 500);
  return record;
}

async function upsertTeamWorkspaceOwnerMembership(database: RuntimeDb, input: {
  organizationId: string;
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const now = Date.now();
  await database.run(
    `
      INSERT INTO canvas_workspace_members (
        organization_id, workspace_id, user_id, role, status,
        can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', 'active', 1, 1, 1, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET
        role = excluded.role,
        status = excluded.status,
        can_read = excluded.can_read,
        can_write = excluded.can_write,
        can_manage = excluded.can_manage,
        updated_at = excluded.updated_at
    `,
    [input.organizationId, input.workspaceId, input.userId, input.userId, now, now],
  );
}

function canReadWorkspace(
  record: ReturnType<typeof rowToWorkspaceRecord>,
  actor: WorkspaceActor,
  permission: PermissionRow | null,
  teamPermission: TeamWorkspacePermissionRow | null = null,
  projectPermission: ProjectPermissionRow | null = null,
): boolean {
  if (record.status !== 'active') return false;
  if (record.type === 'personal') return record.ownerUserId === actor.userId;
  if (record.type === 'organization') {
    return Boolean(permission && permission.status === 'active' && permission.role !== 'external');
  }
  if (record.type === 'team') {
    if (!permission || permission.status !== 'active' || permission.role === 'external') return false;
    if (actor.role === 'owner' || actor.role === 'admin') return true;
    return Boolean(
      teamPermission?.status === 'active' &&
      teamPermission.role !== 'external' &&
      (
        teamPermission.can_read === 1 ||
        teamPermission.can_write === 1 ||
        teamPermission.can_manage === 1
      )
    );
  }
  if (record.type === 'project') {
    if (permission && permission.status !== 'active') return false;
    if ((actor.role === 'owner' || actor.role === 'admin') && permission?.status === 'active') return true;
    if (!permission && projectPermission?.role !== 'external') return false;
    return Boolean(projectPermission?.status === 'active' && projectPermission.can_read === 1);
  }
  return false;
}

function canDeleteWorkspaceRecord(
  record: ReturnType<typeof rowToWorkspaceRecord>,
  actor: WorkspaceActor,
  context: WorkspaceContext,
): boolean {
  if (record.isDefault) return false;
  if (record.type === 'personal') return record.ownerUserId === actor.userId;
  if (record.type === 'organization' || record.type === 'team' || record.type === 'project') {
    return context.permissions.canManageWorkspace;
  }
  return false;
}

async function countActiveWorkspaceAutomations(database: RuntimeDb, workspaceId: string): Promise<number> {
  const row = await database.get(
    `
      SELECT COUNT(*) AS count
      FROM automation_jobs
      WHERE workspace_id = ? AND status = 'active'
    `,
    [workspaceId],
  ) as { count?: number | string } | undefined;

  return Number(row?.count || 0);
}

function normalizeWorkspaceTypeChangeTarget(value: unknown): WorkspaceType {
  if (value === 'personal' || value === 'team' || value === 'project') return value;
  if (value === 'organization') {
    throw new WorkspaceOperationError(
      'WORKSPACE_ORGANIZATION_TYPE_UNSUPPORTED',
      'Changing a workspace to organization is not supported.',
      409,
    );
  }
  throw new WorkspaceOperationError('WORKSPACE_TYPE_INVALID', 'Workspace type is invalid.', 400);
}

function assertWorkspaceRootTargetAvailable(oldRelativePath: string, newRelativePath: string): void {
  if (oldRelativePath === newRelativePath) return;
  if (existsSync(workspaceAbsoluteRoot(newRelativePath))) {
    throw new WorkspaceOperationError('WORKSPACE_ROOT_EXISTS', 'Target workspace root already exists.', 409);
  }
}

function moveWorkspaceRootForTypeChange(oldRelativePath: string, newRelativePath: string): { moved: boolean; created: boolean } {
  if (oldRelativePath === newRelativePath) return { moved: false, created: false };
  assertWorkspaceRootTargetAvailable(oldRelativePath, newRelativePath);

  const oldRoot = workspaceAbsoluteRoot(oldRelativePath);
  const newRoot = workspaceAbsoluteRoot(newRelativePath);
  mkdirSync(path.dirname(newRoot), { recursive: true });

  if (!existsSync(oldRoot)) {
    mkdirSync(newRoot, { recursive: true });
    return { moved: false, created: true };
  }

  try {
    renameSync(oldRoot, newRoot);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV') {
      cpSync(oldRoot, newRoot, { recursive: true, force: false, errorOnExist: true });
      rmSync(oldRoot, { recursive: true, force: true });
    } else {
      throw error;
    }
  }

  return { moved: true, created: false };
}

function rollbackWorkspaceRootTypeChange(
  oldRelativePath: string,
  newRelativePath: string,
  state: { moved: boolean; created: boolean },
): void {
  if (oldRelativePath === newRelativePath) return;
  const oldRoot = workspaceAbsoluteRoot(oldRelativePath);
  const newRoot = workspaceAbsoluteRoot(newRelativePath);

  try {
    if (state.moved && existsSync(newRoot)) {
      mkdirSync(path.dirname(oldRoot), { recursive: true });
      if (existsSync(oldRoot)) {
        const entries = readdirSync(oldRoot);
        if (entries.length > 0) return;
        rmSync(oldRoot, { recursive: true, force: true });
      }
      renameSync(newRoot, oldRoot);
    } else if (state.created && existsSync(newRoot)) {
      rmSync(newRoot, { recursive: true, force: true });
    }
  } catch {
    // Preserve the original type-change failure. Manual recovery may be needed if rollback fails.
  }
}

type TypeChangeMemberRow = {
  user_id: string;
  role: string;
  status: string;
  can_read: number;
  can_write: number;
  can_manage: number;
  invited_by_user_id: string | null;
};

function managerMemberForActor(actor: WorkspaceActor): TypeChangeMemberRow {
  return {
    user_id: actor.userId,
    role: 'admin',
    status: 'active',
    can_read: 1,
    can_write: 1,
    can_manage: 1,
    invited_by_user_id: actor.userId,
  };
}

function ensureAtLeastOneManagerForTypeChange(members: TypeChangeMemberRow[], actor: WorkspaceActor): TypeChangeMemberRow[] {
  if (members.some((member) => member.can_manage === 1)) return members;
  return [...members, managerMemberForActor(actor)];
}

async function collectWorkspaceMembersForTypeChange(database: RuntimeDb, workspaceId: string): Promise<TypeChangeMemberRow[]> {
  return await database.all(
    `
      SELECT user_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage, invited_by_user_id
      FROM canvas_workspace_members
      WHERE workspace_id = ?
    `,
    [workspaceId],
  ) as TypeChangeMemberRow[];
}

async function collectProjectMembersForTypeChange(database: RuntimeDb, organizationId: string, projectId: string): Promise<TypeChangeMemberRow[]> {
  return await database.all(
    `
      SELECT user_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage, invited_by_user_id
      FROM canvas_project_members
      WHERE organization_id = ? AND project_id = ?
    `,
    [organizationId, projectId],
  ) as TypeChangeMemberRow[];
}

async function upsertWorkspaceMembersForTypeChange(
  database: RuntimeDb,
  organizationId: string,
  workspaceId: string,
  members: TypeChangeMemberRow[],
): Promise<void> {
  const now = Date.now();
  for (const member of members) {
    await database.run(
      `
        INSERT INTO canvas_workspace_members (
          organization_id, workspace_id, user_id, role, status,
          can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET
          organization_id = excluded.organization_id,
          role = excluded.role,
          status = excluded.status,
          can_read = excluded.can_read,
          can_write = excluded.can_write,
          can_manage = excluded.can_manage,
          invited_by_user_id = excluded.invited_by_user_id,
          updated_at = excluded.updated_at
      `,
      [
        organizationId,
        workspaceId,
        member.user_id,
        normalizeWorkspaceMemberRole(member.role),
        normalizeWorkspaceStatus(member.status),
        member.can_read,
        member.can_write,
        member.can_manage,
        member.invited_by_user_id,
        now,
        now,
      ],
    );
  }
}

async function upsertProjectMembersForTypeChange(
  database: RuntimeDb,
  organizationId: string,
  projectId: string,
  members: TypeChangeMemberRow[],
): Promise<void> {
  const now = Date.now();
  for (const member of members) {
    await database.run(
      `
        INSERT INTO canvas_project_members (
          organization_id, project_id, user_id, role, status,
          can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET
          organization_id = excluded.organization_id,
          role = excluded.role,
          status = excluded.status,
          can_read = excluded.can_read,
          can_write = excluded.can_write,
          can_manage = excluded.can_manage,
          invited_by_user_id = excluded.invited_by_user_id,
          updated_at = excluded.updated_at
      `,
      [
        organizationId,
        projectId,
        member.user_id,
        normalizeWorkspaceMemberRole(member.role),
        normalizeWorkspaceStatus(member.status),
        member.can_read,
        member.can_write,
        member.can_manage,
        member.invited_by_user_id,
        now,
        now,
      ],
    );
  }
}

function workspaceContextFromRecord(
  record: ReturnType<typeof rowToWorkspaceRecord>,
  actor: WorkspaceActor,
  permission: PermissionRow | null = null,
  teamPermission: TeamWorkspacePermissionRow | null = null,
  projectPermission: ProjectPermissionRow | null = null,
): WorkspaceContext {
  const role = actor.role;
  const activeInternalOrganizationUser = Boolean(permission && permission.status === 'active' && permission.role !== 'external');
  const ownsPersonalWorkspace = record.type === 'personal' && record.ownerUserId === actor.userId;
  const canAccessOrganizationWorkspace = record.type === 'organization' && activeInternalOrganizationUser;
  const canWriteOrganizationWorkspace = record.type === 'organization' && (
    permission?.status === 'active' &&
    (
      role === 'owner' ||
      role === 'admin' ||
      permission?.can_write_team_workspace === 1
    )
  );
  const canDeleteOrganizationWorkspace = record.type === 'organization' && (
    permission?.status === 'active' &&
    permission?.can_delete_team_files === 1
  );
  const canUseTeamMembership = record.type === 'team' && teamPermission?.status === 'active' && teamPermission.role !== 'external';
  const canAccessTeamWorkspace = canUseTeamMembership && teamPermission.can_read === 1;
  const canWriteTeamWorkspace = canUseTeamMembership && teamPermission.can_write === 1;
  const canDeleteTeamWorkspace = canUseTeamMembership && permission?.status === 'active' && permission.can_delete_team_files === 1;
  const canManageTeamWorkspace = canUseTeamMembership && teamPermission.can_manage === 1;
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
    description: record.description,
    icon: record.icon,
    status: record.status,
    isDefault: record.isDefault,
    actor,
    organizationId: record.organizationId,
    customerId: record.customerId,
    projectId: record.projectId,
    ownerUserId: record.ownerUserId,
    permissions: resolveWorkspacePermissions({
      role,
      workspaceType: record.type,
      ownsPersonalWorkspace,
      canAccessOrganizationWorkspace,
      canWriteOrganizationWorkspace,
      canDeleteOrganizationWorkspace,
      canAccessTeamWorkspace,
      canWriteTeamWorkspace,
      canDeleteTeamWorkspace,
      canManageTeamWorkspace,
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

async function getTeamWorkspacePermissionRows(
  database: RuntimeDb,
  userId: string,
  workspaceIds: string[],
): Promise<Map<string, TeamWorkspacePermissionRow>> {
  const uniqueWorkspaceIds = Array.from(new Set(workspaceIds.filter(Boolean)));
  if (uniqueWorkspaceIds.length === 0) return new Map();
  const placeholders = uniqueWorkspaceIds.map(() => '?').join(', ');
  const rows = await database.all(
    `
      SELECT workspace_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
      FROM canvas_workspace_members
      WHERE user_id = ? AND workspace_id IN (${placeholders})
    `,
    [userId, ...uniqueWorkspaceIds],
  ) as TeamWorkspacePermissionRow[];

  return new Map(rows.flatMap((row) => (row.workspace_id ? [[row.workspace_id, row]] : [])));
}

async function getTeamWorkspacePermissionRow(
  database: RuntimeDb,
  workspaceId: string,
  userId: string,
): Promise<TeamWorkspacePermissionRow | null> {
  return await database.get(
    `
      SELECT workspace_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
      FROM canvas_workspace_members
      WHERE workspace_id = ? AND user_id = ?
      LIMIT 1
    `,
    [workspaceId, userId],
  ) as TeamWorkspacePermissionRow | undefined || null;
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
      SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, status, is_default, created_at, updated_at
      FROM canvas_workspaces
      WHERE organization_id = ? AND status = 'active'
        AND (type != 'personal' OR owner_user_id = ?)
      ORDER BY is_default DESC, CASE type WHEN 'personal' THEN 0 WHEN 'organization' THEN 1 WHEN 'team' THEN 2 ELSE 3 END, created_at ASC
    `,
    [organizationId, actor.userId],
  ) as WorkspaceRow[];
  const permission = await getPermissionRow(database, organizationId, actor.userId);
  const teamPermissionRows = await getTeamWorkspacePermissionRows(
    database,
    actor.userId,
    rows.flatMap((row) => (row.type === 'team' ? [row.id] : [])),
  );
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
      teamPermission: record.type === 'team' ? teamPermissionRows.get(record.id) ?? null : null,
      projectPermission: record.projectId ? projectPermissionRows.get(record.projectId) ?? null : null,
    }))
    .filter(({ record, teamPermission, projectPermission }) => canReadWorkspace(record, actor, permission, teamPermission, projectPermission))
    .map(({ record, teamPermission, projectPermission }) => workspaceContextFromRecord(record, actor, permission, teamPermission, projectPermission));
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
  const teamPermission = record.type === 'team'
    ? await getTeamWorkspacePermissionRow(database, record.id, actor.userId)
    : null;
  const projectPermission = await getProjectPermissionRow(database, record.organizationId, record.projectId, actor.userId);
  if (!canReadWorkspace(record, actor, permission, teamPermission, projectPermission)) return null;
  return workspaceContextFromRecord(record, actor, permission, teamPermission, projectPermission);
}

function buildStatus(
  organization: OrganizationRow | null,
  ownerUser: PostgresUserRow | null,
  permission: OrganizationPermissionSnapshot | null,
  organizationWorkspaceRootRelativePath: string | null = null,
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
      personalWorkspace: ownerUserId
        ? path.join(/* turbopackIgnore: true */ dataRoot, personalWorkspaceRootRelativePath(ownerUserId))
        : null,
      userSettings: ownerUserId ? path.join(dataRoot, 'users', ownerUserId, 'settings') : null,
      userSecrets: ownerUserId ? path.join(dataRoot, 'users', ownerUserId, 'secrets') : null,
      organizationRoot: organizationId ? path.join(dataRoot, 'organizations', organizationId) : null,
      teamWorkspace: organizationWorkspaceRootRelativePath
        ? path.join(/* turbopackIgnore: true */ dataRoot, organizationWorkspaceRootRelativePath)
        : null,
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
    const organizationWorkspace = organization
      ? await getActiveOrganizationWorkspace(database, organization.organization_id)
      : null;
    return buildStatus(
      organization,
      ownerUser,
      permission,
      organizationWorkspace?.rootRelativePath ?? null,
    );
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

  await ensureWorkspaceRecord(database, {
    organizationId: organization.organization_id,
    type: 'personal',
    ownerUserId: ownerUser.id,
    rootRelativePath: personalWorkspaceRootRelativePath(ownerUser.id),
    displayName: 'Personal Workspace',
    icon: getDefaultWorkspaceIcon('personal'),
    isDefault: true,
  });
  if (targetUser.id !== ownerUser.id) {
    await ensureWorkspaceRecord(database, {
      organizationId: organization.organization_id,
      type: 'personal',
      ownerUserId: targetUser.id,
      rootRelativePath: personalWorkspaceRootRelativePath(targetUser.id),
      displayName: 'Personal Workspace',
      icon: getDefaultWorkspaceIcon('personal'),
      isDefault: true,
    });
  }

  const organizationWorkspace = await getActiveOrganizationWorkspace(
    database,
    organization.organization_id,
  );
  return buildStatus(
    organization,
    ownerUser,
    ownerPermission,
    organizationWorkspace?.rootRelativePath ?? null,
  );
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

export async function createPostgresWorkspaceForActor(
  actor: WorkspaceActor,
  input: {
    type: WorkspaceType;
    name: unknown;
    description?: unknown;
    icon?: unknown;
    projectFeaturesEnabled?: boolean;
    projectId?: string | null;
  },
): Promise<WorkspaceContext> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const status = await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    if (!status.organizationId) {
      throw new OrganizationBootstrapError('DATABASE_ERROR', 'Organization is not configured.');
    }
    const permission = await getPermissionRow(database, status.organizationId, actor.userId);
    if (!permission || permission.status !== 'active' || permission.role === 'external') {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
    }

    const name = normalizeWorkspaceName(input.name);
    const description = normalizeWorkspaceDescription(input.description);
    const icon = normalizeWorkspaceIcon(input.icon, input.type);
    if (
      input.type !== 'personal'
      && input.type !== 'organization'
      && input.type !== 'team'
      && input.type !== 'project'
    ) {
      throw new WorkspaceOperationError('WORKSPACE_TYPE_INVALID', 'Workspace type is invalid.', 400);
    }
    if ((input.type === 'organization' || input.type === 'team') && !status.teamFeaturesEnabled) {
      throw new WorkspaceOperationError(
        'WORKSPACE_TEAM_FEATURES_DISABLED',
        'Shared organization and team workspaces are not enabled.',
        403,
      );
    }
    if (
      (input.type === 'organization' || input.type === 'team')
      && actor.role !== 'owner'
      && actor.role !== 'admin'
    ) {
      throw new WorkspaceOperationError(
        'WORKSPACE_PERMISSION_DENIED',
        'Only admins can create organization and team workspaces.',
        403,
      );
    }
    if (input.type === 'project' && actor.role !== 'owner' && actor.role !== 'admin') {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Only admins can create project workspaces.', 403);
    }
    if (input.type === 'project') {
      if (!input.projectFeaturesEnabled) {
        throw new WorkspaceOperationError(
          'WORKSPACE_PROJECT_FEATURE_DISABLED',
          'Project workspaces are not yet available.',
          501,
        );
      }
      const projectId = input.projectId?.trim() || '';
      if (!projectId) {
        throw new WorkspaceOperationError('WORKSPACE_PROJECT_REQUIRED', 'Project id is required.', 400);
      }
      const existingProjectWorkspace = await database.get(
        `
          SELECT id
          FROM canvas_workspaces
          WHERE type = 'project' AND organization_id = ? AND project_id = ?
          LIMIT 1
        `,
        [status.organizationId, projectId],
      ) as { id: string } | undefined;
      if (existingProjectWorkspace) {
        throw new WorkspaceOperationError('WORKSPACE_PROJECT_ALREADY_HAS_WORKSPACE', 'Project already has a workspace.', 409);
      }
    }
    if (input.type === 'organization') {
      await database.get(
        'SELECT pg_advisory_xact_lock(hashtext(?))',
        [`canvas:organization-workspace:${status.organizationId}`],
      );
      if (await getActiveOrganizationWorkspace(database, status.organizationId)) {
        throw new WorkspaceOperationError(
          'WORKSPACE_ORGANIZATION_ALREADY_EXISTS',
          'An active organization workspace already exists.',
          409,
        );
      }
    }

    const project = input.type === 'project'
      ? await database.get(
          `
            SELECT id, customer_id
            FROM canvas_projects
            WHERE organization_id = ? AND id = ? AND status = 'active'
            LIMIT 1
          `,
          [status.organizationId, input.projectId?.trim() || ''],
        ) as { id: string; customer_id: string | null } | undefined
      : null;
    if (input.type === 'project' && !project) {
      throw new WorkspaceOperationError('WORKSPACE_PROJECT_NOT_FOUND', 'Project not found.', 404);
    }

    const slug = normalizeWorkspaceSlug(name);
    const rootRelativePath = input.type === 'personal'
      ? await reserveWorkspaceRootRelativePath(
          database,
          slug,
          (candidate) => personalWorkspaceRootRelativePathForSlug(actor.userId, candidate),
        )
      : input.type === 'organization'
        ? await reserveWorkspaceRootRelativePath(
            database,
            slug,
            (candidate) => organizationWorkspaceRootRelativePathForSlug(status.organizationId!, candidate),
          )
        : input.type === 'team'
        ? await reserveWorkspaceRootRelativePath(
            database,
            slug,
            (candidate) => teamWorkspaceRootRelativePathForSlug(status.organizationId!, candidate),
          )
        : projectWorkspaceRootRelativePath(project?.id ?? '');
    const record = await insertWorkspaceRecord(database, {
      organizationId: status.organizationId,
      type: input.type,
      ownerUserId: input.type === 'personal' ? actor.userId : null,
      projectId: input.type === 'project' ? project?.id ?? null : null,
      rootRelativePath,
      displayName: name,
      description,
      icon,
      isDefault: false,
    });

    if (record.type === 'project' && project?.customer_id) {
      await database.run(
        'UPDATE canvas_workspaces SET customer_id = ?, updated_at = ? WHERE id = ?',
        [project.customer_id, Date.now(), record.id],
      );
    }
    if (record.type === 'team') {
      await upsertTeamWorkspaceOwnerMembership(database, {
        organizationId: status.organizationId,
        workspaceId: record.id,
        userId: actor.userId,
      });
    }
    if (record.type === 'project' && record.projectId) {
      const now = Date.now();
      await database.run(
        `
          INSERT INTO canvas_project_members (
            organization_id, project_id, user_id, role, status,
            can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'admin', 'active', 1, 1, 1, ?, ?, ?)
          ON CONFLICT(project_id, user_id) DO UPDATE SET
            role = excluded.role,
            status = excluded.status,
            can_read = excluded.can_read,
            can_write = excluded.can_write,
            can_manage = excluded.can_manage,
            invited_by_user_id = excluded.invited_by_user_id,
            updated_at = excluded.updated_at
        `,
        [status.organizationId, record.projectId, actor.userId, actor.userId, now, now],
      );
    }

    const workspace = await resolveWorkspaceContextById(database, actor, record.id);
    if (!workspace) {
      throw new WorkspaceOperationError('WORKSPACE_CREATE_FAILED', 'Workspace was created but could not be resolved.', 500);
    }
    await database.run('COMMIT');
    return workspace;
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function updatePostgresWorkspaceForActor(
  actor: WorkspaceActor,
  workspaceId: string,
  input: {
    name?: unknown;
    description?: unknown;
    icon?: unknown;
  },
): Promise<WorkspaceContext> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    const record = await getWorkspaceById(database, workspaceId);
    if (!record || record.status === 'disabled' || record.status === 'archived') {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    if (record.status !== 'active') {
      throw new WorkspaceOperationError('WORKSPACE_NOT_ACTIVE', 'Workspace is not active.', 409);
    }

    const context = await resolveWorkspaceContextById(database, actor, workspaceId);
    if (!context || !context.permissions.canManageWorkspace) {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
    }

    const nextName = input.name === undefined ? record.displayName : normalizeWorkspaceName(input.name);
    const nextDescription = input.description === undefined
      ? record.description
      : normalizeWorkspaceDescription(input.description);
    const nextIcon = input.icon === undefined ? record.icon : normalizeWorkspaceIcon(input.icon, record.type);
    if (
      nextName !== record.displayName
      || nextDescription !== record.description
      || nextIcon !== record.icon
    ) {
      await database.run(
        'UPDATE canvas_workspaces SET display_name = ?, description = ?, workspace_icon = ?, updated_at = ? WHERE id = ?',
        [nextName, nextDescription, nextIcon, Date.now(), record.id],
      );
    }

    const updated = await getWorkspaceById(database, record.id);
    if (!updated) throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    const permission = await getPermissionRow(database, updated.organizationId, actor.userId);
    const teamPermission = updated.type === 'team'
      ? await getTeamWorkspacePermissionRow(database, updated.id, actor.userId)
      : null;
    const projectPermission = await getProjectPermissionRow(database, updated.organizationId, updated.projectId, actor.userId);
    const workspace = workspaceContextFromRecord(updated, actor, permission, teamPermission, projectPermission);
    await database.run('COMMIT');
    return workspace;
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function deletePostgresWorkspaceForActor(
  actor: WorkspaceActor,
  workspaceId: string,
): Promise<void> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    const record = await getWorkspaceById(database, workspaceId);
    if (!record || record.status === 'disabled' || record.status === 'archived') {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    if (record.status !== 'active') {
      throw new WorkspaceOperationError('WORKSPACE_NOT_ACTIVE', 'Workspace is not active.', 409);
    }
    if (record.isDefault) {
      throw new WorkspaceOperationError('WORKSPACE_IS_DEFAULT', 'Default workspaces cannot be deleted.', 409);
    }
    const workspace = await resolveWorkspaceContextById(database, actor, workspaceId);
    if (!workspace || !canDeleteWorkspaceRecord(record, actor, workspace)) {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
    }
    if (await countActiveWorkspaceAutomations(database, workspaceId) > 0) {
      throw new WorkspaceOperationError(
        'WORKSPACE_HAS_AUTOMATIONS',
        'Workspace has active automations and cannot be deleted.',
        409,
      );
    }

    await database.run(
      "UPDATE canvas_workspaces SET status = 'disabled', updated_at = ? WHERE id = ?",
      [Date.now(), workspaceId],
    );
    await database.run('COMMIT');
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function changePostgresWorkspaceTypeForActor(
  actor: WorkspaceActor,
  workspaceId: string,
  input: {
    type: unknown;
    projectId?: unknown;
  },
): Promise<WorkspaceContext> {
  const database = await openDb();
  let rootMove: { moved: boolean; created: boolean } | null = null;
  let oldRootRelativePath: string | null = null;
  let nextRootRelativePath: string | null = null;

  try {
    await database.run('BEGIN');
    const status = await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    if (!status.organizationId) {
      throw new OrganizationBootstrapError('DATABASE_ERROR', 'Organization is not configured.');
    }
    const record = await getWorkspaceById(database, workspaceId);
    if (!record || record.status === 'disabled' || record.status === 'archived') {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    if (record.status !== 'active') {
      throw new WorkspaceOperationError('WORKSPACE_NOT_ACTIVE', 'Workspace is not active.', 409);
    }
    if (record.isDefault) {
      throw new WorkspaceOperationError('WORKSPACE_DEFAULT_TYPE_LOCKED', 'Default workspaces cannot change type.', 409);
    }
    if (record.type === 'organization') {
      throw new WorkspaceOperationError('WORKSPACE_ORGANIZATION_TYPE_LOCKED', 'Organization workspace type cannot be changed.', 409);
    }
    if (actor.role !== 'owner' && actor.role !== 'admin') {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Only admins can change workspace type.', 403);
    }

    const context = await resolveWorkspaceContextById(database, actor, workspaceId);
    if (!context || !context.permissions.canManageWorkspace) {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
    }

    const targetType = normalizeWorkspaceTypeChangeTarget(input.type);
    if (targetType === 'team' && !status.teamFeaturesEnabled) {
      throw new WorkspaceOperationError('WORKSPACE_TEAM_FEATURES_DISABLED', 'Team workspaces are not enabled.', 403);
    }
    const targetProjectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    const targetProject = targetType === 'project'
      ? await database.get(
          `
            SELECT id, customer_id
            FROM canvas_projects
            WHERE organization_id = ? AND id = ? AND status = 'active'
            LIMIT 1
          `,
          [record.organizationId, targetProjectId],
        ) as { id: string; customer_id: string | null } | undefined
      : null;
    if (targetType === 'project' && !targetProject) {
      throw new WorkspaceOperationError('WORKSPACE_PROJECT_NOT_FOUND', 'Project not found.', 404);
    }

    if (record.type === targetType && (targetType !== 'project' || record.projectId === targetProjectId)) {
      await database.run('COMMIT');
      return context;
    }

    const slug = normalizeWorkspaceSlug(record.displayName);
    nextRootRelativePath = targetType === 'personal'
      ? await reserveWorkspaceRootRelativePath(
          database,
          slug,
          (candidate) => personalWorkspaceRootRelativePathForSlug(actor.userId, candidate),
        )
      : targetType === 'team'
        ? await reserveWorkspaceRootRelativePath(
            database,
            slug,
            (candidate) => teamWorkspaceRootRelativePathForSlug(record.organizationId, candidate),
          )
        : projectWorkspaceRootRelativePath(targetProjectId);

    if (targetType === 'project') {
      const existingProjectWorkspace = await database.get(
        `
          SELECT id
          FROM canvas_workspaces
          WHERE type = 'project' AND organization_id = ? AND project_id = ?
          LIMIT 1
        `,
        [record.organizationId, targetProjectId],
      ) as { id: string } | undefined;
      if (existingProjectWorkspace && existingProjectWorkspace.id !== record.id) {
        throw new WorkspaceOperationError('WORKSPACE_PROJECT_ALREADY_HAS_WORKSPACE', 'Project already has a workspace.', 409);
      }
      const existingRoot = await database.get(
        `
          SELECT id
          FROM canvas_workspaces
          WHERE root_relative_path = ? AND id != ?
          LIMIT 1
        `,
        [nextRootRelativePath, record.id],
      ) as { id: string } | undefined;
      if (existingRoot) {
        throw new WorkspaceOperationError('WORKSPACE_ROOT_EXISTS', 'Target workspace root already exists.', 409);
      }
    }

    const sourceTeamMembers = record.type === 'team'
      ? await collectWorkspaceMembersForTypeChange(database, record.id)
      : [];
    const sourceProjectMembers = record.type === 'project' && record.projectId
      ? await collectProjectMembersForTypeChange(database, record.organizationId, record.projectId)
      : [];

    oldRootRelativePath = record.rootRelativePath;
    rootMove = moveWorkspaceRootForTypeChange(record.rootRelativePath, nextRootRelativePath);
    const now = Date.now();
    await database.run(
      `
        UPDATE canvas_workspaces
        SET type = ?,
          owner_user_id = ?,
          customer_id = ?,
          project_id = ?,
          root_relative_path = ?,
          is_default = 0,
          updated_at = ?
        WHERE id = ?
      `,
      [
        targetType,
        targetType === 'personal' ? actor.userId : null,
        targetProject?.customer_id ?? null,
        targetType === 'project' ? targetProjectId : null,
        nextRootRelativePath,
        now,
        record.id,
      ],
    );

    if (record.type === 'team' && targetType !== 'team') {
      await database.run('DELETE FROM canvas_workspace_members WHERE workspace_id = ?', [record.id]);
    }
    if (record.type === 'project' && record.projectId && (targetType !== 'project' || record.projectId !== targetProjectId)) {
      await database.run(
        'DELETE FROM canvas_project_members WHERE organization_id = ? AND project_id = ?',
        [record.organizationId, record.projectId],
      );
    }

    if (targetType === 'team') {
      await upsertWorkspaceMembersForTypeChange(
        database,
        record.organizationId,
        record.id,
        ensureAtLeastOneManagerForTypeChange(record.type === 'project' ? sourceProjectMembers : sourceTeamMembers, actor),
      );
    } else if (targetType === 'project') {
      await upsertProjectMembersForTypeChange(
        database,
        record.organizationId,
        targetProjectId,
        ensureAtLeastOneManagerForTypeChange(record.type === 'team' ? sourceTeamMembers : sourceProjectMembers, actor),
      );
    }

    const updated = await getWorkspaceById(database, record.id);
    if (!updated) {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    const permission = await getPermissionRow(database, updated.organizationId, actor.userId);
    const teamPermission = updated.type === 'team'
      ? await getTeamWorkspacePermissionRow(database, updated.id, actor.userId)
      : null;
    const projectPermission = await getProjectPermissionRow(database, updated.organizationId, updated.projectId, actor.userId);
    const workspace = workspaceContextFromRecord(updated, actor, permission, teamPermission, projectPermission);
    await database.run('COMMIT');
    return workspace;
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    if (rootMove && oldRootRelativePath && nextRootRelativePath) {
      rollbackWorkspaceRootTypeChange(oldRootRelativePath, nextRootRelativePath, rootMove);
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function listPostgresWorkspaceMembersForActor(
  actor: WorkspaceActor,
  workspaceId: string,
  options: { requireManage?: boolean; includeCandidates?: boolean } = {},
): Promise<{ workspace: WorkspaceContext; members: WorkspaceMemberRecord[]; candidates: WorkspaceMemberCandidate[] }> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    const workspace = await resolveWorkspaceContextById(database, actor, workspaceId);
    if (!workspace) {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    const requireManage = options.requireManage !== false;
    if (requireManage ? !workspace.permissions.canManageWorkspace : !workspace.permissions.canRead) {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
    }
    if (workspace.workspaceType === 'personal') {
      throw new WorkspaceOperationError('WORKSPACE_PERSONAL_NO_MEMBERS', 'Personal workspaces do not have members.', 403);
    }
    if (workspace.workspaceType === 'organization') {
      throw new WorkspaceOperationError(
        'WORKSPACE_ORGANIZATION_MANAGED_VIA_ORG',
        'Organization workspace access is managed through organization users.',
        403,
      );
    }
    if (workspace.workspaceType !== 'team' && workspace.workspaceType !== 'project') {
      throw new WorkspaceOperationError('WORKSPACE_MEMBERS_UNSUPPORTED', 'Workspace members are only supported for team and project workspaces.', 403);
    }
    if (workspace.workspaceType === 'project' && !workspace.projectId) {
      throw new WorkspaceOperationError('WORKSPACE_PROJECT_REQUIRED', 'Project workspace project id is required.', 409);
    }

    const rows = workspace.workspaceType === 'project'
      ? await database.all(
          `
            SELECT
              ? AS workspace_id,
              m.user_id,
              u.name,
              u.email,
              m.role,
              COALESCE(m.status, 'active') AS status,
              m.can_read,
              m.can_write,
              m.can_manage,
              m.created_at,
              m.updated_at
            FROM canvas_project_members m
            LEFT JOIN "user" u ON u.id = m.user_id
            WHERE m.organization_id = ? AND m.project_id = ?
            ORDER BY m.can_manage DESC, lower(COALESCE(u.email, u.name, m.user_id)) ASC
          `,
          [workspace.workspaceId, workspace.organizationId, workspace.projectId],
        ) as WorkspaceMemberRow[]
      : await database.all(
          `
            SELECT
              m.workspace_id,
              m.user_id,
              u.name,
              u.email,
              m.role,
              COALESCE(m.status, 'active') AS status,
              m.can_read,
              m.can_write,
              m.can_manage,
              m.created_at,
              m.updated_at
            FROM canvas_workspace_members m
            LEFT JOIN "user" u ON u.id = m.user_id
            WHERE m.workspace_id = ?
            ORDER BY m.can_manage DESC, lower(COALESCE(u.email, u.name, m.user_id)) ASC
          `,
          [workspaceId],
        ) as WorkspaceMemberRow[];
    const candidateRows = options.includeCandidates === false ? [] : await database.all(
      `
        SELECT
          u.id AS user_id,
          u.name,
          u.email,
          COALESCE(p.role, 'member') AS role,
          COALESCE(p.status, 'active') AS status,
          u.banned
        FROM "user" u
        LEFT JOIN organization_user_permissions p
          ON p.user_id = u.id AND p.organization_id = ?
        WHERE COALESCE(p.status, 'active') = 'active'
          AND COALESCE(p.role, 'member') != 'external'
        ORDER BY lower(COALESCE(u.email, u.name, u.id)) ASC
      `,
      [workspace.organizationId],
    ) as WorkspaceMemberCandidateRow[];
    await database.run('COMMIT');
    return {
      workspace,
      members: rows.map(rowToWorkspaceMemberRecord),
      candidates: candidateRows
        .filter((row) => !isBannedWorkspaceUser(row.banned))
        .map(rowToWorkspaceMemberCandidate),
    };
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await database.close();
  }
}

async function assertPostgresWorkspaceRetainsManager(
  database: RuntimeDb,
  workspace: WorkspaceContext,
  userId: string,
  nextCanManage: boolean,
) {
  if (nextCanManage) return;

  const rows = workspace.workspaceType === 'project'
    ? await database.all(
        `
          SELECT user_id, can_manage
          FROM canvas_project_members
          WHERE organization_id = ?
            AND project_id = ?
            AND COALESCE(status, 'active') = 'active'
          ORDER BY user_id
          FOR UPDATE
        `,
        [workspace.organizationId, workspace.projectId],
      ) as Array<{ user_id: string; can_manage: number }>
    : await database.all(
        `
          SELECT user_id, can_manage
          FROM canvas_workspace_members
          WHERE workspace_id = ?
            AND COALESCE(status, 'active') = 'active'
          ORDER BY user_id
          FOR UPDATE
        `,
        [workspace.workspaceId],
      ) as Array<{ user_id: string; can_manage: number }>;
  const target = rows.find((row) => row.user_id === userId);
  const activeManagerCount = rows.filter((row) => Boolean(row.can_manage)).length;
  if (wouldRemoveLastWorkspaceManager({
    targetIsActiveManager: Boolean(target?.can_manage),
    activeManagerCount,
    nextCanManage,
  })) {
    throw new WorkspaceOperationError(
      WORKSPACE_LAST_MANAGER_CODE,
      WORKSPACE_LAST_MANAGER_MESSAGE,
      409,
    );
  }
}

export async function upsertPostgresWorkspaceMemberForActor(
  actor: WorkspaceActor,
  workspaceId: string,
  input: {
    userId: unknown;
    role?: unknown;
    canRead?: unknown;
    canWrite?: unknown;
    canManage?: unknown;
  },
): Promise<WorkspaceMemberRecord> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    const workspace = await resolveWorkspaceContextById(database, actor, workspaceId);
    if (!workspace) {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    if (!workspace.permissions.canManageWorkspace) {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
    }
    if (workspace.workspaceType !== 'team' && workspace.workspaceType !== 'project') {
      throw new WorkspaceOperationError('WORKSPACE_MEMBERS_UNSUPPORTED', 'Workspace members are only supported for team and project workspaces.', 403);
    }
    if (workspace.workspaceType === 'project' && !workspace.projectId) {
      throw new WorkspaceOperationError('WORKSPACE_PROJECT_REQUIRED', 'Project workspace project id is required.', 409);
    }
    const organizationId = workspace.organizationId;
    if (!organizationId) {
      throw new WorkspaceOperationError('WORKSPACE_ORGANIZATION_REQUIRED', 'Workspace organization id is required.', 409);
    }
    if (workspace.workspaceType === 'project') {
      const project = await database.get(
        `
          SELECT id
          FROM canvas_projects
          WHERE organization_id = ? AND id = ? AND status = 'active'
          LIMIT 1
        `,
        [organizationId, workspace.projectId],
      ) as { id: string } | undefined;
      if (!project) {
        throw new WorkspaceOperationError('WORKSPACE_PROJECT_NOT_FOUND', 'Project not found.', 404);
      }
    }

    const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
    if (!userId) {
      throw new WorkspaceOperationError('WORKSPACE_MEMBER_USER_REQUIRED', 'User is required.', 400);
    }
    await ensurePostgresWorkspaceMemberCandidate(database, {
      organizationId,
      userId,
    });

    const role = typeof input.role === 'string' ? normalizeWorkspaceMemberRole(input.role) : 'member';
    const canManage = Boolean(input.canManage);
    const canWrite = canManage || Boolean(input.canWrite);
    const canRead = canManage || canWrite || input.canRead !== false;
    await assertPostgresWorkspaceRetainsManager(database, workspace, userId, canManage);
    const now = Date.now();
    if (workspace.workspaceType === 'project') {
      await database.run(
        `
          INSERT INTO canvas_project_members (
            organization_id, project_id, user_id, role, status,
            can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, user_id) DO UPDATE SET
            organization_id = excluded.organization_id,
            role = excluded.role,
            status = excluded.status,
            can_read = excluded.can_read,
            can_write = excluded.can_write,
            can_manage = excluded.can_manage,
            invited_by_user_id = excluded.invited_by_user_id,
            updated_at = excluded.updated_at
        `,
        [
          workspace.organizationId,
          workspace.projectId,
          userId,
          role,
          canRead ? 1 : 0,
          canWrite ? 1 : 0,
          canManage ? 1 : 0,
          actor.userId,
          now,
          now,
        ],
      );
    } else {
      await database.run(
        `
          INSERT INTO canvas_workspace_members (
            organization_id, workspace_id, user_id, role, status,
            can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, user_id) DO UPDATE SET
            role = excluded.role,
            status = excluded.status,
            can_read = excluded.can_read,
            can_write = excluded.can_write,
            can_manage = excluded.can_manage,
            invited_by_user_id = excluded.invited_by_user_id,
            updated_at = excluded.updated_at
        `,
        [
          workspace.organizationId,
          workspace.workspaceId,
          userId,
          role,
          canRead ? 1 : 0,
          canWrite ? 1 : 0,
          canManage ? 1 : 0,
          actor.userId,
          now,
          now,
        ],
      );
    }

    const row = workspace.workspaceType === 'project'
      ? await database.get(
          `
            SELECT
              ? AS workspace_id,
              m.user_id,
              u.name,
              u.email,
              m.role,
              COALESCE(m.status, 'active') AS status,
              m.can_read,
              m.can_write,
              m.can_manage,
              m.created_at,
              m.updated_at
            FROM canvas_project_members m
            LEFT JOIN "user" u ON u.id = m.user_id
            WHERE m.organization_id = ? AND m.project_id = ? AND m.user_id = ?
            LIMIT 1
          `,
          [workspace.workspaceId, workspace.organizationId, workspace.projectId, userId],
        ) as WorkspaceMemberRow | undefined
      : await database.get(
          `
            SELECT
              m.workspace_id,
              m.user_id,
              u.name,
              u.email,
              m.role,
              COALESCE(m.status, 'active') AS status,
              m.can_read,
              m.can_write,
              m.can_manage,
              m.created_at,
              m.updated_at
            FROM canvas_workspace_members m
            LEFT JOIN "user" u ON u.id = m.user_id
            WHERE m.workspace_id = ? AND m.user_id = ?
            LIMIT 1
          `,
          [workspace.workspaceId, userId],
        ) as WorkspaceMemberRow | undefined;
    if (!row) {
      throw new WorkspaceOperationError('WORKSPACE_MEMBER_UPDATE_FAILED', 'Workspace member update failed.', 500);
    }
    await database.run('COMMIT');
    return rowToWorkspaceMemberRecord(row);
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function removePostgresWorkspaceMemberForActor(
  actor: WorkspaceActor,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await ensurePostgresOrganizationBootstrapForUser(database, actor.userId);
    const workspace = await resolveWorkspaceContextById(database, actor, workspaceId);
    if (!workspace) {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    if (!workspace.permissions.canManageWorkspace) {
      throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
    }
    if (workspace.workspaceType !== 'team' && workspace.workspaceType !== 'project') {
      throw new WorkspaceOperationError('WORKSPACE_MEMBERS_UNSUPPORTED', 'Workspace members are only supported for team and project workspaces.', 403);
    }
    if (workspace.workspaceType === 'project' && !workspace.projectId) {
      throw new WorkspaceOperationError('WORKSPACE_PROJECT_REQUIRED', 'Project workspace project id is required.', 409);
    }

    await assertPostgresWorkspaceRetainsManager(database, workspace, userId, false);

    if (workspace.workspaceType === 'project') {
      await database.run(
        'DELETE FROM canvas_project_members WHERE organization_id = ? AND project_id = ? AND user_id = ?',
        [workspace.organizationId, workspace.projectId, userId],
      );
    } else {
      await database.run(
        'DELETE FROM canvas_workspace_members WHERE workspace_id = ? AND user_id = ?',
        [workspace.workspaceId, userId],
      );
    }
    await database.run('COMMIT');
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original failure.
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

export async function getPostgresOrganizationPermissionForUser(
  userId: string,
): Promise<OrganizationPermissionState> {
  const database = await openDb();
  try {
    const organization = await getPrimaryOrganization(database);
    const deploymentMode = organization?.deployment_mode || getDeploymentMode();
    const teamFeaturesEnabled = organization
      ? booleanFromDb(organization.team_features_enabled)
      : areTeamFeaturesEnabled(deploymentMode);
    const permission = organization
      ? rowToPermissionSnapshot(await getPermissionRow(database, organization.organization_id, userId))
      : null;
    return {
      configured: Boolean(organization),
      organizationId: organization?.organization_id || null,
      ownerUserId: organization?.owner_user_id || null,
      teamFeaturesEnabled,
      databaseProvider: getDatabaseProvider(),
      permission,
    };
  } finally {
    await database.close();
  }
}

export async function findPostgresPermissionUserCandidate(
  userId: string,
): Promise<{ id: string; email: string | null; role: string | null } | null> {
  const database = await openDb();
  try {
    return await findPostgresUserById(database, userId);
  } finally {
    await database.close();
  }
}
