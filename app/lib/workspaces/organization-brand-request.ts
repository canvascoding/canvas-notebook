import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { assertUserOrganizationAdmin } from '@/app/lib/organization/permissions';

type OrganizationBrandRequestResult =
  | {
      ok: true;
      session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
      organizationId: string;
    }
  | { ok: false; response: NextResponse };

export async function requireOrganizationBrandAdmin(
  request: NextRequest,
  organizationIdInput: string,
): Promise<OrganizationBrandRequestResult> {
  const organizationId = organizationIdInput.trim();
  if (!organizationId) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Organization id is required.' },
        { status: 400 },
      ),
    };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  try {
    const state = await assertUserOrganizationAdmin(
      session.user.id,
      'Only organization admins can manage the organization brand.',
    );
    if (state.organizationId && state.organizationId !== organizationId) {
      return {
        ok: false,
        response: NextResponse.json({ success: false, error: 'Organization not found.' }, { status: 404 }),
      };
    }
    return { ok: true, session, organizationId };
  } catch (error) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : 'Forbidden' },
        { status: 403 },
      ),
    };
  }
}
