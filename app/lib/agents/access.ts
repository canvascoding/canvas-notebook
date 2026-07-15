import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { listAgentProfiles, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';

export type AgentAccess = {
  canUse: boolean;
  canEdit: boolean;
  canManage: boolean;
};

export type AgentAccessContext = {
  organizationId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
};

export type AgentMemberRecord = AgentAccess & {
  agentId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
};

export type AgentMemberCandidate = {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
};

type AgentMemberRow = {
  agent_id: string;
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
  can_use: unknown;
  can_edit: unknown;
  can_manage: unknown;
};

type AgentCandidateRow = {
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  status: string;
};

export class AgentAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentAccessError';
  }
}

const MAIN_AGENT_ACCESS: AgentAccess = {
  canUse: true,
  canEdit: true,
  canManage: true,
};

const NO_AGENT_ACCESS: AgentAccess = {
  canUse: false,
  canEdit: false,
  canManage: false,
};

function booleanFromDb(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function mergeAgentAccess(...entries: AgentAccess[]): AgentAccess {
  return {
    canUse: entries.some((entry) => entry.canUse),
    canEdit: entries.some((entry) => entry.canEdit),
    canManage: entries.some((entry) => entry.canManage),
  };
}

function rowToMember(row: AgentMemberRow): AgentMemberRecord {
  return {
    agentId: row.agent_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    canUse: booleanFromDb(row.can_use),
    canEdit: booleanFromDb(row.can_edit),
    canManage: booleanFromDb(row.can_manage),
  };
}

async function requireOrganizationId(userId: string): Promise<string> {
  const state = await readOrganizationPermissionForUser(userId);
  if (!state.configured || !state.organizationId || state.permission?.status !== 'active') {
    throw new AgentAccessError(
      'ORGANIZATION_SETUP_REQUIRED',
      'Complete the app setup before managing agent access.',
      409,
    );
  }
  return state.organizationId;
}

async function assertSpecialAgent(database: SqlConnection, agentId: string): Promise<void> {
  const agent = await database.get(
    `SELECT agent_id, type FROM agents WHERE agent_id = ? LIMIT 1`,
    [agentId],
  ) as { agent_id: string; type: string } | undefined;
  if (!agent) {
    throw new AgentAccessError('AGENT_NOT_FOUND', 'Agent not found.', 404);
  }
  if (agent.type === 'main') {
    throw new AgentAccessError('AGENT_MEMBERS_UNSUPPORTED', 'Canvas Agent access is available to every user.', 403);
  }
}

export async function getAgentAccess(
  userId: string,
  agentIdInput?: string | null,
  context: AgentAccessContext = {},
): Promise<AgentAccess> {
  const agentId = normalizeManagedAgentId(agentIdInput);
  if (agentId === DEFAULT_MANAGED_AGENT_ID) return MAIN_AGENT_ACCESS;

  const database = await openDb();
  try {
    const row = await database.get(
      `
        SELECT
          a.access_policy, a.scope_type, a.organization_id, a.owner_user_id,
          m.can_use, m.can_edit, m.can_manage
        FROM agents a
        LEFT JOIN agent_members m
          ON m.agent_id = a.agent_id AND m.user_id = ? AND m.status = 'active'
        WHERE a.agent_id = ?
        LIMIT 1
      `,
      [userId, agentId],
    ) as {
      access_policy: string;
      scope_type: string;
      organization_id: string | null;
      owner_user_id: string | null;
      can_use: unknown;
      can_edit: unknown;
      can_manage: unknown;
    } | undefined;
    if (!row) return NO_AGENT_ACCESS;
    if (row.access_policy === 'legacy') return MAIN_AGENT_ACCESS;
    if (row.scope_type === 'user' && row.owner_user_id === userId) return MAIN_AGENT_ACCESS;
    const directAccess: AgentAccess = {
      canUse: booleanFromDb(row.can_use),
      canEdit: booleanFromDb(row.can_edit),
      canManage: booleanFromDb(row.can_manage),
    };
    // Pre-scope agents have no owner and continue to use their legacy member grants.
    if (row.scope_type === 'user') {
      return row.owner_user_id ? NO_AGENT_ACCESS : directAccess;
    }
    if (row.scope_type !== 'organization' || !row.organization_id) return NO_AGENT_ACCESS;

    const permission = await database.get(
      `SELECT role, status FROM organization_user_permissions
       WHERE organization_id = ? AND user_id = ? LIMIT 1`,
      [row.organization_id, userId],
    ) as { role?: string | null; status?: string | null } | undefined;
    if (!permission || permission.status !== 'active') return NO_AGENT_ACCESS;
    if (context.organizationId && context.organizationId !== row.organization_id) return NO_AGENT_ACCESS;

    const grantRows = await database.all(
      `SELECT target_type, target_id, can_use, can_edit, can_manage
       FROM agent_grants
       WHERE agent_id = ? AND organization_id = ?`,
      [agentId, row.organization_id],
    ) as Array<{
      target_type: string;
      target_id: string;
      can_use: unknown;
      can_edit: unknown;
      can_manage: unknown;
    }>;
    const [workspaceRows, projectRows] = await Promise.all([
      context.workspaceId ? Promise.resolve([]) : database.all(
        `SELECT DISTINCT w.id
         FROM canvas_workspaces w
         LEFT JOIN canvas_workspace_members wm
           ON wm.workspace_id = w.id AND wm.user_id = ? AND wm.status = 'active'
         LEFT JOIN canvas_project_members pm
           ON pm.project_id = w.project_id AND pm.user_id = ? AND pm.status = 'active'
         WHERE w.organization_id = ? AND w.status = 'active'
           AND (w.type = 'organization' OR w.owner_user_id = ? OR wm.user_id IS NOT NULL OR pm.user_id IS NOT NULL)`,
        [userId, userId, row.organization_id, userId],
      ),
      context.projectId ? Promise.resolve([]) : database.all(
        `SELECT DISTINCT p.id
         FROM canvas_projects p
         LEFT JOIN canvas_project_members pm
           ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'active'
         WHERE p.organization_id = ? AND p.status = 'active'
           AND (p.created_by_user_id = ? OR pm.user_id IS NOT NULL OR ? IN ('owner', 'admin'))`,
        [userId, row.organization_id, userId, permission.role || 'member'],
      ),
    ]) as [Array<{ id: string }>, Array<{ id: string }>];
    const accessibleWorkspaceIds = new Set(workspaceRows.map((entry) => entry.id));
    const accessibleProjectIds = new Set(projectRows.map((entry) => entry.id));
    const matchedGrantAccess = grantRows
      .filter((grant) => {
        if (grant.target_type === 'organization') return grant.target_id === row.organization_id;
        if (grant.target_type === 'role') return grant.target_id === permission.role;
        if (grant.target_type === 'user') return grant.target_id === userId;
        if (grant.target_type === 'workspace') {
          return context.workspaceId ? grant.target_id === context.workspaceId : accessibleWorkspaceIds.has(grant.target_id);
        }
        if (grant.target_type === 'project') {
          return context.projectId ? grant.target_id === context.projectId : accessibleProjectIds.has(grant.target_id);
        }
        return false;
      })
      .map((grant): AgentAccess => ({
        canUse: booleanFromDb(grant.can_use),
        canEdit: booleanFromDb(grant.can_edit),
        canManage: booleanFromDb(grant.can_manage),
      }));
    return mergeAgentAccess(directAccess, ...matchedGrantAccess);
  } finally {
    await database.close();
  }
}

export async function requireAgentAccess(
  userId: string,
  agentId: string,
  permission: keyof AgentAccess,
  context: AgentAccessContext = {},
): Promise<AgentAccess> {
  const access = await getAgentAccess(userId, agentId, context);
  if (!access[permission]) {
    throw new AgentAccessError('AGENT_ACCESS_DENIED', 'Agent access denied.', 403);
  }
  return access;
}

export async function listAgentAccessForUser(
  userId: string,
  context: AgentAccessContext = {},
): Promise<Map<string, AgentAccess>> {
  const profiles = await listAgentProfiles();
  const entries = await Promise.all(profiles.map(async (profile) => (
    [profile.agentId, await getAgentAccess(userId, profile.agentId, context)] as const
  )));
  return new Map(entries.filter(([, access]) => access.canUse));
}

export async function createAgentManagerMembership(agentIdInput: string, userId: string): Promise<AgentMemberRecord> {
  const agentId = normalizeManagedAgentId(agentIdInput);
  const organizationId = await requireOrganizationId(userId);
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await assertSpecialAgent(database, agentId);
    const user = await database.get(
      `SELECT id FROM "user" WHERE id = ? AND COALESCE(banned, 0) = 0 LIMIT 1`,
      [userId],
    );
    if (!user) {
      throw new AgentAccessError('AGENT_MEMBER_NOT_ELIGIBLE', 'User is unavailable for agent access.', 400);
    }
    const now = Date.now();
    await database.run(
      `
        INSERT INTO agent_members (
          agent_id, organization_id, user_id, role, status,
          can_use, can_edit, can_manage, invited_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'manager', 'active', 1, 1, 1, ?, ?, ?)
        ON CONFLICT(agent_id, user_id) DO UPDATE SET
          organization_id = excluded.organization_id,
          role = 'manager',
          status = 'active',
          can_use = 1,
          can_edit = 1,
          can_manage = 1,
          updated_at = excluded.updated_at
      `,
      [agentId, organizationId, userId, userId, now, now],
    );
    await database.run(`UPDATE agents SET access_policy = 'restricted', updated_at = ? WHERE agent_id = ?`, [now, agentId]);
    const row = await readAgentMember(database, agentId, userId);
    if (!row) throw new AgentAccessError('AGENT_MEMBER_UPDATE_FAILED', 'Agent member update failed.', 500);
    await database.run('COMMIT');
    return rowToMember(row);
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    await database.close();
  }
}

async function readAgentMember(database: SqlConnection, agentId: string, userId: string): Promise<AgentMemberRow | undefined> {
  return await database.get(
    `
      SELECT
        m.agent_id, m.user_id, u.name, u.email, m.role, m.status,
        m.can_use, m.can_edit, m.can_manage
      FROM agent_members m
      LEFT JOIN "user" u ON u.id = m.user_id
      WHERE m.agent_id = ? AND m.user_id = ?
      LIMIT 1
    `,
    [agentId, userId],
  ) as AgentMemberRow | undefined;
}

async function ensureEligibleCandidate(
  database: SqlConnection,
  organizationId: string,
  userId: string,
): Promise<void> {
  const row = await database.get(
    `
      SELECT u.id
      FROM "user" u
      JOIN organization_user_permissions p
        ON p.user_id = u.id AND p.organization_id = ?
      WHERE u.id = ?
        AND p.status = 'active'
        AND p.role != 'external'
        AND COALESCE(u.banned, 0) = 0
      LIMIT 1
    `,
    [organizationId, userId],
  );
  if (!row) {
    throw new AgentAccessError('AGENT_MEMBER_NOT_ELIGIBLE', 'User is unavailable for agent access.', 400);
  }
}

export async function listAgentMembersForManager(
  agentIdInput: string,
  actorUserId: string,
): Promise<{ members: AgentMemberRecord[]; candidates: AgentMemberCandidate[] }> {
  const agentId = normalizeManagedAgentId(agentIdInput);
  await requireAgentAccess(actorUserId, agentId, 'canManage');
  const organizationId = await requireOrganizationId(actorUserId);
  const database = await openDb();
  try {
    await assertSpecialAgent(database, agentId);
    const memberRows = await database.all(
      `
        SELECT
          m.agent_id, m.user_id, u.name, u.email, m.role, m.status,
          m.can_use, m.can_edit, m.can_manage
        FROM agent_members m
        LEFT JOIN "user" u ON u.id = m.user_id
        WHERE m.agent_id = ? AND m.organization_id = ? AND m.status = 'active'
        ORDER BY m.can_manage DESC, m.can_edit DESC, lower(COALESCE(u.email, u.name, m.user_id)) ASC
      `,
      [agentId, organizationId],
    ) as AgentMemberRow[];
    const candidateRows = await database.all(
      `
        SELECT u.id AS user_id, u.name, u.email, p.role, p.status
        FROM "user" u
        JOIN organization_user_permissions p
          ON p.user_id = u.id AND p.organization_id = ?
        WHERE p.status = 'active'
          AND p.role != 'external'
          AND COALESCE(u.banned, 0) = 0
        ORDER BY lower(COALESCE(u.email, u.name, u.id)) ASC
      `,
      [organizationId],
    ) as AgentCandidateRow[];
    return {
      members: memberRows.map(rowToMember),
      candidates: candidateRows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        role: row.role,
        status: row.status,
      })),
    };
  } finally {
    await database.close();
  }
}

export async function upsertAgentMemberForManager(input: {
  agentId: string;
  actorUserId: string;
  userId: unknown;
  canUse?: unknown;
  canEdit?: unknown;
  canManage?: unknown;
}): Promise<AgentMemberRecord> {
  const agentId = normalizeManagedAgentId(input.agentId);
  await requireAgentAccess(input.actorUserId, agentId, 'canManage');
  const organizationId = await requireOrganizationId(input.actorUserId);
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (!userId) throw new AgentAccessError('AGENT_MEMBER_USER_REQUIRED', 'User is required.', 400);

  const canManage = Boolean(input.canManage);
  const canEdit = canManage || Boolean(input.canEdit);
  const canUse = canEdit || input.canUse !== false;
  const role = canManage ? 'manager' : canEdit ? 'editor' : 'user';
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await assertSpecialAgent(database, agentId);
    await ensureEligibleCandidate(database, organizationId, userId);

    const current = await readAgentMember(database, agentId, userId);
    if (current && booleanFromDb(current.can_manage) && !canManage) {
      const countRow = await database.get(
        `SELECT COUNT(*) AS count FROM agent_members WHERE agent_id = ? AND status = 'active' AND can_manage = 1`,
        [agentId],
      ) as { count?: number | string } | undefined;
      if (Number(countRow?.count || 0) <= 1) {
        throw new AgentAccessError('AGENT_LAST_MANAGER', 'The last agent manager cannot be changed.', 409);
      }
    }

    const now = Date.now();
    await database.run(
      `
        INSERT INTO agent_members (
          agent_id, organization_id, user_id, role, status,
          can_use, can_edit, can_manage, invited_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, user_id) DO UPDATE SET
          organization_id = excluded.organization_id,
          role = excluded.role,
          status = 'active',
          can_use = excluded.can_use,
          can_edit = excluded.can_edit,
          can_manage = excluded.can_manage,
          invited_by_user_id = excluded.invited_by_user_id,
          updated_at = excluded.updated_at
      `,
      [
        agentId,
        organizationId,
        userId,
        role,
        canUse ? 1 : 0,
        canEdit ? 1 : 0,
        canManage ? 1 : 0,
        input.actorUserId,
        now,
        now,
      ],
    );
    const row = await readAgentMember(database, agentId, userId);
    if (!row) throw new AgentAccessError('AGENT_MEMBER_UPDATE_FAILED', 'Agent member update failed.', 500);
    await database.run('COMMIT');
    return rowToMember(row);
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    await database.close();
  }
}

export async function removeAgentMemberForManager(input: {
  agentId: string;
  actorUserId: string;
  userId: string;
}): Promise<void> {
  const agentId = normalizeManagedAgentId(input.agentId);
  await requireAgentAccess(input.actorUserId, agentId, 'canManage');
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await assertSpecialAgent(database, agentId);
    const current = await readAgentMember(database, agentId, input.userId);
    if (current && booleanFromDb(current.can_manage)) {
      const countRow = await database.get(
        `SELECT COUNT(*) AS count FROM agent_members WHERE agent_id = ? AND status = 'active' AND can_manage = 1`,
        [agentId],
      ) as { count?: number | string } | undefined;
      if (Number(countRow?.count || 0) <= 1) {
        throw new AgentAccessError('AGENT_LAST_MANAGER', 'The last agent manager cannot be removed.', 409);
      }
    }
    await database.run(`DELETE FROM agent_members WHERE agent_id = ? AND user_id = ?`, [agentId, input.userId]);
    await database.run('COMMIT');
  } catch (error) {
    try {
      await database.run('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    await database.close();
  }
}
