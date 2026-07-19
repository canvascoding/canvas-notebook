import 'server-only';

import { getDatabaseProvider } from '@/app/lib/db/provider';
import { requireTeamRuntimeLicense } from '@/app/lib/license/entitlements';
import {
  ensureOrganizationBootstrapForUser,
  openOrganizationBootstrapDatabase,
} from '@/app/lib/organization/bootstrap';
import { areProjectFeaturesEnabled } from '@/app/lib/projects/features';
import { getPostgresWorkspaceState } from './postgres-runtime';
import { listWorkspaceContextsForUser, resolveDefaultWorkspaceContext } from './service';
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

async function assertTeamRuntimeLicense(teamFeaturesEnabled: boolean): Promise<void> {
  if (teamFeaturesEnabled) await requireTeamRuntimeLicense();
}

export async function loadWorkspaceListingForActor(actor: WorkspaceActor): Promise<WorkspaceListing> {
  if (getDatabaseProvider() === 'postgres') {
    const state = await getPostgresWorkspaceState(actor);
    await assertTeamRuntimeLicense(state.status.teamFeaturesEnabled);
    return {
      organizationId: state.status.organizationId,
      teamFeaturesEnabled: state.status.teamFeaturesEnabled,
      projectFeaturesEnabled: areProjectFeaturesEnabled(),
      canCreateSharedWorkspaces: actor.role === 'owner' || actor.role === 'admin',
      databaseProvider: state.status.databaseProvider,
      activeWorkspaceId: state.defaultWorkspace?.workspaceId || null,
      defaultWorkspace: state.defaultWorkspace,
      workspaces: state.workspaces,
      warnings: state.status.warnings,
    };
  }

  const sqlite = openOrganizationBootstrapDatabase();
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const status = ensureOrganizationBootstrapForUser(sqlite, actor.userId);
    await assertTeamRuntimeLicense(status.teamFeaturesEnabled);
    if (!status.organizationId) {
      throw new WorkspaceListingError(
        'Organization is not configured',
        'ORGANIZATION_NOT_CONFIGURED',
        409,
      );
    }

    const defaultWorkspace = resolveDefaultWorkspaceContext(sqlite, {
      actor,
      organizationId: status.organizationId,
    });
    const workspaces = listWorkspaceContextsForUser(sqlite, {
      actor,
      organizationId: status.organizationId,
    });
    sqlite.exec('COMMIT');

    return {
      organizationId: status.organizationId,
      teamFeaturesEnabled: status.teamFeaturesEnabled,
      projectFeaturesEnabled: areProjectFeaturesEnabled(),
      canCreateSharedWorkspaces: actor.role === 'owner' || actor.role === 'admin',
      databaseProvider: status.databaseProvider,
      activeWorkspaceId: defaultWorkspace?.workspaceId || null,
      defaultWorkspace,
      workspaces,
      warnings: status.warnings,
    };
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.close();
  }
}
