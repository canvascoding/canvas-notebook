import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  ensureOnboardingProfileSession,
  OnboardingProfileError,
} from '@/app/lib/onboarding/profile';
import {
  isOnboardingComplete,
  isOnboardingEnabled,
} from '@/app/lib/onboarding/status';
import { getUserOnboardingState } from '@/app/lib/user-preferences';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const dynamic = 'force-dynamic';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: string, code: string, status: number) {
  return NextResponse.json(
    { success: false, error, code },
    { status, headers: responseHeaders },
  );
}

export async function POST(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return errorResponse('Onboarding is not enabled.', 'ONBOARDING_DISABLED', 403);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'mobile-onboarding-profile-session',
  });
  if (!limited.ok) return limited.response;

  if (!(await isOnboardingComplete())) {
    return errorResponse(
      'Finish instance setup before personal onboarding begins.',
      'INSTANCE_SETUP_REQUIRED',
      409,
    );
  }

  const onboarding = await getUserOnboardingState(session.user.id);
  if (onboarding.step !== 'profile' && onboarding.profile === 'pending') {
    return errorResponse(
      'Confirm the personal workspace before starting the profile.',
      'PROFILE_STEP_NOT_READY',
      409,
    );
  }
  if (onboarding.profile !== 'pending') {
    return NextResponse.json(
      { success: true, data: { complete: true } },
      { headers: responseHeaders },
    );
  }

  try {
    const payload = await request.json().catch(() => null) as {
      locale?: unknown;
    } | null;
    const locale = typeof payload?.locale === 'string'
      ? payload.locale
      : null;
    const result = await ensureOnboardingProfileSession({
      userId: session.user.id,
      locale,
    });
    return NextResponse.json(
      { success: true, data: result },
      { headers: responseHeaders },
    );
  } catch (error) {
    if (error instanceof OnboardingProfileError) {
      return errorResponse(error.message, error.code, error.statusCode);
    }
    console.error('[API] Mobile onboarding profile session failed:', error);
    return errorResponse(
      'Could not create onboarding profile session.',
      'PROFILE_SESSION_FAILED',
      500,
    );
  }
}
