import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
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

  const plugin = await getCanvasPlugin(name, { userId: session.user.id });
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
  const result = await deleteCanvasPlugin(
    name,
    { userId: pluginPermission.session.user.id },
    pluginPermission.session.user.email || pluginPermission.session.user.id,
  );
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.error?.includes('not found') ? 404 : 400 },
    );
  }

  return NextResponse.json({ success: true });
}
