import 'server-only';

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceDataRoot } from './context';
import {
  DEFAULT_WORKSPACE_COLOR,
  parseWorkspaceColor,
  type WorkspaceColor,
} from './colors';
import { WORKSPACE_DESCRIPTION_MAX_LENGTH } from './description';
import { getDefaultWorkspaceIcon, isWorkspaceIcon, type WorkspaceIcon } from './icons';
import { resolveWorkspacePermissions } from './permissions';
import { seedWorkspaceStarterDocument } from './starter-document';
import {
  WORKSPACE_LAST_MANAGER_CODE,
  WORKSPACE_LAST_MANAGER_MESSAGE,
  wouldRemoveLastWorkspaceManager,
} from './member-manager-policy';
import type { WorkspaceActor, WorkspaceContext, WorkspaceStatus, WorkspaceType, WorkspaceUserRole } from './types';

export interface WorkspaceRecord {
  id: string;
  organizationId: string;
  type: WorkspaceType;
  ownerUserId: string | null;
  customerId: string | null;
  projectId: string | null;
  rootRelativePath: string;
  displayName: string;
  description: string;
  icon: WorkspaceIcon;
  color: WorkspaceColor;
  status: WorkspaceStatus;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DefaultWorkspaceRecords {
  personal: WorkspaceRecord;
}

export interface WorkspaceMemberRecord {
  workspaceId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: WorkspaceUserRole;
  status: WorkspaceStatus;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceMemberCandidate {
  userId: string;
  name: string | null;
  email: string | null;
  role: WorkspaceUserRole;
  status: WorkspaceStatus;
}

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
  workspace_color: string | null;
  status: string;
  is_default: number;
  created_at: number;
  updated_at: number;
};

type PermissionRow = {
  role: string;
  status: string;
  can_write_team_workspace: number;
  can_create_public_links: number;
  can_delete_team_files: number;
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

export type CreateWorkspaceRecordType = 'personal' | 'team' | 'project';

export class WorkspaceOperationError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WorkspaceOperationError';
    this.code = code;
    this.status = status;
  }
}

function normalizeWorkspaceType(value: string): WorkspaceType {
  if (value === 'organization' || value === 'team' || value === 'project') return value;
  return 'personal';
}

function normalizeWorkspaceRole(value: string): WorkspaceUserRole {
  if (value === 'owner' || value === 'admin' || value === 'external') return value;
  return 'member';
}

function normalizeWorkspaceStatus(value: string): WorkspaceStatus {
  if (value === 'archived' || value === 'disabled' || value === 'recovery_locked') return value;
  return 'active';
}

function isBannedWorkspaceUser(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function rowToWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
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
    color: parseWorkspaceColor(row.workspace_color) || DEFAULT_WORKSPACE_COLOR,
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
    role: normalizeWorkspaceRole(row.role),
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
    role: normalizeWorkspaceRole(row.role),
    status: normalizeWorkspaceStatus(row.status),
  };
}

export function personalWorkspaceRootRelativePath(userId: string): string {
  return path.posix.join('workspaces', 'personal', userId, 'files');
}

export function personalWorkspaceRootRelativePathForSlug(userId: string, slug: string): string {
  return path.posix.join('workspaces', 'personal', userId, slug, 'files');
}

export function organizationWorkspaceRootRelativePath(organizationId: string): string {
  return path.posix.join('workspaces', 'organization', organizationId, 'files');
}

export function organizationWorkspaceRootRelativePathForSlug(organizationId: string, slug: string): string {
  return path.posix.join('workspaces', 'organization', organizationId, slug, 'files');
}

export function teamWorkspaceRootRelativePath(organizationId: string): string {
  return path.posix.join('workspaces', 'team', organizationId, 'default', 'files');
}

export function teamWorkspaceRootRelativePathForSlug(organizationId: string, slug: string): string {
  return path.posix.join('workspaces', 'team', organizationId, slug, 'files');
}

export function legacyTeamWorkspaceRootRelativePath(organizationId: string): string {
  return path.posix.join('workspaces', 'team', organizationId, 'files');
}

export function projectWorkspaceRootRelativePath(projectId: string): string {
  return path.posix.join('workspaces', 'project', projectId, 'files');
}

export function workspaceAbsoluteRoot(rootRelativePath: string): string {
  if (path.isAbsolute(rootRelativePath) || rootRelativePath.includes('\0')) {
    throw new Error('Invalid workspace root path');
  }

  const segments = rootRelativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Invalid workspace root path');
  }

  return path.join(resolveWorkspaceDataRoot(), ...segments);
}

function ensureWorkspaceDirectory(record: WorkspaceRecord): void {
  mkdirSync(workspaceAbsoluteRoot(record.rootRelativePath), { recursive: true });
}

function createWorkspaceId(): string {
  return `ws_${randomUUID()}`;
}

export function normalizeWorkspaceSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
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

export function normalizeWorkspaceColor(
  value: unknown,
  fallback: WorkspaceColor = DEFAULT_WORKSPACE_COLOR,
): WorkspaceColor {
  if (value === undefined || value === null) return fallback;
  const color = parseWorkspaceColor(value);
  if (color) return color;
  throw new WorkspaceOperationError('WORKSPACE_COLOR_INVALID', 'Workspace color is invalid.', 400);
}

export function normalizeWorkspaceDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new WorkspaceOperationError(
      'WORKSPACE_DESCRIPTION_INVALID',
      'Workspace description must be text.',
      400,
    );
  }
  const description = value.trim();
  if (description.length > WORKSPACE_DESCRIPTION_MAX_LENGTH) {
    throw new WorkspaceOperationError(
      'WORKSPACE_DESCRIPTION_TOO_LONG',
      `Workspace description must be ${WORKSPACE_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      400,
    );
  }
  return description;
}

function reserveWorkspaceRootRelativePath(
  sqlite: Database.Database,
  baseSlug: string,
  buildPath: (slug: string) => string,
): string {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const slug = suffix === 0 ? baseSlug : `${baseSlug}-${suffix + 1}`;
    const rootRelativePath = buildPath(slug);
    const existing = sqlite.prepare(`
      SELECT id
      FROM canvas_workspaces
      WHERE root_relative_path = ?
      LIMIT 1
    `).get(rootRelativePath) as { id: string } | undefined;
    if (!existing) return rootRelativePath;
  }

  throw new WorkspaceOperationError(
    'WORKSPACE_SLUG_UNAVAILABLE',
    'Could not allocate a unique workspace path.',
    409,
  );
}

function getWorkspaceById(sqlite: Database.Database, workspaceId: string): WorkspaceRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, workspace_color, status, is_default, created_at, updated_at
    FROM canvas_workspaces
    WHERE id = ?
    LIMIT 1
  `).get(workspaceId) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

function getPersonalWorkspace(sqlite: Database.Database, userId: string): WorkspaceRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, workspace_color, status, is_default, created_at, updated_at
    FROM canvas_workspaces
    WHERE type = 'personal' AND owner_user_id = ?
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `).get(userId) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

function getActiveOrganizationWorkspace(sqlite: Database.Database, organizationId: string): WorkspaceRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, workspace_color, status, is_default, created_at, updated_at
    FROM canvas_workspaces
    WHERE type = 'organization' AND organization_id = ? AND status = 'active'
    ORDER BY created_at ASC
    LIMIT 1
  `).get(organizationId) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

function getProjectWorkspace(sqlite: Database.Database, organizationId: string, projectId: string): WorkspaceRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, workspace_color, status, is_default, created_at, updated_at
    FROM canvas_workspaces
    WHERE type = 'project' AND organization_id = ? AND project_id = ?
    LIMIT 1
  `).get(organizationId, projectId) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

function insertWorkspace(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    type: WorkspaceType;
    ownerUserId: string | null;
    customerId?: string | null;
    projectId?: string | null;
    rootRelativePath: string;
    displayName: string;
    description?: string;
    icon: WorkspaceIcon;
    color?: WorkspaceColor;
    isDefault?: boolean;
  },
): WorkspaceRecord {
  if (input.type === 'project' && !input.projectId) {
    throw new Error('Project workspace requires a project id.');
  }

  const now = Date.now();
  const id = createWorkspaceId();
  sqlite.prepare(`
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, workspace_color, status, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    id,
    input.organizationId,
    input.type,
    input.ownerUserId,
    input.customerId ?? null,
    input.projectId ?? null,
    input.rootRelativePath,
    input.displayName,
    input.description ?? '',
    input.icon,
    input.color ?? DEFAULT_WORKSPACE_COLOR,
    input.isDefault ? 1 : 0,
    now,
    now,
  );

  const record = getWorkspaceById(sqlite, id);
  if (!record) throw new Error('Workspace insert failed');
  ensureWorkspaceDirectory(record);
  seedWorkspaceStarterDocument({
    rootPath: workspaceAbsoluteRoot(record.rootRelativePath),
    workspaceType: record.type,
  });
  return record;
}

function updateWorkspaceRoot(
  sqlite: Database.Database,
  record: WorkspaceRecord,
  input: {
    rootRelativePath: string;
    displayName?: string;
    isDefault?: boolean;
  },
): WorkspaceRecord {
  const nextIsDefault = input.isDefault ?? record.isDefault;
  const nextDisplayName = input.displayName ?? record.displayName;
  if (
    record.rootRelativePath === input.rootRelativePath &&
    record.displayName === nextDisplayName &&
    record.isDefault === nextIsDefault
  ) {
    ensureWorkspaceDirectory(record);
    return record;
  }

  sqlite.prepare(`
    UPDATE canvas_workspaces
    SET root_relative_path = ?, display_name = ?, is_default = ?, updated_at = ?
    WHERE id = ?
  `).run(input.rootRelativePath, nextDisplayName, nextIsDefault ? 1 : 0, Date.now(), record.id);

  const updated = getWorkspaceById(sqlite, record.id);
  if (!updated) throw new Error('Workspace update failed');
  ensureWorkspaceDirectory(updated);
  return updated;
}

export function ensureDefaultWorkspaceRecords(
  sqlite: Database.Database,
  params: {
    organizationId: string;
    userId: string;
  },
): DefaultWorkspaceRecords {
  const personalRoot = personalWorkspaceRootRelativePath(params.userId);
  const existingPersonal = getPersonalWorkspace(sqlite, params.userId);
  const personal = existingPersonal
    ? updateWorkspaceRoot(sqlite, existingPersonal, {
        rootRelativePath: personalRoot,
        isDefault: true,
      })
    : insertWorkspace(sqlite, {
        organizationId: params.organizationId,
        type: 'personal',
        ownerUserId: params.userId,
        rootRelativePath: personalRoot,
        displayName: 'Personal Workspace',
        icon: getDefaultWorkspaceIcon('personal'),
        isDefault: true,
      });

  return { personal };
}

export function ensureProjectWorkspaceRecord(
  sqlite: Database.Database,
  params: {
    organizationId: string;
    projectId: string;
    customerId?: string | null;
    displayName: string;
  },
): WorkspaceRecord {
  const projectRoot = projectWorkspaceRootRelativePath(params.projectId);
  const existingProjectWorkspace = getProjectWorkspace(sqlite, params.organizationId, params.projectId);
  if (existingProjectWorkspace) {
    if (existingProjectWorkspace.customerId !== (params.customerId ?? null)) {
      sqlite.prepare(`
        UPDATE canvas_workspaces
        SET customer_id = ?, updated_at = ?
        WHERE id = ?
      `).run(params.customerId ?? null, Date.now(), existingProjectWorkspace.id);
      const updated = getWorkspaceById(sqlite, existingProjectWorkspace.id);
      if (!updated) throw new Error('Project workspace update failed');
      return updateWorkspaceRoot(sqlite, updated, {
        rootRelativePath: projectRoot,
        displayName: params.displayName,
      });
    }

    return updateWorkspaceRoot(sqlite, existingProjectWorkspace, {
      rootRelativePath: projectRoot,
      displayName: params.displayName,
    });
  }

  return insertWorkspace(sqlite, {
    organizationId: params.organizationId,
    type: 'project',
    ownerUserId: null,
    customerId: params.customerId ?? null,
    projectId: params.projectId,
    rootRelativePath: projectRoot,
    displayName: params.displayName,
    icon: getDefaultWorkspaceIcon('project'),
  });
}

function getPermissionRow(sqlite: Database.Database, organizationId: string, userId: string): PermissionRow | null {
  return sqlite.prepare(`
    SELECT role, COALESCE(status, 'active') AS status, can_write_team_workspace, can_create_public_links, can_delete_team_files
    FROM organization_user_permissions
    WHERE organization_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, userId) as PermissionRow | undefined || null;
}

function getProjectPermissionRow(
  sqlite: Database.Database,
  organizationId: string,
  projectId: string | null,
  userId: string,
): ProjectPermissionRow | null {
  if (!projectId) return null;
  return sqlite.prepare(`
    SELECT role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
    FROM canvas_project_members
    WHERE organization_id = ? AND project_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, projectId, userId) as ProjectPermissionRow | undefined || null;
}

function getProjectPermissionRows(
  sqlite: Database.Database,
  organizationId: string,
  userId: string,
  projectIds: string[],
): Map<string, ProjectPermissionRow> {
  const uniqueProjectIds = Array.from(new Set(projectIds.filter(Boolean)));
  if (uniqueProjectIds.length === 0) return new Map();

  const placeholders = uniqueProjectIds.map(() => '?').join(', ');
  const rows = sqlite.prepare(`
    SELECT project_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
    FROM canvas_project_members
    WHERE organization_id = ? AND user_id = ? AND project_id IN (${placeholders})
  `).all(organizationId, userId, ...uniqueProjectIds) as ProjectPermissionRow[];

  return new Map(rows.flatMap((row) => (row.project_id ? [[row.project_id, row]] : [])));
}

function getTeamWorkspacePermissionRow(
  sqlite: Database.Database,
  workspaceId: string,
  userId: string,
): TeamWorkspacePermissionRow | null {
  return sqlite.prepare(`
    SELECT workspace_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
    FROM canvas_workspace_members
    WHERE workspace_id = ? AND user_id = ?
    LIMIT 1
  `).get(workspaceId, userId) as TeamWorkspacePermissionRow | undefined || null;
}

function getTeamWorkspacePermissionRows(
  sqlite: Database.Database,
  userId: string,
  workspaceIds: string[],
): Map<string, TeamWorkspacePermissionRow> {
  const uniqueWorkspaceIds = Array.from(new Set(workspaceIds.filter(Boolean)));
  if (uniqueWorkspaceIds.length === 0) return new Map();

  const placeholders = uniqueWorkspaceIds.map(() => '?').join(', ');
  const rows = sqlite.prepare(`
    SELECT workspace_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage
    FROM canvas_workspace_members
    WHERE user_id = ? AND workspace_id IN (${placeholders})
  `).all(userId, ...uniqueWorkspaceIds) as TeamWorkspacePermissionRow[];

  return new Map(rows.flatMap((row) => (row.workspace_id ? [[row.workspace_id, row]] : [])));
}

function upsertTeamWorkspaceOwnerMembership(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    workspaceId: string;
    userId: string;
  },
): void {
  const now = Date.now();
  sqlite.prepare(`
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
  `).run(
    input.organizationId,
    input.workspaceId,
    input.userId,
    input.userId,
    now,
    now,
  );
}

function canReadWorkspace(
  record: WorkspaceRecord,
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
  record: WorkspaceRecord,
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

function countActiveWorkspaceAutomations(sqlite: Database.Database, workspaceId: string): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM automation_jobs
    WHERE workspace_id = ? AND status = 'active'
  `).get(workspaceId) as { count?: number } | undefined;

  return Number(row?.count || 0);
}

export function workspaceContextFromRecord(
  record: WorkspaceRecord,
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
    color: record.color,
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

export function listWorkspaceContextsForUser(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    organizationId: string;
  },
): WorkspaceContext[] {
  const rows = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, customer_id, project_id, root_relative_path, display_name, description, workspace_icon, workspace_color, status, is_default, created_at, updated_at
    FROM canvas_workspaces
    WHERE organization_id = ? AND status = 'active'
      AND (type != 'personal' OR owner_user_id = ?)
    ORDER BY is_default DESC, CASE type WHEN 'personal' THEN 0 WHEN 'organization' THEN 1 WHEN 'team' THEN 2 ELSE 3 END, created_at ASC
  `).all(params.organizationId, params.actor.userId) as WorkspaceRow[];
  const permission = getPermissionRow(sqlite, params.organizationId, params.actor.userId);
  const teamPermissionRows = getTeamWorkspacePermissionRows(
    sqlite,
    params.actor.userId,
    rows.flatMap((row) => (row.type === 'team' ? [row.id] : [])),
  );
  const projectPermissionRows = getProjectPermissionRows(
    sqlite,
    params.organizationId,
    params.actor.userId,
    rows.flatMap((row) => (row.type === 'project' && row.project_id ? [row.project_id] : [])),
  );

  return rows
    .map(rowToWorkspaceRecord)
    .map((record) => ({
      record,
      teamPermission: record.type === 'team' ? teamPermissionRows.get(record.id) ?? null : null,
      projectPermission: record.projectId ? projectPermissionRows.get(record.projectId) ?? null : null,
    }))
    .filter(({ record, teamPermission, projectPermission }) => canReadWorkspace(record, params.actor, permission, teamPermission, projectPermission))
    .map(({ record, teamPermission, projectPermission }) => workspaceContextFromRecord(record, params.actor, permission, teamPermission, projectPermission));
}

export function resolveDefaultWorkspaceContext(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    organizationId: string;
  },
): WorkspaceContext | null {
  const personal = getPersonalWorkspace(sqlite, params.actor.userId);
  if (!personal) return null;
  const permission = getPermissionRow(sqlite, params.organizationId, params.actor.userId);
  if (!canReadWorkspace(personal, params.actor, permission)) return null;
  return workspaceContextFromRecord(personal, params.actor, permission);
}

export function resolveWorkspaceContextById(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    workspaceId: string;
  },
): WorkspaceContext | null {
  const record = getWorkspaceById(sqlite, params.workspaceId);
  if (!record) return null;
  const permission = getPermissionRow(sqlite, record.organizationId, params.actor.userId);
  const teamPermission = record.type === 'team'
    ? getTeamWorkspacePermissionRow(sqlite, record.id, params.actor.userId)
    : null;
  const projectPermission = getProjectPermissionRow(sqlite, record.organizationId, record.projectId, params.actor.userId);
  if (!canReadWorkspace(record, params.actor, permission, teamPermission, projectPermission)) return null;
  return workspaceContextFromRecord(record, params.actor, permission, teamPermission, projectPermission);
}

export function createWorkspaceRecord(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    organizationId: string;
    type: WorkspaceType;
    name: unknown;
    description?: unknown;
    icon?: unknown;
    color?: unknown;
    teamFeaturesEnabled: boolean;
    projectFeaturesEnabled?: boolean;
    projectId?: string | null;
  },
): WorkspaceContext {
  const name = normalizeWorkspaceName(params.name);
  const description = normalizeWorkspaceDescription(params.description);
  const icon = normalizeWorkspaceIcon(params.icon, params.type);
  const color = normalizeWorkspaceColor(params.color);
  const permission = getPermissionRow(sqlite, params.organizationId, params.actor.userId);
  if (!permission || permission.status !== 'active' || permission.role === 'external') {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
  }

  if (
    params.type !== 'personal'
    && params.type !== 'organization'
    && params.type !== 'team'
    && params.type !== 'project'
  ) {
    throw new WorkspaceOperationError('WORKSPACE_TYPE_INVALID', 'Workspace type is invalid.', 400);
  }
  if ((params.type === 'organization' || params.type === 'team') && !params.teamFeaturesEnabled) {
    throw new WorkspaceOperationError(
      'WORKSPACE_TEAM_FEATURES_DISABLED',
      'Shared organization and team workspaces are not enabled.',
      403,
    );
  }
  if (
    (params.type === 'organization' || params.type === 'team')
    && params.actor.role !== 'owner'
    && params.actor.role !== 'admin'
  ) {
    throw new WorkspaceOperationError(
      'WORKSPACE_PERMISSION_DENIED',
      'Only admins can create organization and team workspaces.',
      403,
    );
  }
  if (params.type === 'project' && params.actor.role !== 'owner' && params.actor.role !== 'admin') {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Only admins can create project workspaces.', 403);
  }
  if (params.type === 'project') {
    if (!params.projectFeaturesEnabled) {
      throw new WorkspaceOperationError(
        'WORKSPACE_PROJECT_FEATURE_DISABLED',
        'Project workspaces are not yet available.',
        501,
      );
    }
    const projectId = params.projectId?.trim() || '';
    if (!projectId) {
      throw new WorkspaceOperationError('WORKSPACE_PROJECT_REQUIRED', 'Project id is required.', 400);
    }
    const existingProjectWorkspace = getProjectWorkspace(sqlite, params.organizationId, projectId);
    if (existingProjectWorkspace) {
      throw new WorkspaceOperationError('WORKSPACE_PROJECT_ALREADY_HAS_WORKSPACE', 'Project already has a workspace.', 409);
    }
  }
  if (params.type === 'organization' && getActiveOrganizationWorkspace(sqlite, params.organizationId)) {
    throw new WorkspaceOperationError(
      'WORKSPACE_ORGANIZATION_ALREADY_EXISTS',
      'An active organization workspace already exists.',
      409,
    );
  }

  const slug = normalizeWorkspaceSlug(name);
  const rootRelativePath = params.type === 'personal'
    ? reserveWorkspaceRootRelativePath(
        sqlite,
        slug,
        (candidate) => personalWorkspaceRootRelativePathForSlug(params.actor.userId, candidate),
      )
    : params.type === 'organization'
      ? reserveWorkspaceRootRelativePath(
          sqlite,
          slug,
          (candidate) => organizationWorkspaceRootRelativePathForSlug(params.organizationId, candidate),
        )
      : params.type === 'team'
      ? reserveWorkspaceRootRelativePath(
          sqlite,
          slug,
          (candidate) => teamWorkspaceRootRelativePathForSlug(params.organizationId, candidate),
        )
      : projectWorkspaceRootRelativePath(params.projectId?.trim() || '');
  const project = params.type === 'project'
    ? getActiveProjectForWorkspaceTypeChange(sqlite, params.organizationId, params.projectId?.trim() || '')
    : null;

  const record = insertWorkspace(sqlite, {
    organizationId: params.organizationId,
    type: params.type,
    ownerUserId: params.type === 'personal' ? params.actor.userId : null,
    customerId: project?.customer_id ?? null,
    projectId: params.type === 'project' ? project?.id ?? null : null,
    rootRelativePath,
    displayName: name,
    description,
    icon,
    color,
    isDefault: false,
  });

  if (record.type === 'team') {
    upsertTeamWorkspaceOwnerMembership(sqlite, {
      organizationId: params.organizationId,
      workspaceId: record.id,
      userId: params.actor.userId,
    });
  }
  if (record.type === 'project' && record.projectId) {
    upsertProjectWorkspaceMember(sqlite, {
      actor: params.actor,
      organizationId: params.organizationId,
      workspaceId: record.id,
      projectId: record.projectId,
      userId: params.actor.userId,
      role: 'admin',
      canRead: true,
      canWrite: true,
      canManage: true,
    });
  }

  const teamPermission = record.type === 'team'
    ? getTeamWorkspacePermissionRow(sqlite, record.id, params.actor.userId)
    : null;
  const projectPermission = getProjectPermissionRow(sqlite, record.organizationId, record.projectId, params.actor.userId);
  return workspaceContextFromRecord(record, params.actor, permission, teamPermission, projectPermission);
}

export function updateWorkspaceRecord(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    workspaceId: string;
    name?: unknown;
    description?: unknown;
    icon?: unknown;
    color?: unknown;
  },
): WorkspaceContext {
  const record = getWorkspaceById(sqlite, params.workspaceId);
  if (!record || record.status === 'disabled' || record.status === 'archived') {
    throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  }
  if (record.status !== 'active') {
    throw new WorkspaceOperationError('WORKSPACE_NOT_ACTIVE', 'Workspace is not active.', 409);
  }

  const context = resolveWorkspaceContextById(sqlite, {
    actor: params.actor,
    workspaceId: params.workspaceId,
  });
  if (!context || !context.permissions.canManageWorkspace) {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
  }

  const nextName = params.name === undefined ? record.displayName : normalizeWorkspaceName(params.name);
  const nextDescription = params.description === undefined
    ? record.description
    : normalizeWorkspaceDescription(params.description);
  const nextIcon = params.icon === undefined ? record.icon : normalizeWorkspaceIcon(params.icon, record.type);
  const nextColor = params.color === undefined ? record.color : normalizeWorkspaceColor(params.color, record.color);
  if (
    nextName === record.displayName
    && nextDescription === record.description
    && nextIcon === record.icon
    && nextColor === record.color
  ) return context;

  sqlite.prepare(`
    UPDATE canvas_workspaces
    SET display_name = ?, description = ?, workspace_icon = ?, workspace_color = ?, updated_at = ?
    WHERE id = ?
  `).run(nextName, nextDescription, nextIcon, nextColor, Date.now(), record.id);

  const updated = getWorkspaceById(sqlite, record.id);
  if (!updated) throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  const permission = getPermissionRow(sqlite, updated.organizationId, params.actor.userId);
  const teamPermission = updated.type === 'team'
    ? getTeamWorkspacePermissionRow(sqlite, updated.id, params.actor.userId)
    : null;
  const projectPermission = getProjectPermissionRow(sqlite, updated.organizationId, updated.projectId, params.actor.userId);
  return workspaceContextFromRecord(updated, params.actor, permission, teamPermission, projectPermission);
}

export function deleteWorkspaceRecord(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    workspaceId: string;
  },
): WorkspaceContext {
  const record = getWorkspaceById(sqlite, params.workspaceId);
  if (!record || record.status === 'disabled' || record.status === 'archived') {
    throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  }
  if (record.status !== 'active') {
    throw new WorkspaceOperationError('WORKSPACE_NOT_ACTIVE', 'Workspace is not active.', 409);
  }
  if (record.isDefault) {
    throw new WorkspaceOperationError('WORKSPACE_IS_DEFAULT', 'Default workspaces cannot be deleted.', 409);
  }
  const context = resolveWorkspaceContextById(sqlite, {
    actor: params.actor,
    workspaceId: params.workspaceId,
  });
  if (!context || !canDeleteWorkspaceRecord(record, params.actor, context)) {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
  }

  if (countActiveWorkspaceAutomations(sqlite, record.id) > 0) {
    throw new WorkspaceOperationError(
      'WORKSPACE_HAS_AUTOMATIONS',
      'Workspace has active automations and cannot be deleted.',
      409,
    );
  }

  sqlite.prepare(`
    UPDATE canvas_workspaces
    SET status = 'disabled', updated_at = ?
    WHERE id = ?
  `).run(Date.now(), record.id);

  const updated = getWorkspaceById(sqlite, record.id);
  if (!updated) throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  return workspaceContextFromRecord(updated, params.actor, getPermissionRow(sqlite, updated.organizationId, params.actor.userId));
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

function getActiveProjectForWorkspaceTypeChange(
  sqlite: Database.Database,
  organizationId: string,
  projectId: string,
): { id: string; customer_id: string | null } {
  const project = sqlite.prepare(`
    SELECT id, customer_id
    FROM canvas_projects
    WHERE organization_id = ? AND id = ? AND status = 'active'
    LIMIT 1
  `).get(organizationId, projectId) as { id: string; customer_id: string | null } | undefined;
  if (!project) {
    throw new WorkspaceOperationError('WORKSPACE_PROJECT_NOT_FOUND', 'Project not found.', 404);
  }
  return project;
}

function assertWorkspaceRootTargetAvailable(oldRelativePath: string, newRelativePath: string): void {
  if (oldRelativePath === newRelativePath) return;
  const newRoot = workspaceAbsoluteRoot(newRelativePath);
  if (existsSync(newRoot)) {
    throw new WorkspaceOperationError(
      'WORKSPACE_ROOT_EXISTS',
      'Target workspace root already exists.',
      409,
    );
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

function collectWorkspaceMembersForTypeChange(sqlite: Database.Database, workspaceId: string): Array<{
  user_id: string;
  role: string;
  status: string;
  can_read: number;
  can_write: number;
  can_manage: number;
  invited_by_user_id: string | null;
}> {
  return sqlite.prepare(`
    SELECT user_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage, invited_by_user_id
    FROM canvas_workspace_members
    WHERE workspace_id = ?
  `).all(workspaceId) as Array<{
    user_id: string;
    role: string;
    status: string;
    can_read: number;
    can_write: number;
    can_manage: number;
    invited_by_user_id: string | null;
  }>;
}

function collectProjectMembersForTypeChange(sqlite: Database.Database, organizationId: string, projectId: string): Array<{
  user_id: string;
  role: string;
  status: string;
  can_read: number;
  can_write: number;
  can_manage: number;
  invited_by_user_id: string | null;
}> {
  return sqlite.prepare(`
    SELECT user_id, role, COALESCE(status, 'active') AS status, can_read, can_write, can_manage, invited_by_user_id
    FROM canvas_project_members
    WHERE organization_id = ? AND project_id = ?
  `).all(organizationId, projectId) as Array<{
    user_id: string;
    role: string;
    status: string;
    can_read: number;
    can_write: number;
    can_manage: number;
    invited_by_user_id: string | null;
  }>;
}

function upsertWorkspaceMembersForTypeChange(
  sqlite: Database.Database,
  organizationId: string,
  workspaceId: string,
  members: Array<{
    user_id: string;
    role: string;
    status: string;
    can_read: number;
    can_write: number;
    can_manage: number;
    invited_by_user_id: string | null;
  }>,
): void {
  const now = Date.now();
  const statement = sqlite.prepare(`
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
  `);
  for (const member of members) {
    statement.run(
      organizationId,
      workspaceId,
      member.user_id,
      normalizeWorkspaceRole(member.role),
      normalizeWorkspaceStatus(member.status),
      member.can_read,
      member.can_write,
      member.can_manage,
      member.invited_by_user_id,
      now,
      now,
    );
  }
}

function upsertProjectMembersForTypeChange(
  sqlite: Database.Database,
  organizationId: string,
  projectId: string,
  members: Array<{
    user_id: string;
    role: string;
    status: string;
    can_read: number;
    can_write: number;
    can_manage: number;
    invited_by_user_id: string | null;
  }>,
): void {
  const now = Date.now();
  const statement = sqlite.prepare(`
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
  `);
  for (const member of members) {
    statement.run(
      organizationId,
      projectId,
      member.user_id,
      normalizeWorkspaceRole(member.role),
      normalizeWorkspaceStatus(member.status),
      member.can_read,
      member.can_write,
      member.can_manage,
      member.invited_by_user_id,
      now,
      now,
    );
  }
}

function managerMemberForActor(actor: WorkspaceActor) {
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

function ensureAtLeastOneManagerForTypeChange<T extends { user_id: string; can_manage: number }>(
  members: T[],
  actor: WorkspaceActor,
): Array<T | ReturnType<typeof managerMemberForActor>> {
  if (members.some((member) => member.can_manage === 1)) return members;
  return [...members, managerMemberForActor(actor)];
}

export function changeWorkspaceType(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    workspaceId: string;
    type: unknown;
    projectId?: unknown;
    teamFeaturesEnabled: boolean;
  },
): WorkspaceContext {
  const record = getWorkspaceById(sqlite, params.workspaceId);
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
  if (params.actor.role !== 'owner' && params.actor.role !== 'admin') {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Only admins can change workspace type.', 403);
  }

  const context = resolveWorkspaceContextById(sqlite, {
    actor: params.actor,
    workspaceId: params.workspaceId,
  });
  if (!context || !context.permissions.canManageWorkspace) {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Workspace permission denied.', 403);
  }

  const targetType = normalizeWorkspaceTypeChangeTarget(params.type);
  if (targetType === 'team' && !params.teamFeaturesEnabled) {
    throw new WorkspaceOperationError('WORKSPACE_TEAM_FEATURES_DISABLED', 'Team workspaces are not enabled.', 403);
  }
  const targetProjectId = typeof params.projectId === 'string' ? params.projectId.trim() : '';
  const targetProject = targetType === 'project'
    ? getActiveProjectForWorkspaceTypeChange(sqlite, record.organizationId, targetProjectId)
    : null;

  if (record.type === targetType && (targetType !== 'project' || record.projectId === targetProjectId)) {
    return context;
  }

  const slug = normalizeWorkspaceSlug(record.displayName);
  const nextRootRelativePath = targetType === 'personal'
    ? reserveWorkspaceRootRelativePath(
        sqlite,
        slug,
        (candidate) => personalWorkspaceRootRelativePathForSlug(params.actor.userId, candidate),
      )
    : targetType === 'team'
      ? reserveWorkspaceRootRelativePath(
          sqlite,
          slug,
          (candidate) => teamWorkspaceRootRelativePathForSlug(record.organizationId, candidate),
        )
      : projectWorkspaceRootRelativePath(targetProjectId);

  if (targetType === 'project') {
    const existingProjectWorkspace = getProjectWorkspace(sqlite, record.organizationId, targetProjectId);
    if (existingProjectWorkspace && existingProjectWorkspace.id !== record.id) {
      throw new WorkspaceOperationError(
        'WORKSPACE_PROJECT_ALREADY_HAS_WORKSPACE',
        'Project already has a workspace.',
        409,
      );
    }
    const existingRoot = sqlite.prepare(`
      SELECT id
      FROM canvas_workspaces
      WHERE root_relative_path = ? AND id != ?
      LIMIT 1
    `).get(nextRootRelativePath, record.id) as { id: string } | undefined;
    if (existingRoot) {
      throw new WorkspaceOperationError(
        'WORKSPACE_ROOT_EXISTS',
        'Target workspace root already exists.',
        409,
      );
    }
  }

  const sourceTeamMembers = record.type === 'team'
    ? collectWorkspaceMembersForTypeChange(sqlite, record.id)
    : [];
  const sourceProjectMembers = record.type === 'project' && record.projectId
    ? collectProjectMembersForTypeChange(sqlite, record.organizationId, record.projectId)
    : [];
  const rootMove = moveWorkspaceRootForTypeChange(record.rootRelativePath, nextRootRelativePath);
  try {
    const now = Date.now();
    sqlite.prepare(`
      UPDATE canvas_workspaces
      SET type = ?,
        owner_user_id = ?,
        customer_id = ?,
        project_id = ?,
        root_relative_path = ?,
        is_default = 0,
        updated_at = ?
      WHERE id = ?
    `).run(
      targetType,
      targetType === 'personal' ? params.actor.userId : null,
      targetProject?.customer_id ?? null,
      targetType === 'project' ? targetProjectId : null,
      nextRootRelativePath,
      now,
      record.id,
    );

    if (record.type === 'team' && targetType !== 'team') {
      sqlite.prepare('DELETE FROM canvas_workspace_members WHERE workspace_id = ?').run(record.id);
    }
    if (record.type === 'project' && record.projectId && (targetType !== 'project' || record.projectId !== targetProjectId)) {
      sqlite.prepare('DELETE FROM canvas_project_members WHERE organization_id = ? AND project_id = ?').run(record.organizationId, record.projectId);
    }

    if (targetType === 'team') {
      const members = ensureAtLeastOneManagerForTypeChange(
        record.type === 'project' ? sourceProjectMembers : sourceTeamMembers,
        params.actor,
      );
      upsertWorkspaceMembersForTypeChange(sqlite, record.organizationId, record.id, members);
    } else if (targetType === 'project') {
      const members = ensureAtLeastOneManagerForTypeChange(
        record.type === 'team' ? sourceTeamMembers : sourceProjectMembers,
        params.actor,
      );
      upsertProjectMembersForTypeChange(sqlite, record.organizationId, targetProjectId, members);
    }

    const updated = getWorkspaceById(sqlite, record.id);
    if (!updated) {
      throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    }
    const permission = getPermissionRow(sqlite, updated.organizationId, params.actor.userId);
    const teamPermission = updated.type === 'team'
      ? getTeamWorkspacePermissionRow(sqlite, updated.id, params.actor.userId)
      : null;
    const projectPermission = getProjectPermissionRow(sqlite, updated.organizationId, updated.projectId, params.actor.userId);
    return workspaceContextFromRecord(updated, params.actor, permission, teamPermission, projectPermission);
  } catch (error) {
    rollbackWorkspaceRootTypeChange(record.rootRelativePath, nextRootRelativePath, rootMove);
    throw error;
  }
}

export function listWorkspaceMemberCandidates(
  sqlite: Database.Database,
  organizationId: string,
): WorkspaceMemberCandidate[] {
  const rows = sqlite.prepare(`
    SELECT
      u.id AS user_id,
      u.name,
      u.email,
      COALESCE(p.role, 'member') AS role,
      COALESCE(p.status, 'active') AS status,
      u.banned
    FROM user u
    LEFT JOIN organization_user_permissions p
      ON p.user_id = u.id AND p.organization_id = ?
    WHERE COALESCE(p.status, 'active') = 'active'
      AND COALESCE(p.role, 'member') != 'external'
    ORDER BY lower(COALESCE(u.email, u.name, u.id)) ASC
  `).all(organizationId) as WorkspaceMemberCandidateRow[];

  return rows
    .filter((row) => !isBannedWorkspaceUser(row.banned))
    .map(rowToWorkspaceMemberCandidate);
}

function ensureWorkspaceMemberCandidate(
  sqlite: Database.Database,
  params: { organizationId: string; userId: string },
): void {
  const candidate = sqlite.prepare(`
    SELECT
      p.role AS organization_role,
      p.status AS organization_status,
      u.banned
    FROM user u
    LEFT JOIN organization_user_permissions p
      ON p.user_id = u.id AND p.organization_id = ?
    WHERE u.id = ?
    LIMIT 1
  `).get(params.organizationId, params.userId) as WorkspaceMemberCandidateEligibilityRow | undefined;

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
  sqlite.prepare(`
    INSERT INTO organization_user_permissions (
      organization_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', ?, ?)
    ON CONFLICT(organization_id, user_id) DO NOTHING
  `).run(params.organizationId, params.userId, now, now);
}

export function listTeamWorkspaceMembers(
  sqlite: Database.Database,
  workspaceId: string,
): WorkspaceMemberRecord[] {
  const rows = sqlite.prepare(`
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
    LEFT JOIN user u ON u.id = m.user_id
    WHERE m.workspace_id = ?
    ORDER BY m.can_manage DESC, lower(COALESCE(u.email, u.name, m.user_id)) ASC
  `).all(workspaceId) as WorkspaceMemberRow[];

  return rows.map(rowToWorkspaceMemberRecord);
}

export function listProjectWorkspaceMembers(
  sqlite: Database.Database,
  params: {
    workspaceId: string;
    organizationId: string;
    projectId: string;
  },
): WorkspaceMemberRecord[] {
  const rows = sqlite.prepare(`
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
    LEFT JOIN user u ON u.id = m.user_id
    WHERE m.organization_id = ? AND m.project_id = ?
    ORDER BY m.can_manage DESC, lower(COALESCE(u.email, u.name, m.user_id)) ASC
  `).all(params.workspaceId, params.organizationId, params.projectId) as WorkspaceMemberRow[];

  return rows.map(rowToWorkspaceMemberRecord);
}

function assertTeamWorkspaceRetainsManager(
  sqlite: Database.Database,
  params: { workspaceId: string; userId: string; nextCanManage: boolean },
) {
  const member = sqlite.prepare(`
    SELECT can_manage
    FROM canvas_workspace_members
    WHERE workspace_id = ? AND user_id = ? AND COALESCE(status, 'active') = 'active'
    LIMIT 1
  `).get(params.workspaceId, params.userId) as { can_manage: number } | undefined;
  if (member?.can_manage !== 1 || params.nextCanManage) return;

  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM canvas_workspace_members
    WHERE workspace_id = ?
      AND COALESCE(status, 'active') = 'active'
      AND can_manage = 1
  `).get(params.workspaceId) as { count?: number } | undefined;
  if (wouldRemoveLastWorkspaceManager({
    targetIsActiveManager: true,
    activeManagerCount: Number(row?.count || 0),
    nextCanManage: params.nextCanManage,
  })) {
    throw new WorkspaceOperationError(
      WORKSPACE_LAST_MANAGER_CODE,
      WORKSPACE_LAST_MANAGER_MESSAGE,
      409,
    );
  }
}

function assertProjectWorkspaceRetainsManager(
  sqlite: Database.Database,
  params: { organizationId: string; projectId: string; userId: string; nextCanManage: boolean },
) {
  const member = sqlite.prepare(`
    SELECT can_manage
    FROM canvas_project_members
    WHERE organization_id = ? AND project_id = ? AND user_id = ? AND COALESCE(status, 'active') = 'active'
    LIMIT 1
  `).get(params.organizationId, params.projectId, params.userId) as { can_manage: number } | undefined;
  if (member?.can_manage !== 1 || params.nextCanManage) return;

  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM canvas_project_members
    WHERE organization_id = ?
      AND project_id = ?
      AND COALESCE(status, 'active') = 'active'
      AND can_manage = 1
  `).get(params.organizationId, params.projectId) as { count?: number } | undefined;
  if (wouldRemoveLastWorkspaceManager({
    targetIsActiveManager: true,
    activeManagerCount: Number(row?.count || 0),
    nextCanManage: params.nextCanManage,
  })) {
    throw new WorkspaceOperationError(
      WORKSPACE_LAST_MANAGER_CODE,
      WORKSPACE_LAST_MANAGER_MESSAGE,
      409,
    );
  }
}

export function upsertTeamWorkspaceMember(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    organizationId: string;
    workspaceId: string;
    userId: unknown;
    role?: unknown;
    canRead?: unknown;
    canWrite?: unknown;
    canManage?: unknown;
  },
): WorkspaceMemberRecord {
  const record = getWorkspaceById(sqlite, params.workspaceId);
  if (!record || record.type !== 'team' || record.organizationId !== params.organizationId) {
    throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  }

  const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
  if (!userId) {
    throw new WorkspaceOperationError('WORKSPACE_MEMBER_USER_REQUIRED', 'User is required.', 400);
  }
  ensureWorkspaceMemberCandidate(sqlite, { organizationId: params.organizationId, userId });

  const role = typeof params.role === 'string' ? normalizeWorkspaceRole(params.role) : 'member';
  const canManage = Boolean(params.canManage);
  const canWrite = canManage || Boolean(params.canWrite);
  const canRead = canManage || canWrite || params.canRead !== false;
  assertTeamWorkspaceRetainsManager(sqlite, {
    workspaceId: params.workspaceId,
    userId,
    nextCanManage: canManage,
  });
  const now = Date.now();

  sqlite.prepare(`
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
  `).run(
    params.organizationId,
    params.workspaceId,
    userId,
    role,
    canRead ? 1 : 0,
    canWrite ? 1 : 0,
    canManage ? 1 : 0,
    params.actor.userId,
    now,
    now,
  );

  const member = listTeamWorkspaceMembers(sqlite, params.workspaceId).find((item) => item.userId === userId);
  if (!member) {
    throw new WorkspaceOperationError('WORKSPACE_MEMBER_UPDATE_FAILED', 'Workspace member update failed.', 500);
  }
  return member;
}

export function upsertProjectWorkspaceMember(
  sqlite: Database.Database,
  params: {
    actor: WorkspaceActor;
    organizationId: string;
    workspaceId: string;
    projectId: string;
    userId: unknown;
    role?: unknown;
    canRead?: unknown;
    canWrite?: unknown;
    canManage?: unknown;
  },
): WorkspaceMemberRecord {
  const record = getWorkspaceById(sqlite, params.workspaceId);
  if (!record || record.type !== 'project' || record.organizationId !== params.organizationId || record.projectId !== params.projectId) {
    throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  }

  const project = sqlite.prepare(`
    SELECT id
    FROM canvas_projects
    WHERE organization_id = ? AND id = ? AND status = 'active'
    LIMIT 1
  `).get(params.organizationId, params.projectId) as { id: string } | undefined;
  if (!project) {
    throw new WorkspaceOperationError('WORKSPACE_PROJECT_NOT_FOUND', 'Project not found.', 404);
  }

  const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
  if (!userId) {
    throw new WorkspaceOperationError('WORKSPACE_MEMBER_USER_REQUIRED', 'User is required.', 400);
  }
  ensureWorkspaceMemberCandidate(sqlite, { organizationId: params.organizationId, userId });

  const role = typeof params.role === 'string' ? normalizeWorkspaceRole(params.role) : 'member';
  const canManage = Boolean(params.canManage);
  const canWrite = canManage || Boolean(params.canWrite);
  const canRead = canManage || canWrite || params.canRead !== false;
  assertProjectWorkspaceRetainsManager(sqlite, {
    organizationId: params.organizationId,
    projectId: params.projectId,
    userId,
    nextCanManage: canManage,
  });
  const now = Date.now();

  sqlite.prepare(`
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
  `).run(
    params.organizationId,
    params.projectId,
    userId,
    role,
    canRead ? 1 : 0,
    canWrite ? 1 : 0,
    canManage ? 1 : 0,
    params.actor.userId,
    now,
    now,
  );

  const member = listProjectWorkspaceMembers(sqlite, {
    workspaceId: params.workspaceId,
    organizationId: params.organizationId,
    projectId: params.projectId,
  }).find((item) => item.userId === userId);
  if (!member) {
    throw new WorkspaceOperationError('WORKSPACE_MEMBER_UPDATE_FAILED', 'Workspace member update failed.', 500);
  }
  return member;
}

export function removeTeamWorkspaceMember(
  sqlite: Database.Database,
  params: {
    organizationId: string;
    workspaceId: string;
    userId: string;
  },
): void {
  const record = getWorkspaceById(sqlite, params.workspaceId);
  if (!record || record.type !== 'team' || record.organizationId !== params.organizationId) {
    throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  }

  assertTeamWorkspaceRetainsManager(sqlite, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    nextCanManage: false,
  });

  sqlite.prepare(`
    DELETE FROM canvas_workspace_members
    WHERE workspace_id = ? AND user_id = ?
  `).run(params.workspaceId, params.userId);
}

export function removeProjectWorkspaceMember(
  sqlite: Database.Database,
  params: {
    organizationId: string;
    workspaceId: string;
    projectId: string;
    userId: string;
  },
): void {
  const record = getWorkspaceById(sqlite, params.workspaceId);
  if (!record || record.type !== 'project' || record.organizationId !== params.organizationId || record.projectId !== params.projectId) {
    throw new WorkspaceOperationError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
  }

  assertProjectWorkspaceRetainsManager(sqlite, {
    organizationId: params.organizationId,
    projectId: params.projectId,
    userId: params.userId,
    nextCanManage: false,
  });

  sqlite.prepare(`
    DELETE FROM canvas_project_members
    WHERE organization_id = ? AND project_id = ? AND user_id = ?
  `).run(params.organizationId, params.projectId, params.userId);
}
