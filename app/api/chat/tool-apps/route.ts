import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { isMcpAppsEnabled, mcpAppOrigins } from '@/app/lib/mcp/apps-config';
import { issueBuiltinToolAppTicket } from '@/app/lib/mcp/apps-host';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { readBuiltinToolAppDescriptor } from '@/app/lib/tool-apps/types';
import { readBoundedWidgetJson } from '@/app/lib/tool-apps/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    if (!isMcpAppsEnabled()) throw new McpAccessError('Widgets are disabled.', 404);
    if (request.headers.get('origin') !== mcpAppOrigins().appOrigin) throw new McpAccessError('Cross-origin widget access is not allowed.', 403);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new McpAccessError('Sign in to use widgets.', 401);
    const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'tool-app', verifiedUserId: session.user.id });
    if (!limited.ok) return limited.response;
    const body = await readBoundedWidgetJson(request, 8192);
    const app = readBuiltinToolAppDescriptor(body?.app);
    if (!app || body.action !== 'render') throw new McpAccessError('Invalid widget action.', 400);
    const chat = { userId: session.user.id, sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      agentId: typeof body.agentId === 'string' ? body.agentId : '' };
    const data = await issueBuiltinToolAppTicket({ ...chat, app, authSessionId: session.session.id, authSessionExpiresAt: session.session.expiresAt });
    return NextResponse.json({ success: true, data }, { headers });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof McpAccessError ? error.message : 'Widget is unavailable.' },
      { status: mcpErrorStatus(error), headers });
  }
}
