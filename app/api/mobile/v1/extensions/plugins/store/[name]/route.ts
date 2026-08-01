import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { serializeMobilePluginDetail } from '@/app/lib/mobile/extensions';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { getCanvasPluginStorePlugin } from '@/app/lib/plugins/canvas-plugin-store';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name } = await context.params;
    const organizationState = await readOrganizationPermissionForUser(session.user.id);
    const scope = resolveCapabilityStorageScope({
      requestedScope: request.nextUrl.searchParams.get('scope'),
      userId: session.user.id,
      organizationState,
    });
    const result = await getCanvasPluginStorePlugin(decodeURIComponent(name), scope);
    if (!result) {
      return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      plugin: await serializeMobilePluginDetail(result.plugin),
      scope: scope.scopeType,
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    console.error('[Mobile Plugin Detail API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load plugin details' },
      { status: 500 },
    );
  }
}
