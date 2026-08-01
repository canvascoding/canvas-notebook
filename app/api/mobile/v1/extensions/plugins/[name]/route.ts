import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { serializeMobileInstalledPluginDetail } from '@/app/lib/mobile/extensions';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { getCanvasPlugin } from '@/app/lib/plugins/canvas-plugin-registry';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await context.params;
  const scope = resolveCapabilityStorageScope({
    requestedScope: request.nextUrl.searchParams.get('scope'),
    userId: session.user.id,
    organizationState: await readOrganizationPermissionForUser(session.user.id),
  });
  const plugin = await getCanvasPlugin(decodeURIComponent(name), scope);
  if (!plugin) {
    return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    plugin: serializeMobileInstalledPluginDetail(plugin),
    scope: scope.scopeType,
  }, {
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie, Authorization',
    },
  });
}
