import { NextRequest, NextResponse } from 'next/server';
import { requireMobileMcpActor } from '@/app/lib/mobile/mcp-apps-access';
import { readMobileMcpRender } from '@/app/lib/mobile/mcp-apps-contracts';
import { issueMobileMcpAppTicket } from '@/app/lib/mcp/mobile-app-tickets';
import { MOBILE_TOOL_APPS_HEADERS, readMobileToolAppJson, mobileToolAppErrorResponse } from '@/app/lib/mobile/tool-apps-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params, actor = await requireMobileMcpActor(request, sessionId);
    const limit = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'mobile-mcp-render', verifiedUserId: actor.userId });
    if (!limit.ok) return limit.response;
    const source = readMobileMcpRender(await readMobileToolAppJson(request));
    const result = await issueMobileMcpAppTicket(actor, source);
    return NextResponse.json({ success: true, contractVersion: 1, sessionId, workspaceId: actor.workspaceId,
      toolCallId: source.toolCallId, ...result }, { headers: MOBILE_TOOL_APPS_HEADERS });
  } catch (error) { return mobileToolAppErrorResponse(error); }
}
