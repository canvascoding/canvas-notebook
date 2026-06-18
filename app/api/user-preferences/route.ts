import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getUserPreferences,
  normalizeUserLastActiveAgentId,
  normalizeUserLocale,
  normalizeUserTimeZone,
  setUserPreferredLocale,
  updateUserPreferences,
  type UserPreferences,
} from '@/app/lib/user-preferences';
import { getAgentProfile } from '@/app/lib/agents/registry';

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

  if (payload && typeof payload === 'object' && 'timeZone' in payload) {
    const timeZone = normalizeUserTimeZone(payload.timeZone);
    if (!timeZone) {
      return NextResponse.json({ success: false, error: 'Unsupported time zone.' }, { status: 400 });
    }
    updates.timeZone = timeZone;
  }

  if (payload && typeof payload === 'object' && 'emailAllowRemoteImages' in payload) {
    if (typeof payload.emailAllowRemoteImages !== 'boolean') {
      return NextResponse.json({ success: false, error: 'Unsupported email remote image setting.' }, { status: 400 });
    }
    updates.emailAllowRemoteImages = payload.emailAllowRemoteImages;
  }

  if (payload && typeof payload === 'object' && 'emailRemoteImageAllowedSenders' in payload) {
    if (!Array.isArray(payload.emailRemoteImageAllowedSenders)) {
      return NextResponse.json({ success: false, error: 'Unsupported email remote image sender setting.' }, { status: 400 });
    }
    updates.emailRemoteImageAllowedSenders = payload.emailRemoteImageAllowedSenders;
  }

  if (payload && typeof payload === 'object' && 'lastActiveAgentId' in payload) {
    const lastActiveAgentId = normalizeUserLastActiveAgentId(payload.lastActiveAgentId);
    if (!lastActiveAgentId) {
      return NextResponse.json({ success: false, error: 'Unsupported agent ID.' }, { status: 400 });
    }
    const agent = await getAgentProfile(lastActiveAgentId);
    if (!agent) {
      return NextResponse.json({ success: false, error: 'Agent not found.' }, { status: 404 });
    }
    updates.lastActiveAgentId = lastActiveAgentId;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: 'No supported preference update provided.' }, { status: 400 });
  }

  const preferences = 'locale' in updates && Object.keys(updates).length === 1
    ? await setUserPreferredLocale(session.user.id, updates.locale)
    : await updateUserPreferences(session.user.id, updates);
  return NextResponse.json({ success: true, data: preferences });
}
