import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isOnboardingEnabled, readIsOnboardingComplete } from '@/app/lib/onboarding/status';
import { resolveServerSettingsUpdatePermission } from '@/app/lib/server-settings-policy';
import {
  getServerSettings,
  setServerPreferredTimeZone,
} from '@/app/lib/server-settings';
import { isValidTimeZone } from '@/app/lib/time-zones';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const settings = await getServerSettings();
  return NextResponse.json({ success: true, data: settings });
}

async function getOnboardingCompleteForServerSettingsUpdate(): Promise<boolean> {
  if (!isOnboardingEnabled()) {
    return true;
  }

  try {
    return await readIsOnboardingComplete();
  } catch (error) {
    console.warn('[server-settings] Failed to read onboarding status for update permission:', error);
    return true;
  }
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    console.warn('[server-settings] PATCH unauthorized: no session');
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const onboardingEnabled = isOnboardingEnabled();
  const onboardingComplete = await getOnboardingCompleteForServerSettingsUpdate();
  const permission = resolveServerSettingsUpdatePermission(session.user, {
    onboardingEnabled,
    onboardingComplete,
  });

  console.log('[server-settings] PATCH permission check:', {
    userId: session.user.id,
    email: session.user.email,
    role: session.user.role,
    onboardingEnabled,
    onboardingComplete,
    permissionOk: permission.ok,
    permissionReason: permission.reason,
  });

  if (!permission.ok) {
    console.warn('[server-settings] PATCH forbidden:', {
      userId: session.user.id,
      email: session.user.email,
      role: session.user.role,
      reason: permission.reason,
      onboardingEnabled,
      onboardingComplete,
    });
    return NextResponse.json({ success: false, error: 'Forbidden: admin only' }, { status: 403 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || !('timeZone' in payload)) {
    console.warn('[server-settings] PATCH bad request: no timeZone in payload', { payload });
    return NextResponse.json({ success: false, error: 'No supported server setting update provided.' }, { status: 400 });
  }

  const rawTimeZone = payload.timeZone;
  if (!isValidTimeZone(rawTimeZone)) {
    console.warn('[server-settings] PATCH bad request: invalid time zone', { rawTimeZone });
    return NextResponse.json({ success: false, error: 'Unsupported time zone.' }, { status: 400 });
  }

  console.log('[server-settings] PATCH saving time zone:', { userId: session.user.id, timeZone: rawTimeZone });
  const settings = await setServerPreferredTimeZone(session.user.id, rawTimeZone);
  console.log('[server-settings] PATCH saved time zone successfully');
  return NextResponse.json({ success: true, data: settings });
}
