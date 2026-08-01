import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { serializeMobilePluginPreflight } from '@/app/lib/mobile/extensions';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { preflightCanvasPluginFromStore } from '@/app/lib/plugins/canvas-plugin-store';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json() as {
      name?: unknown;
      version?: unknown;
      scope?: unknown;
    };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
    }

    const capabilityScope = resolveCapabilityStorageScope({
      requestedScope: body.scope,
      userId: session.user.id,
      organizationState: await readOrganizationPermissionForUser(session.user.id),
    });
    const preflight = await preflightCanvasPluginFromStore(
      body.name.trim(),
      typeof body.version === 'string' ? body.version.trim() : undefined,
      session.user.id,
      capabilityScope,
      request.headers.get(WORKSPACE_ID_HEADER)?.trim() || null,
    );

    return NextResponse.json({
      success: true,
      preflight: serializeMobilePluginPreflight(preflight),
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    console.error('[Mobile Plugin Preflight API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to check plugin requirements' },
      { status: 500 },
    );
  }
}
