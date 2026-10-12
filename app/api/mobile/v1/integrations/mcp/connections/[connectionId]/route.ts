import { NextRequest } from 'next/server';
import { mobileMcpErrorResponse, mobileMcpResponse, readMobileMcpConnections, readMobileMcpJson, requireMobileMcpContext, testMobileMcpConnection } from '@/app/lib/mobile/mcp-connections';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ connectionId: string }> };
export async function GET(request: NextRequest, context: Context) {
  try { return mobileMcpResponse(await readMobileMcpConnections(await requireMobileMcpContext(request), (await context.params).connectionId)); }
  catch (error) { return mobileMcpErrorResponse(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const actor = await requireMobileMcpContext(request), body = await readMobileMcpJson(request, ['action', 'revision']);
    const connectionId = (await context.params).connectionId;
    const result = await testMobileMcpConnection(actor, connectionId, { action: body.action, revision: body.revision });
    if (body.action === 'reconnect') {
      const { invalidateMobileMcpAppTickets } = await import('@/app/lib/mcp/mobile-app-tickets');
      invalidateMobileMcpAppTickets({ userId: actor.userId, connectionId });
    }
    return mobileMcpResponse(result);
  } catch (error) { return mobileMcpErrorResponse(error); }
}
