import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { loadCapabilityCandidates, resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import { resolveEffectiveCapabilities } from '@/app/lib/capabilities/effective-resolver';
import { assertReadableCapabilityCandidate } from '@/app/lib/capabilities/resources/read';
import { readExactInstalledPlugin } from '@/app/lib/plugins/installed-plugin-read';
import { selectVisibleCapabilities } from '@/app/lib/capabilities/visible-capabilities';
import {
  resolveCapabilityExecutionContextForUser,
  resolveCapabilityStorageScope,
} from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';
import { resolvePluginConnectionReadiness } from '@/app/lib/plugins/plugin-connection-readiness';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

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
    const executionContext = organizationState.organizationId && organizationState.permission?.status === 'active'
      ? await resolveCapabilityExecutionContextForUser({ userId: session.user.id,
        organizationId: organizationState.organizationId, role: organizationState.permission.role, requestedWorkspaceId })
      : null;
    const workspaceId = executionContext?.workspaceId || (await resolveAgentSessionWorkspaceForUser({
      userId: session.user.id, workspaceId: requestedWorkspaceId || undefined, permissions: ['canRead', 'canRunAgent'],
    })).workspaceId;
    const snapshot = executionContext ? await resolveEffectiveCapabilitySnapshot(executionContext)
      : resolveEffectiveCapabilities({ context: { userId: session.user.id, organizationId: '' },
        candidates: await loadCapabilityCandidates({ userId: session.user.id, organizationId: '' }, { resolveConnections: false }), policies: [] });
    const actor = { userId: session.user.id, workspaceId };
    const visible = scope.scopeType === 'organization'
      ? snapshot.capabilities.filter(entry => entry.ref.scopeType === 'organization')
      : selectVisibleCapabilities(snapshot.capabilities);
    const plugins = (await Promise.all(visible.filter(entry => entry.ref.resourceType === 'plugin'
      && entry.resourceAccess?.canRead !== false).map(async entry => {
      const installed = await readExactInstalledPlugin({ name: entry.ref.name, resourceId: entry.ref.resourceId,
        scope: entry.ref.scopeType === 'organization'
          ? { scopeType: 'organization', organizationId: entry.ref.organizationId! }
          : { scopeType: 'user', userId: entry.ref.scopeType === 'system' ? session.user.id : entry.ref.ownerUserId! } });
      if (!installed) return null;
      const connectionReadiness = await resolvePluginConnectionReadiness({ connectors: installed.connectors,
        userId: session.user.id, workspaceId, fresh: request.nextUrl.searchParams.get('fresh') === '1' });
      await assertReadableCapabilityCandidate(actor, entry, snapshot.capabilities);
      const foreignPersonal = entry.ref.scopeType === 'user' && entry.ref.ownerUserId !== session.user.id;
      return { ...installed, ...(foreignPersonal ? { installDir: '', manifestPath: '', skillsDir: undefined, sourcePath: undefined,
        skills: installed.skills.map(skill => ({ ...skill, path: '', directory: '', standaloneDir: undefined })) } : {}),
        resourceId: entry.ref.resourceId, scopeType: entry.ref.scopeType, sourceType: 'standalone' as const,
        organizationId: entry.ref.organizationId, ownerUserId: entry.ref.ownerUserId, revision: entry.ref.revision,
        enabled: entry.effectiveEnabled, effectivePolicy: entry.effectivePolicy, readiness: entry.readiness,
        blockedReason: entry.blockedReason, conflictResourceIds: entry.conflictResourceIds, connectionReadiness,
        resourceMetadata: entry.resourceMetadata, resourceAccess: entry.resourceAccess,
        description: entry.resourceMetadata?.description ?? installed.description };
    }))).filter((plugin): plugin is NonNullable<typeof plugin> => Boolean(plugin));
    const pluginsWithReadiness = plugins;
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
