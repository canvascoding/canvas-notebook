import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
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

export async function PATCH(request: NextRequest) {
  const adminCheck = await requireInstanceAdmin(request);
  if (!adminCheck.ok) {
    return adminCheck.response;
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || !('timeZone' in payload)) {
    return NextResponse.json({ success: false, error: 'No supported server setting update provided.' }, { status: 400 });
  }

  const rawTimeZone = payload.timeZone;
  if (!isValidTimeZone(rawTimeZone)) {
    return NextResponse.json({ success: false, error: 'Unsupported time zone.' }, { status: 400 });
  }

  const settings = await setServerPreferredTimeZone(adminCheck.session.user.id, rawTimeZone);
  return NextResponse.json({ success: true, data: settings });
}