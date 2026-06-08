import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getUserPreferences,
  normalizeUserLocale,
  setUserPreferredLocale,
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
  const locale = normalizeUserLocale(payload?.locale);
  if (!locale) {
    return NextResponse.json({ success: false, error: 'Unsupported locale.' }, { status: 400 });
  }

  const preferences = await setUserPreferredLocale(session.user.id, locale);
  return NextResponse.json({ success: true, data: preferences });
}
