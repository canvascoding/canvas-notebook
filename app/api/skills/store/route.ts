import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { listCanvasSkillStore, type CanvasSkillStoreStateFilter } from '@/app/lib/skills/canvas-skill-store';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

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
    const organizationState = await readOrganizationPermissionForUser(session.user.id);
    if (organizationState.configured && organizationState.permission?.status !== 'active'
      || request.nextUrl.searchParams.get('scope') === 'organization'
        && (!organizationState.organizationId || organizationState.permission?.status !== 'active')) {
      return NextResponse.json({ success: false, code: 'SKILL_STORE_ACCESS_DENIED', error: 'Skill library access is unavailable in this context.' }, { status: 403 });
    }
    const scope = resolveCapabilityStorageScope({
      requestedScope: request.nextUrl.searchParams.get('scope'),
      userId: session.user.id,
      organizationState,
    });
    const store = await listCanvasSkillStore({
      page: parsePositiveInteger(request.nextUrl.searchParams.get('page')),
      pageSize: parsePositiveInteger(request.nextUrl.searchParams.get('pageSize')),
      query: request.nextUrl.searchParams.get('q') || '',
      state: parseState(request.nextUrl.searchParams.get('state')),
      scope,
      actor: { userId: session.user.id,
        workspaceId: request.headers.get(WORKSPACE_ID_HEADER)?.trim() || request.nextUrl.searchParams.get('workspaceId') },
    });
    return NextResponse.json({
      success: true,
      ...store,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof CapabilityResourceError && (error.status === 400 || error.status === 403 || error.status === 404)) {
      return NextResponse.json({ success: false, code: 'SKILL_STORE_ACCESS_DENIED', error: 'Skill library access is unavailable in this context.' }, { status: error.status });
    }
    if (error instanceof Error && (error.message === 'Workspace not found or inaccessible.'
      || (error as Error & { code?: string }).code === 'WORKSPACE_PERMISSION_DENIED')) {
      return NextResponse.json({ success: false, code: 'SKILL_STORE_ACCESS_DENIED', error: 'Skill library access is unavailable in this context.' }, { status: 403 });
    }
    console.error('[Skills Store API] Error loading store:', { errorType: error instanceof Error ? error.name : 'UnknownError' });
    return NextResponse.json(
      { success: false, error: 'Failed to load Canvas Skill Library' },
      { status: 500 },
    );
  }
}
