import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
  requireTeamRuntimeLicense,
} from '@/app/lib/license/entitlements';
import {
  ensureOrganizationBootstrapForUser,
  openOrganizationBootstrapDatabase,
} from '@/app/lib/organization/bootstrap';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { getPostgresWorkspaceState } from '@/app/lib/workspaces/postgres-runtime';
import {
  listWorkspaceContextsForUser,
  resolveDefaultWorkspaceContext,
} from '@/app/lib/workspaces/service';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

function serializeWorkspace(workspace: WorkspaceContext) {
  return {
    id: workspace.workspaceId,
    type: workspace.workspaceType,
    name: workspace.displayName || workspace.workspaceType,
    organizationId: workspace.organizationId,
    ownerUserId: workspace.ownerUserId,
    rootRelativePath: workspace.rootRelativePath,
    status: workspace.status || 'active',
    permissions: workspace.permissions,
    legacy: workspace.legacy,
  };
}

async function requireTeamRuntimeIfEnabled(status: { teamFeaturesEnabled: boolean; databaseProvider: string }) {
  if (!status.teamFeaturesEnabled && status.databaseProvider !== 'postgres') return null;
  try {
    await requireTeamRuntimeLicense();
    return null;
  } catch (error) {
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(licenseEntitlementErrorPayload(error), { status: error.statusCode });
    }
    throw error;
  }
}

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const actor = resolveWorkspaceActor({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  });

  if (getDatabaseProvider() === 'postgres') {
    try {
      const state = await getPostgresWorkspaceState(actor);
      const licenseResponse = await requireTeamRuntimeIfEnabled(state.status);
      if (licenseResponse) return licenseResponse;
      return NextResponse.json({
        success: true,
        organizationId: state.status.organizationId,
        teamFeaturesEnabled: state.status.teamFeaturesEnabled,
        databaseProvider: state.status.databaseProvider,
        activeWorkspaceId: state.defaultWorkspace?.workspaceId || null,
        defaultWorkspace: state.defaultWorkspace ? serializeWorkspace(state.defaultWorkspace) : null,
        workspaces: state.workspaces.map(serializeWorkspace),
        warnings: state.status.warnings,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not resolve workspaces';
      return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
  }

  const sqlite = openOrganizationBootstrapDatabase();
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const status = ensureOrganizationBootstrapForUser(sqlite, session.user.id);
    const licenseResponse = await requireTeamRuntimeIfEnabled(status);
    if (licenseResponse) {
      sqlite.exec('ROLLBACK');
      return licenseResponse;
    }
    if (!status.organizationId) {
      sqlite.exec('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Organization is not configured' }, { status: 409 });
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

    return NextResponse.json({
      success: true,
      organizationId: status.organizationId,
      teamFeaturesEnabled: status.teamFeaturesEnabled,
      databaseProvider: status.databaseProvider,
      activeWorkspaceId: defaultWorkspace?.workspaceId || null,
      defaultWorkspace: defaultWorkspace ? serializeWorkspace(defaultWorkspace) : null,
      workspaces: workspaces.map(serializeWorkspace),
      warnings: status.warnings,
    });
  } catch (error) {
    if (sqlite.inTransaction) {
      sqlite.exec('ROLLBACK');
    }
    const message = error instanceof Error ? error.message : 'Could not resolve workspaces';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    sqlite.close();
  }
}
