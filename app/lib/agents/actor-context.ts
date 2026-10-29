import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { readActorMembershipAuthorityOnConnection, type ActorMembershipAuthority } from '@/app/lib/capabilities/scope-authority';
import { readPostgresWorkspaceForActorInSingleSnapshotOnConnection, workspaceContextFromPermissionSnapshot,
  type WorkspacePermissionSnapshotRow } from '@/app/lib/workspaces/postgres-runtime';
import { normalizeWorkspaceRole, resolveWorkspacePermissions } from '@/app/lib/workspaces/permissions';
import type { WorkspaceContext, WorkspacePermissions, WorkspaceUserRole } from '@/app/lib/workspaces/types';
import type { AgentAccessContext } from './access';

export type AgentActorContextInput = AgentAccessContext & { userId: string };
export type AgentActorContextDatabase = Pick<SqlConnection, 'get' | 'all'>;
export type VerifiedAgentActorContext = {
  userId: string;
  context: AgentAccessContext;
  organizationId: string | null;
  organizationRole: WorkspaceUserRole | null;
  workspacePermissions: WorkspacePermissions | null;
};

export class AgentActorContextError extends Error {
  readonly code = 'AGENT_ACTOR_CONTEXT_DENIED';
  readonly status = 403;
  constructor() {
    super('The requested agent context is not available to this user.');
    this.name = 'AgentActorContextError';
    Object.defineProperty(this, Symbol.for('canvas.agent.actor-context-error.v1'), { value: true });
  }
}

/** Module-copy recognition without trusting serialized errors or request data. */
export function isAgentActorContextError(value: unknown): value is AgentActorContextError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return candidate[Symbol.for('canvas.agent.actor-context-error.v1')] === true
    && candidate.code === 'AGENT_ACTOR_CONTEXT_DENIED' && candidate.status === 403;
}

type Row = Record<string, unknown>;
function deny(): never { throw new AgentActorContextError(); }
function suppliedId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) deny();
  return value;
}
function enabled(value: unknown): boolean { return value === true || value === 1 || value === '1'; }

function actorMembershipContext(userId: string, requestedOrg: string | null,
  current: ActorMembershipAuthority): VerifiedAgentActorContext {
  const organizationId = current.organizationId;
  if (!current.valid) deny();
  const membership = organizationId ? current.memberships.get(organizationId) : null;
  if (organizationId && membership?.status !== 'active') deny();
  if (requestedOrg && requestedOrg !== organizationId) deny();
  const role = membership ? normalizeWorkspaceRole(membership.role) : null;
  const result: VerifiedAgentActorContext = {
    userId, context: {}, organizationId, organizationRole: role, workspacePermissions: null,
  };
  if (requestedOrg) result.context.organizationId = organizationId;
  return result;
}

function actorWorkspaceProject(row: Row | undefined, organizationId: string | null,
  role: WorkspaceUserRole | null, requestedProject: string | null): string | null {
  if (!row || row.organization_id !== organizationId || !role) deny();
  const projectId = typeof row.project_id === 'string' ? row.project_id : null;
  if (requestedProject && requestedProject !== projectId) deny();
  return projectId;
}

function actorWorkspaceContext(result: VerifiedAgentActorContext, workspace: WorkspaceContext | null): VerifiedAgentActorContext {
  if (!workspace?.permissions.canRead || workspace.organizationId !== result.organizationId) deny();
  result.context = { organizationId: result.organizationId, workspaceId: workspace.workspaceId, projectId: workspace.projectId ?? null };
  result.workspacePermissions = { ...workspace.permissions };
  return result;
}

/** Pure decisions for one current workspace snapshot. These data do not grant a
 * Principal, SQL connection or reusable authorization; their caller owns the
 * actual observation and must retain its later I/O and publication fences. */
export function agentWorkspaceActorContextFromSnapshot(input: AgentActorContextInput,
  current: ActorMembershipAuthority, row: WorkspacePermissionSnapshotRow | undefined,
  accountRole: unknown, project: Row | undefined): VerifiedAgentActorContext {
  const userId = suppliedId(input.userId);
  if (!userId) deny();
  const requestedOrg = suppliedId(input.organizationId);
  const requestedWorkspace = suppliedId(input.workspaceId);
  const requestedProject = suppliedId(input.projectId);
  if (!requestedWorkspace) deny();
  const result = actorMembershipContext(userId, requestedOrg, current);
  if (!row || row.id !== requestedWorkspace || row.status !== 'active') deny();
  const projectId = actorWorkspaceProject(row, result.organizationId, result.organizationRole, requestedProject);
  if (projectId && project?.id !== projectId) deny();
  const role = row.type === 'personal'
    ? normalizeWorkspaceRole(typeof accountRole === 'string' ? accountRole : null) : result.organizationRole!;
  return actorWorkspaceContext(result, workspaceContextFromPermissionSnapshot(row, { userId, role }));
}

/** Uses the caller's connection/transaction; it never bootstraps or chooses a default workspace. */
export async function resolveVerifiedAgentActorContextOnConnection(
  input: AgentActorContextInput,
  database: AgentActorContextDatabase,
  options: { lock?: boolean } = {},
): Promise<VerifiedAgentActorContext> {
  // Capture identity before the first await; caller-owned objects are not authority.
  const userId = suppliedId(input.userId);
  if (!userId) deny();
  const requestedOrg = suppliedId(input.organizationId);
  const requestedWorkspace = suppliedId(input.workspaceId);
  const requestedProject = suppliedId(input.projectId);
  const lock = options.lock === true;
  const suffix = lock ? ' FOR SHARE' : '';
  // Both reused read helpers use only get/all. No connection borrowing or transaction
  // operation is exposed by this service's deliberately narrower interface.
  const connection = database as SqlConnection;
  const current = await readActorMembershipAuthorityOnConnection(database, userId, lock);
  const result = actorMembershipContext(userId, requestedOrg, current);
  const { organizationId, organizationRole: role } = result;

  if (requestedWorkspace) {
    const row = await database.get(
      `SELECT id, organization_id, type, project_id FROM canvas_workspaces WHERE id = $1 AND status = 'active'${suffix}`,
      [requestedWorkspace],
    ) as Row | undefined;
    const projectId = actorWorkspaceProject(row, organizationId, role, requestedProject);
    if (lock) await database.get(
      'SELECT user_id FROM canvas_workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
      [requestedWorkspace, userId],
    );
    if (projectId) {
      const project = await database.get(
        `SELECT id FROM canvas_projects WHERE id = $1 AND organization_id = $2 AND status = 'active'${suffix}`,
        [projectId, organizationId],
      );
      if (!project) deny();
      if (lock) await database.get(
        'SELECT user_id FROM canvas_project_members WHERE project_id = $1 AND user_id = $2 FOR SHARE',
        [projectId, userId],
      );
    }
    // Personal access follows the actual user's global workspace role and exact
    // ownership. An external organization role does not remove their own private
    // workspace; shared scopes still use the current organization role.
    let workspaceRole = role;
    if (row!.type === 'personal') {
      const currentUser = await database.get('SELECT role FROM "user" WHERE id = $1', [userId]) as Row | undefined;
      if (!currentUser) deny();
      workspaceRole = normalizeWorkspaceRole(typeof currentUser.role === 'string' ? currentUser.role : null);
    }
    const workspace = await readPostgresWorkspaceForActorInSingleSnapshotOnConnection(connection, { userId, role: workspaceRole! }, requestedWorkspace);
    return actorWorkspaceContext(result, workspace);
  }

  if (requestedProject) {
    if (!organizationId || !role) deny();
    const project = await database.get(
      `SELECT id FROM canvas_projects WHERE id = $1 AND organization_id = $2 AND status = 'active'${suffix}`,
      [requestedProject, organizationId],
    );
    if (!project) deny();
    const projectMember = await database.get(
      `SELECT role, status, can_read, can_write, can_manage FROM canvas_project_members WHERE organization_id = $1 AND project_id = $2 AND user_id = $3${suffix}`,
      [organizationId, requestedProject, userId],
    ) as Row | undefined;
    const admin = role === 'owner' || role === 'admin';
    // Match the existing project-workspace entry condition, including explicit
    // read membership for a non-admin; writing alone does not grant entry.
    if (!admin && !(projectMember?.status === 'active' && enabled(projectMember.can_read))) deny();
    const activeMember = projectMember?.status === 'active';
    result.workspacePermissions = resolveWorkspacePermissions({ role, workspaceType: 'project',
      canReadProjectWorkspace: activeMember && enabled(projectMember.can_read),
      canWriteProjectWorkspace: activeMember && enabled(projectMember.can_write),
      canManageProjectWorkspace: activeMember && enabled(projectMember.can_manage),
    });
    if (!result.workspacePermissions.canRead) deny();
    result.context = { organizationId, projectId: requestedProject };
  }
  return result;
}
