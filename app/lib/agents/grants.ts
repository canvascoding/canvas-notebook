import 'server-only';

import { randomUUID } from 'node:crypto';

import { getDatabaseProvider, openDb } from '@/app/lib/db';
import type { AgentAccess } from '@/app/lib/agents/access';

export type AgentGrantTargetType = 'organization' | 'role' | 'workspace' | 'project' | 'user';

export type AgentGrantRecord = AgentAccess & {
  id: string;
  agentId: string;
  organizationId: string;
  targetType: AgentGrantTargetType;
  targetId: string;
  revision: number;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentGrantTargetCatalog = {
  users: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    role: string;
  }>;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    type: string;
  }>;
  projects: Array<{
    projectId: string;
    name: string;
  }>;
};

export class AgentGrantError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AgentGrantError';
  }
}

type GrantRow = {
  id: string;
  agent_id: string;
  organization_id: string;
  target_type: string;
  target_id: string;
  can_use: unknown;
  can_edit: unknown;
  can_manage: unknown;
  revision: number | string;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: number | string;
  updated_at: number | string;
};

function booleanFromDb(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function mapGrant(row: GrantRow): AgentGrantRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    organizationId: row.organization_id,
    targetType: row.target_type as AgentGrantTargetType,
    targetId: row.target_id,
    canUse: booleanFromDb(row.can_use),
    canEdit: booleanFromDb(row.can_edit),
    canManage: booleanFromDb(row.can_manage),
    revision: Number(row.revision) || 1,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizeTargetType(value: unknown): AgentGrantTargetType {
  if (value === 'organization' || value === 'role' || value === 'workspace' || value === 'project' || value === 'user') {
    return value;
  }
  throw new AgentGrantError('AGENT_GRANT_TARGET_INVALID', 'Grant targetType is invalid.');
}

function normalizeAccess(input: Partial<AgentAccess>): AgentAccess {
  const canManage = input.canManage === true;
  const canEdit = canManage || input.canEdit === true;
  const canUse = canEdit || input.canUse !== false;
  return { canUse, canEdit, canManage };
}

async function assertTargetBelongsToOrganization(
  organizationId: string,
  targetType: AgentGrantTargetType,
  targetId: string,
): Promise<void> {
  if (targetType === 'organization') {
    if (targetId !== organizationId) {
      throw new AgentGrantError('AGENT_GRANT_TARGET_INVALID', 'Organization grants must target the agent organization.');
    }
    return;
  }
  if (targetType === 'role') {
    if (!['owner', 'admin', 'member', 'external'].includes(targetId)) {
      throw new AgentGrantError('AGENT_GRANT_TARGET_INVALID', 'Role grant target is invalid.');
    }
    return;
  }

  const database = await openDb();
  try {
    let row: unknown;
    if (targetType === 'user') {
      row = await database.get(
        `SELECT user_id FROM organization_user_permissions
         WHERE organization_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
        [organizationId, targetId],
      );
    } else if (targetType === 'workspace') {
      row = await database.get(
        `SELECT id FROM canvas_workspaces WHERE organization_id = ? AND id = ? LIMIT 1`,
        [organizationId, targetId],
      );
    } else {
      row = await database.get(
        `SELECT id FROM canvas_projects WHERE organization_id = ? AND id = ? LIMIT 1`,
        [organizationId, targetId],
      );
    }
    if (!row) {
      throw new AgentGrantError('AGENT_GRANT_TARGET_INVALID', 'Grant target is outside the agent organization or unavailable.');
    }
  } finally {
    await database.close();
  }
}

export async function listAgentGrants(agentId: string): Promise<AgentGrantRecord[]> {
  const database = await openDb();
  try {
    const rows = await database.all(
      `SELECT * FROM agent_grants WHERE agent_id = ? ORDER BY target_type ASC, target_id ASC`,
      [agentId],
    ) as GrantRow[];
    return rows.map(mapGrant);
  } finally {
    await database.close();
  }
}

export async function listAgentGrantTargets(organizationId: string): Promise<AgentGrantTargetCatalog> {
  const database = await openDb();
  try {
    const users = await database.all(
      `SELECT
         p.user_id,
         u.name,
         u.email,
         p.role
       FROM organization_user_permissions p
       JOIN "user" u ON u.id = p.user_id
       WHERE p.organization_id = ?
         AND p.status = 'active'
         AND (u.banned IS NULL OR u.banned = ?)
       ORDER BY lower(u.name) ASC, lower(u.email) ASC, p.user_id ASC`,
      [organizationId, getDatabaseProvider() === 'postgres' ? false : 0],
    ) as Array<{
      user_id: string;
      name: string | null;
      email: string | null;
      role: string;
    }>;
    const workspaces = await database.all(
      `SELECT id, display_name, type
       FROM canvas_workspaces
       WHERE organization_id = ? AND status = 'active'
       ORDER BY lower(display_name) ASC, id ASC`,
      [organizationId],
    ) as Array<{
      id: string;
      display_name: string;
      type: string;
    }>;
    const projects = await database.all(
      `SELECT id, name
       FROM canvas_projects
       WHERE organization_id = ? AND status = 'active'
       ORDER BY lower(name) ASC, id ASC`,
      [organizationId],
    ) as Array<{
      id: string;
      name: string;
    }>;

    return {
      users: users.map((user) => ({
        userId: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
      })),
      workspaces: workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.display_name,
        type: workspace.type,
      })),
      projects: projects.map((project) => ({
        projectId: project.id,
        name: project.name,
      })),
    };
  } finally {
    await database.close();
  }
}

export async function upsertAgentGrant(input: {
  agentId: string;
  organizationId: string;
  targetType: unknown;
  targetId: unknown;
  canUse?: boolean;
  canEdit?: boolean;
  canManage?: boolean;
  actorUserId: string;
}): Promise<AgentGrantRecord> {
  const targetType = normalizeTargetType(input.targetType);
  const targetId = typeof input.targetId === 'string' ? input.targetId.trim() : '';
  if (!targetId) throw new AgentGrantError('AGENT_GRANT_TARGET_REQUIRED', 'Grant targetId is required.');
  await assertTargetBelongsToOrganization(input.organizationId, targetType, targetId);
  const access = normalizeAccess(input);
  const database = await openDb();
  try {
    const now = Date.now();
    await database.run(
      `INSERT INTO agent_grants (
        id, agent_id, organization_id, target_type, target_id,
        can_use, can_edit, can_manage, revision,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(agent_id, target_type, target_id) DO UPDATE SET
        can_use = excluded.can_use,
        can_edit = excluded.can_edit,
        can_manage = excluded.can_manage,
        revision = agent_grants.revision + 1,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = excluded.updated_at`,
      [
        `agent-grant-${randomUUID()}`,
        input.agentId,
        input.organizationId,
        targetType,
        targetId,
        access.canUse ? 1 : 0,
        access.canEdit ? 1 : 0,
        access.canManage ? 1 : 0,
        input.actorUserId,
        input.actorUserId,
        now,
        now,
      ],
    );
    const row = await database.get(
      `SELECT * FROM agent_grants WHERE agent_id = ? AND target_type = ? AND target_id = ? LIMIT 1`,
      [input.agentId, targetType, targetId],
    ) as GrantRow | undefined;
    if (!row) throw new AgentGrantError('AGENT_GRANT_WRITE_FAILED', 'Agent grant could not be stored.', 500);
    return mapGrant(row);
  } finally {
    await database.close();
  }
}

export async function removeAgentGrant(input: {
  agentId: string;
  targetType: unknown;
  targetId: unknown;
}): Promise<void> {
  const targetType = normalizeTargetType(input.targetType);
  const targetId = typeof input.targetId === 'string' ? input.targetId.trim() : '';
  if (!targetId) throw new AgentGrantError('AGENT_GRANT_TARGET_REQUIRED', 'Grant targetId is required.');
  const database = await openDb();
  try {
    await database.run(
      `DELETE FROM agent_grants WHERE agent_id = ? AND target_type = ? AND target_id = ?`,
      [input.agentId, targetType, targetId],
    );
  } finally {
    await database.close();
  }
}
