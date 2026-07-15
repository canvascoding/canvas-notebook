import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';
import { getUserOnboardingState, initializeUserOnboarding } from '@/app/lib/user-preferences';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { ensureWorkspaceBootstrapForActor } from '@/app/lib/workspaces/bootstrap-service';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export async function POST(request: NextRequest) {
  const onboardingEnabled = isOnboardingEnabled();
  if (onboardingEnabled && !(await isOnboardingComplete())) {
    return NextResponse.json({ success: false, error: 'Finish instance setup before initializing user onboarding.' }, { status: 409 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdminUser(session.user)) {
    return NextResponse.json({ success: false, error: 'Forbidden: admin only.' }, { status: 403 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'onboarding-user-initialize',
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => null) as { userId?: unknown } | null;
  const userId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  if (!USER_ID_PATTERN.test(userId)) {
    return NextResponse.json({ success: false, error: 'Invalid user ID.' }, { status: 400 });
  }

  const target = await db.select({
    id: user.id,
    email: user.email,
    role: user.role,
  }).from(user).where(eq(user.id, userId)).limit(1);
  if (target.length === 0) {
    return NextResponse.json({ success: false, error: 'User not found.' }, { status: 404 });
  }

  await ensureWorkspaceBootstrapForActor(resolveWorkspaceActor(target[0]));
  const onboarding = onboardingEnabled
    ? await initializeUserOnboarding(userId)
    : await getUserOnboardingState(userId);
  return NextResponse.json({
    success: true,
    data: {
      ...onboarding,
      workspaceInitialized: true,
    },
  });
}
