import { NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { installCanvasPluginFromPath } from '@/app/lib/plugins/canvas-plugin-registry';

export async function POST(request: Request) {
  const pluginPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!pluginPermission.ok) return pluginPermission.response;

  try {
    const body = await request.json() as {
      sourcePath?: unknown;
      enable?: unknown;
      replace?: unknown;
    };

    if (typeof body.sourcePath !== 'string' || body.sourcePath.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'sourcePath is required' },
        { status: 400 },
      );
    }

    const result = await installCanvasPluginFromPath(body.sourcePath, {
      enable: body.enable !== false,
      replace: body.replace === true,
      installedBy: pluginPermission.session.user.email || pluginPermission.session.user.id,
      scope: { userId: pluginPermission.session.user.id },
    });

    if (!result.success) {
      return NextResponse.json(result, { status: result.validation?.valid === false ? 400 : 409 });
    }
    await recordAuditEvent({
      organizationId: pluginPermission.state.organizationId,
      userId: pluginPermission.session.user.id,
      source: 'plugins',
      eventType: 'plugin',
      entityType: 'canvas_plugin',
      entityId: result.plugin?.name ?? null,
      action: 'plugin.install_from_path',
      status: 'success',
      summary: `Plugin ${result.plugin?.name ?? 'unknown'} installed from local path.`,
      metadata: {
        pluginName: result.plugin?.name,
        version: result.plugin?.version,
        enabled: result.plugin?.enabled,
        replace: body.replace === true,
        sourcePath: body.sourcePath,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Plugins Install API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to install plugin' },
      { status: 500 },
    );
  }
}
