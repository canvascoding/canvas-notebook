import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listMobileEmailReviews, MobileEmailError } from '@/app/lib/mobile/email';
import { mobileEmailErrorResponse, mobileEmailResponseHeaders } from '@/app/lib/mobile/email-route';
import { loadMobileInboxScope } from '@/app/lib/mobile/inbox-scope';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401, headers: mobileEmailResponseHeaders });
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-email-review-queue' });
  if (!limited.ok) return limited.response;
  try {
    const scope = request.nextUrl.searchParams.get('scope') || 'selected';
    if (scope !== 'selected' && scope !== 'current') {
      throw new MobileEmailError('The email review scope is invalid.', 'INVALID_EMAIL_REVIEW', 400);
    }
    let workspaces;
    if (scope === 'current') {
      const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
      if (workspaceResult.response) return workspaceResult.response;
      workspaces = [workspaceResult.workspace];
    } else {
      workspaces = (await loadMobileInboxScope(session.user)).includedWorkspaces;
    }
    const limit = request.nextUrl.searchParams.get('limit');
    const data = await listMobileEmailReviews({
      userId: session.user.id,
      workspaces,
      scope,
      filter: request.nextUrl.searchParams.get('filter'),
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: limit === null ? undefined : Number(limit),
    });
    return NextResponse.json({ success: true, ...data }, { headers: mobileEmailResponseHeaders });
  } catch (error) {
    return mobileEmailErrorResponse(error, '[API] Mobile email review queue failed:');
  }
}
