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
  canAccessOrganizationWorkspace?: boolean;
  canWriteOrganizationWorkspace?: boolean;
  canDeleteOrganizationWorkspace?: boolean;
  canAccessTeamWorkspace?: boolean;
  canWriteTeamWorkspace?: boolean;
  canDeleteTeamWorkspace?: boolean;
  canManageTeamWorkspace?: boolean;
  canReadProjectWorkspace?: boolean;
  canWriteProjectWorkspace?: boolean;
  canManageProjectWorkspace?: boolean;
  canCreatePublicLinks?: boolean;
}): WorkspacePermissions {
  const {
    role,
    workspaceType,
    ownsPersonalWorkspace = false,
    canAccessOrganizationWorkspace = false,
    canWriteOrganizationWorkspace = false,
    canDeleteOrganizationWorkspace = false,
    canAccessTeamWorkspace = false,
    canWriteTeamWorkspace = false,
    canDeleteTeamWorkspace = false,
    canManageTeamWorkspace = false,
    canReadProjectWorkspace = false,
    canWriteProjectWorkspace = false,
    canManageProjectWorkspace = false,
    canCreatePublicLinks = true,
  } = params;

  if (role === 'external' && workspaceType !== 'project') {
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
      canManageWorkspace: canUsePersonalWorkspace,
      canRunAgent: canUsePersonalWorkspace,
    };
  }

  if (workspaceType === 'organization') {
    const canWriteOrganization = isAdminLike || canWriteOrganizationWorkspace;
    const canDeleteOrganization = isAdminLike || canDeleteOrganizationWorkspace;
    const canReadOrganization = isAdminLike || canAccessOrganizationWorkspace || canWriteOrganization || canDeleteOrganization;

    return {
      canRead: canReadOrganization,
      canWrite: canWriteOrganization,
      canDelete: canDeleteOrganization,
      canCreatePublicLinks: canReadOrganization && canCreatePublicLinks,
      canManageWorkspace: isAdminLike,
      canRunAgent: canReadOrganization,
    };
  }

  if (workspaceType === 'project') {
    const canReadProject = isAdminLike || canReadProjectWorkspace || canWriteProjectWorkspace || canManageProjectWorkspace;
    const canWriteProject = isAdminLike || canWriteProjectWorkspace || canManageProjectWorkspace;
    const canManageProject = isAdminLike || canManageProjectWorkspace;

    return {
      canRead: canReadProject,
      canWrite: canWriteProject,
      canDelete: canWriteProject,
      canCreatePublicLinks: canReadProject && canCreatePublicLinks && (role !== 'external' || canManageProject),
      canManageWorkspace: canManageProject,
      canRunAgent: canReadProject,
    };
  }

  const canWriteTeam = isAdminLike || canWriteTeamWorkspace;
  const canDeleteTeam = isAdminLike || canDeleteTeamWorkspace;
  const canReadTeam = isAdminLike || canAccessTeamWorkspace || canWriteTeam || canDeleteTeam;
  const canManageTeam = isAdminLike || canManageTeamWorkspace;

  return {
    canRead: canReadTeam,
    canWrite: canWriteTeam,
    canDelete: canDeleteTeam,
    canCreatePublicLinks: canReadTeam && canCreatePublicLinks,
    canManageWorkspace: canManageTeam,
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
