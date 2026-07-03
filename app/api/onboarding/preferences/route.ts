import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { writeOnboardingLog } from '@/app/lib/onboarding/logging';
import { getOnboardingCompletionStatus, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { resolveServerSettingsUpdatePermission } from '@/app/lib/server-settings-policy';
import { setServerPreferredTimeZone } from '@/app/lib/server-settings';
import { isValidTimeZone } from '@/app/lib/time-zones';
import { normalizeUserLocale, setUserPreferredLocale } from '@/app/lib/user-preferences';

function jsonWithRequestId(requestId: string, body: Record<string, unknown>, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Request-Id', requestId);
  return NextResponse.json(body, { ...init, headers });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function getOnboardingCompleteForPreferenceUpdate(requestId: string): Promise<boolean> {
  if (!isOnboardingEnabled()) {
    return true;
  }

  const status = await getOnboardingCompletionStatus('[onboarding/preferences]');
  if (status.source === 'fallback') {
    await writeOnboardingLog('warn', 'preferences.status-fallback', {
      requestId,
      error: status.error,
    });
  }
  return status.complete;
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
    const rawTimeZone = payload && typeof payload === 'object' && 'timeZone' in payload
      ? payload.timeZone
      : null;

    await writeOnboardingLog('info', 'preferences.requested', {
      requestId,
      ...logUser,
      locale,
      timeZone: typeof rawTimeZone === 'string' ? rawTimeZone : null,
      payloadKeys: payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [],
    });

    if (!locale) {
      await writeOnboardingLog('warn', 'preferences.invalid-locale', { requestId, ...logUser });
      return jsonWithRequestId(requestId, { success: false, error: 'Unsupported locale.', requestId }, { status: 400 });
    }

    if (!isValidTimeZone(rawTimeZone)) {
      await writeOnboardingLog('warn', 'preferences.invalid-time-zone', {
        requestId,
        ...logUser,
        rawTimeZone,
      });
      return jsonWithRequestId(requestId, { success: false, error: 'Unsupported time zone.', requestId }, { status: 400 });
    }

    const onboardingEnabled = isOnboardingEnabled();
    const onboardingComplete = await getOnboardingCompleteForPreferenceUpdate(requestId);
    const permission = resolveServerSettingsUpdatePermission(session.user, {
      onboardingEnabled,
      onboardingComplete,
    });

    await writeOnboardingLog('info', 'preferences.permission', {
      requestId,
      ...logUser,
      onboardingEnabled,
      onboardingComplete,
      permissionOk: permission.ok,
      permissionReason: permission.reason,
    });

    if (!permission.ok) {
      await writeOnboardingLog('warn', 'preferences.forbidden', {
        requestId,
        ...logUser,
        reason: permission.reason,
      });
      return jsonWithRequestId(requestId, { success: false, error: 'Forbidden: admin only', requestId }, { status: 403 });
    }

    const preferences = await setUserPreferredLocale(session.user.id, locale);
    const settings = await setServerPreferredTimeZone(session.user.id, rawTimeZone);

    await writeOnboardingLog('info', 'preferences.saved', {
      requestId,
      ...logUser,
      locale: preferences.locale,
      timeZone: settings.timeZone,
    });

    return jsonWithRequestId(requestId, {
      success: true,
      data: {
        preferences,
        settings,
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
