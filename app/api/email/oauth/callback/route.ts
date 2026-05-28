import { NextRequest, NextResponse } from 'next/server';

import { completeLocalEmailOAuth } from '@/app/lib/email/local-service';

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
  const fallbackUrl = `${request.nextUrl.origin}/settings?tab=integrations`;
  const error = request.nextUrl.searchParams.get('error');
  if (error) {
    const redirectUrl = new URL(fallbackUrl);
    redirectUrl.searchParams.set('emailOAuthError', error);
    return NextResponse.redirect(redirectUrl);
  }

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  if (!code || !state) {
    const redirectUrl = new URL(fallbackUrl);
    redirectUrl.searchParams.set('emailOAuthError', 'missing_code_or_state');
    return NextResponse.redirect(redirectUrl);
  }

  try {
    const result = await completeLocalEmailOAuth(code, state);
    const redirectUrl = new URL(safeReturnUrl(result.returnUrl, fallbackUrl, request.nextUrl.origin));
    redirectUrl.searchParams.set('emailOAuth', 'connected');
    return NextResponse.redirect(redirectUrl);
  } catch (callbackError) {
    const redirectUrl = new URL(fallbackUrl);
    redirectUrl.searchParams.set('emailOAuthError', callbackError instanceof Error ? callbackError.message : 'oauth_failed');
    return NextResponse.redirect(redirectUrl);
  }
}
