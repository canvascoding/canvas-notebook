import { NextRequest } from 'next/server';
import { mobileMcpErrorResponse, mobileMcpResponse, readMobileMcpConnections, requireMobileMcpContext } from '@/app/lib/mobile/mcp-connections';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try { return mobileMcpResponse(await readMobileMcpConnections(await requireMobileMcpContext(request))); }
  catch (error) { return mobileMcpErrorResponse(error); }
}
