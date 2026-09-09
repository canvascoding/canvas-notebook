import 'server-only';

import {
  LicenseEntitlementError,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import { areProjectFeaturesEnabled } from '@/app/lib/projects/features';
import { getPostgresWorkspaceState } from './postgres-runtime';
import type { WorkspaceActor, WorkspaceContext } from './types';

export type WorkspaceListing = {
  organizationId: string | null;
  teamFeaturesEnabled: boolean;
  projectFeaturesEnabled: boolean;
  canCreateSharedWorkspaces: boolean;
  databaseProvider: string | null;
  activeWorkspaceId: string | null;
  defaultWorkspace: WorkspaceContext | null;
  workspaces: WorkspaceContext[];
  warnings: string[];
};

export class WorkspaceListingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'WorkspaceListingError';
  }
}

export function restrictWorkspaceListingToCore(
  listing: WorkspaceListing,
  actor: WorkspaceActor,
): WorkspaceListing {
  const workspaces = listing.workspaces.filter((workspace) => (
    workspace.workspaceType === 'personal'
    && (!workspace.ownerUserId || workspace.ownerUserId === actor.userId)
  ));
  const defaultWorkspace = workspaces.find((workspace) => workspace.isDefault) || workspaces[0] || null;
  if (!defaultWorkspace) {
    throw new WorkspaceListingError(
      'Personal workspace is unavailable',
      'PERSONAL_WORKSPACE_UNAVAILABLE',
      409,
    );
  }

  return {
    ...listing,
    teamFeaturesEnabled: false,
    projectFeaturesEnabled: false,
    canCreateSharedWorkspaces: false,
    activeWorkspaceId: defaultWorkspace.workspaceId,
    defaultWorkspace,
    workspaces,
    warnings: [
      ...listing.warnings,
      'Team features are unavailable until a valid Team license is activated.',
    ],
  };
}

async function enforceTeamLicenseBoundary(
  listing: WorkspaceListing,
  actor: WorkspaceActor,
): Promise<WorkspaceListing> {
  if (!listing.teamFeaturesEnabled) return listing;
  try {
    await requireTeamRuntimeLicense();
    return listing;
  } catch (error) {
    if (error instanceof LicenseEntitlementError) {
      return restrictWorkspaceListingToCore(listing, actor);
    }
    throw error;
  }
}

export async function loadWorkspaceListingForActor(actor: WorkspaceActor): Promise<WorkspaceListing> {
  const state = await getPostgresWorkspaceState(actor);
  return enforceTeamLicenseBoundary({
    organizationId: state.status.organizationId,
    teamFeaturesEnabled: state.status.teamFeaturesEnabled,
    projectFeaturesEnabled: areProjectFeaturesEnabled(),
    canCreateSharedWorkspaces: actor.role === 'owner' || actor.role === 'admin',
    databaseProvider: state.status.databaseProvider,
    activeWorkspaceId: state.defaultWorkspace?.workspaceId || null,
    defaultWorkspace: state.defaultWorkspace,
    workspaces: state.workspaces,
    warnings: state.status.warnings,
  }, actor);
}
