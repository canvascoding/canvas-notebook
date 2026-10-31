import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { ApiKeyAccessError } from '@/app/lib/api-keys/contracts';
import { SeatLimitGuardError } from '@/app/lib/license/seat-limit';
import { requireTrustedMutationOrigin } from '@/app/lib/security/mutation-origin';
import { publicRateLimit } from '@/app/lib/security/public-rate-limit';

const responseHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
  Vary: 'Cookie, Authorization, X-Canvas-API-Key' };

/** Management accepts genuine user sessions only; never authenticates a key. */
export async function apiAccessResponse(request: NextRequest, operation: (body: unknown) => Promise<unknown>) {
  try {
    const budget = await publicRateLimit({ keyPrefix: 'api-key-management', limit: 120, globalLimit: 3600, windowMs: 60_000 });
    if (!budget.ok) return budget.response;
    let body: unknown;
    if (request.method !== 'GET') {
      const origin = requireTrustedMutationOrigin(request);
      if (!origin.ok) return origin.response;
      const parsed = await readBoundedJson(request);
      if (parsed.response) return parsed.response;
      body = parsed.body;
    }
    return NextResponse.json({ success: true, data: await operation(body) }, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof ApiKeyAccessError || error instanceof SeatLimitGuardError) {
      const retryAfter = error instanceof ApiKeyAccessError ? error.details.retryAfter : undefined;
      return NextResponse.json({ success: false, code: error.code, error: error.message,
        ...(error instanceof ApiKeyAccessError ? error.details : {}) },
      { status: error.status, headers: { ...responseHeaders, ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } });
    }
    if (error instanceof z.ZodError) return NextResponse.json({ success: false, code: 'API_KEY_INPUT_INVALID',
      error: 'Invalid API access request.' }, { status: 400, headers: responseHeaders });
    // Neither a driver error nor a request body is safe to log for issuance.
    console.error('[ApiAccess] Request failed.', { errorType: error instanceof Error ? error.name : 'UnknownError' });
    return NextResponse.json({ success: false, code: 'API_KEY_UNAVAILABLE', error: 'API access management is temporarily unavailable.' },
      { status: 503, headers: responseHeaders });
  }
}

export function apiAccessPage(request: NextRequest) {
  return Object.fromEntries(request.nextUrl.searchParams);
}

export async function apiIntegrationId(context: { params: Promise<{ integrationId: string }> }) {
  return z.string().uuid().parse((await context.params).integrationId);
}
