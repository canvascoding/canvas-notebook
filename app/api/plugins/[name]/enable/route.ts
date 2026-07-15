import { NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { refreshCapabilityRuntimeForScope } from '@/app/lib/capabilities/activation-actions';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { setCanvasPluginEnabled } from '@/app/lib/plugins/canvas-plugin-registry';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const pluginPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!pluginPermission.ok) return pluginPermission.response;

  const { name } = await params;
  const capabilityScope = resolveCapabilityStorageScope({
    requestedScope: new URL(request.url).searchParams.get('scope'),
    userId: pluginPermission.session.user.id,
    organizationState: pluginPermission.state,
  });
  const result = await setCanvasPluginEnabled(
    name,
    true,
    capabilityScope,
    pluginPermission.session.user.email || pluginPermission.session.user.id,
  );
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.error?.includes('not found') ? 404 : 400 },
    );
  }
  await recordAuditEvent({
    organizationId: pluginPermission.state.organizationId,
    userId: pluginPermission.session.user.id,
    source: 'plugins',
    eventType: 'plugin',
    entityType: 'canvas_plugin',
    entityId: name,
    action: 'plugin.enable',
    status: 'success',
    summary: `Plugin ${name} enabled.`,
    metadata: {
      pluginName: name,
      version: result.plugin?.version,
      sourceType: 'standalone',
      scopeType: capabilityScope.scopeType,
      resourceId: result.plugin?.resourceId,
      checksum: result.plugin?.checksum,
      revision: result.plugin?.revision,
      policy: null,
    },
  });
  await refreshCapabilityRuntimeForScope({
    scope: capabilityScope,
    actorUserId: pluginPermission.session.user.id,
  });

  return NextResponse.json({ success: true, plugin: result.plugin });
}
