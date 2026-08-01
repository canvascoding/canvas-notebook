import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  issueMobileBrowserViewTicket,
  MOBILE_BROWSER_WEBSOCKET_PROTOCOL,
} from '@/app/lib/mobile/browser-view-ticket';
import {
  MobileChatError,
  requireMobileChatSession,
} from '@/app/lib/mobile/chat';
import { buildBrowserRuntimeStatus } from '@/app/lib/pi/browser/status-service';
import { resolveBrowserViewResourceBudget } from '@/app/lib/pi/browser/view-resource-budget';
import { issueBrowserViewTicket } from '@/app/lib/pi/browser/view-ticket';
import { getStatus } from '@/app/lib/pi/runtime-service';
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
  console.error('[API] Mobile browser view ticket failed:', error);
  return NextResponse.json(
    {
      success: false,
      code: 'BROWSER_VIEW_UNAVAILABLE',
      error: 'The live browser is unavailable.',
    },
    { status: 500, headers: responseHeaders },
  );
}

export async function POST(
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
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `mobile-browser-view-ticket:${authSession.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const params = await context.params;
    const workspaceId = request.headers.get('x-canvas-workspace-id')?.trim() || '';
    const interactionPolicy = request.headers.get('x-canvas-browser-interaction-policy') === 'cooperative'
      ? 'cooperative'
      : 'exclusive';
    const { session, workspace } = await requireMobileChatSession({
      userId: authSession.user.id,
      sessionId: params.sessionId,
      workspaceId,
    });
    const [runtimeStatus, browserStatus, resourceBudget] = await Promise.all([
      getStatus(session.sessionId, authSession.user.id),
      buildBrowserRuntimeStatus({
        userId: authSession.user.id,
        agentId: session.agentId,
      }),
      resolveBrowserViewResourceBudget(),
    ]);
    if (!runtimeStatus?.browser?.running) {
      throw new MobileChatError(
        'BROWSER_NOT_RUNNING',
        'The agent is not currently using the live browser.',
        409,
      );
    }
    if (!browserStatus.toolAvailable || !resourceBudget.allowed) {
      throw new MobileChatError(
        'BROWSER_VIEW_UNAVAILABLE',
        resourceBudget.reason || 'The live browser is unavailable on this Canvas instance.',
        409,
      );
    }

    const identity = {
      userId: authSession.user.id,
      authSessionId: authSession.session.id,
      agentId: session.agentId,
      agentSessionId: session.sessionId,
      workspaceId: workspace.workspaceId,
      workspaceType: workspace.workspaceType,
      organizationId: workspace.organizationId ?? null,
    };
    const browserTicket = issueBrowserViewTicket({
      viewId: randomUUID(),
      ...identity,
      interactionPolicy,
    });
    const websocketTicket = issueMobileBrowserViewTicket(identity);

    return NextResponse.json({
      success: true,
      browser: {
        websocket: {
          path: '/ws/browser',
          protocol: MOBILE_BROWSER_WEBSOCKET_PROTOCOL,
          ticketProtocol: websocketTicket.ticketProtocol,
          expiresAt: websocketTicket.expiresAt,
        },
        view: {
          ticket: browserTicket.token,
          viewId: browserTicket.claims.viewId,
          expiresAt: new Date(browserTicket.claims.expiresAt).toISOString(),
          interactionPolicy,
        },
      },
    }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
