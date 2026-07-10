import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { getUserOnboardingState } from '@/app/lib/user-preferences';

export async function GET(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return NextResponse.json({ success: true, enabled: false, complete: true });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const [instanceComplete, userOnboarding] = await Promise.all([
    isOnboardingComplete(),
    getUserOnboardingState(session.user.id),
  ]);

  return NextResponse.json({
    success: true,
    enabled: true,
    complete: instanceComplete,
    instanceComplete,
    profileComplete: userOnboarding.profile !== 'pending',
    userOnboarding,
  });
}
