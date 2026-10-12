import { NextRequest } from 'next/server';
import { mobileMcpErrorResponse, mobileMcpResponse, readMobileMcpJson, requireMobileMcpContext } from '@/app/lib/mobile/mcp-connections';
import { decideMobileMcpOAuth, readMobileMcpOAuth } from '@/app/lib/mobile/mcp-oauth';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ flowId: string }> };
export async function GET(request: NextRequest, context: Context) {
  try { return mobileMcpResponse(await readMobileMcpOAuth(await requireMobileMcpContext(request), (await context.params).flowId)); }
  catch (error) { return mobileMcpErrorResponse(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const actor = await requireMobileMcpContext(request), body = await readMobileMcpJson(request, ['action']);
    return mobileMcpResponse(await decideMobileMcpOAuth(actor, (await context.params).flowId, body.action));
  } catch (error) { return mobileMcpErrorResponse(error); }
}
