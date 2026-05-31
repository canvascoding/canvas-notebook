import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';

export async function requireMigrationAdmin(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const isAdmin = session.user.role === 'admin' || isBootstrapAdminEmail(session.user.email);
  if (!isAdmin) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Forbidden: admin only' }, { status: 403 }),
    };
  }

  return { ok: true as const, session };
}
