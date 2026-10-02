import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { completeLocalEmailOAuth, readLocalEmailOAuthReturnUrl } from '@/app/lib/email/local-service';
import { getPublicRequestOrigin } from '@/app/lib/utils/request-origin';

function safeReturnUrl(value: string | undefined, fallback: string, allowedOrigin: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value, allowedOrigin);
    if (url.origin !== allowedOrigin) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  const requestOrigin = getPublicRequestOrigin(request);
  const fallbackUrl = `${requestOrigin}/settings?tab=integrations`;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const redirectUrl = new URL(fallbackUrl);
    redirectUrl.searchParams.set('emailOAuthError', 'unauthorized');
    return NextResponse.redirect(redirectUrl);
  }

  const state = request.nextUrl.searchParams.get('state');
  const pendingReturnUrl = state
    ? await readLocalEmailOAuthReturnUrl(session.user.id, state).catch(() => undefined)
    : undefined;
  const returnUrl = safeReturnUrl(pendingReturnUrl, fallbackUrl, requestOrigin);
  const error = request.nextUrl.searchParams.get('error');
  if (error) {
    if (state) await readLocalEmailOAuthReturnUrl(session.user.id, state, true).catch(() => undefined);
    const redirectUrl = new URL(returnUrl);
    redirectUrl.searchParams.set('emailOAuthError', ['access_denied', 'user_cancelled', 'cancelled'].includes(error) ? 'cancelled' : 'failed');
    return NextResponse.redirect(redirectUrl);
  }

  const code = request.nextUrl.searchParams.get('code');
  if (!code || !state) {
    if (state) await readLocalEmailOAuthReturnUrl(session.user.id, state, true).catch(() => undefined);
    const redirectUrl = new URL(returnUrl);
    redirectUrl.searchParams.set('emailOAuthError', 'missing_code_or_state');
    return NextResponse.redirect(redirectUrl);
  }

  try {
    const result = await completeLocalEmailOAuth(session.user.id, code, state);
    const redirectUrl = new URL(safeReturnUrl(result.returnUrl, fallbackUrl, requestOrigin));
    redirectUrl.searchParams.set('emailOAuth', 'connected');
    return NextResponse.redirect(redirectUrl);
  } catch {
    const redirectUrl = new URL(returnUrl);
    redirectUrl.searchParams.set('emailOAuthError', 'failed');
    return NextResponse.redirect(redirectUrl);
  }
}
