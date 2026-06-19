import { NextResponse } from 'next/server';

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
  const result = await setCanvasPluginEnabled(name, true);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.error?.includes('not found') ? 404 : 400 },
    );
  }

  return NextResponse.json({ success: true, plugin: result.plugin });
}
