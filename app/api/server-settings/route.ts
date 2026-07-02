import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getOnboardingCompletionStatus, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { resolveServerSettingsUpdatePermission } from '@/app/lib/server-settings-policy';
import {
  getServerSettings,
  setServerPreferredTimeZone,
} from '@/app/lib/server-settings';
import { isValidTimeZone } from '@/app/lib/time-zones';

function jsonWithRequestId(requestId: string, body: Record<string, unknown>, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('X-Request-Id', requestId);
  return NextResponse.json(body, { ...init, headers });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      console.warn('[server-settings] GET unauthorized', { requestId });
      return jsonWithRequestId(requestId, { success: false, error: 'Unauthorized', requestId }, { status: 401 });
    }

    const settings = await getServerSettings();
    console.log('[server-settings] GET success', { requestId, userId: session.user.id });
    return jsonWithRequestId(requestId, { success: true, data: settings });
  } catch (error) {
    console.error('[server-settings] GET failed', { requestId, error });
    return jsonWithRequestId(
      requestId,
      { success: false, error: errorMessage(error, 'Failed to read server settings.'), requestId },
      { status: 500 },
    );
  }
}

async function getOnboardingCompleteForServerSettingsUpdate(requestId: string): Promise<boolean> {
  if (!isOnboardingEnabled()) {
    return true;
  }

  const status = await getOnboardingCompletionStatus('[server-settings]');
  if (status.source === 'fallback') {
    console.warn('[server-settings] PATCH using incomplete-onboarding fallback for permission check', {
      requestId,
      error: status.error,
    });
  }
  return status.complete;
}

export async function PATCH(request: NextRequest) {
  const requestId = randomUUID();
  let logUser: { userId?: string; email?: string | null; role?: string | null } = {};

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      console.warn('[server-settings] PATCH unauthorized: no session', { requestId });
      return jsonWithRequestId(requestId, { success: false, error: 'Unauthorized', requestId }, { status: 401 });
    }

    logUser = {
      userId: session.user.id,
      email: session.user.email,
      role: session.user.role,
    };

    const onboardingEnabled = isOnboardingEnabled();
    const onboardingComplete = await getOnboardingCompleteForServerSettingsUpdate(requestId);
    const permission = resolveServerSettingsUpdatePermission(session.user, {
      onboardingEnabled,
      onboardingComplete,
    });

    console.log('[server-settings] PATCH permission check', {
      requestId,
      ...logUser,
      onboardingEnabled,
      onboardingComplete,
      permissionOk: permission.ok,
      permissionReason: permission.reason,
    });

    if (!permission.ok) {
      console.warn('[server-settings] PATCH forbidden', {
        requestId,
        ...logUser,
        reason: permission.reason,
        onboardingEnabled,
        onboardingComplete,
      });
      return jsonWithRequestId(requestId, { success: false, error: 'Forbidden: admin only', requestId }, { status: 403 });
    }

    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || !('timeZone' in payload)) {
      console.warn('[server-settings] PATCH bad request: no timeZone in payload', { requestId, payload });
      return jsonWithRequestId(
        requestId,
        { success: false, error: 'No supported server setting update provided.', requestId },
        { status: 400 },
      );
    }

    const rawTimeZone = payload.timeZone;
    if (!isValidTimeZone(rawTimeZone)) {
      console.warn('[server-settings] PATCH bad request: invalid time zone', { requestId, rawTimeZone });
      return jsonWithRequestId(requestId, { success: false, error: 'Unsupported time zone.', requestId }, { status: 400 });
    }

    console.log('[server-settings] PATCH saving time zone', { requestId, userId: session.user.id, timeZone: rawTimeZone });
    const settings = await setServerPreferredTimeZone(session.user.id, rawTimeZone);
    console.log('[server-settings] PATCH saved time zone successfully', { requestId, userId: session.user.id, timeZone: settings.timeZone });
    return jsonWithRequestId(requestId, { success: true, data: settings });
  } catch (error) {
    console.error('[server-settings] PATCH failed', { requestId, ...logUser, error });
    return jsonWithRequestId(
      requestId,
      { success: false, error: errorMessage(error, 'Failed to update server settings.'), requestId },
      { status: 500 },
    );
  }
}
