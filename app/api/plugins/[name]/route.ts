import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { refreshCapabilityRuntimeForScope } from '@/app/lib/capabilities/activation-actions';
import { auth } from '@/app/lib/auth';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { deleteCanvasPlugin, getCanvasPlugin } from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidCanvasPluginName } from '@/app/lib/plugins/canvas-plugin-manifest';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await params;
  if (!isValidCanvasPluginName(name)) {
    return NextResponse.json({ success: false, error: 'Invalid plugin name' }, { status: 400 });
  }

  const organizationState = await readOrganizationPermissionForUser(session.user.id);
  const capabilityScope = resolveCapabilityStorageScope({
    requestedScope: new URL(request.url).searchParams.get('scope'),
    userId: session.user.id,
    organizationState,
  });
  const plugin = await getCanvasPlugin(name, capabilityScope);
  if (!plugin) {
    return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, plugin });
}

export async function DELETE(
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
  const existingPlugin = await getCanvasPlugin(name, capabilityScope);
  const result = await deleteCanvasPlugin(
    name,
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
    action: 'plugin.delete',
    status: 'success',
    summary: `Plugin ${name} deleted.`,
    metadata: {
      pluginName: name,
      scopeType: capabilityScope.scopeType,
      resourceId: existingPlugin?.resourceId,
      sourceType: 'standalone',
      version: existingPlugin?.version,
      checksum: existingPlugin?.checksum,
      revision: existingPlugin?.revision,
      policy: null,
    },
  });
  await refreshCapabilityRuntimeForScope({
    scope: capabilityScope,
    actorUserId: pluginPermission.session.user.id,
  });

  return NextResponse.json({ success: true });
}
