import { NextRequest, NextResponse } from 'next/server';
import { requireMobileMcpActor } from '@/app/lib/mobile/mcp-apps-access';
import { readMobileMcpPrepare, MOBILE_MCP_UUID, mcpInvalidRequest } from '@/app/lib/mobile/mcp-apps-contracts';
import { prepareMobileMcpAppCall, readMobileMcpAppCall } from '@/app/lib/mcp/mobile-app-call-service';
import { MOBILE_TOOL_APPS_HEADERS, readMobileToolAppJson, mobileToolAppErrorResponse } from '@/app/lib/mobile/tool-apps-route';
import { rateLimit } from '@/app/lib/utils/rate-limit';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params, actor = await requireMobileMcpActor(request, sessionId);
    const limit = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-mcp-prepare', verifiedUserId: actor.userId });
    if (!limit.ok) return limit.response;
    const result = await prepareMobileMcpAppCall(actor, readMobileMcpPrepare(await readMobileToolAppJson(request)));
    return NextResponse.json(result, { headers: MOBILE_TOOL_APPS_HEADERS });
  } catch (error) { return mobileToolAppErrorResponse(error); }
}
export async function GET(request: NextRequest, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params, actor = await requireMobileMcpActor(request, sessionId);
    const requestId = request.nextUrl.searchParams.get('requestId');
    if (!requestId || !MOBILE_MCP_UUID.test(requestId) || [...request.nextUrl.searchParams.keys()].some(key => key !== 'requestId')) return mcpInvalidRequest();
    return NextResponse.json(await readMobileMcpAppCall(actor, { requestId }), { headers: MOBILE_TOOL_APPS_HEADERS });
  } catch (error) { return mobileToolAppErrorResponse(error); }
}
