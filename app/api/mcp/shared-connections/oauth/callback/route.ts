import { NextRequest, NextResponse } from 'next/server';
import { completeSharedMcpOAuth } from '@/app/lib/mcp/shared-oauth';
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
    const record = await completeSharedMcpOAuth(actor, { state: params.get('state') ?? '', code: params.get('code'), error: params.get('error'), issuer: params.get('iss') });
    return response(record ? 'Shared connection sign-in was saved. You can close this window.' : 'Shared sign-in was cancelled.');
  } catch (error) { return response('Shared connection sign-in could not be completed. Reload the connection and start sign-in again.', sharedMcpResponseError(error).status); }
}
