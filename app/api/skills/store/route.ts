import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listCanvasSkillStore, type CanvasSkillStoreStateFilter } from '@/app/lib/skills/canvas-skill-store';

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseState(value: string | null): CanvasSkillStoreStateFilter {
  if (value === 'available' || value === 'installed' || value === 'updates') return value;
  return 'all';
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const scope = { userId: session.user.id };
    const store = await listCanvasSkillStore({
      page: parsePositiveInteger(request.nextUrl.searchParams.get('page')),
      pageSize: parsePositiveInteger(request.nextUrl.searchParams.get('pageSize')),
      query: request.nextUrl.searchParams.get('q') || '',
      state: parseState(request.nextUrl.searchParams.get('state')),
      scope,
    });
    return NextResponse.json({
      success: true,
      ...store,
    });
  } catch (error) {
    console.error('[Skills Store API] Error loading store:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to load Canvas Skill Library' },
      { status: 500 },
    );
  }
}
