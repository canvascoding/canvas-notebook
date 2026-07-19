import 'server-only';

import type { MobileCompatibility } from './compatibility';
import type { WorkspaceListing } from '@/app/lib/workspaces/listing-action';
import type { WorkspaceContext, WorkspacePermissions, WorkspaceUserRole } from '@/app/lib/workspaces/types';

export type MobileWorkspaceAccess = 'manage' | 'edit' | 'read';

export type MobileWorkspaceSummary = {
  id: string;
  type: WorkspaceContext['workspaceType'];
  name: string;
  description: string;
  icon: string | null;
  status: NonNullable<WorkspaceContext['status']>;
  isDefault: boolean;
  access: MobileWorkspaceAccess;
  permissions: WorkspacePermissions;
};

export type MobileBootstrap = {
  product: 'canvas-notebook';
  mobileApi: {
    version: 'v1';
    capabilities: string[];
  };
  instance: MobileCompatibility['instance'];
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: WorkspaceUserRole;
  };
  workspace: {
    activeWorkspaceId: string | null;
    defaultWorkspaceId: string | null;
    teamFeaturesEnabled: boolean;
    projectFeaturesEnabled: boolean;
    canCreateSharedWorkspaces: boolean;
    items: MobileWorkspaceSummary[];
  };
};

function workspaceAccess(workspace: WorkspaceContext): MobileWorkspaceAccess {
  if (workspace.permissions.canManageWorkspace) return 'manage';
  if (workspace.permissions.canWrite) return 'edit';
  return 'read';
}

function serializeMobileWorkspace(workspace: WorkspaceContext): MobileWorkspaceSummary {
  return {
    id: workspace.workspaceId,
    type: workspace.workspaceType,
    name: workspace.displayName || workspace.workspaceType,
    description: workspace.description || '',
    icon: workspace.icon || null,
    status: workspace.status || 'active',
    isDefault: Boolean(workspace.isDefault),
    access: workspaceAccess(workspace),
    permissions: workspace.permissions,
  };
}

function normalizeRole(value: string | null | undefined): WorkspaceUserRole {
  if (value === 'owner' || value === 'admin' || value === 'external') return value;
  return 'member';
}

export function createMobileBootstrap(input: {
  compatibility: MobileCompatibility;
  user: {
    id: string;
    name?: string | null;
    email: string;
    image?: string | null;
    role?: string | null;
  };
  listing: WorkspaceListing;
}): MobileBootstrap {
  const capabilities = ['workspace.read', 'workspace.switch'];
  if (input.listing.canCreateSharedWorkspaces) capabilities.push('workspace.create');

  return {
    product: 'canvas-notebook',
    mobileApi: {
      version: 'v1',
      capabilities,
    },
    instance: input.compatibility.instance,
    user: {
      id: input.user.id,
      name: input.user.name?.trim() || input.user.email,
      email: input.user.email,
      image: input.user.image || null,
      role: normalizeRole(input.user.role),
    },
    workspace: {
      activeWorkspaceId: input.listing.activeWorkspaceId,
      defaultWorkspaceId: input.listing.defaultWorkspace?.workspaceId || null,
      teamFeaturesEnabled: input.listing.teamFeaturesEnabled,
      projectFeaturesEnabled: input.listing.projectFeaturesEnabled,
      canCreateSharedWorkspaces: input.listing.canCreateSharedWorkspaces,
      items: input.listing.workspaces.map(serializeMobileWorkspace),
    },
  };
}
