export const LOCAL_ORGANIZATION_ID_PREFIX = 'org_';

export type OrganizationRole = 'owner' | 'admin' | 'member' | 'external';
export type OrganizationUserStatus = 'active' | 'disabled' | 'archived' | 'recovery_locked';

export type OrganizationPermissionSnapshot = {
  role: OrganizationRole;
  status: OrganizationUserStatus;
  canWriteTeamWorkspace: boolean;
  canCreatePublicLinks: boolean;
  canCreateTeamAutomations: boolean;
  canSharePluginsAndSkills: boolean;
  canExport: boolean;
  canDeleteTeamFiles: boolean;
  canDeleteStudioAssets: boolean;
  canManageBackups: boolean;
  canManageOrganizationMemory: boolean;
  canMigrateDatabase: boolean;
  canEnableKnowledge: boolean;
  canRecoverWorkspaces: boolean;
};

export type OrganizationBootstrapStatus = {
  configured: boolean;
  organizationId: string | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
  deploymentMode: string;
  teamFeaturesEnabled: boolean;
  databaseProvider: import('@/app/lib/db/provider').DatabaseProvider;
  permission: OrganizationPermissionSnapshot | null;
  paths: {
    personalWorkspace: string | null;
    userSettings: string | null;
    userSecrets: string | null;
    organizationRoot: string | null;
    teamWorkspace: string | null;
    systemBackups: string;
  };
  warnings: string[];
};

export type OrganizationPermissionState = {
  configured: boolean;
  organizationId: string | null;
  ownerUserId: string | null;
  teamFeaturesEnabled: boolean;
  databaseProvider: import('@/app/lib/db/provider').DatabaseProvider;
  permission: OrganizationPermissionSnapshot | null;
};

export class OrganizationBootstrapError extends Error {
  constructor(
    public readonly code: 'NO_USERS' | 'ORGANIZATION_ID_CONFLICT' | 'DATABASE_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationBootstrapError';
  }
}
