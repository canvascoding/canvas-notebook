import 'server-only';

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { resolveWorkspaceDataRoot } from './context';
import { resolveWorkspacePermissions } from './permissions';
import type { WorkspaceActor, WorkspaceContext, WorkspaceStatus, WorkspaceType } from './types';

export interface WorkspaceRecord {
  id: string;
  organizationId: string;
  type: WorkspaceType;
  ownerUserId: string | null;
  rootRelativePath: string;
  displayName: string;
  status: WorkspaceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface DefaultWorkspaceRecords {
  personal: WorkspaceRecord;
  team: WorkspaceRecord | null;
}

type WorkspaceRow = {
  id: string;
  organization_id: string;
  type: string;
  owner_user_id: string | null;
  root_relative_path: string;
  display_name: string;
  status: string;
  created_at: number;
  updated_at: number;
};

type PermissionRow = {
  role: string;
  can_write_team_workspace: number;
  can_create_public_links: number;
};

function normalizeWorkspaceType(value: string): WorkspaceType {
  if (value === 'team' || value === 'project') return value;
  return 'personal';
}

function normalizeWorkspaceStatus(value: string): WorkspaceStatus {
  if (value === 'archived' || value === 'disabled') return value;
  return 'active';
}

function rowToWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: normalizeWorkspaceType(row.type),
    ownerUserId: row.owner_user_id,
    rootRelativePath: row.root_relative_path,
    displayName: row.display_name,
    status: normalizeWorkspaceStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function personalWorkspaceRootRelativePath(userId: string): string {
  return path.posix.join('workspaces', 'personal', userId, 'files');
}

export function teamWorkspaceRootRelativePath(organizationId: string): string {
  return path.posix.join('workspaces', 'team', organizationId, 'files');
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

function getWorkspaceById(sqlite: Database.Database, workspaceId: string): WorkspaceRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
    FROM canvas_workspaces
    WHERE id = ?
    LIMIT 1
  `).get(workspaceId) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

function getPersonalWorkspace(sqlite: Database.Database, userId: string): WorkspaceRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
    FROM canvas_workspaces
    WHERE type = 'personal' AND owner_user_id = ?
    LIMIT 1
  `).get(userId) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

function getTeamWorkspace(sqlite: Database.Database, organizationId: string): WorkspaceRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
    FROM canvas_workspaces
    WHERE type = 'team' AND organization_id = ?
    LIMIT 1
  `).get(organizationId) as WorkspaceRow | undefined;

  return row ? rowToWorkspaceRecord(row) : null;
}

function insertWorkspace(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    type: WorkspaceType;
    ownerUserId: string | null;
    rootRelativePath: string;
    displayName: string;
  },
): WorkspaceRecord {
  const now = Date.now();
  const id = createWorkspaceId();
  sqlite.prepare(`
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    id,
    input.organizationId,
    input.type,
    input.ownerUserId,
    input.rootRelativePath,
    input.displayName,
    now,
    now,
  );

  const record = getWorkspaceById(sqlite, id);
  if (!record) throw new Error('Workspace insert failed');
  ensureWorkspaceDirectory(record);
  return record;
}

function updateWorkspaceRoot(
  sqlite: Database.Database,
  record: WorkspaceRecord,
  input: {
    rootRelativePath: string;
    displayName: string;
  },
): WorkspaceRecord {
  if (record.rootRelativePath === input.rootRelativePath && record.displayName === input.displayName) {
    ensureWorkspaceDirectory(record);
    return record;
  }

  sqlite.prepare(`
    UPDATE canvas_workspaces
    SET root_relative_path = ?, display_name = ?, updated_at = ?
    WHERE id = ?
  `).run(input.rootRelativePath, input.displayName, Date.now(), record.id);

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
    teamFeaturesEnabled: boolean;
  },
): DefaultWorkspaceRecords {
  const personalRoot = personalWorkspaceRootRelativePath(params.userId);
  const existingPersonal = getPersonalWorkspace(sqlite, params.userId);
  const personal = existingPersonal
    ? updateWorkspaceRoot(sqlite, existingPersonal, { rootRelativePath: personalRoot, displayName: 'Personal Workspace' })
    : insertWorkspace(sqlite, {
        organizationId: params.organizationId,
        type: 'personal',
        ownerUserId: params.userId,
        rootRelativePath: personalRoot,
        displayName: 'Personal Workspace',
      });

  if (!params.teamFeaturesEnabled) {
    return { personal, team: null };
  }

  const teamRoot = teamWorkspaceRootRelativePath(params.organizationId);
  const existingTeam = getTeamWorkspace(sqlite, params.organizationId);
  const team = existingTeam
    ? updateWorkspaceRoot(sqlite, existingTeam, { rootRelativePath: teamRoot, displayName: 'Team Workspace' })
    : insertWorkspace(sqlite, {
        organizationId: params.organizationId,
        type: 'team',
        ownerUserId: null,
        rootRelativePath: teamRoot,
        displayName: 'Team Workspace',
      });

  return { personal, team };
}

function getPermissionRow(sqlite: Database.Database, organizationId: string, userId: string): PermissionRow | null {
  return sqlite.prepare(`
    SELECT role, can_write_team_workspace, can_create_public_links
    FROM organization_user_permissions
    WHERE organization_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, userId) as PermissionRow | undefined || null;
}

function canReadWorkspace(record: WorkspaceRecord, actor: WorkspaceActor, permission: PermissionRow | null): boolean {
  if (record.status !== 'active') return false;
  if (record.type === 'personal') return record.ownerUserId === actor.userId;
  if (record.type === 'team') return Boolean(permission && permission.role !== 'external');
  return false;
}

export function workspaceContextFromRecord(
  record: WorkspaceRecord,
  actor: WorkspaceActor,
  permission: PermissionRow | null = null,
): WorkspaceContext {
  const role = actor.role;
  const ownsPersonalWorkspace = record.type === 'personal' && record.ownerUserId === actor.userId;
  const canAccessTeamWorkspace = record.type === 'team' && Boolean(permission && permission.role !== 'external');
  const canWriteTeamWorkspace = record.type === 'team' && (
    role === 'owner' ||
    role === 'admin' ||
    permission?.can_write_team_workspace === 1
  );

  return {
    workspaceId: record.id,
    workspaceType: record.type,
    rootPath: workspaceAbsoluteRoot(record.rootRelativePath),
    rootRelativePath: record.rootRelativePath,
    displayName: record.displayName,
    status: record.status,
    actor,
    organizationId: record.organizationId,
    ownerUserId: record.ownerUserId,
    permissions: resolveWorkspacePermissions({
      role,
      workspaceType: record.type,
      ownsPersonalWorkspace,
      canAccessTeamWorkspace,
      canWriteTeamWorkspace,
      canCreatePublicLinks: permission?.can_create_public_links !== 0,
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
    SELECT id, organization_id, type, owner_user_id, root_relative_path, display_name, status, created_at, updated_at
    FROM canvas_workspaces
    WHERE organization_id = ? AND status = 'active'
      AND (type != 'personal' OR owner_user_id = ?)
    ORDER BY CASE type WHEN 'personal' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, created_at ASC
  `).all(params.organizationId, params.actor.userId) as WorkspaceRow[];
  const permission = getPermissionRow(sqlite, params.organizationId, params.actor.userId);

  return rows
    .map(rowToWorkspaceRecord)
    .filter((record) => canReadWorkspace(record, params.actor, permission))
    .map((record) => workspaceContextFromRecord(record, params.actor, permission));
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
  if (!canReadWorkspace(record, params.actor, permission)) return null;
  return workspaceContextFromRecord(record, params.actor, permission);
}
