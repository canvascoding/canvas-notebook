import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getMobileChatSession, MobileChatError, updateMobileChatSession } from '@/app/lib/mobile/chat';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: unknown): NextResponse {
  if (error instanceof MobileChatError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status, headers: responseHeaders },
    );
  }
  console.error('[API] Mobile chat session update failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'The chat session could not be updated.' },
    { status: 500, headers: responseHeaders },
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authSession = await auth.api.getSession({ headers: request.headers });
  if (!authSession) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'mobile-chat-session-detail' });
  if (!limited.ok) return limited.response;
  try {
    const params = await context.params;
    const session = await getMobileChatSession({
      userId: authSession.user.id,
      sessionId: params.sessionId,
      workspaceId: request.headers.get('x-canvas-workspace-id')?.trim() || '',
    });
    return NextResponse.json({ success: true, session }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authSession = await auth.api.getSession({ headers: request.headers });
  if (!authSession) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-chat-session-update' });
  if (!limited.ok) return limited.response;
  try {
    const params = await context.params;
    const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || Array.isArray(payload)) {
      throw new MobileChatError('INVALID_SESSION_UPDATE', 'Request body must be an object.', 400);
    }
    const session = await updateMobileChatSession({
      userId: authSession.user.id,
      sessionId: params.sessionId,
      workspaceId: request.headers.get('x-canvas-workspace-id')?.trim() || '',
      title: typeof payload.title === 'string' ? payload.title : undefined,
      markAsRead: typeof payload.markAsRead === 'boolean' ? payload.markAsRead : undefined,
      markAsUnread: typeof payload.markAsUnread === 'boolean' ? payload.markAsUnread : undefined,
      archived: typeof payload.archived === 'boolean' ? payload.archived : undefined,
    });
    return NextResponse.json({ success: true, session }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
