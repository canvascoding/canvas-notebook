export type ClientWorkspaceType = 'personal' | 'team' | 'project';

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
  organizationId?: string | null;
  ownerUserId?: string | null;
  rootRelativePath?: string;
  status: ClientWorkspaceStatus;
  permissions: ClientWorkspacePermissions;
  legacy?: boolean;
}

export interface ClientWorkspaceResponse {
  success: boolean;
  organizationId?: string | null;
  teamFeaturesEnabled?: boolean;
  databaseProvider?: string | null;
  activeWorkspaceId?: string | null;
  defaultWorkspace?: ClientWorkspaceSummary | null;
  workspaces?: ClientWorkspaceSummary[];
  warnings?: string[];
  error?: string;
}
