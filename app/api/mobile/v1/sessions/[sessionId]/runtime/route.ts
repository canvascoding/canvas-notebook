import { NextRequest, NextResponse } from 'next/server';

import { parseSessionRuntimeUpdate } from '@/app/lib/agent-runtime-policy/session-runtime-service';
import { runtimeErrorResponse } from '@/app/lib/agent-runtime-policy/runtime-service';
import { auth } from '@/app/lib/auth';
import {
  getMobileChatRuntimeResolution,
  MobileChatError,
  updateMobileChatRuntimeSelection,
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
  const runtimeError = runtimeErrorResponse(error);
  if (runtimeError.status >= 500) {
    console.error('[API] Mobile chat runtime selection failed:', error);
  }
  return NextResponse.json(
    {
      success: false,
      code: runtimeError.code,
      error: runtimeError.message,
      ...(runtimeError.details || {}),
    },
    { status: runtimeError.status, headers: responseHeaders },
  );
}

function actorInput(request: NextRequest, authSession: { user: { id: string }; session: { id: string } }) {
  return {
    userId: authSession.user.id,
    sessionId: authSession.session.id,
    workspaceId: request.headers.get('x-canvas-workspace-id')?.trim() || '',
  };
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
  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-chat-runtime-read' });
  if (!limited.ok) return limited.response;
  try {
    const params = await context.params;
    const resolution = await getMobileChatRuntimeResolution({
      ...actorInput(request, authSession),
      sessionId: params.sessionId,
    });
    return NextResponse.json({ success: true, resolution }, { headers: responseHeaders });
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
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-chat-runtime-update' });
  if (!limited.ok) return limited.response;
  try {
    const params = await context.params;
    const payload = await request.json().catch(() => null);
    const resolution = await updateMobileChatRuntimeSelection({
      ...actorInput(request, authSession),
      sessionId: params.sessionId,
      update: parseSessionRuntimeUpdate(payload),
    });
    return NextResponse.json({ success: true, resolution }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
