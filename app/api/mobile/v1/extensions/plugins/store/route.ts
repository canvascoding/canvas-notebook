import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { serializeMobilePluginSummary } from '@/app/lib/mobile/extensions';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import {
  listCanvasPluginStore,
  type CanvasPluginStoreStateFilter,
} from '@/app/lib/plugins/canvas-plugin-store';

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseState(value: string | null): CanvasPluginStoreStateFilter {
  if (value === 'available' || value === 'installed' || value === 'updates') return value;
  return 'all';
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const organizationState = await readOrganizationPermissionForUser(session.user.id);
    const scope = resolveCapabilityStorageScope({
      requestedScope: request.nextUrl.searchParams.get('scope'),
      userId: session.user.id,
      organizationState,
    });
    const store = await listCanvasPluginStore({
      page: parsePositiveInteger(request.nextUrl.searchParams.get('page')),
      pageSize: parsePositiveInteger(request.nextUrl.searchParams.get('pageSize')),
      query: request.nextUrl.searchParams.get('q') || '',
      state: parseState(request.nextUrl.searchParams.get('state')),
      scope,
    });

    return NextResponse.json({
      success: true,
      registry: {
        id: store.registry.id,
        name: store.registry.name,
        updatedAt: store.registry.updatedAt,
      },
      plugins: store.plugins.map(serializeMobilePluginSummary),
      pagination: store.pagination,
      stats: store.stats,
      scope: scope.scopeType,
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    console.error('[Mobile Plugins Store API] Error loading store:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load plugin marketplace' },
      { status: 500 },
    );
  }
}
