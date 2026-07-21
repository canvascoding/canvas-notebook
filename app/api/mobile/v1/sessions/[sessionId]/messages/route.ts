import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { listMobileChatMessages, MobileChatError } from '@/app/lib/mobile/chat';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'mobile-chat-messages' });
  if (!limited.ok) return limited.response;
  try {
    const params = await context.params;
    const url = new URL(request.url);
    const limitValue = url.searchParams.get('limit');
    const beforeValue = url.searchParams.get('beforeSequence');
    const data = await listMobileChatMessages({
      userId: session.user.id,
      sessionId: params.sessionId,
      workspaceId: request.headers.get('x-canvas-workspace-id')?.trim() || '',
      beforeSequence: beforeValue === null ? null : Number(beforeValue),
      limit: limitValue === null ? undefined : Number(limitValue),
    });
    return NextResponse.json({ success: true, ...data }, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof MobileChatError) {
      return NextResponse.json(
        { success: false, code: error.code, error: error.message },
        { status: error.status, headers: responseHeaders },
      );
    }
    console.error('[API] Mobile chat messages failed:', error);
    return NextResponse.json(
      { success: false, code: 'INTERNAL_ERROR', error: 'The messages could not be loaded.' },
      { status: 500, headers: responseHeaders },
    );
  }
}
