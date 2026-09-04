import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { ensureUserExists } from '@/app/lib/db/ensure-user';
import { parseMobileAppPromotionAction } from '@/app/lib/mobile/promotion-contract';
import {
  getMobileAppPromotionStatus,
  recordMobileAppPromotionAction,
} from '@/app/lib/mobile/promotion-state';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

function unauthorized() {
  return NextResponse.json(
    { success: false, error: 'Unauthorized' },
    { status: 401, headers: responseHeaders },
  );
}

async function prepareUser(session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>) {
  await ensureUserExists(session.user.id, {
    name: session.user.name ?? undefined,
    email: session.user.email ?? undefined,
    image: session.user.image ?? undefined,
    role: session.user.role ?? undefined,
  });
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();

  try {
    await prepareUser(session);
    const promotion = await getMobileAppPromotionStatus({ userId: session.user.id });
    return NextResponse.json({ success: true, promotion }, { headers: responseHeaders });
  } catch (error) {
    console.error('[API] Mobile App promotion status failed:', error);
    return NextResponse.json(
      { success: false, error: 'Could not load Mobile App promotion status.' },
      { status: 500, headers: responseHeaders },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return unauthorized();

  const action = parseMobileAppPromotionAction(await request.json().catch(() => null));
  if (!action) {
    return NextResponse.json(
      { success: false, error: 'Invalid promotion action.' },
      { status: 400, headers: responseHeaders },
    );
  }

  try {
    await prepareUser(session);
    const result = await recordMobileAppPromotionAction({ userId: session.user.id, action });
    return NextResponse.json({ success: true, ...result }, { headers: responseHeaders });
  } catch (error) {
    console.error('[API] Mobile App promotion action failed:', error);
    return NextResponse.json(
      { success: false, error: 'Could not update Mobile App promotion status.' },
      { status: 500, headers: responseHeaders },
    );
  }
}
