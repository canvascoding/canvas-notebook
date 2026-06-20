import 'server-only';

import type { WorkspacePermissions, WorkspaceType, WorkspaceUserRole } from './types';

const NO_WORKSPACE_PERMISSIONS: WorkspacePermissions = {
  canRead: false,
  canWrite: false,
  canDelete: false,
  canCreatePublicLinks: false,
  canManageWorkspace: false,
  canRunAgent: false,
};

export function normalizeWorkspaceRole(role: string | null | undefined): WorkspaceUserRole {
  if (role === 'owner' || role === 'admin' || role === 'external') return role;
  return 'member';
}

export function resolveWorkspacePermissions(params: {
  role: WorkspaceUserRole;
  workspaceType: WorkspaceType;
  ownsPersonalWorkspace?: boolean;
  canAccessTeamWorkspace?: boolean;
  canWriteTeamWorkspace?: boolean;
  canCreatePublicLinks?: boolean;
}): WorkspacePermissions {
  const {
    role,
    workspaceType,
    ownsPersonalWorkspace = false,
    canAccessTeamWorkspace = false,
    canWriteTeamWorkspace = false,
    canCreatePublicLinks = true,
  } = params;

  if (role === 'external') {
    return NO_WORKSPACE_PERMISSIONS;
  }

  const isAdminLike = role === 'owner' || role === 'admin';

  if (workspaceType === 'personal') {
    const canUsePersonalWorkspace = ownsPersonalWorkspace;
    return {
      canRead: canUsePersonalWorkspace,
      canWrite: canUsePersonalWorkspace,
      canDelete: canUsePersonalWorkspace,
      canCreatePublicLinks: canUsePersonalWorkspace && canCreatePublicLinks,
      canManageWorkspace: isAdminLike,
      canRunAgent: canUsePersonalWorkspace,
    };
  }

  const canReadTeam = isAdminLike || canAccessTeamWorkspace || canWriteTeamWorkspace;
  const canWriteTeam = isAdminLike || canWriteTeamWorkspace;

  return {
    canRead: canReadTeam,
    canWrite: canWriteTeam,
    canDelete: canWriteTeam,
    canCreatePublicLinks: canReadTeam && canCreatePublicLinks,
    canManageWorkspace: isAdminLike,
    canRunAgent: canReadTeam,
  };
}

export function assertWorkspacePermission(
  permissions: WorkspacePermissions,
  permission: keyof WorkspacePermissions,
  message = 'Workspace permission denied'
): void {
  if (!permissions[permission]) {
    const error = new Error(message) as Error & { code: string; status: number };
    error.code = 'WORKSPACE_PERMISSION_DENIED';
    error.status = 403;
    throw error;
  }
}
