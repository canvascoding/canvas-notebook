import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getUserPreferences,
  normalizeUserLocale,
  setUserPreferredLocale,
  updateUserPreferences,
  type UserPreferences,
} from '@/app/lib/user-preferences';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const preferences = await getUserPreferences(session.user.id);
  return NextResponse.json({ success: true, data: preferences });
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const updates: UserPreferences = {};

  if (payload && typeof payload === 'object' && 'locale' in payload) {
    const locale = normalizeUserLocale(payload.locale);
    if (!locale) {
      return NextResponse.json({ success: false, error: 'Unsupported locale.' }, { status: 400 });
    }
    updates.locale = locale;
  }

  if (payload && typeof payload === 'object' && 'emailAllowRemoteImages' in payload) {
    if (typeof payload.emailAllowRemoteImages !== 'boolean') {
      return NextResponse.json({ success: false, error: 'Unsupported email remote image setting.' }, { status: 400 });
    }
    updates.emailAllowRemoteImages = payload.emailAllowRemoteImages;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: 'No supported preference update provided.' }, { status: 400 });
  }

  const preferences = 'locale' in updates && Object.keys(updates).length === 1
    ? await setUserPreferredLocale(session.user.id, updates.locale)
    : await updateUserPreferences(session.user.id, updates);
  return NextResponse.json({ success: true, data: preferences });
}
