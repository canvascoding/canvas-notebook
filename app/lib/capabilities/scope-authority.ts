import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import type { OrganizationPolicyTargetCatalog } from '@/app/lib/organization/policy-targets';
import { CapabilityResourceError, type CapabilityResourceActor, type CapabilityResourceOwnerScope, type CapabilityResourceGrantInput } from './resources/contracts';

type Row = Record<string, unknown>;
function error(code: string, message: string, status = 400): never { throw new CapabilityResourceError(code, message, status); }
function flag(value: unknown): boolean { return value === true || value === 1 || value === '1'; }
function optionalString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function orgOf(owner: CapabilityResourceOwnerScope): string | null { return owner.type === 'system' ? null : owner.organizationId; }

export type Membership = { role: string; status: string; canShare: boolean };

export type Workspace = { id: string; organizationId: string; type: string; ownerUserId: string | null; projectId: string | null;
  status: string; canRead: boolean; canManage: boolean };

export type Authority = { userId: string; valid: boolean; memberships: Map<string, Membership>; workspaces: Map<string, Workspace>;
  projects: Set<string>; requestedWorkspace: Workspace | null; contextValid: boolean };

export async function authority(database: SqlConnection, actor: CapabilityResourceActor, lock = false): Promise<Authority> {
  // Organization permission refreshes write organization settings before users.
  // Take the same order so a fresh-rights transaction cannot deadlock a refresh.
  const configured = await database.get(`SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1${lock ? ' FOR SHARE' : ''}`);
  const user = await database.get(`SELECT id, banned FROM "user" WHERE id = $1${lock ? ' FOR SHARE' : ''}`, [actor.userId]) as Row | undefined;
  const memberships = await database.all(`SELECT organization_id, role, status, can_share_plugins_and_skills FROM organization_user_permissions WHERE user_id = $1${lock ? ' ORDER BY organization_id FOR SHARE' : ''}`, [actor.userId]) as Row[];
  const result: Authority = { userId: actor.userId, valid: Boolean(user && !flag(user.banned)), memberships: new Map(memberships.map((row) => [String(row.organization_id), {
    role: String(row.role), status: String(row.status), canShare: flag(row.can_share_plugins_and_skills) }])), workspaces: new Map(), projects: new Set(), requestedWorkspace: null, contextValid: true };
  if (!result.valid) return result;
  if (configured && !memberships.some((membership) => membership.status === 'active')) {
    result.valid = false;
    return result;
  }
  const rows = await database.all(`SELECT w.id, w.organization_id, w.type, w.owner_user_id, w.project_id, w.status, p.status AS project_status,
      wm.status AS member_status, wm.role AS member_role, wm.can_read, wm.can_write, wm.can_manage,
      pm.status AS project_member_status, pm.role AS project_member_role, pm.can_read AS project_can_read, pm.can_write AS project_can_write, pm.can_manage AS project_can_manage
    FROM canvas_workspaces w
    LEFT JOIN canvas_workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
    LEFT JOIN canvas_project_members pm ON pm.project_id = w.project_id AND pm.user_id = $1
    LEFT JOIN canvas_projects p ON p.id = w.project_id AND p.organization_id = w.organization_id
    WHERE w.status = 'active' AND (w.owner_user_id = $1 OR wm.user_id = $1 OR pm.user_id = $1 OR w.organization_id IN
      (SELECT organization_id FROM organization_user_permissions WHERE user_id = $1 AND status = 'active'))`, [actor.userId]) as Row[];
  for (const row of rows) {
    const membership = result.memberships.get(String(row.organization_id));
    const active = membership?.status === 'active';
    const admin = active && ['owner', 'admin'].includes(membership.role);
    const teamMember = active && membership.role !== 'external' && row.member_status === 'active' && row.member_role !== 'external';
    const projectMember = (!membership || active) && row.project_status === 'active' && row.project_member_status === 'active';
    const canRead = row.type === 'personal' ? row.owner_user_id === actor.userId && (!membership || active)
      : row.type === 'organization' ? active && membership.role !== 'external'
        : row.type === 'team' ? admin || teamMember && (flag(row.can_read) || flag(row.can_write) || flag(row.can_manage))
          : row.type === 'project' ? row.project_status === 'active' && (admin || projectMember && (flag(row.project_can_read) || flag(row.project_can_write) || flag(row.project_can_manage))) : false;
    const workspace: Workspace = { id: String(row.id), organizationId: String(row.organization_id), type: String(row.type),
      ownerUserId: optionalString(row.owner_user_id), projectId: optionalString(row.project_id), status: String(row.status), canRead,
      canManage: row.type === 'personal' ? canRead : row.type === 'team' ? teamMember && flag(row.can_manage)
        : row.type === 'project' ? projectMember && flag(row.project_can_manage) : admin && membership.canShare };
    result.workspaces.set(workspace.id, workspace);
    if (canRead && workspace.projectId) result.projects.add(workspace.projectId);
  }
  if (actor.workspaceId) {
    result.requestedWorkspace = result.workspaces.get(actor.workspaceId) ?? null;
    result.contextValid = Boolean(result.requestedWorkspace?.canRead);
  }
  return result;
}

export async function validateTarget(database: SqlConnection, organizationId: string | null, grant: Pick<CapabilityResourceGrantInput, 'targetType' | 'targetId'>): Promise<void> {
  if (!organizationId) error('RESOURCE_TARGET_INVALID', 'Sharing requires an active owning organization.');
  if (grant.targetType === 'organization') {
    if (grant.targetId !== organizationId) error('RESOURCE_TARGET_INVALID', 'Grant organization does not match resource ownership.');
    return;
  }
  if (grant.targetType === 'role') {
    if (!['owner', 'admin', 'member', 'external'].includes(grant.targetId)) error('RESOURCE_TARGET_INVALID', 'Unknown organization role.');
    return;
  }
  let target: unknown;
  if (grant.targetType === 'user') {
    target = await database.get(`SELECT u.id FROM "user" u JOIN organization_user_permissions p ON p.user_id = u.id
      WHERE p.organization_id = $1 AND u.id = $2 AND p.status = 'active' AND COALESCE(u.banned, 0) = 0 FOR SHARE OF u, p`, [organizationId, grant.targetId]);
  } else if (grant.targetType === 'workspace') {
    target = await database.get(`SELECT id FROM canvas_workspaces WHERE organization_id = $1 AND id = $2 AND status = 'active' FOR SHARE`, [organizationId, grant.targetId]);
  } else {
    target = await database.get(`SELECT id FROM canvas_projects WHERE organization_id = $1 AND id = $2 AND status = 'active' FOR SHARE`, [organizationId, grant.targetId]);
  }
  if (!target) error('RESOURCE_TARGET_INVALID', 'Grant target is not active in the owning organization.');
}

export async function lockOwnership(database: SqlConnection, ownership: CapabilityResourceOwnerScope, auth: Authority): Promise<void> {
  const organizationId = orgOf(ownership);
  if (organizationId) {
    const organization = await database.get('SELECT organization_id FROM canvas_organization_settings WHERE organization_id = $1 FOR SHARE', [organizationId]);
    if (!organization || auth.memberships.get(organizationId)?.status !== 'active') error('RESOURCE_ACCESS_DENIED', 'An active owning organization membership is required.', 403);
  }
  if (ownership.type === 'user') {
    const owner = await database.get(`SELECT id FROM "user" WHERE id = $1 AND COALESCE(banned, 0) = 0 FOR SHARE`, [ownership.ownerUserId]);
    if (!owner) error('RESOURCE_ACCESS_DENIED', 'Resource owner is unavailable.', 403);
    if (organizationId) await validateTarget(database, organizationId, { targetType: 'user', targetId: ownership.ownerUserId });
  }
  if (ownership.type === 'team') {
    const team = await database.get(`SELECT id FROM canvas_workspaces WHERE id = $1 AND organization_id = $2 AND type = 'team' AND status = 'active' FOR SHARE`, [ownership.workspaceId, ownership.organizationId]);
    if (!team) error('RESOURCE_SCOPE_INVALID', 'An active team in the owning organization is required.');
  }
}

export function matchesCapabilityScopeGrant(
  auth: Authority,
  organizationId: string,
  workspaceId: string | null | undefined,
  grant: Pick<CapabilityResourceGrantInput, 'targetType' | 'targetId'>,
): boolean {
  const membership = auth.memberships.get(organizationId);
  return grant.targetType === 'organization' ? grant.targetId === organizationId
    : grant.targetType === 'role' ? grant.targetId === membership?.role
      : grant.targetType === 'user' ? grant.targetId === auth.userId
        : grant.targetType === 'workspace' ? workspaceId ? grant.targetId === auth.requestedWorkspace?.id
          : Boolean(auth.workspaces.get(grant.targetId)?.canRead)
          : workspaceId ? grant.targetId === auth.requestedWorkspace?.projectId : auth.projects.has(grant.targetId);
}

/** Locks the actual workspace/project authority used by an inherited or targeted grant. */
export async function lockCapabilityScopeWorkspaceAuthority(
  database: SqlConnection,
  auth: Authority,
  ownership: CapabilityResourceOwnerScope,
  targets: readonly Pick<CapabilityResourceGrantInput, 'targetType' | 'targetId'>[] = [],
): Promise<void> {
  const ids = new Set<string>();
  if (auth.requestedWorkspace?.canRead) ids.add(auth.requestedWorkspace.id);
  if (ownership.type === 'team') ids.add(ownership.workspaceId);
  for (const grant of targets) {
    if (grant.targetType === 'workspace' && auth.workspaces.get(grant.targetId)?.canRead) ids.add(grant.targetId);
    if (grant.targetType === 'project') {
      for (const workspace of auth.workspaces.values()) if (workspace.projectId === grant.targetId && workspace.canRead) ids.add(workspace.id);
    }
  }
  for (const id of [...ids].sort()) {
    const workspace = auth.workspaces.get(id);
    if (!workspace) continue;
    await database.get('SELECT id FROM canvas_workspaces WHERE id = $1 FOR SHARE', [workspace.id]);
    if (workspace.type === 'team') await database.get('SELECT user_id FROM canvas_workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE', [workspace.id, auth.userId]);
    if (workspace.type === 'project' && workspace.projectId) {
      await database.get('SELECT id FROM canvas_projects WHERE id=$1 FOR SHARE', [workspace.projectId]);
      await database.get('SELECT user_id FROM canvas_project_members WHERE project_id = $1 AND user_id = $2 FOR SHARE', [workspace.projectId, auth.userId]);
    }
  }
}

/** Caller must hold resource or ownership management authority; other personal workspaces stay private. */
export async function listCapabilityScopeTargetsOnConnection(database: SqlConnection, organizationId: string,
  actorUserId: string): Promise<OrganizationPolicyTargetCatalog> {
  const limit = 200;
  const users = await database.all(`SELECT u.id, u.name, u.email, p.role FROM "user" u JOIN organization_user_permissions p ON p.user_id=u.id
    WHERE p.organization_id=$1 AND p.status='active' AND COALESCE(u.banned,0)=0 ORDER BY lower(u.name),lower(u.email),u.id LIMIT $2`, [organizationId, limit]) as Row[];
  const workspaces = await database.all("SELECT id,display_name,type FROM canvas_workspaces WHERE organization_id=$1 AND status='active' AND (type!='personal' OR owner_user_id=$3) ORDER BY lower(display_name),id LIMIT $2", [organizationId, limit, actorUserId]) as Row[];
  const projects = await database.all("SELECT id,name FROM canvas_projects WHERE organization_id=$1 AND status='active' ORDER BY lower(name),id LIMIT $2", [organizationId, limit]) as Row[];
  return { users: users.map(row => ({ userId: String(row.id), name: optionalString(row.name), email: optionalString(row.email), role: String(row.role) })),
    workspaces: workspaces.map(row => ({ workspaceId: String(row.id), name: String(row.display_name), type: String(row.type) })),
    projects: projects.map(row => ({ projectId: String(row.id), name: String(row.name) })) };
}
