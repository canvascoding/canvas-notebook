import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import {
  resolveCapabilityExecutionContextForUser,
  resolveCapabilityStorageScope,
} from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import {
  deduplicateCanvasPluginInstallRecords,
  listCanvasPlugins,
} from '@/app/lib/plugins/canvas-plugin-registry';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const organizationState = await readOrganizationPermissionForUser(session.user.id);
    const scope = resolveCapabilityStorageScope({
      requestedScope: request.nextUrl.searchParams.get('scope'),
      userId: session.user.id,
      organizationState,
    });
    let plugins = await listCanvasPlugins(scope);
    if (
      scope.scopeType === 'user'
      && organizationState.organizationId
      && organizationState.permission?.status === 'active'
    ) {
      const [snapshot, organizationPlugins] = await Promise.all([
        resolveCapabilityExecutionContextForUser({
          userId: session.user.id,
          organizationId: organizationState.organizationId,
          role: organizationState.permission.role,
          requestedWorkspaceId: request.nextUrl.searchParams.get('workspaceId'),
        }).then(resolveEffectiveCapabilitySnapshot),
        listCanvasPlugins({
          scopeType: 'organization',
          organizationId: organizationState.organizationId,
        }),
      ]);
      const installedByScope = new Map([
        ...plugins.map((plugin) => [`user:${plugin.name}`, plugin] as const),
        ...organizationPlugins.map((plugin) => [`organization:${plugin.name}`, plugin] as const),
      ]);
      plugins = snapshot.capabilities
        .filter((entry) => entry.ref.resourceType === 'plugin')
        .flatMap((entry) => {
          if (entry.ref.scopeType === 'system') return [];
          const installed = installedByScope.get(`${entry.ref.scopeType}:${entry.ref.name}`);
          if (!installed) return [];
          return [{
            ...installed,
            resourceId: entry.ref.resourceId,
            scopeType: entry.ref.scopeType,
            sourceType: 'standalone' as const,
            organizationId: entry.ref.organizationId,
            ownerUserId: entry.ref.ownerUserId,
            revision: entry.ref.revision,
            enabled: entry.effectiveEnabled,
            effectivePolicy: entry.effectivePolicy,
            readiness: entry.readiness,
            blockedReason: entry.blockedReason,
            conflictResourceIds: entry.conflictResourceIds,
          }];
        });
    }
    plugins = deduplicateCanvasPluginInstallRecords(plugins, scope.scopeType);
    return NextResponse.json({
      success: true,
      plugins,
      stats: {
        total: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        disabled: plugins.filter((plugin) => !plugin.enabled).length,
      },
      scope: scope.scopeType,
    });
  } catch (error) {
    console.error('[Plugins API] Error loading plugins:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load plugins' },
      { status: 500 },
    );
  }
}
