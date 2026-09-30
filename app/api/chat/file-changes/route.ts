import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { McpAccessError, mcpErrorStatus } from '@/app/lib/mcp/access';
import { mcpAppOrigins } from '@/app/lib/mcp/apps-config';
import { requireMcpAppChatAccess } from '@/app/lib/mcp/apps-host';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { dualRateLimit } from '@/app/lib/utils/rate-limit';
import { readBoundedWidgetJson } from '@/app/lib/tool-apps/request';
import { readAuthorizedFileChangeSummary, readFileChangeSummaryApps } from '@/app/lib/tool-apps/file-change-summary-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    if (request.headers.get('origin') !== mcpAppOrigins().appOrigin) {
      throw new McpAccessError('Cross-origin file-change access is not allowed.', 403);
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new McpAccessError('Sign in to view file changes.', 401);
    const limited = dualRateLimit(request, {
      perUserLimit: FILE_VERSION_CENTER_RATE_LIMITS_V1.toolAppRefresh.perUserPerMinute,
      perIpLimit: FILE_VERSION_CENTER_RATE_LIMITS_V1.toolAppRefresh.perIpPerMinute,
      windowMs: 60_000,
      keyPrefix: 'file-version-center:chat-summary',
      verifiedUserId: session.user.id,
    });
    if (!limited.ok) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, {
        status: 429,
        headers: { ...headers, 'Retry-After': limited.response.headers.get('Retry-After') ?? '60' },
      });
    }
    const body = await readBoundedWidgetJson(request, 65536);
    if (Object.keys(body).some((key) => !['sessionId', 'agentId', 'apps'].includes(key))
      || typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 200
      || typeof body.agentId !== 'string' || !body.agentId || body.agentId.length > 200) {
      throw new McpAccessError('Invalid file-change summary request.', 400);
    }
    const apps = readFileChangeSummaryApps(body.apps);
    const chat = { userId: session.user.id, sessionId: body.sessionId, agentId: body.agentId };
    await requireMcpAppChatAccess(chat);
    const data = await readAuthorizedFileChangeSummary(chat, apps);
    return NextResponse.json({ success: true, data }, { headers });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof McpAccessError ? error.message : 'File changes are unavailable.',
    }, { status: mcpErrorStatus(error), headers });
  }
}
