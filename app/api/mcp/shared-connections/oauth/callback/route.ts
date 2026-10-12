import { NextRequest, NextResponse } from 'next/server';
import { completeSharedMcpOAuthWithReturn } from '@/app/lib/mcp/shared-oauth';
import { sharedConnectionOAuthReturnHref } from '@/app/lib/integration-tools/connections/oauth-return';
import { sharedMcpRequestActor, sharedMcpResponseError } from '../../http';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function response(message: string, status = 200) {
  return new NextResponse(`<!doctype html><html><head><meta charset="utf-8"><title>Shared MCP sign-in</title></head><body><p>${message}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
}
export async function GET(request: NextRequest) {
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'shared-mcp-oauth-callback' });
  if (!limited.ok) return limited.response;
  try {
    const actor = await sharedMcpRequestActor(request);
    if (actor instanceof NextResponse) return response('Remain signed in as the initiating connection manager to finish sign-in.', actor.status);
    const params = new URL(request.url).searchParams;
    const completed = await completeSharedMcpOAuthWithReturn(actor, { state: params.get('state') ?? '', code: params.get('code'), error: params.get('error'), issuer: params.get('iss') });
    if (completed.returnContext && completed.appOrigin) {
      const redirect = NextResponse.redirect(new URL(sharedConnectionOAuthReturnHref(completed.returnContext, completed.record ? 'connected' : 'cancelled'), completed.appOrigin), 303);
      redirect.headers.set('Cache-Control', 'no-store'); redirect.headers.set('Referrer-Policy', 'no-referrer');
      return redirect;
    }
    return response(completed.record ? 'Shared connection sign-in was saved. You can close this window.' : 'Shared sign-in was cancelled.');
  } catch (error) { return response('Shared connection sign-in could not be completed. Reload the connection and start sign-in again.', sharedMcpResponseError(error).status); }
}
