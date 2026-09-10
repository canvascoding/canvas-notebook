import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { isMcpAppsEnabled, mcpAppOrigins } from '@/app/lib/mcp/apps-config';
import { issueBuiltinToolAppTicket } from '@/app/lib/mcp/apps-host';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { readBuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import { readBoundedWidgetJson } from '@/app/lib/tool-apps/request';
import { AutomationMutationError } from '@/app/lib/automations/mutation-errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    if (!isMcpAppsEnabled()) throw new McpAccessError('Widgets are disabled.', 404, 'TOOL_APPS_DISABLED');
    if (request.headers.get('origin') !== mcpAppOrigins().appOrigin) throw new McpAccessError('Cross-origin widget access is not allowed.', 403);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new McpAccessError('Sign in to use widgets.', 401);
    const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'tool-app', verifiedUserId: session.user.id });
    if (!limited.ok) return limited.response;
    const body = await readBoundedWidgetJson(request, 8192);
    const app = readBuiltinToolAppDescriptor(body?.app);
    if (!app || (body.action !== 'render' && body.action !== 'status')) throw new McpAccessError('Invalid widget action.', 400);
    const chat = { userId: session.user.id, sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      agentId: typeof body.agentId === 'string' ? body.agentId : '' };
    let data;
    if (body.action === 'status') {
      if ((body.status !== 'active' && body.status !== 'paused') || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
        || typeof body.expectedUpdatedAt !== 'string' || body.expectedUpdatedAt.length > 40 || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
        throw new McpAccessError('Invalid automation status or revision.', 400);
      }
      const actionLimit = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'tool-app-status', verifiedUserId: session.user.id });
      if (!actionLimit.ok) return actionLimit.response;
      const { changeAutomationAppStatus } = await import('@/app/lib/tool-apps/automation-actions');
      data = await changeAutomationAppStatus(chat, app, body.status, Number(body.expectedRevision), body.locale === 'de' ? 'de' : 'en', body.expectedUpdatedAt);
    } else data = await issueBuiltinToolAppTicket({ ...chat, app, authSessionId: session.session.id, authSessionExpiresAt: session.session.expiresAt });
    return NextResponse.json({ success: true, data }, { headers });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof McpAccessError || error instanceof AutomationMutationError ? error.message : 'Widget is unavailable.',
      ...(error instanceof AutomationMutationError || error instanceof McpAccessError ? { code: error.code } : {}) },
      { status: error instanceof AutomationMutationError ? error.status : mcpErrorStatus(error), headers });
  }
}
