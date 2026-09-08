import 'server-only';

import { requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import { areProjectFeaturesEnabled } from '@/app/lib/projects/features';
import { serializeMobileWorkspace, type MobileWorkspaceSummary } from '@/app/lib/mobile/bootstrap';
import {
  createPostgresWorkspaceForActor,
  getPostgresWorkspaceState,
  listPostgresWorkspaceMemberCandidatesForActor,
  listPostgresWorkspaceMembersForActor,
  removePostgresWorkspaceMemberForActor,
  updatePostgresWorkspaceForActor,
  upsertPostgresWorkspaceMemberForActor,
} from '@/app/lib/workspaces/postgres-runtime';
import { WorkspaceOperationError, type WorkspaceMemberCandidate, type WorkspaceMemberRecord } from '@/app/lib/workspaces/service';
import type { WorkspaceActor, WorkspaceType } from '@/app/lib/workspaces/types';

export type MobileWorkspaceMember = {
  userId: string;
  name: string | null;
  email: string | null;
  role: 'owner' | 'admin' | 'member' | 'external';
  status: 'active' | 'archived' | 'disabled' | 'recovery_locked';
  access: 'manage' | 'edit' | 'read';
};

export type MobileWorkspaceMemberCandidate = {
  userId: string;
  name: string | null;
  email: string | null;
  role: 'owner' | 'admin' | 'member' | 'external';
  status: 'active' | 'archived' | 'disabled' | 'recovery_locked';
};

type MobileWorkspaceAccess = 'read' | 'edit' | 'manage';

type MobileInitialMember = {
  userId: string;
  access: MobileWorkspaceAccess;
};

type MobileWorkspaceMutationContext = {
  actor: WorkspaceActor;
};

function normalizeCreateType(value: unknown): WorkspaceType {
  if (value === 'personal' || value === 'team' || value === 'project') return value;
  throw new WorkspaceOperationError(
    'WORKSPACE_TYPE_INVALID',
    'Mobile can create personal, team, or project workspaces.',
    400,
  );
}

function normalizeInitialMembers(value: unknown, type: WorkspaceType): MobileInitialMember[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new WorkspaceOperationError('WORKSPACE_MEMBERS_INVALID', 'Workspace members are invalid.', 400);
  }
  if (type !== 'team' && value.length > 0) {
    throw new WorkspaceOperationError('WORKSPACE_MEMBERS_UNSUPPORTED', 'Only team workspaces accept initial members.', 400);
  }
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new WorkspaceOperationError('WORKSPACE_MEMBERS_INVALID', 'Workspace members are invalid.', 400);
    }
    const record = item as Record<string, unknown>;
    const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
    const access = record.access;
    if (!userId || userId.length > 160 || ids.has(userId) || (access !== 'read' && access !== 'edit' && access !== 'manage')) {
      throw new WorkspaceOperationError('WORKSPACE_MEMBERS_INVALID', 'Workspace members are invalid.', 400);
    }
    ids.add(userId);
    return { userId, access };
  });
}

function accessInput(input: { userId: string; access: MobileWorkspaceAccess }) {
  return {
    userId: input.userId,
    role: input.access === 'manage' ? 'admin' : 'member',
    canRead: true,
    canWrite: input.access === 'edit' || input.access === 'manage',
    canManage: input.access === 'manage',
  };
}

async function requireLicenseWhenEnabled(status: { teamFeaturesEnabled: boolean }): Promise<void> {
  if (status.teamFeaturesEnabled) await requireTeamRuntimeLicense();
}

export function serializeMobileWorkspaceMember(member: WorkspaceMemberRecord): MobileWorkspaceMember {
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
    status: member.status,
    access: member.canManage ? 'manage' : member.canWrite ? 'edit' : 'read',
  };
}

export function serializeMobileWorkspaceMemberCandidate(
  candidate: WorkspaceMemberCandidate,
): MobileWorkspaceMemberCandidate {
  return {
    userId: candidate.userId,
    name: candidate.name,
    email: candidate.email,
    role: candidate.role,
    status: candidate.status,
  };
}

export async function createMobileWorkspace(
  input: MobileWorkspaceMutationContext & {
    type: unknown;
    name: unknown;
    description: unknown;
    icon?: unknown;
    color?: unknown;
    projectId?: unknown;
    initialMembers?: unknown;
  },
): Promise<MobileWorkspaceSummary> {
  const type = normalizeCreateType(input.type);
  const initialMembers = normalizeInitialMembers(input.initialMembers, type);
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() || null : null;
  const state = await getPostgresWorkspaceState(input.actor);
  await requireLicenseWhenEnabled(state.status);
  const workspace = await createPostgresWorkspaceForActor(input.actor, {
      type,
      name: input.name,
      description: input.description,
      icon: input.icon,
      color: input.color,
      projectFeaturesEnabled: areProjectFeaturesEnabled(),
      projectId,
      initialMembers: initialMembers.map(accessInput),
  });
  return serializeMobileWorkspace(workspace);
}

export async function updateMobileWorkspace(
  input: MobileWorkspaceMutationContext & {
    workspaceId: string;
    name: unknown;
    description: unknown;
    color?: unknown;
  },
): Promise<MobileWorkspaceSummary> {
  const state = await getPostgresWorkspaceState(input.actor);
  await requireLicenseWhenEnabled(state.status);
  const workspace = await updatePostgresWorkspaceForActor(input.actor, input.workspaceId, {
      name: input.name,
      description: input.description,
      color: input.color,
  });
  return serializeMobileWorkspace(workspace);
}

export async function listMobileWorkspaceMembers(input: MobileWorkspaceMutationContext & {
  workspaceId: string;
}): Promise<{ workspace: MobileWorkspaceSummary; members: MobileWorkspaceMember[]; candidates: MobileWorkspaceMemberCandidate[] }> {
  const state = await getPostgresWorkspaceState(input.actor);
  await requireLicenseWhenEnabled(state.status);
  const result = await listPostgresWorkspaceMembersForActor(input.actor, input.workspaceId, {
      requireManage: false,
      includeCandidates: true,
    });
    return {
      workspace: serializeMobileWorkspace(result.workspace),
      members: result.members.map(serializeMobileWorkspaceMember),
      candidates: result.workspace.permissions.canManageWorkspace
        ? result.candidates.map(serializeMobileWorkspaceMemberCandidate)
        : [],
  };
}

export async function listMobileWorkspaceMemberCandidates(
  input: MobileWorkspaceMutationContext,
): Promise<MobileWorkspaceMemberCandidate[]> {
  if (input.actor.role !== 'owner' && input.actor.role !== 'admin') {
    throw new WorkspaceOperationError('WORKSPACE_PERMISSION_DENIED', 'Only admins can create team workspaces.', 403);
  }
  const candidates = await listPostgresWorkspaceMemberCandidatesForActor(input.actor);
  return candidates.map(serializeMobileWorkspaceMemberCandidate);
}

export async function updateMobileWorkspaceMember(input: MobileWorkspaceMutationContext & {
  workspaceId: string;
  userId: unknown;
  access: unknown;
}): Promise<MobileWorkspaceMember> {
  const members = normalizeInitialMembers([{ userId: input.userId, access: input.access }], 'team');
  const memberInput = accessInput(members[0]!);
  const state = await getPostgresWorkspaceState(input.actor);
  await requireLicenseWhenEnabled(state.status);
  return serializeMobileWorkspaceMember(
    await upsertPostgresWorkspaceMemberForActor(input.actor, input.workspaceId, memberInput),
  );
}

export async function removeMobileWorkspaceMember(input: MobileWorkspaceMutationContext & {
  workspaceId: string;
  userId: string;
}): Promise<void> {
  const state = await getPostgresWorkspaceState(input.actor);
  await requireLicenseWhenEnabled(state.status);
  await removePostgresWorkspaceMemberForActor(input.actor, input.workspaceId, input.userId);
}
