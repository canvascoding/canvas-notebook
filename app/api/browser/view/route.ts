import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { assertUnambiguousOwnedPiSessionForRuntime } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentExecutionContextForSession } from '@/app/lib/pi/session-workspace-context';
import { buildBrowserRuntimeStatus } from '@/app/lib/pi/browser/status-service';
import { isBrowserLabAllowed } from '@/app/lib/pi/browser/view-access';
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
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isBrowserLabAllowed(session.user)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'browser-view-ticket',
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = (await request.json().catch(() => ({}))) as BrowserViewRequest;
    const rawSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!rawSessionId) {
      return NextResponse.json({ success: false, error: 'sessionId is required.' }, { status: 400 });
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
        error: 'The browser tool is disabled or Chromium is unavailable for this agent.',
        details: {
          toolEnabled: status.toolEnabled,
          blockers: status.capability.blockers,
        },
      }, { status: 409 });
    }
    if (!resourceBudget.allowed) {
      return NextResponse.json({
        success: false,
        error: resourceBudget.reason,
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
    const message = error instanceof Error ? error.message : 'Could not create browser view.';
    const status = message.toLowerCase().includes('not found') ? 404 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
