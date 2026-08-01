import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  mobileInboxErrorResponse,
  mobileInboxResponseHeaders,
} from '@/app/lib/mobile/inbox-route';
import {
  loadMobileInboxScope,
  updateMobileInboxScope,
  type MobileInboxScope,
} from '@/app/lib/mobile/inbox-scope';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

function unauthorizedResponse() {
  return NextResponse.json(
    { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
    { status: 401, headers: mobileInboxResponseHeaders },
  );
}

function preferencesResponse(scope: MobileInboxScope) {
  return {
    excludedWorkspaceIds: scope.excludedWorkspaceIds,
    sources: scope.sources,
  };
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorizedResponse();
  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-inbox-preferences-get',
  });
  if (!limited.ok) return limited.response;
  try {
    const scope = await loadMobileInboxScope(session.user);
    return NextResponse.json(
      { success: true, data: preferencesResponse(scope) },
      { headers: mobileInboxResponseHeaders },
    );
  } catch (error) {
    return mobileInboxErrorResponse(error, '[API] Mobile Inbox preferences GET failed:');
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorizedResponse();
  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'mobile-inbox-preferences-patch',
  });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const scope = await updateMobileInboxScope(session.user, payload.excludedWorkspaceIds);
    return NextResponse.json(
      { success: true, data: preferencesResponse(scope) },
      { headers: mobileInboxResponseHeaders },
    );
  } catch (error) {
    return mobileInboxErrorResponse(error, '[API] Mobile Inbox preferences PATCH failed:');
  }
}
