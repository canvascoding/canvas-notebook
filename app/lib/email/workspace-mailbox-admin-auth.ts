import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { assertUserOrganizationAdmin } from '@/app/lib/organization/permissions';

/** Authorizes organization owners/admins to manage only their business mailboxes. */
export async function requireWorkspaceMailboxAdmin(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  try {
    const state = await assertUserOrganizationAdmin(session.user.id, 'Organization admin permission required.');
    return { ok: true as const, session, organizationId: state.organizationId };
  } catch {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: 'Forbidden: organization admin only' }, { status: 403 }),
    };
  }
}
