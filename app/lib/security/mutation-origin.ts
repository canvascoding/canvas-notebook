import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { isConfiguredTrustedOrigin } from './trusted-origins';

export type TrustedMutationOriginResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Explicit CSRF boundary for cookie-authenticated mutation routes.
 *
 * Authentication still belongs in every route. This check only ensures that a
 * browser did not attach a valid session cookie to a cross-origin request.
 */
export function requireTrustedMutationOrigin(
  request: NextRequest,
): TrustedMutationOriginResult {
  const origin = request.headers.get('origin')?.trim();
  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  const trusted = Boolean(origin && isConfiguredTrustedOrigin(origin));
  const browserMarkedCrossOrigin = fetchSite === 'cross-site';

  if (trusted && !browserMarkedCrossOrigin) return { ok: true };

  return {
    ok: false,
    response: NextResponse.json(
      {
        success: false,
        error: 'The request origin is not allowed.',
        code: 'CSRF_ORIGIN_INVALID',
      },
      {
        status: 403,
        headers: {
          'Cache-Control': 'no-store',
          Vary: 'Origin',
        },
      },
    ),
  };
}
