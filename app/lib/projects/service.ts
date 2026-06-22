import 'server-only';

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { ensureProjectWorkspaceRecord, type WorkspaceRecord } from '@/app/lib/workspaces/service';
import type { WorkspaceUserRole } from '@/app/lib/workspaces/types';

export type CanvasCustomerStatus = 'active' | 'archived' | 'disabled';
export type CanvasProjectStatus = 'active' | 'archived' | 'disabled';
export type CanvasProjectMemberStatus = 'active' | 'disabled' | 'archived';

export interface CanvasCustomerRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  status: CanvasCustomerStatus;
  notes: string | null;
  metadataJson: string | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CanvasProjectRecord {
  id: string;
  organizationId: string;
  customerId: string | null;
  name: string;
  slug: string;
  status: CanvasProjectStatus;
  description: string | null;
  metadataJson: string | null;
  createdByUserId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CanvasProjectMemberRecord {
  organizationId: string;
  projectId: string;
  userId: string;
  role: WorkspaceUserRole;
  status: CanvasProjectMemberStatus;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
  invitedByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

type CustomerRow = {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  status: string;
  notes: string | null;
  metadata_json: string | null;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type ProjectRow = {
  id: string;
  organization_id: string;
  customer_id: string | null;
  name: string;
  slug: string;
  status: string;
  description: string | null;
  metadata_json: string | null;
  created_by_user_id: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

type ProjectMemberRow = {
  organization_id: string;
  project_id: string;
  user_id: string;
  role: string;
  status: string;
  can_read: number;
  can_write: number;
  can_manage: number;
  invited_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

function createScopedId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeProjectSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

function normalizeCustomerStatus(value: string): CanvasCustomerStatus {
  if (value === 'archived' || value === 'disabled') return value;
  return 'active';
}

function normalizeProjectStatus(value: string): CanvasProjectStatus {
  if (value === 'archived' || value === 'disabled') return value;
  return 'active';
}

function normalizeMemberStatus(value: string): CanvasProjectMemberStatus {
  if (value === 'disabled' || value === 'archived') return value;
  return 'active';
}

function normalizeProjectRole(value: string): WorkspaceUserRole {
  if (value === 'owner' || value === 'admin' || value === 'external') return value;
  return 'member';
}

function customerFromRow(row: CustomerRow): CanvasCustomerRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    status: normalizeCustomerStatus(row.status),
    notes: row.notes,
    metadataJson: row.metadata_json,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectFromRow(row: ProjectRow): CanvasProjectRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    name: row.name,
    slug: row.slug,
    status: normalizeProjectStatus(row.status),
    description: row.description,
    metadataJson: row.metadata_json,
    createdByUserId: row.created_by_user_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memberFromRow(row: ProjectMemberRow): CanvasProjectMemberRecord {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    userId: row.user_id,
    role: normalizeProjectRole(row.role),
    status: normalizeMemberStatus(row.status),
    canRead: row.can_read === 1,
    canWrite: row.can_write === 1,
    canManage: row.can_manage === 1,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCanvasCustomer(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    name: string;
    slug?: string;
    notes?: string | null;
    metadataJson?: string | null;
    createdByUserId?: string | null;
  },
): CanvasCustomerRecord {
  const now = Date.now();
  const id = createScopedId('cust');
  const slug = normalizeProjectSlug(input.slug ?? input.name);
  sqlite.prepare(`
    INSERT INTO canvas_customers (
      id, organization_id, name, slug, status, notes, metadata_json, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(
    id,
    input.organizationId,
    input.name.trim(),
    slug,
    input.notes ?? null,
    input.metadataJson ?? null,
    input.createdByUserId ?? null,
    now,
    now,
  );

  const record = getCanvasCustomerById(sqlite, input.organizationId, id);
  if (!record) throw new Error('Customer insert failed');
  return record;
}

export function getCanvasCustomerById(
  sqlite: Database.Database,
  organizationId: string,
  customerId: string,
): CanvasCustomerRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, name, slug, status, notes, metadata_json, created_by_user_id, created_at, updated_at
    FROM canvas_customers
    WHERE organization_id = ? AND id = ?
    LIMIT 1
  `).get(organizationId, customerId) as CustomerRow | undefined;
  return row ? customerFromRow(row) : null;
}

export function createCanvasProject(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    name: string;
    slug?: string;
    customerId?: string | null;
    description?: string | null;
    metadataJson?: string | null;
    createdByUserId?: string | null;
  },
): CanvasProjectRecord {
  const customerId = input.customerId ?? null;
  if (customerId && !getCanvasCustomerById(sqlite, input.organizationId, customerId)) {
    throw new Error('Project customer not found in this organization.');
  }

  const now = Date.now();
  const id = createScopedId('prj');
  const slug = normalizeProjectSlug(input.slug ?? input.name);
  sqlite.prepare(`
    INSERT INTO canvas_projects (
      id, organization_id, customer_id, name, slug, status, description, metadata_json, created_by_user_id, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    input.organizationId,
    customerId,
    input.name.trim(),
    slug,
    input.description ?? null,
    input.metadataJson ?? null,
    input.createdByUserId ?? null,
    now,
    now,
  );

  const record = getCanvasProjectById(sqlite, input.organizationId, id);
  if (!record) throw new Error('Project insert failed');
  return record;
}

export function getCanvasProjectById(
  sqlite: Database.Database,
  organizationId: string,
  projectId: string,
): CanvasProjectRecord | null {
  const row = sqlite.prepare(`
    SELECT id, organization_id, customer_id, name, slug, status, description, metadata_json, created_by_user_id, archived_at, created_at, updated_at
    FROM canvas_projects
    WHERE organization_id = ? AND id = ?
    LIMIT 1
  `).get(organizationId, projectId) as ProjectRow | undefined;
  return row ? projectFromRow(row) : null;
}

export function upsertCanvasProjectMember(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    projectId: string;
    userId: string;
    role?: WorkspaceUserRole;
    status?: CanvasProjectMemberStatus;
    canRead?: boolean;
    canWrite?: boolean;
    canManage?: boolean;
    invitedByUserId?: string | null;
  },
): CanvasProjectMemberRecord {
  const project = getCanvasProjectById(sqlite, input.organizationId, input.projectId);
  if (!project) throw new Error('Project not found in this organization.');

  const now = Date.now();
  const existing = getCanvasProjectMember(sqlite, input.organizationId, input.projectId, input.userId);
  const role = input.role ?? existing?.role ?? 'member';
  const status = input.status ?? existing?.status ?? 'active';
  const canManage = input.canManage ?? existing?.canManage ?? false;
  const canWrite = input.canWrite ?? existing?.canWrite ?? canManage;
  const canRead = input.canRead ?? existing?.canRead ?? true;

  sqlite.prepare(`
    INSERT INTO canvas_project_members (
      organization_id, project_id, user_id, role, status, can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
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
  `).run(
    input.organizationId,
    input.projectId,
    input.userId,
    role,
    status,
    canRead ? 1 : 0,
    canWrite ? 1 : 0,
    canManage ? 1 : 0,
    input.invitedByUserId ?? existing?.invitedByUserId ?? null,
    existing?.createdAt ?? now,
    now,
  );

  const record = getCanvasProjectMember(sqlite, input.organizationId, input.projectId, input.userId);
  if (!record) throw new Error('Project member upsert failed');
  return record;
}

export function getCanvasProjectMember(
  sqlite: Database.Database,
  organizationId: string,
  projectId: string,
  userId: string,
): CanvasProjectMemberRecord | null {
  const row = sqlite.prepare(`
    SELECT organization_id, project_id, user_id, role, status, can_read, can_write, can_manage, invited_by_user_id, created_at, updated_at
    FROM canvas_project_members
    WHERE organization_id = ? AND project_id = ? AND user_id = ?
    LIMIT 1
  `).get(organizationId, projectId, userId) as ProjectMemberRow | undefined;
  return row ? memberFromRow(row) : null;
}

export function ensureCanvasProjectWorkspace(
  sqlite: Database.Database,
  input: {
    organizationId: string;
    projectId: string;
  },
): WorkspaceRecord {
  const project = getCanvasProjectById(sqlite, input.organizationId, input.projectId);
  if (!project) throw new Error('Project not found in this organization.');
  return ensureProjectWorkspaceRecord(sqlite, {
    organizationId: project.organizationId,
    projectId: project.id,
    customerId: project.customerId,
    displayName: project.name,
  });
}
