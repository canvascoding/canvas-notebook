import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import {
  resolveCapabilityExecutionContextForUser,
  resolveCapabilityStorageScope,
} from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { resolvePluginConnectionReadiness } from '@/app/lib/plugins/plugin-connection-readiness';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
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
    const requestedWorkspaceId = request.nextUrl.searchParams.get('workspaceId')
      || request.headers.get(WORKSPACE_ID_HEADER);
    const includesOrganizationAssignments = Boolean(
      scope.scopeType === 'user'
      && organizationState.organizationId
      && organizationState.permission?.status === 'active'
    );
    const [personalPlugins, organizationPlugins, executionContext] = await Promise.all([
      listCanvasPlugins(scope),
      includesOrganizationAssignments ? listCanvasPlugins({
        scopeType: 'organization',
        organizationId: organizationState.organizationId!,
      }) : Promise.resolve([]),
      includesOrganizationAssignments ? resolveCapabilityExecutionContextForUser({
          userId: session.user.id,
          organizationId: organizationState.organizationId!,
          role: organizationState.permission!.role,
          requestedWorkspaceId,
        }) : Promise.resolve(null),
    ]);
    const workspaceId = executionContext?.workspaceId || (await resolveAgentSessionWorkspaceForUser({
      userId: session.user.id,
      workspaceId: requestedWorkspaceId || undefined,
      permissions: ['canRead', 'canRunAgent'],
    })).workspaceId;
    const readinessEntries = await Promise.all([
      ...personalPlugins.map((plugin) => ({ key: `${scope.scopeType}:${plugin.name}`, plugin })),
      ...organizationPlugins.map((plugin) => ({ key: `organization:${plugin.name}`, plugin })),
    ].map(async ({ key, plugin }) => [key, await resolvePluginConnectionReadiness({
      connectors: plugin.connectors,
      userId: session.user.id,
      workspaceId,
      fresh: request.nextUrl.searchParams.get('fresh') === '1',
    })] as const));
    const connectionReadinessByScope = new Map(readinessEntries);
    let plugins = personalPlugins;
    if (executionContext) {
      const snapshot = await resolveEffectiveCapabilitySnapshot(executionContext);
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
    if (request.nextUrl.searchParams.get('identity') === 'resource') {
      // The Plugins app presents every exact personal and assigned resource.
      const pluginsByResource = new Map<string, typeof plugins[number]>();
      for (const plugin of plugins) {
        const key = plugin.resourceId
          ? `resource:${plugin.resourceId}`
          : `name:${plugin.scopeType || scope.scopeType}:${plugin.name}`;
        pluginsByResource.set(key, plugin);
      }
      plugins = [...pluginsByResource.values()].sort((left, right) => left.name.localeCompare(right.name));
    } else {
      plugins = deduplicateCanvasPluginInstallRecords(plugins, scope.scopeType);
    }
    const pluginsWithReadiness = plugins.map((plugin) => ({
      ...plugin,
      connectionReadiness: connectionReadinessByScope.get(`${plugin.scopeType === 'organization' ? 'organization' : scope.scopeType}:${plugin.name}`),
    }));
    return NextResponse.json({
      success: true,
      plugins: pluginsWithReadiness,
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
