import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getUserPreferredLocale,
  normalizeUserLocale,
  setUserPreferredLocale,
} from '@/app/lib/user-preferences';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: string, code: string, status: number) {
  return NextResponse.json(
    { success: false, error, code },
    { status, headers: responseHeaders },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  try {
    const locale = await getUserPreferredLocale(session.user.id);
    return NextResponse.json(
      { success: true, data: { locale } },
      { headers: responseHeaders },
    );
  } catch (error) {
    console.error('[API] Mobile account preferences could not be loaded:', error);
    return errorResponse(
      'Account preferences could not be loaded.',
      'ACCOUNT_PREFERENCES_UNAVAILABLE',
      500,
    );
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'mobile-account-preferences',
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => null);
  const locale = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? normalizeUserLocale((payload as Record<string, unknown>).locale)
    : null;
  if (!locale) return errorResponse('Unsupported locale.', 'UNSUPPORTED_LOCALE', 400);

  try {
    const preferences = await setUserPreferredLocale(session.user.id, locale);
    return NextResponse.json(
      { success: true, data: { locale: preferences.locale } },
      { headers: responseHeaders },
    );
  } catch (error) {
    console.error('[API] Mobile account preferences could not be updated:', error);
    return errorResponse(
      'The account language could not be updated.',
      'ACCOUNT_PREFERENCES_UPDATE_FAILED',
      500,
    );
  }
}
