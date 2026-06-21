import { NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
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
  const result = await setCanvasPluginEnabled(
    name,
    true,
    { userId: pluginPermission.session.user.id },
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
    },
  });

  return NextResponse.json({ success: true, plugin: result.plugin });
}
