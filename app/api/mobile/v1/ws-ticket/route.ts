import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  issueMobileChatTicket,
  MOBILE_CHAT_WEBSOCKET_PROTOCOL,
} from '@/app/lib/mobile/ws-ticket';
import {
  resolveAgentSessionWorkspaceForUser,
  workspaceToChatRequestWorkspace,
} from '@/app/lib/pi/session-workspace-context';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: `mobile-ws-ticket:${session.user.id}`,
  });
  if (!limited.ok) return limited.response;
  try {
    const workspace = await resolveAgentSessionWorkspaceForUser({
      userId: session.user.id,
      workspaceId: request.headers.get('x-canvas-workspace-id')?.trim() || null,
      permissions: ['canRead', 'canRunAgent'],
    });
    const issued = issueMobileChatTicket({
      userId: session.user.id,
      userEmail: session.user.email,
      userName: session.user.name,
      userRole: session.user.role ?? null,
      workspace: workspaceToChatRequestWorkspace(workspace),
    });
    return NextResponse.json({
      success: true,
      websocket: {
        path: '/ws/chat',
        protocol: MOBILE_CHAT_WEBSOCKET_PROTOCOL,
        ticketProtocol: issued.ticketProtocol,
        expiresAt: issued.expiresAt,
      },
    }, { headers: responseHeaders });
  } catch {
    return NextResponse.json(
      {
        success: false,
        code: 'WORKSPACE_ACCESS_DENIED',
        error: 'The workspace is unavailable or cannot run agents.',
      },
      { status: 403, headers: responseHeaders },
    );
  }
}
