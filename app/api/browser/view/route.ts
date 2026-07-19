import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { assertUnambiguousOwnedPiSessionForRuntime } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentExecutionContextForSession } from '@/app/lib/pi/session-workspace-context';
import { buildBrowserRuntimeStatus } from '@/app/lib/pi/browser/status-service';
import { browserViewFailure } from '@/app/lib/pi/browser/view-errors';
import { resolveBrowserViewResourceBudget } from '@/app/lib/pi/browser/view-resource-budget';
import { issueBrowserViewTicket } from '@/app/lib/pi/browser/view-ticket';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type BrowserViewRequest = {
  agentId?: unknown;
  sessionId?: unknown;
};

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({
      success: false,
      code: 'UNAUTHORIZED',
      error: 'Authentication required.',
      retryable: false,
      fatal: true,
    }, { status: 401 });
  }
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'browser-view-ticket',
  });
  if (!limited.ok) {
    return NextResponse.json({
      success: false,
      code: 'RATE_LIMITED',
      error: 'Too many browser view requests. Wait briefly and try again.',
      retryable: true,
      fatal: false,
    }, {
      status: 429,
      headers: { 'Retry-After': limited.response.headers.get('Retry-After') || '1' },
    });
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as BrowserViewRequest;
    const rawSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!rawSessionId) {
      return NextResponse.json({
        success: false,
        code: 'INVALID_MESSAGE',
        error: 'A browser session is required.',
        retryable: false,
        fatal: false,
      }, { status: 400 });
    }
    const agentId = normalizeManagedAgentId(typeof payload.agentId === 'string' ? payload.agentId : null);
    const agentSession = await assertUnambiguousOwnedPiSessionForRuntime({
      sessionId: rawSessionId,
      userId: session.user.id,
      agentId,
    });
    const [executionContext, status, resourceBudget] = await Promise.all([
      resolveAgentExecutionContextForSession({
        sessionId: agentSession.sessionId,
        userId: session.user.id,
        agentId: agentSession.agentId,
      }),
      buildBrowserRuntimeStatus({ userId: session.user.id, agentId: agentSession.agentId }),
      resolveBrowserViewResourceBudget(),
    ]);
    if (!status.toolAvailable) {
      return NextResponse.json({
        success: false,
        code: 'RESOURCE_UNAVAILABLE',
        error: 'The browser tool is disabled or Chromium is unavailable for this agent.',
        retryable: true,
        fatal: true,
        details: {
          toolEnabled: status.toolEnabled,
          blockers: status.capability.blockers,
        },
      }, { status: 409 });
    }
    if (!resourceBudget.allowed) {
      return NextResponse.json({
        success: false,
        code: 'RESOURCE_UNAVAILABLE',
        error: 'The interactive browser is unavailable on this system.',
        retryable: true,
        fatal: true,
        details: { resourceBudget },
      }, { status: 409 });
    }

    const authSessionId = String((session.session as { id?: string }).id || '');
    if (!authSessionId) throw new Error('Authenticated session has no stable identifier.');
    const issued = issueBrowserViewTicket({
      viewId: randomUUID(),
      userId: session.user.id,
      authSessionId,
      agentId: agentSession.agentId,
      agentSessionId: agentSession.sessionId,
      workspaceId: executionContext.workspaceId,
      workspaceType: executionContext.workspaceType,
      organizationId: executionContext.organizationId,
    });

    return NextResponse.json({
      success: true,
      data: {
        ticket: issued.token,
        viewId: issued.claims.viewId,
        expiresAt: new Date(issued.claims.expiresAt).toISOString(),
        websocketUrl: '/ws/browser',
        resourceBudget,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const failure = browserViewFailure(error, 'connection');
    const status = failure.code === 'SESSION_SCOPE_CHANGED' ? 404 : 500;
    return NextResponse.json({ success: false, ...failure }, { status });
  }
}
