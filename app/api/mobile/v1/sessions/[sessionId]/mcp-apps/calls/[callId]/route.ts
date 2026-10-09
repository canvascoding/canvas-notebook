import { NextRequest, NextResponse } from 'next/server';
import { requireMobileMcpActor } from '@/app/lib/mobile/mcp-apps-access';
import { readMobileMcpDecision, MOBILE_MCP_UUID, mcpInvalidRequest } from '@/app/lib/mobile/mcp-apps-contracts';
import { decideMobileMcpAppCall, readMobileMcpAppCall } from '@/app/lib/mcp/mobile-app-call-service';
import { MOBILE_TOOL_APPS_HEADERS, readMobileToolAppJson, mobileToolAppErrorResponse } from '@/app/lib/mobile/tool-apps-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string; callId: string }> }) {
  try {
    const { sessionId, callId } = await context.params;
    if (!MOBILE_MCP_UUID.test(callId)) return mcpInvalidRequest();
    const actor = await requireMobileMcpActor(request, sessionId);
    return NextResponse.json(await readMobileMcpAppCall(actor, { callId }), { headers: MOBILE_TOOL_APPS_HEADERS });
  } catch (error) { return mobileToolAppErrorResponse(error); }
}
export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string; callId: string }> }) {
  try {
    const { sessionId, callId } = await context.params;
    if (!MOBILE_MCP_UUID.test(callId)) return mcpInvalidRequest();
    const actor = await requireMobileMcpActor(request, sessionId);
    const limit = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-mcp-decision', verifiedUserId: actor.userId });
    if (!limit.ok) return limit.response;
    const { decision, approvalToken } = readMobileMcpDecision(await readMobileToolAppJson(request));
    return NextResponse.json(await decideMobileMcpAppCall(actor, callId, decision, approvalToken), { headers: MOBILE_TOOL_APPS_HEADERS });
  } catch (error) { return mobileToolAppErrorResponse(error); }
}
