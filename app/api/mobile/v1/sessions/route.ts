import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  createMobileChatSession,
  listMobileChat,
  MobileChatError,
} from '@/app/lib/mobile/chat';
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
  console.error('[API] Mobile chat sessions failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'The chat sessions could not be loaded.' },
    { status: 500, headers: responseHeaders },
  );
}

function workspaceIdFrom(request: NextRequest): string {
  return request.headers.get('x-canvas-workspace-id')?.trim() || '';
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-chat-list' });
  if (!limited.ok) return limited.response;
  try {
    const url = new URL(request.url);
    const limitValue = url.searchParams.get('limit');
    const data = await listMobileChat({
      userId: session.user.id,
      sessionId: session.session.id,
      workspaceId: workspaceIdFrom(request),
      cursor: url.searchParams.get('cursor'),
      limit: limitValue === null ? undefined : Number(limitValue),
    });
    return NextResponse.json({ success: true, ...data }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'mobile-chat-create' });
  if (!limited.ok) return limited.response;
  try {
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const created = await createMobileChatSession({
      userId: session.user.id,
      sessionId: session.session.id,
      workspaceId: workspaceIdFrom(request),
      agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
      title: typeof payload.title === 'string' ? payload.title : undefined,
    });
    return NextResponse.json({ success: true, session: created }, { status: 201, headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
