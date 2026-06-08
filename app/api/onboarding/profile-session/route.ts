import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { ensureOnboardingProfileSession, OnboardingProfileError } from '@/app/lib/onboarding/profile';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not create onboarding profile session.';
}

export async function POST(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return NextResponse.json({ success: false, error: 'Onboarding is not enabled' }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'onboarding-profile-session',
  });
  if (!limited.ok) {
    return limited.response;
  }

  if (await isOnboardingComplete()) {
    return NextResponse.json({ success: true, complete: true });
  }

  try {
    const payload = (await request.json().catch(() => ({}))) as { locale?: unknown };
    const locale = typeof payload.locale === 'string' ? payload.locale : null;
    const result = await ensureOnboardingProfileSession({
      userId: session.user.id,
      locale,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status = error instanceof OnboardingProfileError ? error.statusCode : 500;
    const code = error instanceof OnboardingProfileError ? error.code : 'PROFILE_SESSION_FAILED';
    return NextResponse.json(
      { success: false, error: getErrorMessage(error), code },
      { status },
    );
  }
}
