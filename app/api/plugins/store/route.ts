import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listCanvasPluginStore, type CanvasPluginStoreStateFilter } from '@/app/lib/plugins/canvas-plugin-store';

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
    const store = await listCanvasPluginStore({
      page: parsePositiveInteger(request.nextUrl.searchParams.get('page')),
      pageSize: parsePositiveInteger(request.nextUrl.searchParams.get('pageSize')),
      query: request.nextUrl.searchParams.get('q') || '',
      state: parseState(request.nextUrl.searchParams.get('state')),
    });
    return NextResponse.json({
      success: true,
      ...store,
    });
  } catch (error) {
    console.error('[Plugins Store API] Error loading store:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load plugin store' },
      { status: 500 },
    );
  }
}
