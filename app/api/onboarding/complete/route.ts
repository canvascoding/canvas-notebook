import { NextRequest, NextResponse } from 'next/server';

import { isAdminUser } from '@/app/lib/admin-auth';
import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import { auth } from '@/app/lib/auth';
import { readMemoryReviewRuntimeCatalog } from '@/app/lib/memory/runtime-configuration';
import { deleteOnboardingBootstrapFile } from '@/app/lib/onboarding/profile';
import { getUserOnboardingState, initializeUserOnboarding } from '@/app/lib/user-preferences';
import { isOnboardingEnabled, isOnboardingComplete, markOnboardingComplete } from '@/app/lib/onboarding/status';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
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

  const settings = await getServerSettings();
  const organizationState = await readOrganizationPermissionForUser(session.user.id);
  if (!organizationState.configured || !organizationState.organizationId) {
    return NextResponse.json(
      { success: false, error: 'Complete the workspace organization setup before finishing onboarding.', code: 'ORGANIZATION_SETUP_REQUIRED' },
      { status: 409 },
    );
  }

  const catalog = await readAppRuntimeCatalog(organizationState.organizationId);
  const defaultSelection = catalog.defaultSelection;
  const defaultProvider = defaultSelection
    ? catalog.providers.find((provider) => provider.installationId === defaultSelection.providerInstallationId)
    : null;
  const defaultModel = defaultSelection
    ? defaultProvider?.models.find((model) => model.id === defaultSelection.modelId)
    : null;
  const currentDefaultReady = Boolean(
    defaultSelection
    && defaultProvider?.enabled
    && defaultProvider.status === 'ready'
    && defaultProvider.providerId === defaultSelection.providerId
    && defaultModel?.enabled,
  );

  if (
    !settings.providerVerifiedAt
    || settings.providerVerifiedCatalogRevision !== catalog.revision
    || settings.providerVerifiedInstallationId !== defaultSelection?.providerInstallationId
    || !currentDefaultReady
  ) {
    return NextResponse.json(
      {
        success: false,
        error: 'Verify the current app-default AI provider and model before completing instance setup.',
        code: 'PROVIDER_VERIFICATION_REQUIRED',
      },
      { status: 409 },
    );
  }

  const memoryRuntime = await readMemoryReviewRuntimeCatalog(organizationState.organizationId);
  if (!memoryRuntime.valid) {
    return NextResponse.json(
      {
        success: false,
        error: 'Verify a Memory Reviewer provider and model before completing instance setup.',
        code: 'MEMORY_REVIEWER_VERIFICATION_REQUIRED',
      },
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
