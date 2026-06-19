import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';

export type AdminUserCandidate = {
  role?: string | null;
  email?: string | null;
};

export function isAdminUser(user: AdminUserCandidate | null | undefined): boolean {
  return Boolean(user?.role === 'admin' || isBootstrapAdminEmail(user?.email));
}

export async function requireInstanceAdmin(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  if (!isAdminUser(session.user)) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Forbidden: admin only' }, { status: 403 }),
    };
  }

  return { ok: true as const, session };
}
