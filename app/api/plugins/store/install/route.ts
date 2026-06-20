import { NextResponse } from 'next/server';

import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { installCanvasPluginFromStore } from '@/app/lib/plugins/canvas-plugin-store';

export async function POST(request: Request) {
  const pluginPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!pluginPermission.ok) return pluginPermission.response;

  try {
    const body = await request.json() as {
      name?: unknown;
      version?: unknown;
      enable?: unknown;
      replace?: unknown;
    };

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'name is required' },
        { status: 400 },
      );
    }

    const result = await installCanvasPluginFromStore(
      body.name.trim(),
      typeof body.version === 'string' ? body.version.trim() : undefined,
      {
        enable: body.enable !== false,
        replace: body.replace !== false,
        installedBy: pluginPermission.session.user.email || pluginPermission.session.user.id,
        scope: { userId: pluginPermission.session.user.id },
      },
    );

    if (!result.success) {
      return NextResponse.json(result, { status: result.validation?.valid === false ? 400 : 409 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Plugins Store Install API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to install plugin from store' },
      { status: 500 },
    );
  }
}
