import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { auth } from '@/app/lib/auth';
import { getLicenseStatus } from '@/app/lib/license';
import { deleteOnboardingBootstrapFile } from '@/app/lib/onboarding/profile';
import { getUserOnboardingState, initializeUserOnboarding } from '@/app/lib/user-preferences';
import { isOnboardingEnabled, isOnboardingComplete, markOnboardingComplete } from '@/app/lib/onboarding/status';
import { getServerSettings, setInstanceOnboardingStep } from '@/app/lib/server-settings';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  if (!isOnboardingEnabled()) {
    return NextResponse.json({ error: 'Onboarding is not enabled' }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdminUser(session.user)) {
    return NextResponse.json({ error: 'Forbidden: owner or admin required.' }, { status: 403 });
  }

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'onboarding-instance-complete',
  });
  if (!limited.ok) return limited.response;

  if (await isOnboardingComplete()) {
    const onboarding = await getUserOnboardingState(session.user.id);
    return NextResponse.json({ success: true, data: { userOnboarding: onboarding } });
  }

  const licenseStatus = await getLicenseStatus();
  if (!licenseStatus.licensed) {
    return NextResponse.json(
      { error: 'License activation required', code: 'LICENSE_REQUIRED' },
      { status: 402 },
    );
  }

  const settings = await getServerSettings();
  if (!settings.providerVerifiedAt) {
    return NextResponse.json(
      { success: false, error: 'Verify the configured agent provider before completing instance setup.', code: 'PROVIDER_VERIFICATION_REQUIRED' },
      { status: 409 },
    );
  }

  // Persist the first admin's personal flow before changing the global gate.
  // If the global completion write fails, the admin safely resumes this review
  // step instead of landing in the app without a personal onboarding state.
  const onboarding = await initializeUserOnboarding(session.user.id);
  await setInstanceOnboardingStep(session.user.id, 'review');
  await markOnboardingComplete({
    completedBy: session.user.id,
    method: 'ui',
    notes: 'instance_setup_completed',
  });
  await deleteOnboardingBootstrapFile();
  return NextResponse.json({ success: true, data: { userOnboarding: onboarding } });
}
