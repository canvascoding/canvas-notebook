import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { writeOnboardingLog } from '@/app/lib/onboarding/logging';
import { normalizeUserLocale, setUserPreferredLocale } from '@/app/lib/user-preferences';

function jsonWithRequestId(requestId: string, body: Record<string, unknown>, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Request-Id', requestId);
  return NextResponse.json(body, { ...init, headers });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let logUser: { userId?: string; email?: string | null; role?: string | null } = {};

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      await writeOnboardingLog('warn', 'preferences.unauthorized', { requestId });
      return jsonWithRequestId(requestId, { success: false, error: 'Unauthorized', requestId }, { status: 401 });
    }

    logUser = {
      userId: session.user.id,
      email: session.user.email,
      role: session.user.role,
    };

    const payload = await request.json().catch(() => null);
    const locale = payload && typeof payload === 'object' && 'locale' in payload
      ? normalizeUserLocale(payload.locale)
      : null;

    await writeOnboardingLog('info', 'preferences.requested', {
      requestId,
      ...logUser,
      locale,
      payloadKeys: payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [],
    });

    if (!locale) {
      await writeOnboardingLog('warn', 'preferences.invalid-locale', { requestId, ...logUser });
      return jsonWithRequestId(requestId, { success: false, error: 'Unsupported locale.', requestId }, { status: 400 });
    }

    if (payload && typeof payload === 'object' && 'timeZone' in payload) {
      await writeOnboardingLog('warn', 'preferences.time-zone-rejected', { requestId, ...logUser });
      return jsonWithRequestId(
        requestId,
        { success: false, error: 'Time zone is a server setting. Use /api/server-settings.', requestId },
        { status: 400 },
      );
    }

    const preferences = await setUserPreferredLocale(session.user.id, locale);

    await writeOnboardingLog('info', 'preferences.saved', {
      requestId,
      ...logUser,
      locale: preferences.locale,
    });

    return jsonWithRequestId(requestId, {
      success: true,
      data: {
        preferences,
      },
    });
  } catch (error) {
    await writeOnboardingLog('error', 'preferences.failed', {
      requestId,
      ...logUser,
      error,
    });
    return jsonWithRequestId(
      requestId,
      { success: false, error: errorMessage(error, 'Failed to save onboarding preferences.'), requestId },
      { status: 500 },
    );
  }
}
