import { NextResponse } from 'next/server';

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
    });

    if (!result.success) {
      return NextResponse.json(result, { status: result.validation?.valid === false ? 400 : 409 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Plugins Install API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to install plugin' },
      { status: 500 },
    );
  }
}
