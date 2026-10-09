import { NextRequest } from 'next/server';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';
import { mobileMcpErrorResponse, mobileMcpResponse, readMobileMcpJson, requireMobileMcpContext } from '@/app/lib/mobile/mcp-connections';
import { startMobileMcpOAuth } from '@/app/lib/mobile/mcp-oauth';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  try {
    const actor = await requireMobileMcpContext(request), body = await readMobileMcpJson(request, ['connectionId', 'revision', 'returnUrl']);
    return mobileMcpResponse(await startMobileMcpOAuth(actor, typeof body.connectionId === 'string' ? body.connectionId : '',
      { revision: body.revision, returnUrl: body.returnUrl }, getPublicRequestOrigin(request)));
  } catch (error) { return mobileMcpErrorResponse(error); }
}
