import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isOnboardingEnabled, isOnboardingComplete, markOnboardingComplete } from '@/app/lib/onboarding/status';

export async function POST(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return NextResponse.json({ error: 'Onboarding is not enabled' }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (await isOnboardingComplete()) {
    return NextResponse.json({ success: true });
  }

  await markOnboardingComplete({
    completedBy: session.user.id,
    method: 'ui',
    notes: session.user.email,
  });

  return NextResponse.json({ success: true });
}
