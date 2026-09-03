import type { WorkspaceColor } from '@/app/lib/workspaces/colors';
import type { WorkspaceIcon } from '@/app/lib/workspaces/icons';

export type ClientWorkspaceType = 'personal' | 'organization' | 'team' | 'project';

export type ClientWorkspaceStatus = 'active' | 'archived' | 'disabled' | 'recovery_locked';

export interface ClientWorkspacePermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canCreatePublicLinks: boolean;
  canManageWorkspace: boolean;
  canRunAgent: boolean;
}

export interface ClientWorkspaceSummary {
  id: string;
  type: ClientWorkspaceType;
  name: string;
  description?: string;
  organizationId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  ownerUserId?: string | null;
  rootRelativePath?: string;
  icon?: WorkspaceIcon;
  color: WorkspaceColor;
  status: ClientWorkspaceStatus;
  isDefault?: boolean;
  permissions: ClientWorkspacePermissions;
  legacy?: boolean;
}

export interface ClientWorkspaceResponse {
  success: boolean;
  organizationId?: string | null;
  teamFeaturesEnabled?: boolean;
  projectFeaturesEnabled?: boolean;
  canCreateSharedWorkspaces?: boolean;
  databaseProvider?: string | null;
  activeWorkspaceId?: string | null;
  defaultWorkspace?: ClientWorkspaceSummary | null;
  workspaces?: ClientWorkspaceSummary[];
  warnings?: string[];
  error?: string;
  code?: string;
  feature?: string;
}
