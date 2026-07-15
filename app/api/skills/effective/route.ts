import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import { resolveCapabilityExecutionContextForUser } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const state = await readOrganizationPermissionForUser(session.user.id);
  if (!state.organizationId || !state.permission || state.permission.status !== 'active') {
    return NextResponse.json({ success: false, error: 'Active organization membership required' }, { status: 403 });
  }

  try {
    const requestedWorkspaceId = request.nextUrl.searchParams.get('workspaceId')?.trim() || undefined;
    const context = await resolveCapabilityExecutionContextForUser({
      userId: session.user.id,
      organizationId: state.organizationId,
      role: state.permission.role,
      requestedWorkspaceId,
    });
    const snapshot = await resolveEffectiveCapabilitySnapshot(context);
    return NextResponse.json({ success: true, snapshot });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to resolve effective capabilities' },
      { status: 500 },
    );
  }
}
