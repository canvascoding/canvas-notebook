import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { OnboardingProfileError, skipOnboardingProfile } from '@/app/lib/onboarding/profile';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not skip onboarding profile.';
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
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'onboarding-profile-skip',
  });
  if (!limited.ok) {
    return limited.response;
  }

  const instanceComplete = await isOnboardingComplete();
  if (!instanceComplete) {
    return NextResponse.json(
      { success: false, error: 'Finish instance setup before personal onboarding begins.', code: 'INSTANCE_SETUP_REQUIRED' },
      { status: 409 },
    );
  }

  try {
    const result = await skipOnboardingProfile({ userId: session.user.id });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof OnboardingProfileError ? error.statusCode : 500;
    const code = error instanceof OnboardingProfileError ? error.code : 'PROFILE_SKIP_FAILED';
    return NextResponse.json(
      { success: false, error: getErrorMessage(error), code },
      { status },
    );
  }
}
