import { NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { refreshCapabilityRuntimeForScope } from '@/app/lib/capabilities/activation-actions';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { resolveLocalPluginSourcePath } from '@/app/lib/plugins/local-plugin-source';
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
      scope?: unknown;
    };

    if (typeof body.sourcePath !== 'string' || body.sourcePath.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'sourcePath is required' },
        { status: 400 },
      );
    }

    const sourcePath = resolveLocalPluginSourcePath(body.sourcePath);
    const capabilityScope = resolveCapabilityStorageScope({
      requestedScope: body.scope,
      userId: pluginPermission.session.user.id,
      organizationState: pluginPermission.state,
    });
    const result = await installCanvasPluginFromPath(sourcePath, {
      enable: body.enable !== false,
      replace: body.replace === true,
      installedBy: pluginPermission.session.user.email || pluginPermission.session.user.id,
      scope: capabilityScope,
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
        sourceType: 'standalone',
        enabled: result.plugin?.enabled,
        replace: body.replace === true,
        sourcePath,
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

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Plugins Install API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to install plugin' },
      { status: 500 },
    );
  }
}
