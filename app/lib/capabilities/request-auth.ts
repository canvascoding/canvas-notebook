import 'server-only';

import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';

export async function requireActiveCapabilityUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return { ok: false as const, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  const state = await readOrganizationPermissionForUser(session.user.id);
  if (state.configured && state.permission?.status !== 'active') {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Active organization membership required' }, { status: 403 }),
    };
  }
  return { ok: true as const, session, state };
}
