import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { IntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { collectSharedComposioDesktopOAuthCallback } from '@/app/lib/composio/composio-shared-desktop-oauth';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const callbackSchema = z.object({
  flow: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
  error: z.enum(['access_denied', 'server_error', 'temporarily_unavailable', 'invalid_request',
    'unauthorized_client', 'unsupported_response_type', 'invalid_scope']).optional(),
}).strict();

function sharedComposioDesktopCallbackHtml(status: number, received = false): NextResponse {
  // All content is static: neither routing proofs nor provider error text enter the document.
  const message = received
    ? 'Return to the Canvas Notebook desktop app to check this sign-in. You can close this window.'
    : 'This sign-in response could not be accepted. Return to Canvas Notebook to check the connection.';
  return new NextResponse(`<!doctype html><html><head><meta charset="utf-8"><title>Return to Canvas Notebook</title></head><body><h1>Return to Canvas Notebook</h1><p>${message}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" } });
}

export async function GET(request: NextRequest) {
  if (request.method !== 'GET') {
    const response = sharedComposioDesktopCallbackHtml(405); response.headers.set('Allow', 'GET'); return response;
  }
  const mode = request.headers.get('sec-fetch-mode'), destination = request.headers.get('sec-fetch-dest');
  if (mode && mode !== 'navigate' || destination && destination !== 'document') return sharedComposioDesktopCallbackHtml(400);
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'composio-shared-desktop-oauth-callback' });
  if (!limited.ok) {
    const response = sharedComposioDesktopCallbackHtml(429);
    response.headers.set('Retry-After', limited.response.headers.get('Retry-After') || '60'); return response;
  }
  try {
    const query = request.nextUrl.searchParams;
    for (const key of query.keys()) {
      if (query.getAll(key).length !== 1) return sharedComposioDesktopCallbackHtml(400);
    }
    const input = callbackSchema.parse(Object.fromEntries(query));
    await collectSharedComposioDesktopOAuthCallback(input.flow, input.error);
    return sharedComposioDesktopCallbackHtml(200, true);
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : error instanceof IntegrationConnectionError
      && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
    return sharedComposioDesktopCallbackHtml(status);
  }
}
