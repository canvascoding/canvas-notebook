import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  listMobileAggregateInbox,
  markMobileAggregateInboxRead,
  MobileInboxError,
} from '@/app/lib/mobile/inbox';
import { getMobileInboxCategoryCounts } from '@/app/lib/mobile/inbox-counts';
import {
  mobileInboxErrorResponse,
  mobileInboxResponseHeaders,
} from '@/app/lib/mobile/inbox-route';
import { loadMobileInboxScope } from '@/app/lib/mobile/inbox-scope';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

function unauthorizedResponse() {
  return NextResponse.json(
    { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
    { status: 401, headers: mobileInboxResponseHeaders },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorizedResponse();
  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-inbox-aggregate-get',
  });
  if (!limited.ok) return limited.response;
  try {
    const scope = await loadMobileInboxScope(session.user);
    const limitValue = request.nextUrl.searchParams.get('limit');
    const [data, categories] = await Promise.all([
      listMobileAggregateInbox({
        userId: session.user.id,
        workspaces: scope.includedWorkspaces,
        filter: request.nextUrl.searchParams.get('filter'),
        groupWorkspaceTodos: request.nextUrl.searchParams.get('groupTodos') === 'workspace',
        cursor: request.nextUrl.searchParams.get('cursor'),
        limit: limitValue === null ? undefined : Number(limitValue),
      }),
      getMobileInboxCategoryCounts({
        userId: session.user.id,
        workspaces: scope.includedWorkspaces,
      }),
    ]);
    return NextResponse.json({ success: true, ...data, categories }, { headers: mobileInboxResponseHeaders });
  } catch (error) {
    return mobileInboxErrorResponse(error, '[API] Mobile aggregate Inbox GET failed:');
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorizedResponse();
  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'mobile-inbox-aggregate-patch',
  });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (
      payload.action !== 'mark_all_read'
      && !(payload.action === 'mark_category_read' && payload.category === 'notifications')
    ) {
      throw new MobileInboxError('INVALID_ACTION', 'The Inbox read action is invalid.', 400);
    }
    const scope = await loadMobileInboxScope(session.user);
    const data = await markMobileAggregateInboxRead({
      userId: session.user.id,
      workspaces: scope.includedWorkspaces,
      ...(payload.action === 'mark_category_read' ? { category: 'notifications' as const } : {}),
    });
    return NextResponse.json({ success: true, data }, { headers: mobileInboxResponseHeaders });
  } catch (error) {
    return mobileInboxErrorResponse(error, '[API] Mobile aggregate Inbox PATCH failed:');
  }
}
