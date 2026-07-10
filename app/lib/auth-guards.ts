import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';

import { auth } from '@/app/lib/auth';
import { hasAnyAuthUser } from '@/app/lib/auth-setup';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { getLicenseStatus } from '@/app/lib/license';
import { getUserOnboardingState } from '@/app/lib/user-preferences';

export async function requirePageSession(options?: {
  allowIncompleteOnboarding?: boolean;
  allowIncompleteUserOnboarding?: boolean;
  allowUnlicensed?: boolean;
}) {
  const [session, locale] = await Promise.all([
    auth.api.getSession({ headers: await headers() }),
    getLocale()
  ]);

  if (!session) {
    if (!(await hasAnyAuthUser())) {
      redirect({ href: '/setup', locale });
    }
    redirect({ href: '/login', locale });
  }

  if (!options?.allowIncompleteOnboarding && isOnboardingEnabled() && !(await isOnboardingComplete())) {
    redirect({ href: '/onboarding', locale });
  }

  if (
    !options?.allowIncompleteUserOnboarding &&
    isOnboardingEnabled() &&
    await isOnboardingComplete()
  ) {
    const onboarding = await getUserOnboardingState(session!.user.id);
    if (onboarding.step !== 'complete') {
      redirect({ href: '/onboarding', locale });
    }
  }

  if (!options?.allowUnlicensed && isOnboardingEnabled() && await isOnboardingComplete()) {
    const status = await getLicenseStatus();
    if (!status.licensed) {
      redirect({ href: '/settings?tab=license', locale });
    }
  }

  return session;
}
