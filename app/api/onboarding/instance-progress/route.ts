import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { isAdminUser } from '@/app/lib/admin-auth';
import {
  getInstanceOnboardingStep,
  INSTANCE_ONBOARDING_STEPS,
  setInstanceOnboardingStep,
  type InstanceOnboardingStep,
} from '@/app/lib/server-settings';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function parseStep(value: unknown): InstanceOnboardingStep | null {
  return typeof value === 'string' && (INSTANCE_ONBOARDING_STEPS as readonly string[]).includes(value)
    ? value as InstanceOnboardingStep
    : null;
}

async function requireInstanceOwner(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return { response: NextResponse.json({ success: false, error: 'Onboarding is disabled.' }, { status: 403 }) };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!isAdminUser(session.user)) {
    return { response: NextResponse.json({ success: false, error: 'Forbidden: owner or admin required.' }, { status: 403 }) };
  }
  if (await isOnboardingComplete()) {
    return { response: NextResponse.json({ success: false, error: 'Instance onboarding is already complete.' }, { status: 409 }) };
  }
  return { session };
}

export async function GET(request: NextRequest) {
  const result = await requireInstanceOwner(request);
  if ('response' in result) return result.response;
  return NextResponse.json({ success: true, data: { step: await getInstanceOnboardingStep() } });
}

export async function PATCH(request: NextRequest) {
  const result = await requireInstanceOwner(request);
  if ('response' in result) return result.response;
  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'onboarding-instance-progress',
  });
  if (!limited.ok) return limited.response;

  const payload = await request.json().catch(() => null) as { step?: unknown } | null;
  const step = parseStep(payload?.step);
  if (!step) {
    return NextResponse.json({ success: false, error: 'Unsupported onboarding step.' }, { status: 400 });
  }

  const settings = await setInstanceOnboardingStep(result.session.user.id, step);
  return NextResponse.json({ success: true, data: { step: settings.onboardingStep } });
}
