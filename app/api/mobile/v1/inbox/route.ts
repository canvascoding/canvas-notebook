import { NextRequest, NextResponse } from 'next/server';

import { listMobileInbox, markMobileInboxRead } from '@/app/lib/mobile/inbox';
import { mobileInboxErrorResponse, mobileInboxResponseHeaders } from '@/app/lib/mobile/inbox-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-inbox-get' });
  if (!limited.ok) return limited.response;
  try {
    const limitValue = request.nextUrl.searchParams.get('limit');
    const data = await listMobileInbox({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      filter: request.nextUrl.searchParams.get('filter'),
      cursor: request.nextUrl.searchParams.get('cursor'),
      limit: limitValue === null ? undefined : Number(limitValue),
    });
    return NextResponse.json({ success: true, ...data }, { headers: mobileInboxResponseHeaders });
  } catch (error) {
    return mobileInboxErrorResponse(error, '[API] Mobile Inbox GET failed:');
  }
}

export async function PATCH(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-inbox-patch' });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const data = await markMobileInboxRead({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      action: payload.action,
      itemId: payload.itemId,
      read: payload.read,
    });
    return NextResponse.json({ success: true, data }, { headers: mobileInboxResponseHeaders });
  } catch (error) {
    return mobileInboxErrorResponse(error, '[API] Mobile Inbox PATCH failed:');
  }
}
