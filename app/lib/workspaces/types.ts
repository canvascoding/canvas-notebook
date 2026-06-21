import 'server-only';

export type WorkspaceType = 'personal' | 'team' | 'project';

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
  status?: WorkspaceStatus;
  actor?: WorkspaceActor;
  organizationId?: string | null;
  ownerUserId?: string | null;
  permissions: WorkspacePermissions;
  legacy: boolean;
}

export interface WorkspacePathResolution {
  workspace: WorkspaceContext;
  relativePath: string;
  absolutePath: string;
}
