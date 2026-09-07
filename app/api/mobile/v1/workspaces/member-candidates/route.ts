import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  LicenseEntitlementError,
  licenseEntitlementErrorPayload,
} from '@/app/lib/license/entitlements';
import { listMobileWorkspaceMemberCandidates } from '@/app/lib/mobile/workspaces';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { WorkspaceOperationError } from '@/app/lib/workspaces/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' }, { status: 401, headers: responseHeaders });
  }
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-workspace-member-candidates' });
  if (!limited.ok) return limited.response;
  try {
    const candidates = await listMobileWorkspaceMemberCandidates({
      actor: resolveWorkspaceActor({ id: session.user.id, email: session.user.email, role: session.user.role }),
    });
    return NextResponse.json({ success: true, candidates }, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof WorkspaceOperationError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status, headers: responseHeaders });
    }
    if (error instanceof LicenseEntitlementError) {
      return NextResponse.json(licenseEntitlementErrorPayload(error), { status: error.statusCode, headers: responseHeaders });
    }
    console.error('[API] Mobile workspace member candidates failed:', error);
    return NextResponse.json({ success: false, code: 'INTERNAL_ERROR', error: 'Workspace member candidates could not be loaded.' }, { status: 500, headers: responseHeaders });
  }
}
