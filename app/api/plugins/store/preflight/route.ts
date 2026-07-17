import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
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

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'name is required' },
        { status: 400 },
      );
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

    return NextResponse.json({ success: true, preflight });
  } catch (error) {
    console.error('[Plugins Store Preflight API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to check plugin connectors' },
      { status: 500 },
    );
  }
}
