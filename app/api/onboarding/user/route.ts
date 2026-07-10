import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getUserOnboardingState,
  updateUserOnboardingState,
  type UserOnboardingStep,
  type UserOnboardingTourStatus,
} from '@/app/lib/user-preferences';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const USER_ONBOARDING_STEPS = new Set<UserOnboardingStep>(['language', 'workspace', 'profile', 'tour', 'complete']);
const USER_ONBOARDING_TOUR_STATUSES = new Set<UserOnboardingTourStatus>(['pending', 'started', 'skipped', 'completed']);

function parsePayload(value: unknown): { step?: UserOnboardingStep; tour?: UserOnboardingTourStatus } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as { step?: unknown; tour?: unknown };
  const step = typeof payload.step === 'string' && USER_ONBOARDING_STEPS.has(payload.step as UserOnboardingStep)
    ? payload.step as UserOnboardingStep
    : undefined;
  const tour = typeof payload.tour === 'string' && USER_ONBOARDING_TOUR_STATUSES.has(payload.tour as UserOnboardingTourStatus)
    ? payload.tour as UserOnboardingTourStatus
    : undefined;
  return step || tour ? { ...(step ? { step } : {}), ...(tour ? { tour } : {}) } : null;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const onboarding = await getUserOnboardingState(session.user.id);
  return NextResponse.json({ success: true, data: onboarding });
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'onboarding-user-progress',
  });
  if (!limited.ok) return limited.response;

  const updates = parsePayload(await request.json().catch(() => null));
  if (!updates) {
    return NextResponse.json({ success: false, error: 'Unsupported onboarding update.' }, { status: 400 });
  }

  const current = await getUserOnboardingState(session.user.id);
  if (
    current.profile === 'pending' &&
    (updates.step === 'tour' || updates.step === 'complete' || updates.tour !== undefined)
  ) {
    return NextResponse.json(
      { success: false, error: 'Complete or skip the personal profile before starting the tour.' },
      { status: 409 },
    );
  }

  if (current.profile === 'pending' && updates.step === 'profile' && current.step !== 'workspace') {
    return NextResponse.json(
      { success: false, error: 'Confirm the personal workspace before starting the profile.' },
      { status: 409 },
    );
  }

  // Profile completion is intentionally server-owned. A client may guide or
  // finish a tour, but cannot claim that the agent profile was written.
  const onboarding = await updateUserOnboardingState(session.user.id, updates);
  return NextResponse.json({ success: true, data: onboarding });
}
