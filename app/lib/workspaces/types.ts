import 'server-only';

import type { WorkspaceColor } from './colors';
import type { WorkspaceIcon } from './icons';

export type WorkspaceType = 'personal' | 'organization' | 'team' | 'project';

export type WorkspaceStatus = 'active' | 'archived' | 'disabled' | 'recovery_locked';

export type WorkspaceUserRole = 'owner' | 'admin' | 'member' | 'external';

export interface WorkspaceActor {
  userId: string;
  email?: string | null;
  role: WorkspaceUserRole;
}

export interface WorkspacePermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canCreatePublicLinks: boolean;
  canManageWorkspace: boolean;
  canRunAgent: boolean;
}

export interface WorkspaceContext {
  workspaceId: string;
  workspaceType: WorkspaceType;
  rootPath: string;
  rootRelativePath?: string;
  displayName?: string;
  description?: string;
  icon?: WorkspaceIcon;
  color?: WorkspaceColor;
  status?: WorkspaceStatus;
  isDefault?: boolean;
  actor?: WorkspaceActor;
  organizationId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  ownerUserId?: string | null;
  permissions: WorkspacePermissions;
  legacy: boolean;
  brandContext?: string;
}

export interface WorkspacePathResolution {
  workspace: WorkspaceContext;
  relativePath: string;
  absolutePath: string;
}
